package works.windmill.app

import android.app.AlarmManager
import android.app.Application
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.ComponentName
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.launch
import androidx.compose.runtime.snapshotFlow
import works.windmill.gym.notification.AndroidWorkoutClock
import works.windmill.gym.notification.WorkoutNotificationHost
import works.windmill.gym.notification.WorkoutNotifications
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymRuntime
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.auth.LocalSession
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.PrefsSessions
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.telemetry.AndroidTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.SentryErrors

class WindmillApplication : Application(), WorkoutNotificationHost {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
        telemetry.failure("application_coroutine", error)
    })
    var telemetry: Telemetry = Telemetry.None
        private set
    lateinit var auth: AuthStore
        private set
    lateinit var gym: GymRuntime
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
        val owner = local.user?.id
        val baseUrl = WindmillApi.resolvedBaseUrl(BuildConfig.WM_API_BASE_URL)
        if (telemetryEnabled) telemetry = AndroidTelemetry(this, baseUrl, release, environment, BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE.toString(), owner, sessions::read, scope)
        telemetry.event("app_started")
        val clock = AndroidWorkoutClock(this, telemetry = telemetry)
        auth = AuthStore(baseUrl, sessions, telemetry = telemetry)
        val store = TrainingStore(
            SetQueue(File(filesDir, SetQueue.fileName), owner, telemetry = telemetry),
            DeviceCopy(File(filesDir, DeviceCopy.fileName), telemetry = telemetry),
            LocalLog(File(filesDir, LocalLog.fileName), owner, telemetry = telemetry),
            LocalPreferences(File(filesDir, LocalPreferences.fileName), telemetry = telemetry),
            LocalBodyweight(File(filesDir, LocalBodyweight.fileName), owner, telemetry = telemetry),
            scope, workoutClock = clock, workoutAuthority = { selectedOwner ->
                when (val current = sessions.localSession) {
                    LocalSession.Absent -> selectedOwner == null
                    is LocalSession.Owned -> selectedOwner == current.user.id
                    is LocalSession.Unresolved -> false
                }
            }, telemetry = telemetry,
        )
        gym = GymRuntime(store, cachedOwner = { sessions.localSession.user?.id },
            authorityAvailable = { sessions.localSession !is LocalSession.Unresolved },
            cachedAccount = { local.user?.let { works.windmill.platform.Account(auth.accountApi(it), it, verified = false,
                locallyTrusted = local is LocalSession.Owned, telemetry = telemetry) } }, authorityRevision = { auth.identityRevision })
        workoutNotifications = WorkoutNotifications(this, gym, scope, clock,
            ComponentName(this, MainActivity::class.java),
            getSystemService(NotificationManager::class.java),
            getSystemService(AlarmManager::class.java),
            getSystemService(KeyguardManager::class.java), telemetry = telemetry)
        workoutNotifications.start()
        scope.launch {
            snapshotFlow { auth.identityRevision to auth.status }.collect {
                gym.restoreLocal()
                workoutNotifications.refreshCapabilities()
            }
        }
    }
}
