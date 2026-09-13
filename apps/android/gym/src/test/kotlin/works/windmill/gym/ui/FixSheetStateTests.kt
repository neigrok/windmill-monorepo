package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.WriteFailure

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FixSheetStateTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun pendingSaveBlocksEditsAndDeleteThenRetainsTheDraftForRetry() {
        val set = TrainingSet(id = "set_3", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, kind = SetKind.Drop, completedAtMs = 0)
        val answer = CompletableDeferred<FixOutcome>()
        val attempts = mutableListOf<SetFix>()
        val busy = mutableListOf<Boolean>()
        var saves = 0
        var deletes = 0
        compose.setContent {
            FixSheet(set, "Bench Press", 3, "Push A",
                onSave = {
                    attempts += it
                    if (attempts.size == 1) answer.await() else FixOutcome.Corrected(it.corrected(set))
                },
                onDelete = { deletes++ }, onSaved = { saves++ }, onBusy = { busy += it })
        }
        compose.onNodeWithText("Bench Press · Set 3").assertIsDisplayed()
        compose.onNodeWithText("Set note").performTextInput("left shoulder")
        compose.onNodeWithText("Save fix").performClick()
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Delete set").assertIsNotEnabled().performClick()
        compose.onNodeWithText("60").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(note = "left shoulder")), attempts)
            assertEquals(listOf(true), busy)
            assertEquals(0, deletes)
            assertEquals(0, saves)
            answer.complete(FixOutcome.Failed(WriteFailure.NoAnswer))
        }
        compose.onNodeWithText("The log didn’t answer — that set wasn’t changed.").assertIsDisplayed()
        compose.onNodeWithText("left shoulder").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(note = "left shoulder"), SetFix(note = "left shoulder")), attempts)
            assertEquals(listOf(true, false, true, false), busy)
            assertEquals(1, saves)
        }
    }

    @Test
    fun bodyAndRefusedEmbeddedBufferSurviveRestorationThenCancelKeepsTheBodyDraft() {
        val set = TrainingSet(id = "set_3", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, kind = SetKind.Working, completedAtMs = 0)
        val restorer = StateRestorationTester(compose)
        val attempts = mutableListOf<SetFix>()
        restorer.setContent {
            FixSheet(set, "Bench Press", 3, "Push A", onSave = {
                attempts += it
                FixOutcome.Failed(WriteFailure.Refused("This workout belongs to another account."))
            }, onDelete = {})
        }
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithText("60").performClick()
        compose.onNodeWithText("5").performClick()
        compose.onNodeWithText("2").performClick()
        compose.onNodeWithText("0").performClick()
        restorer.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("520").assertIsDisplayed()
        compose.onNodeWithText(KeypadEntry.overWeight).assertIsDisplayed()
        compose.onNodeWithText("Set weight").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("60").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performClick()
        restorer.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("This workout belongs to another account.").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(SetFix(note = "controlled tempo")), attempts) }
    }

    @Test
    fun missingSetReportsItsOwnerOutcomeWithoutPretendingToSave() {
        val set = TrainingSet(id = "gone", exerciseId = "bench-press", setNumber = 7,
            weightKg = 60.0, reps = 8, kind = SetKind.Working, completedAtMs = 0)
        val missing = mutableListOf<String>()
        var saves = 0
        compose.setContent {
            FixSheet(set, "Bench Press", 7, null,
                onSave = { FixOutcome.Gone("That set is no longer in the log.") },
                onDelete = {}, onSaved = { saves++ }, onGone = { missing += it })
        }
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(listOf("That set is no longer in the log."), missing)
            assertEquals(0, saves)
        }
    }
    @Test
    fun canonicalSetIdDoesNotReplaceTheBodyOrOpenKeypadDraft() {
        var set by mutableStateOf(TrainingSet(id = "local_set", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, kind = SetKind.Working, completedAtMs = 0))
        val attempts = mutableListOf<SetFix>()
        compose.setContent {
            FixSheet(set, "Bench Press", 3, "Push A", draftKey = "local_set",
                onSave = { attempts += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {})
        }
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithText("60").performClick()
        compose.onNodeWithText("7").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("Set weight").performClick()
        compose.onNodeWithText("8").performClick()
        compose.onNodeWithText("1").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("0").performClick()
        compose.runOnIdle { set = set.copy(id = "canonical_set") }
        compose.onNodeWithText("100").assertIsDisplayed()
        compose.onNodeWithText(KeypadEntry.outsideReps).assertIsDisplayed()
        compose.onNodeWithText("Set reps").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("70").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = 70.0, note = "controlled tempo")), attempts) }
    }

    @Test
    fun canonicalSetIdKeepsAnInFlightSaveLockedAndItsRefusalEditable() {
        var set by mutableStateOf(TrainingSet(id = "local_set", exerciseId = "bench-press", setNumber = 3,
            weightKg = 60.0, reps = 8, kind = SetKind.Working, completedAtMs = 0))
        val answer = CompletableDeferred<FixOutcome>()
        val attempts = mutableListOf<SetFix>()
        val busy = mutableListOf<Boolean>()
        compose.setContent {
            FixSheet(set, "Bench Press", 3, "Push A", draftKey = "local_set",
                onSave = { attempts += it; answer.await() }, onDelete = {}, onBusy = { busy += it })
        }
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { set = set.copy(id = "canonical_set") }
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Delete set").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(note = "controlled tempo")), attempts)
            assertEquals(listOf(true), busy)
            answer.complete(FixOutcome.Failed(WriteFailure.NoAnswer))
        }
        compose.onNodeWithText("The log didn’t answer — that set wasn’t changed.").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.runOnIdle { set = set.copy(id = "reconciled_set") }
        compose.onNodeWithText("The log didn’t answer — that set wasn’t changed.").assertIsDisplayed()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf(true, false), busy)
            assertEquals(listOf(SetFix(note = "controlled tempo")), attempts)
        }
    }

}
