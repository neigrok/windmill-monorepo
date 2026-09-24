package works.windmill.gym.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.swipeUp
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerPagerTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun logger(
        scope: CoroutineScope,
        heavier: Boolean = false,
        benchTarget: SetTarget = SetTarget(5, 82.5),
        rowTarget: SetTarget = SetTarget(8, 60.0),
    ): TrainingStore {
        val server = FakeTraining()
        server.catalog = listOf(
            Exercise(id = "bench-press", name = "Bench Press"),
            Exercise(id = "barbell-row", name = "Barbell Row"),
            Exercise(id = "cable-fly", name = "Cable Fly"),
        )
        val day = 1_754_000_000_000L
        server.lastTimes["bench-press"] = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_bench", startedAtMs = day, finishedAtMs = day + 1),
            sets = listOf(TrainingSet(id = "s_bench", exerciseId = "bench-press",
                weightKg = 80.0, reps = 5, completedAtMs = day)),
        )
        server.lastTimes["barbell-row"] = LastTime(
            exerciseId = "barbell-row",
            session = Session(id = "ses_row", startedAtMs = day, finishedAtMs = day + 1),
            sets = listOf(TrainingSet(id = "s_row", exerciseId = "barbell-row",
                weightKg = 55.0, reps = 8, completedAtMs = day)),
        )
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = 0,
            sync = { server },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam"),
            ))
            val routine = (store.saveRoutine(
                RoutineDraft(name = "Push and pull")
                    .adding("bench-press")
                    .adding("barbell-row")
                    .targeting("bench-press", List(8) { benchTarget })
                    .targeting("barbell-row", List(3) { rowTarget })
            ) as GymResult.Ok).value
            server.open(Session(id = "ses_1", startedAtMs = System.currentTimeMillis(),
                routineId = routine.id, plan = PlanSnapshot(routine)))
            store.start(routine.id)
            store.choose("bench-press")
            if (heavier) store.logSet(87.5, 5)
        }
        compose.setContent {
            LoggerScreen(store = store, isSignedIn = true, say = {},
                onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return store
    }

    @Test
    fun aDragPreviewsTheAdjacentMovementAndReversingKeepsTheDraftAndDepartureQuestion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, heavier = true)
        compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
        compose.onNode(hasContentDescription("one rep more")).performClick()
        compose.onNode(hasContentDescription("Weight 90 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()

        val pager = compose.onNodeWithTag("Movement pager")
        val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
            pager.fetchSemanticsNode().boundsInRoot.top
        pager.performTouchInput {
            down(Offset(width * 0.9f, y))
            moveTo(Offset(width * 0.25f, y), delayMillis = 600)
        }

        compose.onNodeWithText("Bench Press").assertIsDisplayed()
        compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        compose.onNode(hasContentDescription("Set 1, current, target 60 kg, 8 reps")).assertIsDisplayed()
        compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()
        compose.onNodeWithText("Log set").assertIsNotEnabled()
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }

        pager.performTouchInput {
            moveTo(Offset(width * 0.9f, y), delayMillis = 600)
            advanceEventTime(200)
            up()
        }
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }
        compose.onNode(hasContentDescription("Weight 90 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()
        compose.onNodeWithText("Log set").assertIsEnabled()
        compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()

        compose.onNodeWithText("Bench Press").performTouchInput {
            swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
        }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }
        compose.onNodeWithText("Heavier than the plan").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun releasingAShortSlowDragReturnsToTheSameMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)
        val pager = compose.onNodeWithTag("Movement pager")
        val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
            pager.fetchSemanticsNode().boundsInRoot.top

        pager.performTouchInput {
            down(Offset(width * 0.7f, y))
            moveTo(Offset(width * 0.5f, y), delayMillis = 600)
            advanceEventTime(200)
            up()
        }

        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }
        compose.onNodeWithText("Bench Press").assertIsDisplayed()
        compose.onNode(hasContentDescription("Exercise 1 of 2")).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun aRackDragPreviewsTheMovementWhileTheRackStaysPinnedAndReversalDoesNotLog() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)
        val log = compose.onNodeWithText("Log set")
        val button = log.fetchSemanticsNode().boundsInRoot
        val weight = compose.onNode(hasContentDescription("Weight 82.5 kg"))
            .fetchSemanticsNode().boundsInRoot

        log.performTouchInput {
            down(Offset(width * 0.9f, centerY))
            moveTo(Offset(width * 0.25f, centerY), delayMillis = 600)
        }
        compose.onNodeWithText("Bench Press").assertIsDisplayed()
        compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        log.assertIsNotEnabled()
        assertEquals(button, log.fetchSemanticsNode().boundsInRoot)
        assertEquals(weight, compose.onNode(hasContentDescription("Weight 82.5 kg"))
            .fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle {
            assertEquals("bench-press", store.exerciseId)
            assertEquals(emptyList<TrainingSet>(), store.sets)
        }

        log.performTouchInput {
            moveTo(Offset(width * 0.9f, centerY), delayMillis = 600)
            advanceEventTime(200)
            up()
        }
        log.assertIsEnabled()
        compose.runOnIdle {
            assertEquals("bench-press", store.exerciseId)
            assertEquals(emptyList<TrainingSet>(), store.sets)
        }
        scope.cancel()
    }

    @Test
    fun aCancelledTouchPastTheMidpointKeepsTheMovementDraftAndDepartureQuestion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, heavier = true)
        val sets = store.sets.toList()
        compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
        val pager = compose.onNodeWithTag("Movement pager")
        val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
            pager.fetchSemanticsNode().boundsInRoot.top
        pager.performTouchInput {
            down(Offset(width * 0.9f, y))
            moveTo(Offset(width * 0.25f, y), delayMillis = 600)
        }
        compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }

        pager.performTouchInput { cancel() }
        compose.runOnIdle {
            assertEquals("bench-press", store.exerciseId)
            assertEquals(sets, store.sets)
        }
        compose.onNodeWithText("Bench Press").assertIsDisplayed()
        compose.onNode(hasContentDescription("Weight 90 kg")).assertIsDisplayed()
        compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()
        compose.onNodeWithText("Log set").assertIsEnabled()
        scope.cancel()
    }

    @Test
    fun equalPrefillsKeepTheDraftOnReversalAndResetItWhenTheOtherMovementSettles() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, benchTarget = SetTarget(5, 20.0), rowTarget = SetTarget(5, 20.0))
        compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
        compose.onNode(hasContentDescription("one rep more")).performClick()
        compose.onNode(hasContentDescription("Weight 22.5 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()

        val pager = compose.onNodeWithTag("Movement pager")
        val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
            pager.fetchSemanticsNode().boundsInRoot.top
        pager.performTouchInput {
            down(Offset(width * 0.9f, y))
            moveTo(Offset(width * 0.25f, y), delayMillis = 600)
        }
        compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }
        pager.performTouchInput {
            moveTo(Offset(width * 0.9f, y), delayMillis = 600)
            advanceEventTime(200)
            up()
        }
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }
        compose.onNode(hasContentDescription("Weight 22.5 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()

        compose.onNodeWithText("Bench Press").performTouchInput {
            swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
        }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }
        compose.onNode(hasContentDescription("Weight 20 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun aSettledPageUpdatesTheRackAndTheReturnSwipeUsesTheSameOrder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)

        compose.onNodeWithText("Bench Press").performTouchInput {
            swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
        }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }
        compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        compose.onNode(hasContentDescription("Set 1, current, target 60 kg, 8 reps")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Weight 60 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 8")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Exercise 2 of 2")).assertIsDisplayed()

        compose.onNodeWithText("Barbell Row").performTouchInput {
            swipeRight(startX = width * 0.1f, endX = width * 0.9f)
        }
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }
        compose.onNode(hasContentDescription("Weight 82.5 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed()
        scope.cancel()
    }

    // Only the ledger scrolls: a vertical stroke on it reads the sets and leaves the head where it
    // stood, and a horizontal stroke on the same rows still walks to the next movement.
    @Test
    fun aVerticalStrokeScrollsOnlyTheLedgerAndAHorizontalOneWalks() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)
        val ledger = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
        val head = compose.onNodeWithText("Bench Press").assertIsDisplayed().getBoundsInRoot()
        val initial = ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        assertTrue("the ledger overflows",
            ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0f)

        ledger.performTouchInput { swipeUp() }
        val after = ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        assertTrue("vertical drag scrolls the ledger", after > initial)
        assertEquals("and the head stays pinned", head, compose.onNodeWithText("Bench Press").getBoundsInRoot())
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }

        ledger.performTouchInput { swipeDown() }
        assertTrue("the return drag scrolls back through the same movement",
            ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() < after)
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }

        ledger.performTouchInput { swipeLeft(startX = width * 0.9f, endX = width * 0.1f) }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }
        scope.cancel()
    }

    @Test
    fun anAssemblyJumpAndANewMovementLeaveThePagerSynchronized() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)

        compose.onNodeWithText("Bench Press").performClick()
        compose.onAllNodes(hasText("Barbell Row") and hasClickAction()).onFirst().performClick()
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }
        compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        compose.onNodeWithText("Barbell Row").performTouchInput {
            swipeRight(startX = width * 0.1f, endX = width * 0.9f)
        }
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }

        compose.onNodeWithText("Add movement").performScrollTo().performClick()
        compose.onNodeWithText("Cable Fly").performClick()
        compose.runOnIdle { assertEquals("cable-fly", store.exerciseId) }
        compose.onNode(hasContentDescription("Exercise 3 of 3")).assertIsDisplayed()
        compose.onNodeWithText("Cable Fly").performTouchInput {
            swipeRight(startX = width * 0.1f, endX = width * 0.9f)
        }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }
        compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        scope.cancel()
    }
}
