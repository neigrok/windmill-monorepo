package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
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
import androidx.compose.ui.test.performScrollTo
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

// 17-set-targets: the sheet's two zooms — the head that speaks about every set at once and the
// ladder with a row per set — on the brief's two fixtures, the ramp and the straight scheme.
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

    // Connected for nobody, so the catalog holds the six by name and equipment.
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

    private fun editor(scope: CoroutineScope, opening: RoutineDraft, movement: String): () -> RoutineDraft {
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
        compose.onNodeWithText(movement).performClick()
        return { draft }
    }

    private fun typed(description: String): String =
        compose.onNodeWithContentDescription(description).fetchSemanticsNode()
            .config[SemanticsProperties.EditableText].text

    private fun head(): List<String> = listOf(typed("Sets target"), typed("Reps target"), typed("Weight target"))

    private fun ladder(): List<Pair<String, String>> =
        generateSequence(1) { it + 1 }
            .takeWhile { compose.onAllNodesWithContentDescription("Set $it reps").fetchSemanticsNodes().isNotEmpty() }
            .map { typed("Set $it reps") to typed("Set $it load") }
            .toList()

    // `Set · {tail}` with a reading, `Set` alone while something is refused.
    private fun commit() = compose.onNode(SemanticsMatcher("the commit") { node ->
        node.config.getOrNull(SemanticsProperties.Text)?.any { it.text == "Set" || it.text.startsWith("Set · ") } == true
    })

    private fun yOf(description: String): Float =
        compose.onNodeWithContentDescription(description).fetchSemanticsNode().positionInRoot.y

    private fun deleteAction(row: Int): () -> Boolean {
        val rows = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions), useUnmergedTree = true)
            .fetchSemanticsNodes()
            .filter { node -> node.config[SemanticsActions.CustomActions].any { it.label == TargetEntry.delete } }
        return rows[row - 1].config[SemanticsActions.CustomActions].single { it.label == TargetEntry.delete }.action!!
    }

    @Test
    fun testTheRampOpensWithTheHeadSayingVariesAndFiveRowsUnderIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")

        assertEquals(listOf("5", "", ""), head())
        compose.onAllNodesWithText(TargetEntry.varies, useUnmergedTree = true).assertCountEquals(2)
        assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80"), ladder())
        compose.onNodeWithText("1 of 2 · Lower A").assertIsDisplayed()
        commit().assertIsEnabled()
        compose.onNodeWithText("Set · 5 sets").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testTheStraightSchemeOpensWithItsThreeNumbersInTheHeadAndTheRowsAgreeing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, pushA, "Bench Press")

        assertEquals(listOf("3", "8", "60"), head())
        compose.onAllNodesWithText(TargetEntry.varies, useUnmergedTree = true).assertCountEquals(0)
        assertEquals(List(3) { "8" to "60" }, ladder())
        compose.onNodeWithText("Set · 3 × 8 · 60").assertIsDisplayed()
        scope.cancel()
    }

    // A new row copies the row above it: `5 → 6` on a ramp adds a sixth set at the last set's numbers.
    @Test
    fun testGrowingSetsCopiesTheRowAboveAndTheDraftCommitsSixSets() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("6")
        assertEquals(ramp.map { "${it.reps}" to "${it.weightKg!!.toInt()}" } + ("5" to "80"), ladder())
        compose.onNodeWithText("Set · 6 sets").performClick()
        compose.runOnIdle {
            assertEquals(ramp + SetTarget(5, 80.0), draft().entry("back-squat")!!.sets)
        }
        scope.cancel()
    }

    // The copy-down needs no control of its own: typing over `varies` writes every row.
    @Test
    fun testTypingTheHeadRepsWritesEveryRow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Reps target").performTextReplacement("8")
        assertEquals(listOf("8" to "60", "8" to "80", "8" to "90", "8" to "100", "8" to "80"), ladder())
        assertEquals(listOf("5", "8", ""), head())
        commit().performClick()
        compose.runOnIdle {
            assertEquals(ramp.map { it.copy(reps = 8) }, draft().entry("back-squat")!!.sets)
        }
        scope.cancel()
    }

    // The ladder is hidden, not thrown away: a cleared count disables the other two fields and
    // takes the rows off the sheet, and retyping the count brings the same rows back.
    @Test
    fun testClearingSetsHidesTheLadderWithoutDiscardingItAndRetypingBringsItBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onNodeWithContentDescription("Reps target").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Weight target").assertIsNotEnabled()
        assertEquals(emptyList<Pair<String, String>>(), ladder())
        compose.onNodeWithText(TargetEntry.setBySet).assertDoesNotExist()
        compose.onNodeWithText(TargetEntry.openLine).assertIsDisplayed()
        compose.onNodeWithText("Set · open").assertIsDisplayed()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("5")
        compose.onNodeWithText(TargetEntry.openLine).assertDoesNotExist()
        assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80"), ladder())
        compose.onNodeWithText("Set · 5 sets").performClick()
        compose.runOnIdle { assertEquals(ramp, draft().entry("back-squat")!!.sets) }
        scope.cancel()
    }

    // Only the commit of an open line drops the rows.
    @Test
    fun testCommittingWithSetsEmptyOpensTheLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onNodeWithText("Set · open").performClick()
        compose.runOnIdle {
            assertEquals(emptyList<SetTarget>(), draft().entry("back-squat")!!.sets)
            assertTrue(draft().entry("back-squat")!!.isOpen)
        }
        scope.cancel()
    }

    // The pyramid in two typed ends and one tap: the rows between are interpolated, loads onto the
    // ladder's grid and reps to the nearest whole.
    @Test
    fun testFillRampUpInterpolatesBetweenTheTwoEnds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")
        (2..4).forEach {
            compose.onNodeWithContentDescription("Set $it reps").performTextClearance()
            compose.onNodeWithContentDescription("Set $it load").performTextClearance()
        }
        assertEquals(listOf("5" to "60", "" to "", "" to "", "" to "", "5" to "80"), ladder())
        compose.onNodeWithContentDescription("Set 5 reps").performTextReplacement("1")
        compose.onNodeWithContentDescription("Set 5 load").performTextReplacement("100")

        compose.onNodeWithText(TargetEntry.fill).performClick()
        compose.onNodeWithText(TargetEntry.rampUp).assertIsEnabled().performClick()
        assertEquals(listOf("5" to "60", "4" to "70", "3" to "80", "2" to "90", "1" to "100"), ladder())
        compose.onNodeWithText(TargetEntry.rampUp).assertDoesNotExist()
        scope.cancel()
    }

    // Nothing to ramp between ends that agree.
    @Test
    fun testRampUpIsDisabledWhileSetOneAndSetNAgree() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, pushA, "Bench Press")

        compose.onNodeWithText(TargetEntry.fill).performClick()
        compose.onNodeWithText(TargetEntry.rampUp).assertIsNotEnabled()
        compose.onNodeWithText(TargetEntry.matchSetOne).assertIsEnabled()
        scope.cancel()
    }

    // The way back from a ladder to a straight scheme without retyping the head.
    @Test
    fun testFillMatchSetOneWritesSetOneIntoEveryRow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, lowerA, "Back Squat")

        compose.onNodeWithText(TargetEntry.fill).performClick()
        compose.onNodeWithText(TargetEntry.matchSetOne).performClick()
        assertEquals(List(5) { "5" to "60" }, ladder())
        assertEquals(listOf("5", "5", "60"), head())
        compose.onNodeWithText("Set · 5 × 5 · 60").performClick()
        compose.runOnIdle { assertEquals(List(5) { SetTarget(5, 60.0) }, draft().entry("back-squat")!!.sets) }
        scope.cancel()
    }

    @Test
    fun testAddSetAppendsACopyOfTheLastRowAndCountsIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")

        compose.onNodeWithText(TargetEntry.addSet).performClick()
        assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80", "5" to "80"), ladder())
        assertEquals(listOf("6", "", ""), head())
        compose.onNodeWithText(TargetEntry.outsideSets).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun testAddSetIsInertAtTwentyAndSaysTheBand() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val twenty = RoutineDraft(name = "Push A").adding("bench-press")
            .targeting("bench-press", List(20) { SetTarget(8, 60.0) })
        editor(scope, twenty, "Bench Press")
        assertEquals("20", typed("Sets target"))

        // Twenty rows outrun the sheet: Add set is the body's last row, under the scroll.
        compose.onNodeWithText(TargetEntry.addSet).performScrollTo().performClick()
        compose.onNodeWithText(TargetEntry.outsideSets).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Set · 20 × 8 · 60").assertIsDisplayed()

        // The next keystroke anywhere on the sheet clears it.
        compose.onNodeWithContentDescription("Set 1 reps").performScrollTo().performTextReplacement("9")
        compose.onNodeWithText(TargetEntry.outsideSets).assertDoesNotExist()
        scope.cancel()
    }

    // The rows outlive the count typed over them: `5 → 1 → 12` keeps the ramp, the count is the
    // shown prefix, and the commit slices to it.
    @Test
    fun testACountTypedLowAndBackHighKeepsTheRamp() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("1")
        assertEquals(listOf("5" to "60"), ladder())
        assertEquals(listOf("1", "5", "60"), head())
        compose.onNodeWithText("Set · 1 × 5 · 60").assertIsDisplayed()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("12")
        assertEquals(
            listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80") + List(7) { "5" to "80" },
            ladder(),
        )

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("3")
        assertEquals(listOf("5" to "60", "5" to "80", "3" to "90"), ladder())
        compose.onNodeWithText("Set · 3 sets").performClick()
        compose.runOnIdle { assertEquals(ramp.take(3), draft().entry("back-squat")!!.sets) }
        scope.cancel()
    }

    // Add set reveals the next hidden row while there is one, and copies the last shown row after.
    @Test
    fun testAddSetRevealsTheNextHiddenRowBeforeCopyingTheLastShown() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("2")
        assertEquals(listOf("5" to "60", "5" to "80"), ladder())
        compose.onNodeWithText(TargetEntry.addSet).performClick()
        assertEquals(listOf("5" to "60", "5" to "80", "3" to "90"), ladder())
        assertEquals("3", typed("Sets target"))
        repeat(2) { compose.onNodeWithText(TargetEntry.addSet).performClick() }
        assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80"), ladder())
        compose.onNodeWithText(TargetEntry.addSet).performClick()
        assertEquals(listOf("5" to "60", "5" to "80", "3" to "90", "1" to "100", "5" to "80", "5" to "80"), ladder())
        assertEquals("6", typed("Sets target"))
        scope.cancel()
    }

    // A swipe-Delete takes that row out of the array and the count down by one; the hidden tail
    // stands and comes back when the count is typed up.
    @Test
    fun testDeletingAShownRowKeepsTheHiddenTail() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("3")
        val delete = deleteAction(2)
        compose.runOnIdle { delete() }
        assertEquals(listOf("5" to "60", "3" to "90"), ladder())
        assertEquals("2", typed("Sets target"))
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("4")
        assertEquals(listOf("5" to "60", "3" to "90", "1" to "100", "5" to "80"), ladder())
        scope.cancel()
    }

    // A refusal typed in the head is said under the head field — the field itself in the error
    // state, the row it was written into clean — and the commit reads `Set`, disabled.
    @Test
    fun testARefusalTypedInTheHeadIsSaidUnderTheHeadField() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Reps target").performTextReplacement("101")
        val said = compose.onNodeWithText(TargetEntry.outsideReps).assertIsDisplayed().fetchSemanticsNode().positionInRoot.y
        assertTrue("under the head", said > yOf("Reps target"))
        assertTrue("and above row 1", said < yOf("Set 1 reps"))
        compose.onNodeWithContentDescription("Reps target").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Error))
        compose.onNodeWithContentDescription("Set 1 reps").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Error))
        commit().assertIsNotEnabled()
        compose.onNodeWithText("Set").assertIsDisplayed()

        compose.onNodeWithContentDescription("Weight target").performTextReplacement("501")
        compose.onNodeWithContentDescription("Reps target").performTextReplacement("8")
        val load = compose.onNodeWithText(TargetEntry.overWeight).assertIsDisplayed().fetchSemanticsNode().positionInRoot.y
        assertTrue(load > yOf("Weight target") && load < yOf("Set 1 load"))
        compose.onNodeWithContentDescription("Weight target").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Error))
        scope.cancel()
    }

    // Law 1: the row's swipe is half-built until its custom action exists. Deleting decrements Sets.
    @Test
    fun testTheRowsDeleteActionRemovesItAndDecrementsSets() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, lowerA, "Back Squat")

        val delete = deleteAction(2)
        compose.runOnIdle { delete() }
        assertEquals(listOf("5" to "60", "3" to "90", "1" to "100", "5" to "80"), ladder())
        assertEquals(listOf("4", "", ""), head())
        compose.onNodeWithText("Set · 4 sets").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetTarget(5, 60.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)),
                         draft().entry("back-squat")!!.sets)
        }
        scope.cancel()
    }

    // Deleting the last set is the same act as clearing Sets, and lands on the same open line.
    @Test
    fun testDeletingTheOnlyRowLandsOnTheOpenLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val one = RoutineDraft(name = "Push A").adding("bench-press").targeting("bench-press", listOf(SetTarget(8, 60.0)))
        editor(scope, one, "Bench Press")

        val delete = deleteAction(1)
        compose.runOnIdle { delete() }
        assertEquals(listOf("", "", ""), head())
        assertEquals(emptyList<Pair<String, String>>(), ladder())
        compose.onNodeWithText(TargetEntry.openLine).assertIsDisplayed()
        compose.onNodeWithText("Set · open").assertIsDisplayed()
        scope.cancel()
    }

    // A row's fault is drawn under THAT row, in the pinned words, and holds the commit.
    @Test
    fun testARowsFaultIsSaidUnderItsOwnRowAndHoldsTheCommit() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")

        compose.onNodeWithContentDescription("Set 3 reps").performTextReplacement("0")
        val said = compose.onNodeWithText(TargetEntry.zeroTarget).assertIsDisplayed().fetchSemanticsNode().positionInRoot.y
        val row3 = compose.onNodeWithContentDescription("Set 3 reps").fetchSemanticsNode().positionInRoot.y
        val row4 = compose.onNodeWithContentDescription("Set 4 reps").fetchSemanticsNode().positionInRoot.y
        assertTrue("under row 3", said > row3)
        assertTrue("and above row 4", said < row4)
        commit().assertIsNotEnabled()
        compose.onNodeWithText("Set").assertIsDisplayed()

        // Topmost first: a second fault lower down waits its turn.
        compose.onNodeWithContentDescription("Set 5 load").performTextReplacement("501")
        compose.onAllNodesWithText(TargetEntry.zeroTarget).assertCountEquals(1)
        compose.onNodeWithText(TargetEntry.overWeight).assertDoesNotExist()
        compose.onNodeWithContentDescription("Set 3 reps").performTextReplacement("3")
        compose.onNodeWithText(TargetEntry.overWeight).assertIsDisplayed()
        scope.cancel()
    }

    // text-budget: at first paint on the ramp the sheet's chrome is the brief's fourteen words. The
    // movement, the place line, the never-logged line, the numbers and the placeholders — what
    // empty means — are content.
    @Test
    fun testTheChromeAtFirstPaintIsTheFourteenPinnedWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, lowerA, "Back Squat")

        val sheet = compose.onNodeWithText("Set · 5 sets").fetchSemanticsNode().root
        val words = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true)
            .fetchSemanticsNodes()
            .filter { it.root == sheet }
            .flatMap { node -> node.config[SemanticsProperties.Text].map { it.text } }
        val content = setOf("Back Squat", "1 of 2 · Lower A", "Never logged — these are your numbers.",
                            TargetEntry.varies, TargetEntry.repsPlaceholder, TargetEntry.weightPlaceholder)
        val chrome = words.filterNot { it in content || it.all { c -> c.isDigit() || c == '.' } }

        assertEquals(
            listOf("Every set", "Sets", "Reps", "Weight", "Set by set", "Fill", "Add set", "Set · 5 sets"),
            chrome,
        )
        assertEquals(14, chrome.flatMap { it.split(" ") }.count { it != "·" })
        scope.cancel()
    }
}
