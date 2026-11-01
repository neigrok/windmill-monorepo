package works.windmill.gym.notification

import android.Manifest
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.compose.ui.graphics.toArgb
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.R
import works.windmill.gym.ui.GymSkin
import works.windmill.gym.presentation.LogSetCommand
import works.windmill.gym.presentation.LogSetAcceptance
import works.windmill.gym.presentation.WorkoutClock
import works.windmill.gym.presentation.WorkoutKey
import works.windmill.gym.presentation.WorkoutMoment
import works.windmill.gym.presentation.WorkoutNotification
import works.windmill.gym.store.WorkoutCommands

interface WorkoutNotificationHost {
    val workoutNotifications: WorkoutNotifications
}

data class WorkoutCapabilities(
    val postGranted: Boolean,
    val appEnabled: Boolean,
    val channelEnabled: Boolean,
    val promotionAllowed: Boolean?,
    val promotable: Boolean?,
    val promoted: Boolean?,
)

sealed interface WorkoutRoute {
    data class Open(val key: WorkoutKey) : WorkoutRoute
    data class Log(val command: LogSetCommand) : WorkoutRoute
}

class AndroidWorkoutClock(context: Context, private val telemetry: Telemetry = Telemetry.None) : WorkoutClock {
    private val resolver = context.applicationContext.contentResolver

    override fun now(): WorkoutMoment {
        val boot = try {
            "boot:${Settings.Global.getInt(resolver, Settings.Global.BOOT_COUNT)}"
        } catch (error: Exception) {
            telemetry.failure("gym.workoutClock", error)
            processBoot
        }
        return WorkoutMoment(System.currentTimeMillis(), SystemClock.elapsedRealtime(), boot)
    }

    companion object {
        private val processBoot = "process:${UUID.randomUUID()}"
    }
}

class WorkoutNotifications(
    context: Context,
    private val commands: WorkoutCommands,
    private val scope: CoroutineScope,
    private val activity: ComponentName,
    private val notificationManager: NotificationManager,
    private val keyguardManager: KeyguardManager,
    private val telemetry: Telemetry = Telemetry.None,
) {
    private val context = context.applicationContext
    private val receiver = ComponentName(this.context, WorkoutNotificationReceiver::class.java)
    private val measured = MutableStateFlow<WorkoutCapabilities?>(null)
    val capabilities: StateFlow<WorkoutCapabilities?> = measured.asStateFlow()
    private var collector: Job? = null
    private var rendered: WorkoutNotification? = null
    private var renderedAccent: Int? = null
    private var channelReady = false
    private var restored = false

    @Synchronized
    fun start(): Job {
        collector?.let { return it }
        val job = scope.launch(Dispatchers.Main.immediate, start = CoroutineStart.LAZY) {
            commands.restoreLocal()
            restored = true
            createChannel()
            commands.notification.collect { reconcile() }
        }
        collector = job
        job.start()
        return job
    }

    fun refreshCapabilities() {
        scope.launch(Dispatchers.Main.immediate) {
            commands.restoreLocal()
            restored = true
            createChannel()
            reconcile()
        }
    }

    fun route(intent: Intent): WorkoutRoute? {
        if (intent.component != activity) return null
        return when (val command = decode(intent)) {
            is Command.Open -> WorkoutRoute.Open(command.key)
            is Command.Log -> WorkoutRoute.Log(command.value)
            else -> null
        }
    }

    fun dispatch(intent: Intent, onComplete: () -> Unit) {
        scope.launch(Dispatchers.Main.immediate) {
            try {
                receive(intent)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                telemetry.failure("gym.notification.receive", error)
            }
        }.invokeOnCompletion { onComplete() }
    }

    suspend fun perform(route: WorkoutRoute, allowed: Boolean = true): Boolean = withContext(Dispatchers.Main.immediate) {
        val accepted = try {
            when {
                !allowed -> false
                route is WorkoutRoute.Open -> commands.openWorkout(route.key)
                route is WorkoutRoute.Log && !keyguardManager.isDeviceLocked ->
                    commands.logSet(route.command) is LogSetAcceptance.Accepted
                else -> false
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            telemetry.failure("gym.notification.receive", error)
            false
        }
        telemetry.event("gym_action", mapOf("screen" to "notification",
            "action" to if (route is WorkoutRoute.Log) "log_set" else "open",
            "outcome" to if (accepted) "ok" else "refused"))
        accepted
    }

    suspend fun receive(intent: Intent) = withContext(Dispatchers.Main.immediate) {
        val command = decode(intent) ?: return@withContext
        if (intent.component != receiver) return@withContext
        commands.restoreLocal()
        restored = true
        createChannel()
        when (command) {
            is Command.Log -> {
                perform(WorkoutRoute.Log(command.value))
            }
            is Command.Hide -> commands.setHidden(command.key, true)
            else -> Unit
        }
        reconcile()
    }

    private fun createChannel() {
        if (channelReady) return
        if (notificationManager.getNotificationChannel(CHANNEL) == null) {
            val legacy = notificationManager.getNotificationChannel(LEGACY_CHANNEL)
            val importance = if (legacy?.importance == NotificationManager.IMPORTANCE_NONE)
                NotificationManager.IMPORTANCE_NONE else NotificationManager.IMPORTANCE_DEFAULT
            notificationManager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Workout", importance).apply {
                    setSound(null, null)
                    enableVibration(false)
                },
            )
        }
        notificationManager.deleteNotificationChannel(LEGACY_CHANNEL)
        channelReady = true
    }

    private fun measure(candidate: Notification? = null): WorkoutCapabilities {
        val channel = notificationManager.getNotificationChannel(CHANNEL)
        val active = if (Build.VERSION.SDK_INT >= 36) runCatching {
            notificationManager.activeNotifications.firstOrNull { it.tag == CHANNEL && it.id == ID }
        }.onFailure { telemetry.failure("gym.notification.capabilities", it) }.getOrNull() else null
        val result = WorkoutCapabilities(
            postGranted = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED,
            appEnabled = notificationManager.areNotificationsEnabled(),
            channelEnabled = channel != null && channel.importance != NotificationManager.IMPORTANCE_NONE,
            promotionAllowed = if (Build.VERSION.SDK_INT >= 36) runCatching {
                notificationManager.canPostPromotedNotifications()
            }.onFailure { telemetry.failure("gym.notification.capabilities", it) }.getOrNull() else null,
            promotable = if (Build.VERSION.SDK_INT >= 36) runCatching {
                (candidate ?: active?.notification)?.hasPromotableCharacteristics()
            }.onFailure { telemetry.failure("gym.notification.capabilities", it) }.getOrNull() else null,
            promoted = if (Build.VERSION.SDK_INT >= 36) active?.notification?.let {
                it.flags and Notification.FLAG_PROMOTED_ONGOING != 0
            } else null,
        )
        measured.value = result
        return result
    }

    private fun reconcile() {
        if (!restored) return
        val snapshot = commands.notification.value
        if (snapshot == null || snapshot.hidden || !measure().canPost) {
            notificationManager.cancel(CHANNEL, ID)
            rendered = null
            measure()
            return
        }
        val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val accent = (if (dark) GymSkin.Instrument else GymSkin.Daylight).accent.toArgb()
        if (snapshot == rendered && accent == renderedAccent) return
        val offer = snapshot.offer?.takeIf { it.key == snapshot.key }?.let { LogSetCommand(it.key, it.id) }
        val action = offer?.let { Command.Log(it) } ?: Command.Open(snapshot.key)
        val public = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.gym_workout_notification)
            .setColor(accent)
            .setContentTitle(snapshot.title)
            .setWhen(snapshot.sinceSetAtMs)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.gym_workout_notification)
            .setColor(accent)
            .setContentTitle(snapshot.title)
            .setContentText("${snapshot.movement} · ${snapshot.rackLine} · ${snapshot.counter}")
            .setStyle(NotificationCompat.BigTextStyle().bigText("${snapshot.movement} · ${snapshot.rackLine}\n${snapshot.counter}"))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setRequestPromotedOngoing(true)
            .setContentIntent(pending(Command.Open(snapshot.key)))
            .setDeleteIntent(pending(Command.Hide(snapshot.key)))
            .setWhen(snapshot.sinceSetAtMs)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .addAction(
                NotificationCompat.Action.Builder(0, if (offer == null) "Open workout" else "Log set", pending(action))
                    .setAuthenticationRequired(offer != null && Build.VERSION.SDK_INT >= 31).build(),
            ).build()
        if (!measure(notification).canPost) return
        try {
            if (rendered?.key != snapshot.key) notificationManager.cancel(CHANNEL, ID)
            notificationManager.notify(CHANNEL, ID, notification)
            rendered = snapshot
            renderedAccent = accent
        } catch (error: SecurityException) {
            telemetry.failure("gym.notification.post", error)
            rendered = null
        }
        measure(notification)
    }

    private fun pending(command: Command): PendingIntent {
        val activityRoute = command is Command.Open || command is Command.Log
        val intent = Intent(PREFIX + command.action).setComponent(if (activityRoute) activity else receiver)
            .setData(Uri.Builder().scheme("windmill-workout").authority("internal").apply {
                command.segments.forEach(::appendPath)
            }.build())
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        if (!activityRoute) return PendingIntent.getBroadcast(context, 0, intent, flags)
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 0, intent, flags)
    }

    private fun decode(intent: Intent): Command? {
        val uri = intent.data ?: return null
        if (uri.scheme != "windmill-workout" || uri.encodedAuthority != "internal" ||
            uri.query != null || uri.fragment != null || intent.extras?.isEmpty == false
        ) return null
        val parts = uri.pathSegments
        if (parts.size < 3 || parts.any(String::isBlank)) return null
        val canonical = Uri.Builder().scheme("windmill-workout").authority("internal").apply {
            parts.forEach(::appendPath)
        }.build()
        if (canonical != uri) return null
        val key = WorkoutKey(parts[1], parts[2])
        val command = when (parts.first()) {
            "open" -> if (parts.size == 3) Command.Open(key) else null
            "log" -> if (parts.size == 4) Command.Log(LogSetCommand(key, parts[3])) else null
            "hide" -> if (parts.size == 3) Command.Hide(key) else null
            else -> null
        } ?: return null
        if (intent.action != PREFIX + command.action) return null
        val correctComponent = when (command) {
            is Command.Open -> intent.component == activity
            is Command.Log -> intent.component == activity ||
                Build.VERSION.SDK_INT >= 31 && intent.component == receiver
            else -> intent.component == receiver
        }
        if (!correctComponent) return null
        return command
    }

    private sealed class Command(val action: String, val segments: List<String>) {
        class Open(val key: WorkoutKey) : Command("OPEN", listOf("open", key.ownerKey, key.sessionId))
        class Log(val value: LogSetCommand) : Command("LOG_SET", listOf("log", value.key.ownerKey, value.key.sessionId, value.offerId))
        class Hide(val key: WorkoutKey) : Command("HIDE", listOf("hide", key.ownerKey, key.sessionId))
    }

    companion object {
        internal const val CHANNEL = "gym_workout_clock"
        internal const val LEGACY_CHANNEL = "gym_workout"
        internal const val ID = 1
        internal const val PREFIX = "works.windmill.gym.workout."
    }
}

private val WorkoutCapabilities.canPost: Boolean get() = postGranted && appEnabled && channelEnabled
