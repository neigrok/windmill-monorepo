package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.TemporaryFolder
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.RoutineDraft
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

// The walk between movements, on the screen a lifter looks at with a bar in their hands. It took two
// chevron buttons off that screen — and on Android that trade is only safe with the other half of
// Law 1 beside it, so the same two verbs are declared as custom actions on the title.
//
// The dots stay: they are the position readout the swipe needs.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerMovementWalkTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule val tmp = TemporaryFolder()
    private val scopes = mutableListOf<CoroutineScope>()
    @After fun stopStores() { scopes.forEach { it.cancel() } }

    private fun logger(scope: CoroutineScope, threeMovements: Boolean = false, loggedSets: Int = 0): TrainingStore {
        scopes += scope
        val root = tmp.root
        val server = FakeTraining()
        server.catalog = listOf(
            Exercise(id = "bench-press", name = "Bench Press"),
            Exercise(id = "barbell-row", name = "Barbell Row"),
            Exercise(id = "cable-fly", name = "Cable Fly"),
        )
        val store = TrainingStore(
            queue = SetQueue(File(root, "queue.json")),
            deviceCopy = DeviceCopy(File(root, "catalog.json")),
            localLog = LocalLog(File(root, "local.json")),
            localPreferences = LocalPreferences(File(root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = SetQueue.undoWindowMs,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam")))
            store.start(null)
            // The walk is what the session HOLDS, in the order it was walked.
            store.choose("bench-press")
            store.choose("barbell-row")
            if (threeMovements) store.choose("cable-fly")
            store.choose("bench-press")
            repeat(loggedSets) { store.logSet(60.0, 5) }
        }
        compose.setContent {
            LoggerScreen(store = store, isSignedIn = true, say = {}, onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return store
    }

    // The title is the one node carrying both the movement's name and a click action; the prefill
    // card names the movement too.
    // The title is the first clickable node carrying the movement's name; the session's own
    // assembly row carries it too, further down the tree.
    private fun title(name: String) =
        compose.onAllNodes(hasText(name) and hasClickAction()).onFirst()

    @Test
    fun theTwoChevronButtonsAreOffTheScreenAndTheDotsStay() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

        title("Bench Press").assertIsDisplayed()
        assertEquals("the dots stay — they are the position readout the swipe needs", 1,
            compose.nodesDescribed("Movement 1 of 2"))
        assertEquals("and the dots are the only thing that says it: no uppercased line beneath them", 0,
            compose.onAllNodes(hasText("MOVEMENT 1 OF 2")).fetchSemanticsNodes().size)
        assertEquals("but no button says either verb any more", 0,
            compose.nodesDescribed("Previous movement") + compose.nodesDescribed("Next movement"))
        scope.cancel()
    }

    // Law 1's Android half, on the screen where forgetting it would cost the most: without these a
    // lifter on TalkBack could not leave the first movement of a workout at all.
    @Test
    fun theTitleDeclaresBothStepsOfTheWalkAsCustomActions() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)

        val actions = title("Bench Press").fetchSemanticsNode()
            .config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals("nothing behind the first movement, so only one step is offered",
            listOf("Next movement"), actions.map { it.label })

        compose.runOnIdle { actions.single().action?.invoke() }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }

        val back = title("Barbell Row").fetchSemanticsNode()
            .config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals(listOf("Previous movement"), back.map { it.label })
        scope.cancel()
    }

    @Test
    fun aHorizontalStrokeWalksAndAVerticalOneDoesNot() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)

        // Away from the strip at either edge, which belongs to the system and never to the walk.
        title("Bench Press").performTouchInput { swipeLeft(startX = width * 0.85f, endX = width * 0.15f) }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }

        title("Barbell Row").performTouchInput { swipeRight(startX = width * 0.15f, endX = width * 0.85f) }
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }

        title("Bench Press").performTouchInput { swipeRight(startX = width * 0.15f, endX = width * 0.85f) }
        compose.runOnIdle {
            assertEquals("and the walk does not wrap round at its ends",
                "bench-press", store.exerciseId)
        }
        scope.cancel()
    }

    @Test
    fun swipesAcrossClocksRackAndLogButtonMoveOnceWithoutLoggingOrChangingClockAnchors() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, threeMovements = true, loggedSets = 1)
        val session = store.session
        val sets = store.sets.toList()

        val weight = compose.onNode(hasContentDescription("Weight ", substring = true)).fetchSemanticsNode().boundsInRoot
        compose.onRoot().performTouchInput {
            swipe(weight.center, weight.center - Offset(width * 0.35f, 0f))
        }
        compose.runOnIdle { assertEquals("barbell-row", store.exerciseId) }
        compose.onNodeWithText("Set weight").assertDoesNotExist()
        compose.onNodeWithText("Log set").performTouchInput { swipeRight(startX = width * 0.15f, endX = width * 0.85f) }
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }

        val clock = compose.onNode(hasContentDescription("Workout time,", substring = true)).fetchSemanticsNode().boundsInRoot
        compose.onRoot().performTouchInput {
            swipe(Offset(width * 0.8f, clock.center.y), Offset(width * 0.2f, clock.center.y))
        }
        compose.runOnIdle {
            assertEquals("barbell-row", store.exerciseId)
            assertEquals(session, store.session)
            assertEquals(sets, store.sets)
        }
    }

    @Test
    fun aVerticalStartCancellationMultiplePointersAndSystemEdgesNeverNavigate() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)
        title("Bench Press").performTouchInput {
            down(center)
            moveTo(center + Offset(0f, -70f))
            moveTo(center + Offset(-220f, -70f))
            up()
        }
        compose.runOnIdle { assertEquals("bench-press", store.exerciseId) }
        compose.onNodeWithText("Log set").performTouchInput {
            down(center)
            moveTo(center + Offset(-150f, 0f))
            cancel()
        }
        val clock = compose.onNode(hasContentDescription("Workout time,", substring = true)).fetchSemanticsNode().boundsInRoot
        compose.onRoot().performTouchInput {
            val start = Offset(width * 0.6f, clock.center.y)
            down(0, start)
            down(1, start + Offset(30f, 0f))
            moveTo(0, start + Offset(-150f, 0f))
            up(1)
            up(0)
        }
        compose.onRoot().performTouchInput {
            swipe(Offset(1f, height * 0.6f), Offset(width * 0.7f, height * 0.6f))
        }
        compose.runOnIdle {
            assertEquals("bench-press", store.exerciseId)
            assertEquals(emptyList<works.windmill.gym.domain.TrainingSet>(), store.sets)
        }
    }

    @Test
    fun horizontalSetStripKeepsItsDragAndDoesNotChangeMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, loggedSets = 8)
        val strip = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.HorizontalScrollAxisRange))
        val before = strip.fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange].value()
        strip.performTouchInput { swipeRight(startX = width * 0.15f, endX = width * 0.85f) }
        val after = strip.fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange].value()
        compose.runOnIdle {
            assertTrue("the child strip actually scrolled", after < before)
            assertEquals("bench-press", store.exerciseId)
            assertEquals(8, store.sets.size)
        }
    }

    @Test
    fun aShortHorizontalButtonDragCancelsItsTapWithoutChangingMovementOrLogging() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)
        compose.onNodeWithText("Log set").performTouchInput {
            down(center)
            moveTo(center + Offset(-40f, 0f))
            up()
        }
        compose.runOnIdle {
            assertEquals("bench-press", store.exerciseId)
            assertEquals(0, store.sets.size)
        }
    }

    @Test
    fun aMovementChangeDuringADragCancelsTheOldNavigation() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, threeMovements = true)
        compose.onNodeWithText("Log set").performTouchInput {
            down(center)
            moveTo(center + Offset(-180f, 0f))
        }
        compose.runOnIdle { runBlocking { store.choose("barbell-row") } }
        compose.onRoot().performTouchInput { up() }
        compose.runOnIdle {
            assertEquals("barbell-row", store.exerciseId)
            assertEquals(0, store.sets.size)
        }
    }

    @Test
    fun numericEditorOwnsItsDragsAndOrdinaryButtonTapsStillWork() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)
        val reps = store.rack!!.reps
        compose.onNodeWithContentDescription("one rep more").performClick()
        compose.runOnIdle { assertEquals(reps + 1, store.rack!!.reps) }
        compose.onNode(hasContentDescription("Weight ", substring = true)).performClick()
        compose.onNodeWithText("Weight").assertIsDisplayed().performTouchInput {
            swipeLeft(startX = width * 0.85f, endX = width * 0.15f)
        }
        compose.onNodeWithText("Set weight").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("bench-press", store.exerciseId)
            assertEquals(0, store.sets.size)
        }
    }
}

// A matcher throws where nothing matches, and half of what this pins is an ABSENCE, so the count is
// read rather than asserted through one.
private fun ComposeContentTestRule.nodesDescribed(said: String): Int =
    onAllNodes(hasContentDescription(said)).fetchSemanticsNodes().size
