package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
import org.junit.Assert.assertTrue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.CoroutineContext

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerNavigationTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val temporary = TemporaryFolder()

    @Test
    @Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
    fun aSingleLongMovementAndItsNativeRackStayReachableAtDoubleText() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(temporary.newFolder(), scope)
        val name = "Standing Alternating Incline Dumbbell Press"
        try {
            runBlocking {
                room.select(null)
                val exercise = (room.store.create(name, "dumbbell") as GymResult.Ok).value
                val routine = (room.store.saveRoutine(RoutineDraft(name = "Single").adding(exercise.id)) as GymResult.Ok).value
                room.store.start(routine.id)
                room.store.choose(exercise.id)
            }
            compose.setContent {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                    LoggerScreen(room.store, {}, {})
                }
            }
            val head = compose.onNode(hasText(name) and hasClickAction())
            head.assertIsDisplayed()
            assertTrue(head.getBoundsInRoot().height >= 48.dp)
            compose.onNodeWithText("Exercise 1 / 1").assertDoesNotExist()
            compose.onNodeWithText("Add movement").assertDoesNotExist()
            compose.onNodeWithText("Set 1").performScrollTo().assertIsDisplayed()
            assertTrue(compose.onNodeWithTag("Set ledger").getBoundsInRoot().height <= 144.dp)
            compose.onNode(hasContentDescription("Load, kg each")).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Log set").assertIsDisplayed().assertIsEnabled()
        } finally { scope.cancel(); room.close() }
    }

    @Test
    fun anOldAccountsDelayedChoiceCannotClearOrReportTheNewAccountsChoice() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pending = ConcurrentLinkedQueue<Runnable>()
        var hold = false
        val reads = object : CoroutineDispatcher() {
            override fun isDispatchNeeded(context: CoroutineContext): Boolean = hold
            override fun dispatch(context: CoroutineContext, block: Runnable) { pending.add(block) }
        }
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        val room = EngineRoomFixture(temporary.newFolder(), scope, readDispatcher = reads)
        try {
            runBlocking {
                room.select("first")
                room.pull(EngineRoomFixture.server())
                val routine = (room.store.saveRoutine(RoutineDraft(name = "First")
                    .adding("bench-press").adding("barbell-row")) as GymResult.Ok).value
                room.store.start(routine.id)
                room.store.choose("bench-press")
            }
            compose.setContent {
                CompositionLocalProvider(LocalTelemetry provides telemetry) {
                    LoggerScreen(room.store, {}, {})
                }
            }
            val firstNext = compose.onNode(hasContentDescription("Exercise 1 of 2")).fetchSemanticsNode()
                .config[SemanticsActions.CustomActions].single()
            compose.runOnIdle { hold = true; firstNext.action() }
            compose.waitUntil(10_000) { pending.isNotEmpty() }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNodeWithText("Log set").assertIsNotEnabled()
            val oldRead = pending.remove()

            val arrival = compose.runOnIdle {
                hold = false
                scope.async {
                    room.select("second")
                    room.pull(EngineRoomFixture.server())
                    val routine = (room.store.saveRoutine(RoutineDraft(name = "Second")
                        .adding("bench-press").adding("overhead-press")) as GymResult.Ok).value
                    room.store.start(routine.id)
                room.store.choose("bench-press")
                }
            }
            compose.waitUntil(10_000) { compose.runOnIdle { arrival.isCompleted } }
            runBlocking { arrival.await() }
            compose.onNodeWithText("Log set").assertIsEnabled()
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)
            val secondNext = compose.onNode(hasContentDescription("Exercise 1 of 2")).fetchSemanticsNode()
                .config[SemanticsActions.CustomActions].single()
            compose.runOnIdle { hold = true; secondNext.action() }
            compose.waitUntil(10_000) { pending.isNotEmpty() }
            compose.runOnIdle { oldRead.run() }
            compose.onNodeWithText("Log set").assertIsNotEnabled()
            compose.runOnIdle { assertEquals("overhead-press", room.store.exerciseId) }
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)

            compose.runOnIdle { hold = false; while (pending.isNotEmpty()) pending.remove().run() }
            compose.waitUntil(10_000) { compose.runOnIdle { events.isNotEmpty() } }
            compose.onNodeWithText("Log set").assertIsEnabled()
            assertEquals(listOf("gym_action" to mapOf("screen" to "workout", "action" to "movement_switch", "outcome" to "ok")), events)
        } finally {
            hold = false
            scope.cancel()
            while (pending.isNotEmpty()) pending.remove().run()
            room.close()
        }
    }
}
