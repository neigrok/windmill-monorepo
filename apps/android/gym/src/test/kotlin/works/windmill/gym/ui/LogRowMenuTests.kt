package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
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
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// D7. `13-gestures.md` kept Discard out of the session row's long press only *until the withheld
// delete exists* — it does now, so the condition has fired and the menu carries BOTH acts.
//
// The `⋮` that used to carry Discard is gone with it. A gesture earns its place by REMOVING a
// control (Law 4); adding a drawn button to every row of the log to carry an act the menu can hold
// is that law backwards. Law 1 is still met without it — the session review screen draws Discard, so
// the long press is never the only path — and a screen reader reaches both acts through the row's
// own custom actions, which is what this file checks.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogRowMenuTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val startedAtMs = 1_754_000_000_000L

    private fun store(scope: CoroutineScope): TrainingStore {
        val server = FakeTraining()
        server.stored["ses_1"] = Session(id = "ses_1", startedAtMs = startedAtMs,
                                         finishedAtMs = startedAtMs + 3_600_000)
        server.sets["ses_1"] = mutableListOf(
            TrainingSet(id = "set_1", exerciseId = "bench-press", weightKg = 82.5, reps = 5,
                        kind = SetKind.Working, completedAtMs = startedAtMs + 60_000),
        )
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_new" },
            mintSet = Ids::set,
            sync = { server },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam")))
        }
        return store
    }

    private fun log(store: TrainingStore, doors: MutableList<String>) {
        compose.setContent {
            LogScreen(
                store = store,
                seat = "",
                onOpenSession = { doors += "open" },
                onOpenBodyweight = { doors += "bodyweight" },
                onShareSession = { doors += "share" },
                onDiscardSession = { doors += "discard" },
            )
        }
    }

    // The row's title is the one node carrying both the session's name and a click action.
    private fun row() = compose.onAllNodes(hasText(Readout.noRoutine) and hasClickAction()).onFirst()

    @Test
    fun theLongPressHoldsExactlyTwoItemsAndTheRowDrawsNoOverflowAtAll() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        log(store(scope), doors)

        // Read off the UNMERGED tree: a button inside the row is folded into the row's own node in
        // the merged one, which is exactly how a drawn control would slip past this check.
        assertEquals("no glyph on the row says `more`", 0,
            compose.onAllNodes(hasContentDescription("More", substring = true), useUnmergedTree = true)
                .fetchSemanticsNodes().size)
        assertEquals("and the row holds no control of its own at all — the long press is the door", 0,
            compose.onAllNodes(hasAnyAncestor(hasText(Readout.noRoutine) and hasClickAction())
                and hasClickAction()).fetchSemanticsNodes().size)

        row().performTouchInput { longClick() }
        compose.waitForIdle()

        val items = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction())
            .fetchSemanticsNodes().size
        assertEquals("two acts, and only two", 2, items)
        compose.onNodeWithText("Share this workout").assertIsDisplayed()
        compose.onNodeWithText("Discard session").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun discardingFromTheMenuGoesThroughTheSameWithheldDeleteAsTheReviewScreens() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        log(store(scope), doors)

        row().performTouchInput { longClick() }
        compose.waitForIdle()
        compose.onNodeWithText("Discard session").performClick()

        compose.runOnIdle { assertEquals(listOf("discard"), doors) }
        scope.cancel()
    }

    @Test
    fun sharingFromTheMenuStillReachesTheShareItAlwaysDid() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        log(store(scope), doors)

        row().performTouchInput { longClick() }
        compose.waitForIdle()
        compose.onNodeWithText("Share this workout").performClick()

        compose.runOnIdle { assertEquals(listOf("share"), doors) }
        scope.cancel()
    }

    // A long press is unreachable by a screen reader, and this row now draws no button for EITHER
    // act, so both are declared by hand. Without the second one a lifter on TalkBack could not
    // discard a workout from the log at all.
    @Test
    fun bothActsAreDeclaredAsCustomActionsBecauseNeitherIsDrawn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        log(store(scope), doors)

        val actions = row().fetchSemanticsNode()
            .config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals(listOf("Share this workout", "Discard session"), actions.map { it.label })

        compose.runOnIdle { actions.first { it.label == "Discard session" }.action?.invoke() }
        compose.runOnIdle { assertEquals(listOf("discard"), doors) }
        scope.cancel()
    }

    @Test
    fun theRowStillOpensOnAnOrdinaryTap() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        log(store(scope), doors)

        row().performClick()

        compose.runOnIdle {
            assertTrue("a long press may not have taken the tap with it", doors == listOf("open"))
        }
        scope.cancel()
    }
}
