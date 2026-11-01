package works.windmill.gym.ui

import android.graphics.Insets
import android.view.WindowInsets
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.TargetEntry
import works.windmill.gym.store.EngineRoomFixture

// The combined form retains raw targets, inline refusals and native keyboard priority.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TargetSheetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val pushA = RoutineDraft(name = "Push A").adding("bench-press")
        .targeting("bench-press", List(3) { SetTarget(8, 60.0) })

    // Signed out, so the catalog is the anonymous replica's: the seeds by name and equipment.
    private fun editor(room: EngineRoomFixture, opening: RoutineDraft): () -> RoutineDraft {
        runBlocking { room.select(null) }
        var draft by mutableStateOf(opening)
        compose.setContent {
            RoutineBuilder(
                draft = draft,
                store = room.store,
                saving = false,
                onDraft = { draft = it },
                onSave = {},
                onClose = {},
                say = {},
                backTo = "Routines",
            )
        }
        return { draft }
    }

    private fun openTheSheet() {
        compose.onNodeWithText("Bench Press").performClick()
        compose.onNodeWithText("Done").assertIsDisplayed()
        compose.onNodeWithContentDescription("Movement name").assertExists()
        compose.onNodeWithContentDescription("Equipment").assertExists()
    }

    // Back, the scrim or the handle — a test takes the one the platform draws.
    private fun dismissTheSheet() {
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Done").fetchSemanticsNodes().isEmpty()
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
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, pushA)
            openTheSheet()

            compose.onNodeWithContentDescription("Sets").performTextReplacement("0")
            compose.onNodeWithText(TargetEntry.outsideSets).assertIsDisplayed()
            compose.onNode(hasText("Done") and hasClickAction()).assertIsNotEnabled()

            compose.onNodeWithContentDescription("Sets").performTextReplacement("21")
            compose.onNodeWithText(TargetEntry.outsideSets).assertIsDisplayed()
            compose.onNodeWithText(TargetEntry.zeroTarget).assertDoesNotExist()

            compose.onNodeWithContentDescription("Sets").performTextReplacement("2.5")
            compose.onNodeWithText(TargetEntry.outsideSets).assertIsDisplayed()

            compose.onNodeWithContentDescription("Sets").performTextReplacement("3")
            compose.onNodeWithText(TargetEntry.outsideSets).assertDoesNotExist()
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // The head writes every row, so a fault typed there is the head's and is said once, under the
    // focused head field.
    @Test
    fun testAFaultTypedIntoTheHeadIsSaidOnceUnderTheHeadField() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, pushA)
            openTheSheet()

            compose.onNodeWithContentDescription("Reps").performTextReplacement("101")
            compose.onAllNodesWithText(TargetEntry.outsideReps).assertCountEquals(1)
            val said = compose.onNodeWithText(TargetEntry.outsideReps).fetchSemanticsNode().positionInRoot.y
            val head = compose.onNodeWithContentDescription("Reps").fetchSemanticsNode().positionInRoot.y
            assertTrue("under the focused head field", said > head)
            compose.onNodeWithContentDescription("Set 1 reps").assertDoesNotExist()

            compose.onNodeWithContentDescription("Reps").performTextReplacement("5")
            compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("82.5.0")
            compose.onNodeWithContentDescription("Load, kg total").assertTextContains("60")
            compose.onNodeWithText(TargetEntry.onePoint).assertDoesNotExist()
            compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("1e999")
            compose.onNodeWithText(TargetEntry.notANumber).assertIsDisplayed()
            compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("eighty")
            compose.onNodeWithText(TargetEntry.notANumber).assertIsDisplayed()

            // With every field readable nothing stands where the refusal was: a comma and a point both
            // read, and no sentence says so.
            compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("100")
            compose.onNodeWithText(TargetEntry.notANumber).assertDoesNotExist()
            compose.onNodeWithText("comma or point", substring = true).assertDoesNotExist()
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun anOpenTargetKeepsNameEquipmentAndRawBlankCountOnTheSameForm() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft(name = "Push A").adding("bench-press"))
            openTheSheet()
            assertEquals("", compose.onNodeWithContentDescription("Sets").fetchSemanticsNode()
                .config[SemanticsProperties.EditableText].text)
            compose.onNodeWithContentDescription("Reps").assertIsNotEnabled()
            compose.onNodeWithContentDescription("Load, kg total").assertIsNotEnabled()
            compose.onNodeWithContentDescription("Movement name").assertExists()
            compose.onNodeWithContentDescription("Equipment").assertExists()
            compose.onNodeWithText(TargetEntry.openLine).assertDoesNotExist()
            compose.onNodeWithContentDescription("Sets").performTextReplacement("3")
            assertEquals("3", compose.onNodeWithContentDescription("Sets").fetchSemanticsNode()
                .config[SemanticsProperties.EditableText].text)
            compose.onNodeWithContentDescription("Sets").performTextClearance()
            assertEquals("", compose.onNodeWithContentDescription("Sets").fetchSemanticsNode()
                .config[SemanticsProperties.EditableText].text)
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun testAClearedLoadIsLastTimeAndTheOthersStillWrite() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, pushA)
            openTheSheet()

            compose.onNodeWithContentDescription("Load, kg total").performTextClearance()
            compose.onNodeWithContentDescription("Reps").performTextReplacement("5")
            compose.onNodeWithText("Done").performClick()

            compose.runOnIdle {
                assertEquals("a cleared load means `last time`", List(3) { SetTarget(5) }, draft().entry("bench-press")!!.sets)
            }
        } } finally { scope.cancel() }
    }

    // The sheet's window is padded by whatever keyboard is up when it opens, and the keyboard
    // belongs to the screen underneath: a fresh editor opens with the name field focused and the
    // keyboard up. The screen gives it up as the sheet rises, so the sheet's fields stand in the
    // same place on every open.
    @Test
    fun testTheScreenGivesUpItsKeyboardAsTheSheetRises() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft().adding("bench-press"))
            compose.waitForIdle()
            compose.onNodeWithContentDescription("Routine name").assertIsFocused()

            openTheSheet()
            compose.onNodeWithContentDescription("Routine name").assertIsNotFocused()
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheSheetsFieldsStandInTheSamePlaceOnTwoConsecutiveOpens() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, pushA)

            openTheSheet()
            val first = compose.onNodeWithContentDescription("Sets").getBoundsInRoot().top
            compose.onNodeWithContentDescription("Sets").performClick()
            keyboardOverTheSheet(up = true)
            val lifted = compose.onNodeWithContentDescription("Sets").getBoundsInRoot().top
            assertTrue("the keyboard lifts the sheet while it stands", lifted < first)
            dismissTheSheet()

            openTheSheet()
            val second = compose.onNodeWithContentDescription("Sets").getBoundsInRoot().top
            assertEquals("the same place on the next open", first, second)
        } } finally { scope.cancel() }
    }

    // Back with the keyboard up puts the keyboard down and leaves the sheet; with it down, Back is
    // the sheet's own. Driven through the sheet's dispatcher, the back a Robolectric dialog can take.
    @Test
    fun testBackWithTheKeyboardUpDismissesOnlyTheKeyboard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, pushA)
            openTheSheet()
            compose.onNodeWithContentDescription("Sets").performClick()

            keyboardOverTheSheet(up = true)
            compose.runOnIdle { ShadowDialog.getLatestDialog().onBackPressed() }
            compose.waitForIdle()
            compose.onNodeWithText("Done").assertIsDisplayed()

            keyboardOverTheSheet(up = false)
            compose.runOnIdle { ShadowDialog.getLatestDialog().onBackPressed() }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Done").fetchSemanticsNodes().isEmpty()
            }
        } } finally { scope.cancel() }
    }
}
