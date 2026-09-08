package works.windmill.gym.ui

import android.graphics.Insets
import android.view.WindowInsets
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextReplacement
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
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

// The target sheet's head: the count's refusals under it, the open line's one sentence, and the
// two keyboard rules — the sheet paints in the same place on every open, and Back with the
// keyboard up puts only the keyboard down.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TargetSheetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val pushA = RoutineDraft(name = "Push A").adding("bench-press")
        .targeting("bench-press", List(3) { SetTarget(8, 60.0) })

    private fun store(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { null },
        )
        runBlocking {
            store.connect(Account(api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }), user = null))
        }
        return store
    }

    private fun editor(scope: CoroutineScope, opening: RoutineDraft): () -> RoutineDraft {
        val store = store(scope)
        var draft by mutableStateOf(opening)
        compose.setContent {
            RoutineBuilder(
                draft = draft,
                store = store,
                saving = false,
                onDraft = { draft = it },
                onSave = {},
                onClose = {},
                say = {},
            )
        }
        return { draft }
    }

    private fun openTheSheet() {
        compose.onNodeWithText("Bench Press").performClick()
        compose.onNodeWithText("Set · ", substring = true).assertIsDisplayed()
    }

    // Back, the scrim or the handle — a test takes the one the platform draws.
    private fun dismissTheSheet() {
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Set · ", substring = true).fetchSemanticsNodes().isEmpty()
        }
    }

    // The sheet is its own window; what the keyboard does to it is what its window's insets say.
    private fun keyboardOverTheSheet(up: Boolean) {
        val insets = WindowInsets.Builder()
            .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, if (up) 700 else 0))
            .setVisible(WindowInsets.Type.ime(), up)
            .build()
        compose.runOnIdle { ShadowDialog.getLatestDialog().window!!.decorView.dispatchApplyWindowInsets(insets) }
        compose.waitForIdle()
    }

    @Test
    fun testTheCountsRefusalsAreSaidUnderTheHeadAndTheCommitWaitsForThem() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, pushA)
        openTheSheet()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("0")
        compose.onNodeWithText(TargetEntry.zeroTarget).assertIsDisplayed()
        compose.onNodeWithText("Set").assertIsNotEnabled()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("21")
        compose.onNodeWithText(TargetEntry.outsideSets).assertIsDisplayed()
        compose.onNodeWithText(TargetEntry.zeroTarget).assertDoesNotExist()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("2.5")
        compose.onNodeWithText(TargetEntry.outsideSets).assertIsDisplayed()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("3")
        compose.onNodeWithText(TargetEntry.outsideSets).assertDoesNotExist()
        compose.onNodeWithText("Set · 3 × 8 · 60").assertIsDisplayed()
        scope.cancel()
    }

    // The head writes every row, so a fault typed there is the head's and is said once, under the
    // head field and above row 1.
    @Test
    fun testAFaultTypedIntoTheHeadIsSaidOnceUnderTheHeadField() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, pushA)
        openTheSheet()

        compose.onNodeWithContentDescription("Reps target").performTextReplacement("101")
        compose.onAllNodesWithText(TargetEntry.outsideReps).assertCountEquals(1)
        val said = compose.onNodeWithText(TargetEntry.outsideReps).fetchSemanticsNode().positionInRoot.y
        val head = compose.onNodeWithContentDescription("Reps target").fetchSemanticsNode().positionInRoot.y
        val row1 = compose.onNodeWithContentDescription("Set 1 reps").fetchSemanticsNode().positionInRoot.y
        assertTrue("under the head field and above row 1", said > head && said < row1)

        compose.onNodeWithContentDescription("Reps target").performTextReplacement("5")
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("82.5.0")
        compose.onNodeWithText(TargetEntry.onePoint).assertIsDisplayed()
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("501")
        compose.onNodeWithText(TargetEntry.overWeight).assertIsDisplayed()
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("eighty")
        compose.onNodeWithText(TargetEntry.notANumber).assertIsDisplayed()

        // With every field readable nothing stands where the refusal was: a comma and a point both
        // read, and no sentence says so.
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("100")
        compose.onNodeWithText(TargetEntry.notANumber).assertDoesNotExist()
        compose.onNodeWithText("comma or point", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Set · 3 × 5 · 100").assertIsDisplayed()
        scope.cancel()
    }

    // A movement added from the picker opens on the open line. 15-the-routine pins the sentence on
    // EVERY surface, and the sheet is its one home: the list behind it prints `open` per row and no
    // sentence. It sits ABOVE the fields, beside the never-logged line; under a field stands only
    // that field's own refusal.
    @Test
    fun testTheOpenLineSaysWhatItMeansAboveTheFieldsWhereTheLifterDecidesIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push A").adding("bench-press"))
        openTheSheet()

        compose.onAllNodesWithText(TargetEntry.openLine).assertCountEquals(1)
        compose.onNodeWithText("Never logged — these are your numbers.").assertIsDisplayed()
        val sentence = compose.onNodeWithText(TargetEntry.openLine).fetchSemanticsNode().positionInRoot.y
        val neverLogged = compose.onNodeWithText("Never logged — these are your numbers.").fetchSemanticsNode().positionInRoot.y
        val sets = compose.onNodeWithContentDescription("Sets target").fetchSemanticsNode().positionInRoot.y
        assertTrue("beside the never-logged line", sentence > neverLogged)
        assertTrue("and above the fields", sentence < sets)
        compose.onNodeWithContentDescription("Reps target").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Weight target").assertIsNotEnabled()

        // It goes the moment the line names a count, and comes back when the count is cleared.
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("3")
        compose.onAllNodesWithText(TargetEntry.openLine).assertCountEquals(0)
        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onAllNodesWithText(TargetEntry.openLine).assertCountEquals(1)
        scope.cancel()
    }

    @Test
    fun testAClearedLoadIsLastTimeAndTheOthersStillWrite() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, pushA)
        openTheSheet()

        compose.onNodeWithContentDescription("Weight target").performTextClearance()
        compose.onNodeWithContentDescription("Reps target").performTextReplacement("5")
        compose.onNodeWithText("Set · 3 × 5").performClick()

        compose.runOnIdle {
            assertEquals("a cleared load means `last time`", List(3) { SetTarget(5) }, draft().entry("bench-press")!!.sets)
        }
        scope.cancel()
    }

    // The sheet's window is padded by whatever keyboard is up when it opens, and the keyboard
    // belongs to the screen underneath: a fresh editor opens with the name field focused and the
    // keyboard up. The screen gives it up as the sheet rises, so the sheet's fields stand in the
    // same place on every open.
    @Test
    fun testTheScreenGivesUpItsKeyboardAsTheSheetRises() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft().adding("bench-press"))
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Routine name").assertIsFocused()

        openTheSheet()
        compose.onNodeWithContentDescription("Routine name").assertIsNotFocused()
        scope.cancel()
    }

    @Test
    fun testTheSheetsFieldsStandInTheSamePlaceOnTwoConsecutiveOpens() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, pushA)

        openTheSheet()
        val first = compose.onNodeWithContentDescription("Sets target").getBoundsInRoot().top
        compose.onNodeWithContentDescription("Sets target").performClick()
        keyboardOverTheSheet(up = true)
        val lifted = compose.onNodeWithContentDescription("Sets target").getBoundsInRoot().top
        assertTrue("the keyboard lifts the sheet while it stands", lifted < first)
        dismissTheSheet()

        openTheSheet()
        val second = compose.onNodeWithContentDescription("Sets target").getBoundsInRoot().top
        assertEquals("the same place on the next open", first, second)
        scope.cancel()
    }

    // Back with the keyboard up puts the keyboard down and leaves the sheet; with it down, Back is
    // the sheet's own. Driven through the sheet's dispatcher, the back a Robolectric dialog can take.
    @Test
    fun testBackWithTheKeyboardUpDismissesOnlyTheKeyboard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, pushA)
        openTheSheet()
        compose.onNodeWithContentDescription("Sets target").performClick()

        keyboardOverTheSheet(up = true)
        compose.runOnIdle { ShadowDialog.getLatestDialog().onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithText("Set · 3 × 8 · 60").assertIsDisplayed()

        keyboardOverTheSheet(up = false)
        compose.runOnIdle { ShadowDialog.getLatestDialog().onBackPressed() }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Set · ", substring = true).fetchSemanticsNodes().isEmpty()
        }
        scope.cancel()
    }
}
