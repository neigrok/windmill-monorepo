package works.windmill.gym.notification

import android.Manifest
import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
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
import works.windmill.gym.R
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.RestAlertCommand
import works.windmill.gym.domain.WorkoutClock
import works.windmill.gym.domain.WorkoutChange
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutMoment
import works.windmill.gym.domain.WorkoutNotification
import works.windmill.gym.store.WorkoutCommands

interface WorkoutNotificationHost {
    val workoutNotifications: WorkoutNotifications
}

data class WorkoutCapabilities(
    val postGranted: Boolean,
    val appEnabled: Boolean,
    val channelEnabled: Boolean,
    val channelAudible: Boolean,
    val exactAlarms: Boolean,
    val promotionAllowed: Boolean?,
    val promotable: Boolean?,
    val promoted: Boolean?,
)

sealed interface WorkoutRoute {
    data class Open(val key: WorkoutKey) : WorkoutRoute
    data class Log(val command: LogSetCommand) : WorkoutRoute
}

class AndroidWorkoutClock(context: Context) : WorkoutClock {
    private val resolver = context.applicationContext.contentResolver

    override fun now(): WorkoutMoment {
        val boot = try {
            "boot:${Settings.Global.getInt(resolver, Settings.Global.BOOT_COUNT)}"
        } catch (_: Exception) {
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
    private val clock: WorkoutClock,
    private val activity: ComponentName,
    private val notificationManager: NotificationManager,
    private val alarmManager: AlarmManager,
    private val keyguardManager: KeyguardManager,
) {
    private val context = context.applicationContext
    private val receiver = ComponentName(this.context, WorkoutNotificationReceiver::class.java)
    private val measured = MutableStateFlow<WorkoutCapabilities?>(null)
    val capabilities: StateFlow<WorkoutCapabilities?> = measured.asStateFlow()
    private var collector: Job? = null
    private var rendered: Card? = null
    private var alarm: RestAlertCommand? = null
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
            } catch (_: Exception) {
                // A receiver cannot turn a refused local operation into another write.
            }
        }.invokeOnCompletion { onComplete() }
    }

    suspend fun receive(intent: Intent) = withContext(Dispatchers.Main.immediate) {
        val systemRefresh = intent.action == Intent.ACTION_TIME_CHANGED ||
            intent.action == AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED
        val command = decode(intent)
        if (command == null && !systemRefresh) return@withContext
        if (command != null && intent.component != receiver) return@withContext
        commands.restoreLocal()
        restored = true
        createChannel()
        if (systemRefresh) {
            reconcile(clockChanged = intent.action == Intent.ACTION_TIME_CHANGED)
            return@withContext
        }
        when (command) {
            is Command.Log -> {
                if (!keyguardManager.isDeviceLocked) commands.logSet(command.value)
            }
            is Command.Hide -> commands.setHidden(command.key, true)
            is Command.Rest -> {
                if (alertAccess() && commands.claimRest(command.value)) {
                    val current = commands.notification.value
                    val after = measure()
                    if (current != null && current.key == command.value.key &&
                        current.rest?.id == command.value.eventId && current.rest.alertRevision == command.value.alertRevision &&
                        !current.hidden && current.restAlerts && after.canAlert
                    ) {
                        val card = card(current, clock.now())
                        post(card, audible = true)
                    }
                }
            }
            else -> Unit
        }
        reconcile()
    }

    fun notificationSettings(): Intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL)

    fun alarmSettings(): Intent = if (Build.VERSION.SDK_INT >= 31) {
        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
            .setData(Uri.fromParts("package", context.packageName, null))
    } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", context.packageName, null))
    }

    private fun createChannel() {
        if (channelReady) return
        notificationManager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Workout", NotificationManager.IMPORTANCE_DEFAULT).apply {
                setSound(
                    Settings.System.DEFAULT_NOTIFICATION_URI,
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                )
                enableVibration(false)
            },
        )
        channelReady = true
    }

    private fun measure(candidate: Notification? = null): WorkoutCapabilities {
        val channel = notificationManager.getNotificationChannel(CHANNEL)
        val active = if (Build.VERSION.SDK_INT >= 36) runCatching {
            notificationManager.activeNotifications.firstOrNull { it.tag == CHANNEL && it.id == ID }
        }.getOrNull() else null
        val result = WorkoutCapabilities(
            postGranted = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED,
            appEnabled = notificationManager.areNotificationsEnabled(),
            channelEnabled = channel != null && channel.importance != NotificationManager.IMPORTANCE_NONE,
            channelAudible = channel != null && channel.importance >= NotificationManager.IMPORTANCE_DEFAULT &&
                channel.sound != null,
            exactAlarms = Build.VERSION.SDK_INT < 31 || runCatching { alarmManager.canScheduleExactAlarms() }.getOrDefault(false),
            promotionAllowed = if (Build.VERSION.SDK_INT >= 36) runCatching {
                notificationManager.canPostPromotedNotifications()
            }.getOrNull() else null,
            promotable = if (Build.VERSION.SDK_INT >= 36) runCatching {
                (candidate ?: active?.notification)?.hasPromotableCharacteristics()
            }.getOrNull() else null,
            promoted = if (Build.VERSION.SDK_INT >= 36) active?.notification?.let {
                it.flags and Notification.FLAG_PROMOTED_ONGOING != 0
            } else null,
        )
        measured.value = result
        return result
    }

    private suspend fun reconcile(clockChanged: Boolean = false) {
        if (!restored) return
        val canAlert = alertAccess()
        val snapshot = commands.notification.value
        val access = measured.value ?: return
        if (snapshot == null || snapshot.hidden || !access.canPost) {
            cancelAlarm(snapshot?.rest?.let { RestAlertCommand(snapshot.key, it.id, it.alertRevision) })
            notificationManager.cancel(CHANNEL, ID)
            rendered = null
            measure()
            return
        }
        val now = clock.now()
        val card = card(snapshot, now, clockChanged)
        if (card != rendered) post(card, audible = false)
        val rest = snapshot.rest
        val target = rest?.targetSeconds
        val command = rest?.let { RestAlertCommand(snapshot.key, it.id, it.alertRevision) }
        val due = if (rest != null && target != null && target > 0) {
            rest.origin.elapsedMs + target.toLong() * 1_000
        } else null
        val eligible = canAlert && snapshot.restAlerts && rest != null && !rest.attempted &&
            rest.origin.bootId == now.bootId && rest.origin.elapsedMs <= now.elapsedMs && due != null
        if (!eligible || command != alarm) cancelAlarm(command.takeIf { !eligible })
        if (!eligible || command == null || due <= now.elapsedMs || alarm == command) return
        try {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, due, pending(Command.Rest(command)))
            alarm = command
        } catch (_: SecurityException) {
            measure()
        }
    }

    private suspend fun alertAccess(): Boolean {
        while (true) {
            val before = measure()
            val key = commands.notification.value?.key ?: return false
            val result = commands.setAlertAccess(key, before.canAlert)
            val after = measure()
            if (commands.notification.value?.key != key || before.canAlert != after.canAlert) continue
            return result == WorkoutChange.Saved && after.canAlert
        }
    }

    private fun cancelAlarm(current: RestAlertCommand? = null) {
        alarm?.let { alarmManager.cancel(pending(Command.Rest(it))) }
        if (current != null && current != alarm) alarmManager.cancel(pending(Command.Rest(current)))
        alarm = null
    }

    private fun card(snapshot: WorkoutNotification, now: WorkoutMoment, clockChanged: Boolean = false): Card {
        val origin = snapshot.rest?.origin?.takeIf { it.bootId == now.bootId && it.elapsedMs <= now.elapsedMs }
        val previous = rendered?.takeIf { it.key == snapshot.key && it.origin == origin }
        val whenMs = if (origin == null) null else if (!clockChanged && previous != null) previous.whenMs else {
            now.wallMs - (now.elapsedMs - origin.elapsedMs)
        }
        return Card(
            snapshot.key, snapshot.title, snapshot.movement, snapshot.rackLine, snapshot.counter,
            snapshot.targetLine, origin, whenMs,
            snapshot.offer?.takeIf { it.key == snapshot.key }?.let { LogSetCommand(it.key, it.id) },
        )
    }

    private fun post(card: Card, audible: Boolean) {
        val details = listOfNotNull(
            "${card.movement} · ${card.rackLine}", card.counter,
            if (card.origin != null) "Rest elapsed" else null, card.targetLine,
        ).joinToString("\n")
        val action = card.offer?.let { Command.Log(it) } ?: Command.Open(card.key)
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.gym_nav_log)
            .setContentTitle(card.title)
            .setContentText("${card.movement} · ${card.rackLine} · ${card.counter}")
            .setStyle(NotificationCompat.BigTextStyle().bigText(details))
            .setOngoing(true)
            .setOnlyAlertOnce(!audible)
            .setSilent(!audible)
            .setRequestPromotedOngoing(true)
            .setContentIntent(pending(Command.Open(card.key)))
            .setDeleteIntent(pending(Command.Hide(card.key)))
            .setShowWhen(card.whenMs != null)
            .setUsesChronometer(card.whenMs != null)
            .setChronometerCountDown(false)
            .addAction(
                NotificationCompat.Action.Builder(0, if (card.offer == null) "Open workout" else "Log set", pending(action))
                    .setAuthenticationRequired(card.offer != null && Build.VERSION.SDK_INT >= 31).build(),
            )
        card.whenMs?.let(builder::setWhen)
        val notification = builder.build()
        val access = measure(notification)
        if (if (audible) !access.canAlert else !access.canPost) return
        try {
            if (rendered?.key != card.key) notificationManager.cancel(CHANNEL, ID)
            notificationManager.notify(CHANNEL, ID, notification)
            rendered = card
        } catch (_: SecurityException) {
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
            "rest" -> if (parts.size == 5) parts[4].toLongOrNull()?.takeIf {
                it >= 0 && it.toString() == parts[4]
            }?.let { Command.Rest(RestAlertCommand(key, parts[3], it)) } else null
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

    private data class Card(
        val key: WorkoutKey,
        val title: String,
        val movement: String,
        val rackLine: String,
        val counter: String,
        val targetLine: String?,
        val origin: WorkoutMoment?,
        val whenMs: Long?,
        val offer: LogSetCommand?,
    )

    private sealed class Command(val action: String, val segments: List<String>) {
        class Open(val key: WorkoutKey) : Command("OPEN", listOf("open", key.ownerKey, key.sessionId))
        class Log(val value: LogSetCommand) : Command("LOG_SET", listOf("log", value.key.ownerKey, value.key.sessionId, value.offerId))
        class Hide(val key: WorkoutKey) : Command("HIDE", listOf("hide", key.ownerKey, key.sessionId))
        class Rest(val value: RestAlertCommand) : Command("REST_DUE", listOf("rest", value.key.ownerKey, value.key.sessionId, value.eventId, value.alertRevision.toString()))
    }

    companion object {
        internal const val CHANNEL = "gym_workout"
        internal const val ID = 1
        internal const val PREFIX = "works.windmill.gym.workout."
    }
}

private val WorkoutCapabilities.canPost: Boolean get() = postGranted && appEnabled && channelEnabled
private val WorkoutCapabilities.canAlert: Boolean get() = canPost && channelAudible && exactAlarms
