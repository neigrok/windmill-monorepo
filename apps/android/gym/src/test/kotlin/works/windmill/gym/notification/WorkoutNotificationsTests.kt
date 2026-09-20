package works.windmill.gym.notification

import android.Manifest
import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAlarmManager
import org.robolectric.shadows.ShadowNotificationManager
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.LogSetOffer
import works.windmill.gym.domain.RestAlertCommand
import works.windmill.gym.domain.WorkoutChange
import works.windmill.gym.domain.WorkoutClock
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutMoment
import works.windmill.gym.domain.WorkoutNotification
import works.windmill.gym.domain.WorkoutRest
import works.windmill.gym.store.WorkoutCommands

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [WorkoutNotificationsTests.Posts::class])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WorkoutNotificationsTests {
    @After fun resetDispatcher() = Dispatchers.resetMain()

    @Test
    @Config(sdk = [26, 30, 31, 34, 35])
    fun stockFactsAndOpaqueActionsKeepTheSameWorkoutOnEverySupportedApi() = runTest {
        val f = Fixture(this)
        val job = f.adapter.start()
        assertSame(job, f.adapter.start())
        assertNull(f.adapter.capabilities.value)
        runCurrent()
        val card = f.card()
        assertEquals("Push A", card.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Overhead Press · 30 kg × 8 · Set 1 of 3", card.extras.getString(Notification.EXTRA_TEXT))
        assertEquals("Overhead Press · 30 kg × 8\nSet 1 of 3\nRest target · 90s", card.extras.getString(Notification.EXTRA_BIG_TEXT))
        assertFalse(card.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
        assertFalse(card.extras.getBoolean(Notification.EXTRA_SHOW_WHEN))
        assertTrue(card.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertTrue(card.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        assertEquals(0, card.flags and Notification.FLAG_GROUP_SUMMARY)
        assertEquals("silent", card.group)
        assertNull(card.contentView)
        assertNull(card.bigContentView)
        assertEquals(0, card.extras.getInt(Notification.EXTRA_PROGRESS_MAX))
        assertEquals(listOf("Log set"), card.actions.map { it.title.toString() })
        val content = shadowOf(card.contentIntent)
        val log = shadowOf(card.actions.single().actionIntent)
        val hide = shadowOf(card.deleteIntent)
        assertTrue(content.isActivity)
        assertTrue(log.isActivity)
        assertFalse(log.isBroadcast)
        assertTrue(hide.isBroadcast)
        for (intent in listOf(content, log, hide)) {
            assertEquals(PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT, intent.flags)
            assertEquals(0, intent.requestCode)
            assertTrue(intent.isImmutable)
            assertNull(intent.savedIntent.extras)
        }
        assertEquals(3, setOf(content.savedIntent.data, log.savedIntent.data, hide.savedIntent.data).size)
        assertEquals(WorkoutRoute.Open(f.key), f.adapter.route(content.savedIntent))
        assertEquals(WorkoutRoute.Log(LogSetCommand(f.key, "offer/α 1")), f.adapter.route(log.savedIntent))
        assertEquals(listOf("log", "seat/α", "session 1", "offer/α 1"), log.savedIntent.data!!.pathSegments)
        if (Build.VERSION.SDK_INT >= 31) assertTrue(card.actions.single().isAuthenticationRequired)
        assertEquals(listOf(true), f.posts.mainThread)
        assertEquals(WorkoutCapabilities(true, true, true, true, true, null, null, null), f.adapter.capabilities.value)
    }

    @Test fun aRestUsesItsOriginalElapsedAnchorAndClockChangesOnlyRebuildTheWallAnchor() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        assertEquals(997_000L, f.card().`when`)
        assertTrue(f.card().extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
        assertFalse(f.card().extras.getBoolean(Notification.EXTRA_CHRONOMETER_COUNT_DOWN))
        assertEquals("Overhead Press · 30 kg × 8\nSet 1 of 3\nRest elapsed\nRest target · 90s", f.card().extras.getString(Notification.EXTRA_BIG_TEXT))
        val before = f.card()
        f.now = f.now.copy(wallMs = f.now.wallMs + 60_000, elapsedMs = f.now.elapsedMs + 60_000)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertSame(before, f.card())
        assertEquals(1, f.posts.cards.size)
        f.now = f.now.copy(wallMs = f.now.wallMs - 3_600_000)
        f.adapter.receive(Intent(Intent.ACTION_TIME_CHANGED))
        assertEquals(997_000L - 3_600_000, f.card().`when`)
        assertEquals(2, f.posts.cards.size)
        assertEquals(100_000L, shadowOf(f.alarms).scheduledAlarms.single().triggerAtTime)
    }

    @Test
    @Config(sdk = [26, 30, 31, 34, 35])
    fun logActionLaunchesTheActivityWithItsExactOfferAndNeverRunsAsAReceiver() = runTest {
        val f = Fixture(this)
        f.start()
        shadowOf(f.keyguard).setIsDeviceLocked(true)
        val action = f.card().actions.single().actionIntent
        action.send()
        val launch = shadowOf(f.context).nextStartedActivity
        assertEquals(f.activity, launch.component)
        assertEquals("works.windmill.gym.workout.LOG_SET", launch.action)
        assertEquals(listOf("log", "seat/α", "session 1", "offer/α 1"), launch.data!!.pathSegments)
        assertNull(launch.extras)
        assertEquals(WorkoutRoute.Log(LogSetCommand(f.key, "offer/α 1")), f.adapter.route(launch))
        val restores = f.commands.restores
        f.adapter.receive(launch)
        shadowOf(f.keyguard).setIsDeviceLocked(false)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertEquals(restores + 1, f.commands.restores)
        assertEquals(emptyList<LogSetCommand>(), f.commands.logs)
        assertEquals(emptyList<String>(), f.commands.accepted)
        assertEquals("offer/α 1", f.commands.notification.value!!.offer!!.id)
    }

    @Test fun lockedAndRepeatedLegacyBroadcastsNeverSubstituteTheNextRackValues() = runTest {
        val f = Fixture(this)
        f.start()
        val old = Intent(shadowOf(f.card().actions.single().actionIntent).savedIntent)
            .setComponent(ComponentName(f.context, WorkoutNotificationReceiver::class.java))
        assertNull(f.adapter.route(old))
        shadowOf(f.keyguard).setIsDeviceLocked(true)
        f.adapter.receive(old)
        assertEquals(emptyList<LogSetCommand>(), f.commands.logs)
        assertEquals(emptyList<String>(), f.commands.accepted)
        shadowOf(f.keyguard).setIsDeviceLocked(false)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertEquals(emptyList<LogSetCommand>(), f.commands.logs)
        f.adapter.receive(old)
        f.adapter.receive(old)
        assertEquals(listOf(LogSetCommand(f.key, "offer/α 1"), LogSetCommand(f.key, "offer/α 1")), f.commands.logs)
        assertEquals(listOf("offer/α 1"), f.commands.accepted)
        assertEquals("Open workout", f.card().actions.single().title)
        assertTrue(f.posts.cards.all { it.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
    }

    @Test fun malformedAndConflictingCommandsHaveNoLocalEffectOrInventedRoute() = runTest {
        val f = Fixture(this)
        f.start()
        val valid = shadowOf(f.card().actions.single().actionIntent).savedIntent
        val invalid = listOf(
            Intent(valid).setAction("works.windmill.gym.workout.UNKNOWN"),
            Intent(valid).setComponent(ComponentName(f.context.packageName, "some.OtherActivity")),
            Intent(valid).putExtra("offerId", "some other offer"),
            Intent(valid).setData(Uri.parse("windmill-workout://internal/log/seat/session/")),
            Intent(valid).setData(Uri.parse("windmill-workout://elsewhere/log/seat/session/offer")),
            Intent(valid).setData(Uri.parse("windmill-workout://internal/log/seat/session/offer?weight=100")),
            Intent(valid).setData(Uri.parse("windmill-workout://internal/log/seat/session/offer#extra")),
            Intent(valid).setData(Uri.parse("windmill-workout://internal/log/%20/session/offer")),
            Intent(valid).setData(Uri.parse("windmill-workout://internal/log/seat//session/offer")),
        )
        val restores = f.commands.restores
        for (intent in invalid) {
            assertNull(f.adapter.route(intent))
            f.adapter.receive(intent)
        }
        assertEquals(restores, f.commands.restores)
        assertEquals(emptyList<LogSetCommand>(), f.commands.logs)
        assertEquals(1, f.posts.cards.size)
    }

    @Test fun hidePersistsAndReentryCannotShowOrScheduleItUntilExplicitShow() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val hide = shadowOf(f.card().deleteIntent).savedIntent
        assertEquals(1, shadowOf(f.alarms).scheduledAlarms.size)
        f.adapter.receive(hide)
        assertTrue(f.commands.notification.value!!.hidden)
        assertNull(f.posts.getNotification("gym_workout", 1))
        assertEquals(emptyList<Any>(), shadowOf(f.alarms).scheduledAlarms)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertNull(f.posts.getNotification("gym_workout", 1))
        assertEquals(1, f.posts.cards.size)
        f.commands.setHidden(f.key, false)
        runCurrent()
        assertEquals("Push A", f.card().extras.getString(Notification.EXTRA_TITLE))
        assertEquals(1, shadowOf(f.alarms).scheduledAlarms.size)
    }

    @Test fun permissionChannelAndAlarmGatesPreserveOrdinaryFallbackWithoutFakePromotion() = runTest {
        val f = Fixture(this)
        f.rest()
        shadowOf(f.context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        f.start()
        assertFalse(f.adapter.capabilities.value!!.postGranted)
        assertEquals(0, f.posts.cards.size)
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
        shadowOf(f.context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        ShadowAlarmManager.setCanScheduleExactAlarms(false)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertEquals("Push A", f.card().extras.getString(Notification.EXTRA_TITLE))
        assertFalse(f.adapter.capabilities.value!!.exactAlarms)
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
        val channel = f.manager.getNotificationChannel("gym_workout")
        channel.setSound(null, null)
        f.manager.createNotificationChannel(channel)
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertFalse(f.adapter.capabilities.value!!.channelAudible)
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
        f.posts.setNotificationsEnabled(false)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertFalse(f.adapter.capabilities.value!!.appEnabled)
        assertNull(f.posts.getNotification("gym_workout", 1))
        assertNull(f.adapter.capabilities.value!!.promoted)
        assertEquals(emptyList<String>(), f.commands.accepted)
    }

    @Test fun oneElapsedExactAlarmReplacesTargetsAndNeverRearmsAnOverdueRest() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val first = shadowOf(f.alarms).scheduledAlarms.single()
        assertEquals(AlarmManager.ELAPSED_REALTIME_WAKEUP, first.type)
        assertEquals(100_000L, first.triggerAtTime)
        assertEquals(0L, first.interval)
        assertEquals(ShadowAlarmManager.WINDOW_EXACT, first.windowLengthMs)
        assertTrue(first.isAllowWhileIdle)
        val oldIntent = shadowOf(first.operation).savedIntent
        val snapshot = f.commands.notification.value!!
        f.commands.notification.value = snapshot.copy(rest = snapshot.rest!!.copy(targetSeconds = 120, alertRevision = 2))
        runCurrent()
        val next = shadowOf(f.alarms).scheduledAlarms.single()
        assertEquals(130_000L, next.triggerAtTime)
        assertNotEquals(first.operation, next.operation)
        f.now = f.now.copy(elapsedMs = 150_000)
        f.adapter.receive(oldIntent)
        assertEquals(0, f.commands.claimed)
        f.commands.notification.value = f.commands.notification.value!!.copy(restAlerts = false)
        runCurrent()
        f.commands.notification.value = f.commands.notification.value!!.copy(restAlerts = true)
        runCurrent()
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
        assertTrue(f.posts.cards.all { it.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
    }

    @Test fun aDurablyClaimedRestPostsOnceAndItsAttemptDoesNotImmediatelySilenceIt() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val due = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        f.now = f.now.copy(elapsedMs = 100_000, wallMs = 1_087_000)
        f.adapter.receive(due)
        runCurrent()
        assertEquals(1, f.commands.claimed)
        assertTrue(f.commands.notification.value!!.rest!!.attempted)
        assertEquals(listOf(true, false), f.posts.cards.map { it.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
        assertNull(f.card().group)
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
        f.adapter.receive(due)
        runCurrent()
        assertEquals(1, f.commands.claimed)
        assertEquals(2, f.posts.cards.size)
        f.commands.notification.value = f.commands.notification.value!!.copy(counter = "Set 2 of 3")
        runCurrent()
        assertEquals(listOf(true, false, true), f.posts.cards.map { it.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
        assertTrue(f.posts.mainThread.all { it })
    }

    @Test fun capabilityLossOrSupersededEventAfterClaimDropsTheEffect() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val due = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        f.now = f.now.copy(elapsedMs = 100_000)
        val hold = CompletableDeferred<Unit>()
        f.commands.afterClaim = { hold.await() }
        val delivery = launch { f.adapter.receive(due) }
        runCurrent()
        assertEquals(1, f.commands.claimed)
        val other = f.commands.notification.value!!.copy(key = WorkoutKey("other owner", "other session"), title = "Pull B", rest = null, offer = null)
        f.commands.notification.value = other
        runCurrent()
        hold.complete(Unit)
        delivery.join()
        assertEquals("Pull B", f.card().extras.getString(Notification.EXTRA_TITLE))
        assertTrue(f.posts.cards.all { it.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
    }

    @Test fun permissionLossDuringDurableClaimNeverRequestsSound() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val due = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        f.now = f.now.copy(elapsedMs = 100_000)
        f.commands.afterClaim = { ShadowAlarmManager.setCanScheduleExactAlarms(false) }
        f.adapter.receive(due)
        runCurrent()
        assertEquals(1, f.commands.claimed)
        assertEquals(1, f.posts.cards.size)
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
    }

    @Test fun observedAccessLossRevokesTheOldCallbackEvenAfterAccessReturns() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val old = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        ShadowAlarmManager.setCanScheduleExactAlarms(false)
        f.adapter.refreshCapabilities()
        runCurrent()
        assertEquals(2L, f.commands.notification.value!!.rest!!.alertRevision)
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        f.adapter.refreshCapabilities()
        runCurrent()
        val current = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        assertEquals(listOf("rest", "seat/α", "session 1", "rest 1", "2"), current.data!!.pathSegments)
        assertNotEquals(old.data, current.data)
        f.now = f.now.copy(elapsedMs = 100_000)
        f.adapter.receive(old)
        assertEquals(0, f.commands.claimed)
        assertTrue(f.posts.cards.all { it.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
        f.adapter.receive(current)
        assertEquals(1, f.commands.claimed)
        assertEquals(listOf(true, false), f.posts.cards.map { it.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 })
    }

    @Test fun cancellationAfterDurableClaimFinishesTheReceiverWithoutRetryingTheLostEffect() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val due = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        f.now = f.now.copy(elapsedMs = 100_000)
        val hold = CompletableDeferred<Unit>()
        f.commands.afterClaim = { hold.await() }
        val owner = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        var completions = 0
        f.newAdapter(owner).dispatch(due) { completions++ }
        runCurrent()
        assertTrue(f.commands.notification.value!!.rest!!.attempted)
        owner.cancel()
        runCurrent()
        assertEquals(1, completions)
        assertEquals(1, f.commands.claimed)
        assertEquals(1, f.posts.cards.size)
        f.adapter.receive(due)
        assertEquals(1, f.commands.claimed)
        assertEquals(1, f.posts.cards.size)
        assertTrue(shadowOf(f.alarms).scheduledAlarms.isEmpty())
    }

    @Test fun coldDueDeliveryUsesTheSamePortButOrdinaryStartupDoesNotCatchUp() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val due = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        f.adapter.start().cancel()
        f.now = f.now.copy(elapsedMs = 110_000)
        val cold = f.newAdapter(backgroundScope)
        cold.start()
        runCurrent()
        assertEquals(0, f.commands.claimed)
        cold.receive(due)
        runCurrent()
        assertEquals(1, f.commands.claimed)
        assertFalse(f.card().flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        assertEquals(0, f.commands.logs.size)
    }

    @Test fun aColdClosedWorkoutRejectsTheOldAlarmWithoutAPostOrWrite() = runTest {
        val f = Fixture(this)
        f.rest()
        f.start()
        val due = shadowOf(shadowOf(f.alarms).scheduledAlarms.single().operation).savedIntent
        f.adapter.start().cancel()
        f.commands.notification.value = null
        val cold = f.newAdapter(backgroundScope)
        cold.receive(due)
        assertEquals(1, f.posts.cards.size)
        assertNull(f.posts.getNotification("gym_workout", 1))
        assertEquals(0, f.commands.claimed)
        assertEquals(emptyList<String>(), f.commands.accepted)
    }

    @Test fun dispatchCompletesExactlyOnceForInvalidFailedAndAlreadyCancelledWork() = runTest {
        val f = Fixture(this)
        var completions = 0
        f.adapter.dispatch(Intent("unknown")) { completions++ }
        runCurrent()
        assertEquals(1, completions)
        f.start()
        val action = Intent(shadowOf(f.card().actions.single().actionIntent).savedIntent)
            .setComponent(ComponentName(f.context, WorkoutNotificationReceiver::class.java))
        f.commands.beforeRestore = { throw IOException("local authority unreadable") }
        f.adapter.dispatch(action) { completions++ }
        runCurrent()
        assertEquals(2, completions)
        val stopped = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        stopped.cancel()
        f.newAdapter(stopped).dispatch(action) { completions++ }
        runCurrent()
        assertEquals(3, completions)
        assertEquals(emptyList<String>(), f.commands.accepted)
    }

    @Test fun dispatchCancellationDuringLocalRestoreCompletesWithoutLogging() = runTest {
        val f = Fixture(this)
        f.start()
        val action = Intent(shadowOf(f.card().actions.single().actionIntent).savedIntent)
            .setComponent(ComponentName(f.context, WorkoutNotificationReceiver::class.java))
        val hold = CompletableDeferred<Unit>()
        f.commands.beforeRestore = { hold.await() }
        val owner = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        var completions = 0
        f.newAdapter(owner).dispatch(action) { completions++ }
        runCurrent()
        owner.cancel()
        runCurrent()
        assertEquals(1, completions)
        assertEquals(emptyList<String>(), f.commands.accepted)
    }

    @Test fun settingsIntentsBelongToThisPackageAndClockUsesElapsedAndBootIdentity() = runTest {
        val f = Fixture(this)
        assertEquals(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS, f.adapter.notificationSettings().action)
        assertEquals(f.context.packageName, f.adapter.notificationSettings().getStringExtra(Settings.EXTRA_APP_PACKAGE))
        assertEquals("gym_workout", f.adapter.notificationSettings().getStringExtra(Settings.EXTRA_CHANNEL_ID))
        assertEquals(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, f.adapter.alarmSettings().action)
        assertEquals("package:${f.context.packageName}", f.adapter.alarmSettings().dataString)
        Settings.Global.putInt(f.context.contentResolver, Settings.Global.BOOT_COUNT, 7)
        val clock = AndroidWorkoutClock(f.context)
        val first = clock.now()
        SystemClock.sleep(1_000)
        val next = clock.now()
        assertEquals("boot:7", first.bootId)
        assertEquals(first.bootId, next.bootId)
        assertEquals(1_000L, next.elapsedMs - first.elapsedMs)
        Settings.Global.putInt(f.context.contentResolver, Settings.Global.BOOT_COUNT, 8)
        assertEquals("boot:8", clock.now().bootId)
    }

    private class Fixture(val test: TestScope) {
        val context = RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(NotificationManager::class.java)
        val alarms = context.getSystemService(AlarmManager::class.java)
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        val activity = ComponentName(context.packageName, "works.windmill.MainActivity")
        val posts = Shadow.extract<Posts>(manager)
        val key = WorkoutKey("seat/α", "session 1")
        var now = WorkoutMoment(1_000_000, 13_000, "boot:7")
        val commands = Commands(
            WorkoutNotification(key, "Push A", "Overhead Press", "30 kg × 8", "Set 1 of 3", "Rest target · 90s", null,
                LogSetOffer(key, "offer/α 1", 4, "overhead-press", 1, 30.0, 8), false, true),
        ) { now }
        val adapter: WorkoutNotifications

        init {
            Dispatchers.setMain(StandardTestDispatcher(test.testScheduler))
            shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
            ShadowAlarmManager.setCanScheduleExactAlarms(true)
            ShadowAlarmManager.setAutoSchedule(false)
            adapter = newAdapter(test.backgroundScope)
        }

        fun newAdapter(scope: CoroutineScope) = WorkoutNotifications(context, commands, scope, WorkoutClock { now }, activity, manager, alarms, keyguard)
        fun start() { adapter.start(); test.runCurrent() }
        fun card(): Notification = posts.getNotification("gym_workout", 1)!!
        fun rest() {
            commands.notification.value = commands.notification.value!!.copy(
                rest = WorkoutRest("rest 1", WorkoutMoment(997_000, 10_000, "boot:7"), 90, 1, false),
            )
        }
    }

    private class Commands(initial: WorkoutNotification, val now: () -> WorkoutMoment) : WorkoutCommands {
        override val notification = MutableStateFlow<WorkoutNotification?>(initial)
        val logs = mutableListOf<LogSetCommand>()
        val accepted = mutableListOf<String>()
        var restores = 0
        var claimed = 0
        var beforeRestore: suspend () -> Unit = {}
        var afterClaim: suspend () -> Unit = {}
        private var alertAccess: Boolean? = null
        override suspend fun restoreLocal() { restores++; beforeRestore() }
        override suspend fun logSet(command: LogSetCommand): LogSetAcceptance {
            logs += command
            val current = notification.value ?: return LogSetAcceptance.Stale
            if (current.key != command.key || current.offer?.id != command.offerId) return LogSetAcceptance.Stale
            accepted += command.offerId
            notification.value = current.copy(offer = null)
            return LogSetAcceptance.Accepted(command.offerId)
        }
        override suspend fun setHidden(key: WorkoutKey, hidden: Boolean): WorkoutChange {
            val current = notification.value ?: return WorkoutChange.Stale
            if (current.key != key) return WorkoutChange.Stale
            notification.value = current.copy(hidden = hidden, rest = current.rest?.let {
                if (current.hidden != hidden) it.copy(alertRevision = it.alertRevision + 1) else it
            })
            return WorkoutChange.Saved
        }
        override suspend fun openWorkout(key: WorkoutKey) = notification.value?.key == key
        override suspend fun setAlertAccess(key: WorkoutKey, available: Boolean): WorkoutChange {
            val current = notification.value ?: return WorkoutChange.Stale
            if (current.key != key) return WorkoutChange.Stale
            if (!available && alertAccess != false) {
                notification.value = current.copy(rest = current.rest?.let { it.copy(alertRevision = it.alertRevision + 1) })
            }
            alertAccess = available
            return WorkoutChange.Saved
        }
        override suspend fun claimRest(command: RestAlertCommand): Boolean {
            val current = notification.value ?: return false
            val rest = current.rest ?: return false
            val target = rest.targetSeconds ?: return false
            if (current.key != command.key || rest.id != command.eventId || rest.alertRevision != command.alertRevision ||
                current.hidden || !current.restAlerts || rest.attempted || target <= 0 || rest.origin.bootId != now().bootId ||
                now().elapsedMs < rest.origin.elapsedMs + target * 1_000L
            ) return false
            notification.value = current.copy(rest = rest.copy(attempted = true))
            claimed++
            afterClaim()
            return true
        }
    }

    @Implements(NotificationManager::class)
    class Posts : ShadowNotificationManager() {
        val cards = mutableListOf<Notification>()
        val mainThread = mutableListOf<Boolean>()
        @Implementation
        public override fun notify(tag: String?, id: Int, notification: Notification) {
            cards += notification
            mainThread += Looper.myLooper() == Looper.getMainLooper()
            super.notify(tag, id, notification)
        }
    }
}
