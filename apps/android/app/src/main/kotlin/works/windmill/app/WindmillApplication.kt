package works.windmill.app

import works.windmill.platform.you.AccountDeletionStorage
import works.windmill.platform.you.AccountDeletionStore
import works.windmill.platform.you.AccountDeletionHttp
import works.windmill.platform.you.DeletionIdentity
import works.windmill.gym.coach.LocalCoach
import works.windmill.gym.coach.onboarding.CoachOnboardingHttp
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.onboarding.CoachOnboardingStore
import works.windmill.gym.coach.onboarding.CoachRoutineImports
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationHttp
import works.windmill.platform.ai.AiInstallationLifecycle
import android.app.Application
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.ComponentName
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
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
import works.windmill.gym.notification.WorkoutTile
import works.windmill.gym.notification.WorkoutTileHost
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

class WindmillApplication : Application(), WorkoutNotificationHost, WorkoutTileHost {
    private var connectivity: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var processLifecycle: DefaultLifecycleObserver? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
        telemetry.failure("application_coroutine", error)
    })
    var telemetry: Telemetry = Telemetry.None
        private set
    lateinit var auth: AuthStore
        private set
    lateinit var accountDeletion: AccountDeletionStore
        private set
    lateinit var gym: GymRuntime
        private set
    lateinit var engineSession: GymEngineSession
        private set
    lateinit var coachOnboarding: CoachOnboardingStore
        private set
    lateinit var coachImports: CoachRoutineImports
        private set
    lateinit var onboardingLaunch: OnboardingLaunch
        private set
    override lateinit var workoutNotifications: WorkoutNotifications
        private set
    override lateinit var workoutTile: WorkoutTile
        private set

    override fun onCreate() {
        super.onCreate()
        val release = "android-${BuildConfig.VERSION_NAME}-${BuildConfig.WM_SOURCE_REVISION.take(12)}"
        val environment = if (BuildConfig.DEBUG) "development" else "production"
        val telemetryEnabled = !BuildConfig.DEBUG || BuildConfig.WM_DEBUG_TELEMETRY
        if (telemetryEnabled) AndroidTelemetry.startSentry(this, BuildConfig.WM_SENTRY_DSN, release, environment, BuildConfig.VERSION_CODE.toString())
        val bootstrap = if (telemetryEnabled) SentryErrors else Telemetry.None
        val vault = SecretVault.onThisDevice(bootstrap)
        val deletionStorage = AccountDeletionStorage.onThisDevice(this, vault, bootstrap)
        val sessions = PrefsSessions(this, vault, bootstrap)
        fun deletionPending() = deletionStorage.blocked || (::accountDeletion.isInitialized && accountDeletion.transitionPending)
        fun accountWritable() = !deletionPending() && !sessions.signOutPending && (!::auth.isInitialized || !auth.transitionPending)
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
            rewriteDeviceValue = EngineTraining.rewriteDeviceValue,
            intentResultWrites = EngineTraining.intentResultWrites,
            pendingDeviceWork = WorkoutImports.pendingDeviceWork)
        val engineStorage = EngineStorage(this, vault)
        if (accountWritable() && owner != null) sessions.read()?.let { engineStorage.save(owner, it) }
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
            engineStorage, BuildConfig.VERSION_NAME, products = listOf("gym"), activityAllowed = ::accountWritable,
            signOutDrainAllowed = { !sessions.signOutPending && !deletionStorage.blocked })
        val training = EngineTraining(engine, writeAuthority = ::accountWritable)
        val localCoach = LocalCoach(File(filesDir, LocalCoach.fileName), writesAllowed = { !deletionPending() })
        val installation = AiInstallation.onThisDevice(this, AiInstallationHttp(baseUrl, telemetry), telemetry, BuildConfig.VERSION_NAME)
        if (local is LocalSession.Owned && !deletionPending()) {
            try { installation.retainBindingIntent() }
            catch (_: Exception) { telemetry.event("ai_installation_outcome", mapOf("action" to "bind", "outcome" to "failed")) }
        }
        val anonymousSeat = {
            if (accountWritable() && sessions.localSession == LocalSession.Absent && training.anonymous)
                CoachOnboardingSeat(localCoach.anonymousOwner(), engine.activeReplica()) else null
        }
        coachOnboarding = CoachOnboardingStore(localCoach, installation, CoachOnboardingHttp(baseUrl, telemetry), anonymousSeat, scope, telemetry)
        coachImports = CoachRoutineImports(engine, anonymousSeat, scope, telemetry)
        val store = TrainingStore(
            controls = WorkoutControls(File(filesDir, WorkoutControls.fileName), owner, telemetry = telemetry),
            training = training,
            scope = scope,
            rest = { (auth.status as? AuthStatus.SignedIn)?.let { GymHttp(auth.accountApi(it.user)) } },
            workoutClock = clock, workoutAuthority = { selectedOwner ->
                accountWritable() && when (val current = sessions.localSession) {
                    LocalSession.Absent -> selectedOwner == null
                    is LocalSession.Owned -> selectedOwner == current.user.id
                    is LocalSession.Unresolved -> false
                }
            }, telemetry = telemetry,
            localCoach = localCoach,
            coachOnboarding = coachOnboarding,
        )
        engineSession = GymEngineSession(engine, syncRuntime, telemetry, transport, beforeAccountChange = {
            val revision = auth.accountOperationRevision
            val deletionRevision = if (::accountDeletion.isInitialized) accountDeletion.operationRevision else 0L
            store.prepareEngineTransition { auth.accountOperationRevision == revision &&
                (!::accountDeletion.isInitialized || accountDeletion.operationRevision == deletionRevision) }
        }, clearAccountCredential = engineStorage::delete)
        val accountLifecycle = AiInstallationLifecycle(engineSession, installation, scope, telemetry)
        auth = AuthStore(baseUrl, sessions, telemetry = telemetry,
            lifecycle = accountLifecycle, handoffScope = scope, externalTransitionPending = ::deletionPending,
            onVerifiedSignIn = { localCoach.reopenVerifiedOwner(it.id) })
        fun deletionIdentity(): DeletionIdentity? {
            val user = sessions.user() ?: return null
            val credential = sessions.read() ?: return null
            if (sessions.localSession != LocalSession.Owned(user)) return null
            return DeletionIdentity(user, credential, engine.activeReplica(), auth.accountOperationRevision)
        }
        accountDeletion = AccountDeletionStore(deletionStorage, AccountDeletionHttp(baseUrl, telemetry), scope,
            identity = ::deletionIdentity,
            begin = { identity -> identity.copy(revision = auth.beginAccountDeletion(identity.user, identity.credential)) },
            unsent = { sessions.user()?.id?.let(engineSession::deletionUnsent) ?: 0 },
            prepare = { identity ->
                check(deletionIdentity() == identity) { "The account changed." }
                accountLifecycle.prepareSignOut(identity.user.id)
            },
            finishEngine = { pending, held ->
                val stored = sessions.user()
                check(stored?.id != pending.user.id || stored == pending.user && sessions.read() == pending.credential) { "The account changed." }
                engineSession.finishAccountDeletion(pending.user.id, pending.replica, held)
            },
            cleanup = { pending ->
                auth.validateAccountDeletion(pending.user, pending.credential)
                val credential = engineStorage.token(pending.user.id)
                check(credential == null || credential == pending.credential) { "The account credential changed." }
                store.eraseDeletedOwner(pending.user.id, pending.replica)
                if (credential != null) engineStorage.delete(pending.user.id)
                auth.completeAccountDeletion(pending.user, pending.credential)
            }, telemetry = telemetry)
        scope.launch {
            try { if (!deletionPending()) store.coach.resumeAnonymous() }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { telemetry.failure("gym.coachOnboarding", java.io.IOException("Coach recovery could not be read.")) }
        }
        delivery = { replica, reply -> if (training.reportDelivery(replica, reply)) store.refreshEngine() }
        gym = GymRuntime(store, cachedOwner = { sessions.localSession.user?.id },
            authorityAvailable = { accountWritable() && sessions.localSession !is LocalSession.Unresolved },
            authorityRevision = { auth.identityRevision })
        workoutNotifications = WorkoutNotifications(this, gym, scope,
            ComponentName(this, MainActivity::class.java),
            getSystemService(NotificationManager::class.java),
            getSystemService(KeyguardManager::class.java), telemetry = telemetry)
        workoutNotifications.start()
        workoutTile = WorkoutTile(gym, ComponentName(this, MainActivity::class.java), store::requestRoutines, telemetry)
        store.observeEngine()
        scope.launch { engine.revisions().collect { accountDeletion.refreshCount() } }
        val manager = getSystemService(ConnectivityManager::class.java)
        var knownOnline: Boolean? = null
        fun applyRuntimeActivity() {
            if (!accountWritable()) return
            syncRuntime.launch(engineStorage)
            syncRuntime.connectivity(knownOnline ?: false)
            if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) engineSession.enter()
        }
        fun updateConnectivity() {
            val online = manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            if (online == knownOnline) return
            knownOnline = online
            applyRuntimeActivity()
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
        scope.launch {
            snapshotFlow { Triple(auth.identityRevision, auth.status, auth.transitionPending) }.collect {
                gym.restoreLocal()
                workoutNotifications.refreshCapabilities()
                applyRuntimeActivity()
            }
        }
        val lifecycle = object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { applyRuntimeActivity() }
            override fun onStop(owner: LifecycleOwner) { scope.launch { engineSession.leave() } }
        }
        processLifecycle = lifecycle
        ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycle)
    }

    override fun onTerminate() {
        networkCallback?.let { connectivity?.unregisterNetworkCallback(it) }
        processLifecycle?.let { ProcessLifecycleOwner.get().lifecycle.removeObserver(it) }
        if (::engineSession.isInitialized) engineSession.close()
        scope.cancel()
        super.onTerminate()
    }
}
