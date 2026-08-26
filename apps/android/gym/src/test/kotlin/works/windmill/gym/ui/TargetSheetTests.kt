package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore

// The target sheet after the ± ladder came off it: three typed fields, the six refusals under the
// field they belong to, and the clear that is refused rather than cascading.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TargetSheetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope) = TrainingStore(
        queue = SetQueue(File(tmp.root, "queue.json")),
        deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
        localLog = LocalLog(File(tmp.root, "local.json")),
        localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
        localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
        scope = scope,
        sync = { null },
    )

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
                onDelete = {},
                onClose = {},
                say = {},
            )
        }
        compose.onNodeWithText("bench-press").performClick()
        return { draft }
    }

    @Test
    fun testEachRefusalIsSaidUnderItsOwnFieldAndSaveWaitsForIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 82.5))

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("0")
        compose.onNodeWithText("A zero target is no target — clear the field instead.").assertIsDisplayed()
        compose.onNodeWithText("Set  ·  ", substring = true).assertIsNotEnabled()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("21")
        compose.onNodeWithText("Sets, 1 to 20.").assertIsDisplayed()
        compose.onNodeWithText("A zero target is no target — clear the field instead.").assertDoesNotExist()

        compose.onNodeWithContentDescription("Sets target").performTextReplacement("3")
        compose.onNodeWithContentDescription("Reps target").performTextReplacement("101")
        compose.onNodeWithText("Whole reps, 1 to 100.").assertIsDisplayed()

        compose.onNodeWithContentDescription("Reps target").performTextReplacement("5")
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("82.5.0")
        compose.onNodeWithText("One decimal point only.").assertIsDisplayed()

        compose.onNodeWithContentDescription("Weight target").performTextReplacement("501")
        compose.onNodeWithText("Over 500 kg — check the number.").assertIsDisplayed()

        compose.onNodeWithContentDescription("Weight target").performTextReplacement("eighty")
        compose.onNodeWithText("That is not a number yet.").assertIsDisplayed()

        // With every field readable the hint stands where the refusal was.
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("100")
        compose.onNodeWithText("comma or point, both read as a decimal").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testClearingSetsIsRefusedWhileTheOtherTwoHoldValuesAndOpensTheLineWhenTheyDoNot() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 82.5))

        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onNodeWithText("Clear reps and weight first — an open line names neither.").assertIsDisplayed()
        // The clear is REFUSED: the field keeps what it had.
        compose.onNodeWithContentDescription("Sets target").assertTextContains("3")

        compose.onNodeWithContentDescription("Reps target").performTextClearance()
        compose.onNodeWithContentDescription("Weight target").performTextClearance()
        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onNodeWithText("Clear reps and weight first — an open line names neither.").assertDoesNotExist()

        compose.onNodeWithText("Set  ·  ", substring = true).performClick()
        compose.runOnIdle {
            val entry = draft().entry("bench-press")!!
            assertEquals("an open line names no sets", null, entry.targetSets)
            assertEquals("so it names no reps", null, entry.targetReps)
            assertEquals("and no load either", null, entry.targetWeightKg)
        }
        scope.cancel()
    }

    // A movement added from the picker opens with all three fields empty; typing into two of them
    // and leaving the third is the way an open line takes two numbers away without a word.
    @Test
    fun testTypingRepsAndWeightAgainstAnEmptySetsFieldIsRefusedRatherThanSilentlyDropped() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press"))

        compose.onNodeWithContentDescription("Reps target").performTextReplacement("8")
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("82.5")

        compose.onNodeWithText("Name the sets first — an open line names neither.").assertIsDisplayed()
        compose.onNodeWithText("comma or point, both read as a decimal").assertDoesNotExist()
        compose.onNodeWithText("Set  ·  ", substring = true).assertIsNotEnabled()

        // Naming the sets is the way out, and the two numbers the lifter typed are still there.
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("4")
        compose.onNodeWithText("Name the sets first — an open line names neither.").assertDoesNotExist()
        compose.onNodeWithText("Set  ·  ", substring = true).performClick()
        compose.runOnIdle {
            val entry = draft().entry("bench-press")!!
            assertEquals(4, entry.targetSets)
            assertEquals(8, entry.targetReps)
            assertEquals(82.5, entry.targetWeightKg!!, 0.0001)
        }
        scope.cancel()
    }

    // 15-the-routine pins the open line's sentence on EVERY surface, and C19 pins how many: while the
    // sheet stands it OWNS the sentence, and the editor's copy beneath the movement list stands down.
    // One state says it once — never a blessing behind a scrim beside a refusal in front of it.
    @Test
    fun testTheOpenLineSaysWhatItMeansWhereTheLifterDecidesIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press"))

        // The sheet's own, and the only one on screen: the row behind it is open too.
        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(1)
        compose.onNodeWithText("Never logged — these are your numbers.").assertIsDisplayed()

        // It goes the moment the line names a number, and nothing steps in behind it: the ROW stays
        // open until Set is pressed, and the list under the scrim says nothing while the sheet stands.
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("3")
        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(0)

        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(1)
        scope.cancel()
    }

    // C15: a statement about the whole line sits ABOVE the three fields, beside the never-logged
    // line; everything drawn UNDER a field is that field's own note, which is the decimal hint.
    @Test
    fun testTheOpenLineSitsAboveTheThreeFieldsAndTheDecimalHintBelowThem() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        // Every line of this draft names its numbers, so the editor behind the sheet says nothing and
        // the sentence on screen is the sheet's own.
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 82.5))
        compose.onNodeWithContentDescription("Reps target").performTextClearance()
        compose.onNodeWithContentDescription("Weight target").performTextClearance()
        compose.onNodeWithContentDescription("Sets target").performTextClearance()

        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(1)
        val sentence = compose.onNodeWithText("You decide the numbers at the rack.")
            .fetchSemanticsNode().positionInRoot.y
        val neverLogged = compose.onNodeWithText("Never logged — these are your numbers.")
            .fetchSemanticsNode().positionInRoot.y
        val sets = compose.onNodeWithContentDescription("Sets target").fetchSemanticsNode().positionInRoot.y
        val hint = compose.onNodeWithText("comma or point, both read as a decimal")
            .fetchSemanticsNode().positionInRoot.y

        assertTrue("beside the never-logged line", sentence > neverLogged)
        assertTrue("and above the three fields", sentence < sets)
        assertTrue("the decimal hint is a field's own note and stays under them", hint > sets)
        scope.cancel()
    }

    @Test
    fun testAClearedFieldIsTheNullAndTheOthersStillWrite() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 82.5))

        compose.onNodeWithContentDescription("Weight target").performTextClearance()
        compose.onNodeWithContentDescription("Reps target").performTextReplacement("8")
        compose.onNodeWithText("Set  ·  ", substring = true).performClick()

        compose.runOnIdle {
            val entry = draft().entry("bench-press")!!
            assertEquals(3, entry.targetSets)
            assertEquals(8, entry.targetReps)
            assertEquals("a cleared load means `last time`", null, entry.targetWeightKg)
        }
        scope.cancel()
    }
}
