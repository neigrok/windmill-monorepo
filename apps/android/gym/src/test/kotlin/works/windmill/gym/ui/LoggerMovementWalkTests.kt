package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.performTouchInput
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
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
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

    private fun logger(scope: CoroutineScope): TrainingStore {
        val root = File(System.getProperty("java.io.tmpdir"), "walk-${System.nanoTime()}")
        root.mkdirs()
        val server = FakeTraining()
        server.catalog = listOf(
            Exercise(id = "bench-press", name = "Bench Press"),
            Exercise(id = "barbell-row", name = "Barbell Row"),
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
            store.choose("bench-press")
        }
        compose.setContent {
            LoggerScreen(store = store, isSignedIn = true, say = {}, onFinish = {}, onSignIn = {})
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
            compose.nodesDescribed("movement 1 of 2"))
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
}

// A matcher throws where nothing matches, and half of what this pins is an ABSENCE, so the count is
// read rather than asserted through one.
private fun ComposeContentTestRule.nodesDescribed(said: String): Int =
    onAllNodes(hasContentDescription(said)).fetchSemanticsNodes().size
