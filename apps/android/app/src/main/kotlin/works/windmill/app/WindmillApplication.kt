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

class WindmillApplication : Application(), WorkoutNotificationHost {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var auth: AuthStore
        private set
    lateinit var gym: GymRuntime
        private set
    override lateinit var workoutNotifications: WorkoutNotifications
        private set

    override fun onCreate() {
        super.onCreate()
        val sessions = PrefsSessions(this)
        val local = sessions.localSession
        val owner = local.user?.id
        val clock = AndroidWorkoutClock(this)
        auth = AuthStore(WindmillApi.resolvedBaseUrl(BuildConfig.WM_API_BASE_URL), sessions)
        val store = TrainingStore(
            SetQueue(File(filesDir, SetQueue.fileName), owner),
            DeviceCopy(File(filesDir, DeviceCopy.fileName)),
            LocalLog(File(filesDir, LocalLog.fileName), owner),
            LocalPreferences(File(filesDir, LocalPreferences.fileName)),
            LocalBodyweight(File(filesDir, LocalBodyweight.fileName), owner),
            scope, workoutClock = clock, workoutAuthority = { selectedOwner ->
                when (val current = sessions.localSession) {
                    LocalSession.Absent -> selectedOwner == null
                    is LocalSession.Owned -> selectedOwner == current.user.id
                    is LocalSession.Unresolved -> false
                }
            },
        )
        gym = GymRuntime(store, cachedOwner = { sessions.localSession.user?.id },
            authorityAvailable = { sessions.localSession !is LocalSession.Unresolved },
            cachedAccount = { local.user?.let { works.windmill.platform.Account(auth.accountApi(it), it, verified = false,
                locallyTrusted = local is LocalSession.Owned) } }, authorityRevision = { auth.identityRevision })
        workoutNotifications = WorkoutNotifications(this, gym, scope, clock,
            ComponentName(this, MainActivity::class.java),
            getSystemService(NotificationManager::class.java),
            getSystemService(AlarmManager::class.java),
            getSystemService(KeyguardManager::class.java))
        workoutNotifications.start()
        scope.launch {
            snapshotFlow { auth.identityRevision to auth.status }.collect {
                gym.restoreLocal()
                workoutNotifications.refreshCapabilities()
            }
        }
    }
}
