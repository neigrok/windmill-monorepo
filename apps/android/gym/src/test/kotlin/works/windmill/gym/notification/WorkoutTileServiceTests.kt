package works.windmill.gym.notification

import android.app.Application
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowService
import org.robolectric.util.ReflectionHelpers
import works.windmill.gym.R
import works.windmill.gym.presentation.LogSetAcceptance
import works.windmill.gym.presentation.LogSetCommand
import works.windmill.gym.presentation.WorkoutChange
import works.windmill.gym.presentation.WorkoutKey
import works.windmill.gym.presentation.WorkoutNotification
import works.windmill.gym.store.WorkoutCommands
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = WorkoutTileServiceTests.App::class, shadows = [WorkoutTileServiceTests.SystemTiles::class])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WorkoutTileServiceTests {
    @After fun resetDispatcher() = Dispatchers.resetMain()

    @Test
    @Config(sdk = [26, 29, 34, 35])
    fun visibleTileFollowsTheSameSnapshotAndStopsItsClockWhenListeningEnds() = runTest {
        val f = Fixture(this)
        try {
            f.service.onStartListening()
            runCurrent()
            val tile = f.service.qsTile
            assertEquals("Workout", tile.label)
            assertEquals(Tile.STATE_INACTIVE, tile.state)
            assertEquals("Workout, Off", tile.contentDescription)
            assertEquals(R.drawable.gym_workout_notification, shadowOf(tile.icon).resId)
            if (Build.VERSION.SDK_INT >= 29) assertEquals("Off", tile.subtitle)

            f.commands.notification.value = f.workout
            runCurrent()
            assertEquals(Tile.STATE_ACTIVE, tile.state)
            assertEquals("Workout, Push A · 2:11", tile.contentDescription)
            if (Build.VERSION.SDK_INT >= 29) assertEquals("Push A · 2:11", tile.subtitle)
            f.now += 1_000
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals("Workout, Push A · 2:12", tile.contentDescription)
            f.commands.notification.value = f.workout.copy(sinceSetAtMs = f.now, hidden = true)
            runCurrent()
            assertEquals("Workout, Push A · 0:00", tile.contentDescription)

            f.service.onStopListening()
            f.now += 60_000
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals("Workout, Push A · 0:00", tile.contentDescription)
            f.service.onStartListening()
            runCurrent()
            assertEquals("Workout, Push A · 1:00", tile.contentDescription)
            f.commands.notification.value = null
            runCurrent()
            assertEquals(Tile.STATE_INACTIVE, tile.state)
            assertEquals("Workout, Off", tile.contentDescription)
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), f.events)
            assertEquals(emptyList<String>(), f.failures)
        } finally { f.service.onDestroy() }
    }

    @Test
    @Config(sdk = [26, 33, 34, 35])
    fun inactiveAndActiveClicksUseExplicitRoutesAndEmitOnlyAfterTheRootHandlesThem() = runTest {
        val f = Fixture(this)
        try {
            f.service.onClick()
            runCurrent()
            val inactive = shadowOf(f.app).nextStartedActivity
            assertEquals(f.activity, inactive.component)
            assertEquals("windmill-workout-tile://route/routines", inactive.dataString)
            assertEquals(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP, inactive.flags)
            assertNull(inactive.extras)
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), f.events)
            assertEquals(Build.VERSION.SDK_INT >= 34, f.system.usedPendingIntent)
            if (Build.VERSION.SDK_INT >= 34) assertEquals(PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE, f.system.pendingFlags)
            f.adapter.open(inactive)
            assertEquals(1, f.routines)
            assertEquals(emptyList<WorkoutKey>(), f.commands.opened)

            f.commands.notification.value = f.workout
            f.service.onClick()
            runCurrent()
            val active = shadowOf(f.app).nextStartedActivity
            assertEquals(listOf("open", "seat/α", "workout 1"), active.data!!.pathSegments)
            assertNull(active.extras)
            f.adapter.open(active)
            assertEquals(listOf(f.workout.key), f.commands.opened)
            assertEquals(1, f.routines)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "tile", "action" to "routines", "outcome" to "ok"),
                "gym_action" to mapOf("screen" to "tile", "action" to "open", "outcome" to "ok"),
            ), f.events)
            assertEquals(emptyList<String>(), f.failures)
        } finally { f.service.onDestroy() }
    }

    @Test
    fun restoredStateChoosesTheRouteAndAChangedAccountCannotOpenTheOldWorkout() = runTest {
        val f = Fixture(this)
        try {
            f.commands.beforeRestore = { f.commands.notification.value = f.workout }
            f.service.onClick()
            runCurrent()
            val intent = shadowOf(f.app).nextStartedActivity
            f.commands.beforeRestore = { f.commands.notification.value = f.workout.copy(key = WorkoutKey("other-seat", "other-workout")) }
            f.adapter.open(intent)
            assertEquals(emptyList<WorkoutKey>(), f.commands.opened)
            assertEquals(0, f.routines)
            assertEquals(listOf("gym_action" to mapOf("screen" to "tile", "action" to "open", "outcome" to "failed")), f.events)
            assertEquals(emptyList<String>(), f.failures)
        } finally { f.service.onDestroy() }
    }

    @Test
    fun aRecreatedServiceReadsTheCurrentWorkoutInsteadOfKeepingItsOldClock() = runTest {
        val f = Fixture(this)
        f.commands.notification.value = f.workout
        f.service.onStartListening()
        runCurrent()
        assertEquals("Workout, Push A · 2:11", f.service.qsTile.contentDescription)
        f.service.onDestroy()
        f.commands.beforeRestore = { f.commands.notification.value = null }
        val fresh = Robolectric.buildService(WorkoutTileService::class.java).create().get()
        try {
            fresh.onStartListening()
            runCurrent()
            assertEquals(Tile.STATE_INACTIVE, fresh.qsTile.state)
            assertEquals("Workout, Off", fresh.qsTile.contentDescription)
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), f.events)
            assertEquals(emptyList<String>(), f.failures)
        } finally { fresh.onDestroy() }
    }

    @Test
    fun technicalLaunchFailuresReportOnceAndCancellationReportsNothing() = runTest {
        val f = Fixture(this)
        try {
            f.commands.notification.value = f.workout
            f.system.refuseLaunch = true
            f.service.onClick()
            runCurrent()
            assertEquals(listOf("gym.tile"), f.failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "tile", "action" to "open", "outcome" to "failed")), f.events)
            assertNull(shadowOf(f.app).nextStartedActivity)
            f.commands.beforeRestore = { throw CancellationException() }
            f.service.onClick()
            runCurrent()
            assertEquals(listOf("gym.tile"), f.failures)
            assertEquals(1, f.events.size)
        } finally { f.service.onDestroy() }
    }

    @Test
    fun anUnavailableExplicitActivityReportsOneFailureInsteadOfSubmittingASilentPendingIntent() = runTest {
        for (missing in listOf(false, true)) {
            val f = Fixture(this)
            try {
                if (missing) shadowOf(f.app.packageManager).removeActivity(f.activity)
                else f.app.packageManager.setComponentEnabledSetting(f.activity,
                    android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    android.content.pm.PackageManager.DONT_KILL_APP)
                f.service.onClick()
                runCurrent()
                assertNull(shadowOf(f.app).nextStartedActivity)
                assertFalse(f.system.usedPendingIntent)
                assertEquals(listOf("gym.tile"), f.failures)
                assertEquals(listOf("gym_action" to mapOf("screen" to "tile", "action" to "routines", "outcome" to "failed")), f.events)
            } finally {
                f.app.packageManager.setComponentEnabledSetting(f.activity,
                    android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DEFAULT,
                    android.content.pm.PackageManager.DONT_KILL_APP)
                f.service.onDestroy()
            }
        }
    }

    @Test
    fun foreignAndMalformedIntentsCannotNavigateOrEmitEvents() = runTest {
        val f = Fixture(this)
        try {
            f.service.onClick()
            runCurrent()
            val original = shadowOf(f.app).nextStartedActivity
            val invalid = listOf(Intent(original).setAction(Intent.ACTION_VIEW),
                Intent(original).setComponent(ComponentName("other", "OtherActivity")),
                Intent(original).setData(android.net.Uri.parse("windmill-workout-tile://route/open/seat")),
                Intent(original).setData(android.net.Uri.parse("windmill-workout-tile://route/routines?content=secret")),
                Intent(original).setData(android.net.Uri.parse("https://route/routines")))
            for (intent in invalid) { assertFalse(f.adapter.handles(intent)); f.adapter.open(intent) }
            assertEquals(0, f.routines)
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), f.events)
            assertEquals(emptyList<String>(), f.failures)
        } finally { f.service.onDestroy() }
    }

    class App : Application(), WorkoutTileHost {
        override lateinit var workoutTile: WorkoutTile
    }

    private class Fixture(test: TestScope) {
        val app = RuntimeEnvironment.getApplication() as App
        val activity = ComponentName(app.packageName, "works.windmill.MainActivity")
        val commands = Commands()
        val workout = WorkoutNotification(WorkoutKey("seat/α", "workout 1"), "Push A", "Bench Press", "30 kg × 8",
            "Set 2 of 3", null, false, 90_000)
        var now = 221_000L
        var routines = 0
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        val adapter = WorkoutTile(commands, activity, { routines++ }, object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }, { now })
        val service: WorkoutTileService
        val system: SystemTiles
        init {
            Dispatchers.setMain(StandardTestDispatcher(test.testScheduler))
            app.workoutTile = adapter
            shadowOf(app.packageManager).addActivityIfNotPresent(activity)
            service = Robolectric.buildService(WorkoutTileService::class.java).create().get()
            system = Shadow.extract(service)
        }
    }

    private class Commands : WorkoutCommands {
        override val notification = MutableStateFlow<WorkoutNotification?>(null)
        val opened = mutableListOf<WorkoutKey>()
        var beforeRestore: suspend () -> Unit = {}
        override suspend fun restoreLocal() = beforeRestore()
        override suspend fun openWorkout(key: WorkoutKey): Boolean {
            if (notification.value?.key != key) return false
            opened += key
            return true
        }
        override suspend fun logSet(command: LogSetCommand): LogSetAcceptance = error("Tile must not log a set")
        override suspend fun setHidden(key: WorkoutKey, hidden: Boolean): WorkoutChange = error("Tile must not hide a workout")
    }

    @Implements(TileService::class)
    class SystemTiles : ShadowService() {
        @RealObject private lateinit var service: TileService
        var usedPendingIntent = false
        var pendingFlags = 0
        var refuseLaunch = false
        private val tile = ReflectionHelpers.callConstructor(Tile::class.java)
        @Implementation
        protected fun getQsTile(): Tile = tile
        @Implementation(minSdk = 34)
        protected fun startActivityAndCollapse(pending: PendingIntent) {
            if (refuseLaunch) throw IllegalStateException("private fixture must not reach telemetry")
            usedPendingIntent = true
            pendingFlags = shadowOf(pending).flags
            pending.send()
        }
        @Implementation(maxSdk = 33)
        protected fun startActivityAndCollapse(intent: Intent) {
            if (refuseLaunch) throw IllegalStateException("private fixture must not reach telemetry")
            service.startActivity(intent)
        }
    }
}
