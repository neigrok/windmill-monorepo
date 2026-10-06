package works.windmill.app

import android.app.Application
import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.ComponentName
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Bundle
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext
import androidx.compose.runtime.snapshotFlow
import works.windmill.gym.notification.AndroidWorkoutClock
import works.windmill.gym.notification.WorkoutNotificationHost
import works.windmill.gym.notification.WorkoutNotifications
import works.windmill.gym.store.GymRuntime
import works.windmill.gym.store.WorkoutControls
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.GymEngineSession
import works.windmill.gym.store.WorkoutImports
import works.windmill.gym.net.GymHttp
import works.windmill.platform.auth.LocalSession
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.PrefsSessions
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.telemetry.AndroidTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.SentryErrors
import works.windmill.sync.engine.AndroidClock
import works.windmill.sync.engine.AndroidSqlite
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.HTTPTransport
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.SyncTransport
import works.windmill.sync.engine.SyncResponse
import works.windmill.sync.engine.Reply
import works.windmill.sync.core.Json
import works.windmill.sync.schema.SyncSchema

class WindmillApplication : Application(), WorkoutNotificationHost {
    private var connectivity: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var activityLifecycle: ActivityLifecycleCallbacks? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
        telemetry.failure("application_coroutine", error)
    })
    var telemetry: Telemetry = Telemetry.None
        private set
    lateinit var auth: AuthStore
        private set
    lateinit var gym: GymRuntime
        private set
    lateinit var engineSession: GymEngineSession
        private set
    lateinit var onboardingLaunch: OnboardingLaunch
        private set
    override lateinit var workoutNotifications: WorkoutNotifications
        private set

    override fun onCreate() {
        super.onCreate()
        val release = "android-${BuildConfig.VERSION_NAME}-${BuildConfig.WM_SOURCE_REVISION.take(12)}"
        val environment = if (BuildConfig.DEBUG) "development" else "production"
        val telemetryEnabled = !BuildConfig.DEBUG || BuildConfig.WM_DEBUG_TELEMETRY
        if (telemetryEnabled) AndroidTelemetry.startSentry(this, BuildConfig.WM_SENTRY_DSN, release, environment, BuildConfig.VERSION_CODE.toString())
        val sessions = PrefsSessions(this, telemetry = if (telemetryEnabled) SentryErrors else Telemetry.None)
        val local = sessions.localSession
        val owner = (local as? LocalSession.Owned)?.user?.id
        val baseUrl = WindmillApi.resolvedBaseUrl(BuildConfig.WM_API_BASE_URL)
        if (telemetryEnabled) telemetry = AndroidTelemetry(this, baseUrl, release, environment, BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE.toString(), owner, sessions::read, scope)
        telemetry.event("app_started")
        onboardingLaunch = OnboardingLaunch(this, telemetry)
        val clock = AndroidWorkoutClock(this, telemetry = telemetry)
        val identities = DeviceIdentities()
        val engineTelemetry = engineTelemetry(telemetry)
        val initial = Engine.memory(SyncSchema.registry, identities = identities).use { it.snapshot() }
        val engine = AndroidSqlite.open(File(filesDir, "sync-replica.sqlite"), SyncSchema.registry, initial,
            AndroidClock(this), identities, identities.actorID(), telemetry = engineTelemetry,
            rewriteDeviceValue = WorkoutImports.rewriteDeviceValue,
            commandResultWrites = WorkoutImports.commandResultWrites,
            pendingDeviceWork = WorkoutImports.pendingDeviceWork)
        val engineStorage = EngineStorage(this, SecretVault.onThisDevice(telemetry))
        if (owner != null) sessions.read()?.let { engineStorage.save(owner, it) }
        val transport = HTTPTransport(baseUrl.toString(), SyncSchema.version.toInt(), engineTelemetry)
        var delivery: suspend (String, Reply<SyncResponse>) -> Unit = { _, _ -> }
        val reportedTransport = object : SyncTransport by transport {
            override suspend fun push(request: Json, token: String): Reply<SyncResponse> {
                val replica = engine.activeReplica()
                val account = request.member("account").str()
                val reply = transport.push(request, token)
                withContext(Dispatchers.Main.immediate) {
                    if (engineStorage.token(account) == token) delivery(replica, reply)
                }
                return reply
            }
        }
        val syncRuntime = SyncRuntime(engine, reportedTransport,
            engineStorage, BuildConfig.VERSION_NAME, products = listOf("gym"))
        val training = EngineTraining(engine)
        val store = TrainingStore(
            controls = WorkoutControls(File(filesDir, WorkoutControls.fileName), owner, telemetry = telemetry),
            training = training,
            scope = scope,
            rest = { (auth.status as? AuthStatus.SignedIn)?.let { GymHttp(auth.accountApi(it.user)) } },
            workoutClock = clock, workoutAuthority = { selectedOwner ->
                when (val current = sessions.localSession) {
                    LocalSession.Absent -> selectedOwner == null
                    is LocalSession.Owned -> selectedOwner == current.user.id
                    is LocalSession.Unresolved -> false
                }
            }, telemetry = telemetry,
            localCoach = works.windmill.gym.store.LocalCoach(File(filesDir, works.windmill.gym.store.LocalCoach.fileName)),
        )
        engineSession = GymEngineSession(engine, syncRuntime, telemetry, transport, beforeAccountChange = store::prepareEngineTransition)
        auth = AuthStore(baseUrl, sessions, telemetry = telemetry, lifecycle = engineSession)
        delivery = { replica, reply -> if (training.reportDelivery(replica, reply)) store.refreshEngine() }
        syncRuntime.launch(engineStorage)
        gym = GymRuntime(store, cachedOwner = { sessions.localSession.user?.id },
            authorityAvailable = { sessions.localSession !is LocalSession.Unresolved },
            authorityRevision = { auth.identityRevision })
        workoutNotifications = WorkoutNotifications(this, gym, scope,
            ComponentName(this, MainActivity::class.java),
            getSystemService(NotificationManager::class.java),
            getSystemService(KeyguardManager::class.java), telemetry = telemetry)
        workoutNotifications.start()
        scope.launch {
            snapshotFlow { auth.identityRevision to auth.status }.collect {
                gym.restoreLocal()
                workoutNotifications.refreshCapabilities()
            }
        }
        store.observeEngine()
        val manager = getSystemService(ConnectivityManager::class.java)
        var knownOnline: Boolean? = null
        fun updateConnectivity() {
            val online = manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            if (online == knownOnline) return
            knownOnline = online
            syncRuntime.connectivity(online)
            telemetry.event("sync_connectivity", mapOf("state" to if (online) "online" else "offline"))
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = updateConnectivity()
            override fun onLost(network: Network) = updateConnectivity()
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = updateConnectivity()
        }
        connectivity = manager
        networkCallback = callback
        updateConnectivity()
        manager.registerDefaultNetworkCallback(callback)
        val visibleActivities = mutableSetOf<Activity>()
        val lifecycle = object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                if (visibleActivities.add(activity) && visibleActivities.size == 1) engineSession.enter()
            }
            override fun onActivityStopped(activity: Activity) {
                if (visibleActivities.remove(activity) && visibleActivities.isEmpty()) scope.launch { engineSession.leave() }
            }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        }
        activityLifecycle = lifecycle
        registerActivityLifecycleCallbacks(lifecycle)
    }

    override fun onTerminate() {
        networkCallback?.let { connectivity?.unregisterNetworkCallback(it) }
        activityLifecycle?.let(::unregisterActivityLifecycleCallbacks)
        if (::engineSession.isInitialized) engineSession.close()
        scope.cancel()
        super.onTerminate()
    }
}
