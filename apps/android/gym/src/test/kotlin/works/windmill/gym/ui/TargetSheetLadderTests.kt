package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.performScrollTo
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
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.store.EngineRoomFixture

// The sheet's two zooms — the head that speaks about every set at once and the ladder with a row
// per set — on the two fixtures every surface's tests share: Lower A's Back Squat ramp and Push A's
// straight Bench Press.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TargetSheetLadderTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))

    private val lowerA = RoutineDraft(name = "Lower A").adding("back-squat").adding("deadlift")
        .targeting("back-squat", ramp)

    private val pushA = RoutineDraft(name = "Push A").adding("bench-press")
        .targeting("bench-press", List(3) { SetTarget(8, 60.0) })

    // Signed out, so the catalog is the anonymous replica's: the seeds by name and equipment.
    private fun editor(room: EngineRoomFixture, opening: RoutineDraft, movement: String): () -> RoutineDraft {
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
        compose.onNodeWithText(movement).performClick()
        val targets = opening.entries.first().sets
        if (targets.isNotEmpty() && works.windmill.gym.domain.Scheme.straight(targets)) {
            compose.onNodeWithText("Vary by set").performClick()
        }
        return { draft }
    }

    private fun uniform() {
        if (compose.onAllNodesWithContentDescription("Sets").fetchSemanticsNodes().isEmpty())
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
    }

    private fun rows() {
        val count = compose.onAllNodesWithContentDescription("Sets").fetchSemanticsNodes().singleOrNull()
        if (count != null && count.config[SemanticsProperties.EditableText].text.isNotBlank())
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
    }

    private fun headField(description: String): SemanticsNodeInteraction {
        uniform()
        return compose.onNodeWithContentDescription(description).performScrollTo()
    }

    private fun typed(description: String): String {
        val label = when (description) {
            "Sets target" -> "Sets"
            "Reps target" -> "Reps"
            "Weight target" -> "Load, kg total"
            else -> description
        }
        val wasRows = compose.onAllNodesWithContentDescription("Set 1 reps").fetchSemanticsNodes().isNotEmpty()
        val value = if (label != description) headField(label).fetchSemanticsNode().config[SemanticsProperties.EditableText].text
            else compose.onNodeWithContentDescription(label).fetchSemanticsNode().config[SemanticsProperties.EditableText].text
        if (label != description && wasRows) rows()
        return value
    }

    private fun head(): List<String> = listOf(typed("Sets target"), typed("Reps target"), typed("Weight target"))

    private fun ladder(): List<Pair<String, String>> {
        rows()
        return generateSequence(1) { it + 1 }
            .takeWhile { compose.onAllNodesWithContentDescription("Set $it reps").fetchSemanticsNodes().isNotEmpty() }
            .map { typed("Set $it reps") to typed("Set $it load") }.toList()
    }

    private fun commit() = compose.onNodeWithText("Done")

    private fun yOf(description: String): Float =
        compose.onNodeWithContentDescription(description).fetchSemanticsNode().positionInRoot.y

    private fun deleteAction(row: Int): () -> Boolean {
        rows()
        val rows = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions), useUnmergedTree = true)
            .fetchSemanticsNodes()
            .filter { node -> node.config[SemanticsActions.CustomActions].any { it.label == TargetEntry.delete } }
        return rows[row - 1].config[SemanticsActions.CustomActions].single { it.label == TargetEntry.delete }.action!!
    }

    @Test
    fun testTheRampOpensWithTheHeadSayingVariesAndFiveRowsUnderIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")

            assertEquals(listOf("5", "", ""), head())
            compose.onNodeWithText("5 sets · varies").assertIsDisplayed()
            assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80"), ladder())
            assertEquals("Back Squat", typed("Movement name"))
            compose.onNodeWithContentDescription("Equipment").assertExists()
            commit().assertIsEnabled()
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheStraightSchemeOpensWithItsThreeNumbersInTheHeadAndTheRowsAgreeing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, pushA, "Bench Press")

            assertEquals(listOf("3", "8", "60"), head())
            compose.onAllNodesWithText(TargetEntry.varies, useUnmergedTree = true).assertCountEquals(0)
            assertEquals(List(3) { "8" to "60" }, ladder())
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // A new row copies the row above it: `5 → 6` on a ramp adds a sixth set at the last set's numbers.
    @Test
    fun testGrowingSetsCopiesTheRowAboveAndTheDraftCommitsSixSets() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, lowerA, "Back Squat")

            headField("Sets").performTextReplacement("6")
            assertEquals(ramp.map { "${it.reps}" to "${it.weightKg!!.toInt()}" } + ("5" to "80"), ladder())
            compose.onNodeWithText("Done").performClick()
            compose.runOnIdle {
                assertEquals(ramp + SetTarget(5, 80.0), draft().entry("back-squat")!!.sets)
            }
        } } finally { scope.cancel() }
    }

    // The copy-down needs no control of its own: typing over `varies` writes every row.
    @Test
    fun testTypingTheHeadRepsWritesEveryRow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, lowerA, "Back Squat")

            headField("Reps").performTextReplacement("8")
            assertEquals(listOf("8" to "60", "8" to "80", "8" to "90", "8" to "100", "8" to "80"), ladder())
            assertEquals(listOf("5", "8", ""), head())
            commit().performClick()
            compose.runOnIdle {
                assertEquals(ramp.map { it.copy(reps = 8) }, draft().entry("back-squat")!!.sets)
            }
        } } finally { scope.cancel() }
    }

    // The ladder is hidden, not thrown away: a cleared count disables the other two fields and
    // takes the rows off the sheet, and retyping the count brings the same rows back.
    @Test
    fun testClearingSetsHidesTheLadderWithoutDiscardingItAndRetypingBringsItBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, lowerA, "Back Squat")

            headField("Sets").performTextClearance()
            headField("Reps").assertIsNotEnabled()
            headField("Load, kg total").assertIsNotEnabled()
            assertEquals(emptyList<Pair<String, String>>(), ladder())
            compose.onNodeWithText(TargetEntry.setBySet).assertDoesNotExist()
            compose.onAllNodesWithText("open", useUnmergedTree = true).assertCountEquals(3)
            compose.onNodeWithText("Done").assertIsDisplayed()

            headField("Sets").performTextReplacement("5")
            compose.onNodeWithText("You decide the numbers at the rack.").assertDoesNotExist()
            assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80"), ladder())
            compose.onNodeWithText("Done").performClick()
            compose.runOnIdle { assertEquals(ramp, draft().entry("back-squat")!!.sets) }
        } } finally { scope.cancel() }
    }

    // Only the commit of an open line drops the rows.
    @Test
    fun testCommittingWithSetsEmptyOpensTheLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, lowerA, "Back Squat")

            headField("Sets").performTextClearance()
            compose.onNodeWithText("Done").performClick()
            compose.runOnIdle {
                assertEquals(emptyList<SetTarget>(), draft().entry("back-squat")!!.sets)
                assertTrue(draft().entry("back-squat")!!.isOpen)
            }
        } } finally { scope.cancel() }
    }

    // The pyramid in two typed ends and one tap: the rows between are interpolated, loads onto the
    // ladder's grid and reps to the nearest whole.
    @Test
    fun testFillRampUpInterpolatesBetweenTheTwoEnds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")
            (2..4).forEach {
                compose.onNodeWithContentDescription("Set $it reps").performTextClearance()
                compose.onNodeWithContentDescription("Set $it load").performTextClearance()
            }
            assertEquals(listOf("5" to "60", "" to "", "" to "", "" to "", "5" to "80"), ladder())
            compose.onNodeWithContentDescription("Set 5 reps").performTextReplacement("1")
            compose.onNodeWithContentDescription("Set 5 load").performTextReplacement("100")

            compose.onNodeWithText(TargetEntry.fill).performClick()
            compose.onAllNodesWithText(TargetEntry.rampUp).onLast().assertIsEnabled().performClick()
            assertEquals(listOf("5" to "60", "4" to "70", "3" to "80", "2" to "90", "1" to "100"), ladder())
            compose.onAllNodesWithText(TargetEntry.rampUp).assertCountEquals(1)
            compose.onNodeWithText(TargetEntry.matchSetOne).assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    // Nothing to ramp between ends that agree.
    @Test
    fun testRampUpIsDisabledWhileSetOneAndSetNAgree() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, pushA, "Bench Press")

            compose.onNodeWithText(TargetEntry.fill).performClick()
            compose.onAllNodesWithText(TargetEntry.rampUp).onLast().assertIsNotEnabled()
            compose.onNodeWithText(TargetEntry.matchSetOne).assertIsEnabled()
        } } finally { scope.cancel() }
    }

    // The way back from a ladder to a straight scheme without retyping the head.
    @Test
    fun testFillMatchSetOneWritesSetOneIntoEveryRow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, lowerA, "Back Squat")

            compose.onNodeWithText(TargetEntry.fill).performClick()
            compose.onNodeWithText(TargetEntry.matchSetOne).performClick()
            assertEquals(List(5) { "5" to "60" }, ladder())
            assertEquals(listOf("5", "5", "60"), head())
            compose.onNodeWithText("Done").performClick()
            compose.runOnIdle { assertEquals(List(5) { SetTarget(5, 60.0) }, draft().entry("back-squat")!!.sets) }
        } } finally { scope.cancel() }
    }

    @Test
    fun testAddSetAppendsACopyOfTheLastRowAndCountsIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")

            compose.onNodeWithText(TargetEntry.addSet).performScrollTo().performClick()
            assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80", "5" to "80"), ladder())
            assertEquals(listOf("6", "", ""), head())
            compose.onNodeWithText(TargetEntry.outsideSets).assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test
    fun testAddSetIsInertAtTwentyAndSaysTheBand() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val twenty = RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(20) { SetTarget(8, 60.0) })
            editor(room, twenty, "Bench Press")
            assertEquals("20", typed("Sets target"))

            // Twenty rows outrun the sheet: Add set is the body's last row, under the scroll.
            compose.onNodeWithText(TargetEntry.addSet).performScrollTo().performClick()
            compose.onNodeWithText(TargetEntry.outsideSets).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Done").assertIsDisplayed()

            // The next keystroke anywhere on the sheet clears it.
            compose.onNodeWithContentDescription("Set 1 reps").performScrollTo().performTextReplacement("9")
            compose.onNodeWithText(TargetEntry.outsideSets).assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    // The rows outlive the count typed over them: `5 → 1 → 12` keeps the ramp, the count is the
    // shown prefix, and the commit slices to it.
    @Test
    fun testACountTypedLowAndBackHighKeepsTheRamp() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, lowerA, "Back Squat")

            headField("Sets").performTextReplacement("1")
            assertEquals(listOf("5" to "60"), ladder())
            assertEquals(listOf("1", "5", "60"), head())
            compose.onNodeWithText("Done").assertIsDisplayed()

            headField("Sets").performTextReplacement("12")
            assertEquals(
                listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80") + List(7) { "5" to "80" },
                ladder(),
            )

            headField("Sets").performTextReplacement("3")
            assertEquals(listOf("5" to "60", "5" to "80", "3" to "90"), ladder())
            compose.onNodeWithText("Done").performClick()
            compose.runOnIdle { assertEquals(ramp.take(3), draft().entry("back-squat")!!.sets) }
        } } finally { scope.cancel() }
    }

    // Add set reveals the next hidden row while there is one, and copies the last shown row after.
    @Test
    fun testAddSetRevealsTheNextHiddenRowBeforeCopyingTheLastShown() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")

            headField("Sets").performTextReplacement("2")
            assertEquals(listOf("5" to "60", "5" to "80"), ladder())
            compose.onNodeWithText(TargetEntry.addSet).performScrollTo().performClick()
            assertEquals(listOf("5" to "60", "5" to "80", "3" to "90"), ladder())
            assertEquals("3", typed("Sets target"))
            repeat(2) { compose.onNodeWithText(TargetEntry.addSet).performScrollTo().performClick() }
            assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80"), ladder())
            compose.onNodeWithText(TargetEntry.addSet).performScrollTo().performClick()
            assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80", "5" to "80"), ladder())
            assertEquals("6", typed("Sets target"))
        } } finally { scope.cancel() }
    }

    // A swipe-Delete takes that row out of the array and the count down by one; the hidden tail
    // stands and comes back when the count is typed up.
    @Test
    fun testDeletingAShownRowKeepsTheHiddenTail() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")

            headField("Sets").performTextReplacement("3")
            val delete = deleteAction(2)
            compose.runOnIdle { delete() }
            assertEquals(listOf("5" to "60", "3" to "90"), ladder())
            assertEquals("2", typed("Sets target"))
            headField("Sets").performTextReplacement("4")
            assertEquals(listOf("5" to "60", "3" to "90", "1" to "100", "5" to "80"), ladder())
        } } finally { scope.cancel() }
    }

    // A refusal typed in the head is said under the head field — the field itself in the error
    // state, the row it was written into clean — and the commit reads `Set`, disabled.
    @Test
    fun testARefusalTypedInTheHeadIsSaidUnderTheHeadField() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")

            headField("Reps").performTextReplacement("101")
            val said = compose.onNodeWithText(TargetEntry.outsideReps).assertIsDisplayed().fetchSemanticsNode().positionInRoot.y
            assertTrue("under the head", said > yOf("Reps"))
            headField("Reps").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Error))
            compose.onNodeWithContentDescription("Set 1 reps").assertDoesNotExist()
            commit().assertIsNotEnabled()
            commit().assertIsDisplayed()

            headField("Load, kg total").performTextReplacement("1e999")
            headField("Reps").performTextReplacement("8")
            val load = compose.onNodeWithText(TargetEntry.notANumber).assertIsDisplayed().fetchSemanticsNode().positionInRoot.y
            assertTrue(load > yOf("Load, kg total"))
            headField("Load, kg total").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Error))
        } } finally { scope.cancel() }
    }

    // Law 1: the row's swipe is half-built until its custom action exists. Deleting decrements Sets.
    @Test
    fun testTheRowsDeleteActionRemovesItAndDecrementsSets() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, lowerA, "Back Squat")

            val delete = deleteAction(2)
            compose.runOnIdle { delete() }
            assertEquals(listOf("5" to "60", "3" to "90", "1" to "100", "5" to "80"), ladder())
            assertEquals(listOf("4", "", ""), head())
            compose.onNodeWithText("Done").performClick()
            compose.runOnIdle {
                assertEquals(listOf(SetTarget(5, 60.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)),
                             draft().entry("back-squat")!!.sets)
            }
        } } finally { scope.cancel() }
    }

    // Deleting the last set is the same act as clearing Sets, and lands on the same open line.
    @Test
    fun testDeletingTheOnlyRowLandsOnTheOpenLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val one = RoutineDraft(name = "Push A").adding("bench-press").targeting("bench-press", listOf(SetTarget(8, 60.0)))
            editor(room, one, "Bench Press")

            val delete = deleteAction(1)
            compose.runOnIdle { delete() }
            assertEquals(listOf("", "", ""), head())
            assertEquals(emptyList<Pair<String, String>>(), ladder())
            compose.onAllNodesWithText("open", useUnmergedTree = true).assertCountEquals(2)
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // A row's fault is drawn under THAT row, in the pinned words, and holds the commit.
    @Test
    fun testARowsFaultIsSaidUnderItsOwnRowAndHoldsTheCommit() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")

            compose.onNodeWithContentDescription("Set 3 reps").performTextReplacement("0")
            val said = compose.onNodeWithText(TargetEntry.zeroTarget).assertIsDisplayed().fetchSemanticsNode().positionInRoot.y
            val row3 = compose.onNodeWithContentDescription("Set 3 reps").fetchSemanticsNode().positionInRoot.y
            val row4 = compose.onNodeWithContentDescription("Set 4 reps").fetchSemanticsNode().positionInRoot.y
            assertTrue("under row 3", said > row3)
            assertTrue("and above row 4", said < row4)
            commit().assertIsNotEnabled()
            commit().assertIsDisplayed()

            // Topmost first: a second fault lower down waits its turn.
            compose.onNodeWithContentDescription("Set 5 load").performTextReplacement("1e999")
            compose.onAllNodesWithText(TargetEntry.zeroTarget).assertCountEquals(1)
            compose.onNodeWithText(TargetEntry.notANumber).assertDoesNotExist()
            compose.onNodeWithContentDescription("Set 3 reps").performTextReplacement("3")
            compose.onNodeWithText(TargetEntry.notANumber).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun stepperAndLadderNamesExposeBothLevelsOfTheTarget() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, lowerA, "Back Squat")

            uniform()
            compose.onNodeWithContentDescription("Increase Sets").assertExists()
            compose.onNodeWithContentDescription("Decrease Reps").assertExists()
            compose.onNodeWithContentDescription("Increase Load").assertExists()
            compose.onNodeWithText("Vary by set").assertExists()
            compose.onNodeWithText("Ramp up").assertExists()
            rows()
            compose.onNodeWithContentDescription("Set 5 load").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }
    @Test
    fun integralDecimalCountsGrowEditableRowsAndKeepTheFifthTargetThroughAHiddenTail() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, pushA, "Bench Press")
            headField("Sets").performTextReplacement("5.0")
            assertEquals(List(5) { "8" to "60" }, ladder())
            compose.onNodeWithContentDescription("Set 5 load").performScrollTo().performTextReplacement("85")
            headField("Sets").performScrollTo().performTextReplacement("3")
            headField("Sets").performTextReplacement("5,")
            assertEquals(List(4) { "8" to "60" } + ("8" to "85"), ladder())
            compose.onNodeWithContentDescription("Set 5 reps").performScrollTo().performTextReplacement("5")
            compose.onNodeWithText("Done").performClick()
            compose.runOnIdle {
                assertEquals(List(4) { SetTarget(8, 60.0) } + SetTarget(5, 85.0),
                    draft().entry("bench-press")!!.sets)
            }
        } } finally { scope.cancel() }
    }

}
