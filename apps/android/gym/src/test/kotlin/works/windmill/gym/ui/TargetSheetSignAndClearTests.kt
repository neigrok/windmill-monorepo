package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
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

// C6 and C7 on the routine target sheet: a refused clear hands the value back SELECTED, so the next
// digit replaces it instead of landing beside it; and the sign control is `±`, which is the only way
// a band-assisted target can be typed on a numeric keyboard.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TargetSheetSignAndClearTests {
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

    // The gesture the refusal protects: backspace to clear, then type the number you meant. If the
    // kept value comes back with the caret after it, the next digit APPENDS and the lifter is refused
    // a second time for a number they never typed.
    @Test
    fun testARefusedClearHandsTheValueBackSelectedSoTheNextDigitReplacesIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 82.5))

        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onNodeWithText("Clear reps and weight first — an open line names neither.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Sets target").assertTextContains("3")

        compose.onNodeWithContentDescription("Sets target").performTextInput("4")
        compose.onNodeWithContentDescription("Sets target").assertTextContains("4")
        compose.onNodeWithText("Sets, 1 to 20.").assertDoesNotExist()

        compose.onNodeWithText("Set  ·  ", substring = true).performClick()
        compose.runOnIdle {
            assertEquals("the digit replaced what was kept", 4, draft().entry("bench-press")!!.targetSets)
        }
        scope.cancel()
    }

    // Twice in a row is the same moment twice, not a second state: the second refused clear hands the
    // same value back, still selected, and the digit after it still replaces.
    @Test
    fun testASecondRefusedClearStillHandsTheValueBackSelected() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 82.5))

        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onNodeWithContentDescription("Sets target").performTextClearance()
        compose.onNodeWithText("Clear reps and weight first — an open line names neither.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Sets target").assertTextContains("3")

        compose.onNodeWithContentDescription("Sets target").performTextInput("5")
        compose.onNodeWithContentDescription("Sets target").assertTextContains("5")
        compose.onNodeWithText("Set  ·  ", substring = true).performClick()
        compose.runOnIdle {
            assertEquals(5, draft().entry("bench-press")!!.targetSets)
        }
        scope.cancel()
    }

    @Test
    fun testTheSignControlIsPlusMinusAndMakesABandAssistedTargetTypeable() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Pull Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 8, weightKg = 20.0))

        compose.onNodeWithContentDescription("Flip the sign").assertIsDisplayed()
        compose.onNodeWithText("±").assertIsDisplayed()

        compose.onNodeWithContentDescription("Flip the sign").performClick()
        compose.onNodeWithContentDescription("Weight target").assertTextContains("−20")

        compose.onNodeWithText("Set  ·  ", substring = true).performClick()
        compose.runOnIdle {
            assertEquals("band-assisted work is a negative load",
                         -20.0, draft().entry("bench-press")!!.targetWeightKg!!, 0.0001)
        }
        scope.cancel()
    }

    @Test
    fun testTheSignFlipsBackAndNeverDoublesItself() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Pull Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 8, weightKg = -20.0))

        compose.onNodeWithContentDescription("Weight target").assertTextContains("−20")
        compose.onNodeWithContentDescription("Flip the sign").performClick()
        compose.onNodeWithContentDescription("Weight target").assertTextContains("20")

        compose.onNodeWithContentDescription("Flip the sign").performClick()
        compose.onNodeWithContentDescription("Weight target").assertTextContains("−20")
        scope.cancel()
    }

    // C17: the glyph reads as nothing out loud, so both halves of the control's accessible name are
    // the same pinned bytes — the label TalkBack speaks for the click, and the description.
    @Test
    fun testTheSignControlIsNamedTheSameBytesForItsClickAndItsDescription() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Pull Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 8, weightKg = 20.0))

        val sign = compose.onNodeWithContentDescription("Flip the sign").fetchSemanticsNode()
        assertEquals(listOf("Flip the sign"), sign.config[SemanticsProperties.ContentDescription])
        assertEquals("Flip the sign", sign.config[SemanticsActions.OnClick].label)
        scope.cancel()
    }

    // An empty weight field is `last time`, and a sign with no number behind it is not a load.
    @Test
    fun testTheSignOnAnEmptyFieldLeavesItEmpty() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Pull Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 8, weightKg = null))

        compose.onNodeWithContentDescription("Flip the sign").performClick()
        compose.onNodeWithText("That is not a number yet.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Weight target").performTextReplacement("20")
        compose.onNodeWithContentDescription("Weight target").assertTextContains("20")
        scope.cancel()
    }
}
