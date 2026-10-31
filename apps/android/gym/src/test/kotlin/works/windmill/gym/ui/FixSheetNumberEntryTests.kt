package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.FixOrigin
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.gym.store.FixOutcome

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FixSheetNumberEntryTests {
    @get:Rule val compose = createComposeRule()

    private fun sheet(saved: MutableList<SetFix>, sensations: MutableList<HapticFeedbackType> = mutableListOf(),
        entryCancel: ((() -> Unit)?) -> Unit = {}, restoration: StateRestorationTester? = null) {
        val set = TrainingSet("set_1", exerciseId = "bench-press", setNumber = 2,
            weightKg = 82.5, reps = 5, completedAtMs = 0)
        val haptics = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { sensations += hapticFeedbackType }
        }
        val content: @androidx.compose.runtime.Composable () -> Unit = {
            CompositionLocalProvider(LocalHapticFeedback provides haptics) {
                GymMaterial {
                    FixSheet(set, "Bench Press", 2, null,
                        onSave = { saved += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {}, onEntryCancel = entryCancel)
                }
            }
        }
        if (restoration == null) compose.setContent(content) else restoration.setContent(content)
    }

    private fun loadedSheet(saved: MutableList<SetFix>, exercise: Exercise) {
        val set = TrainingSet("set_1", exerciseId = exercise.id, setNumber = 1, weightKg = 75.0, reps = 8, completedAtMs = 0)
        compose.setContent { GymMaterial {
            FixSheet(set, exercise.name, 1, null, onSave = { saved += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {},
                exercise = exercise)
        } }
    }

    @Test fun aBarbellLoadBelowZeroIsRefusedWithAMinusSignAndSaveFixWaits() {
        val saved = mutableListOf<SetFix>()
        loadedSheet(saved, Exercise("bench-press", "Bench Press", "press", "barbell", 2.5))
        compose.onNodeWithContentDescription("Load, kg total").performClick().performTextReplacement("-12.5")
        compose.onNodeWithContentDescription("Load, kg total").assertTextEquals("Load", "kg total", "−12.5")
        compose.onNodeWithText("Enter 0 or more, or cancel to keep 75").assertExists()
        compose.onNodeWithText("Save fix").assertIsNotEnabled().performClick()
        compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("0")
        compose.onNodeWithText("Enter 0 or more, or cancel to keep 75").assertDoesNotExist()
        compose.onNodeWithText("Save fix").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = 0.0)), saved) }
    }

    @Test fun aKeptBarbellLoadUnderZeroCannotBeSteppedDownAndStepsUpOnlyToZero() {
        val saved = mutableListOf<SetFix>()
        val set = TrainingSet("set_1", exerciseId = "bench-press", setNumber = 1, weightKg = -10.0, reps = 8, completedAtMs = 0)
        compose.setContent { GymMaterial {
            FixSheet(set, "Bench Press", 1, null, onSave = { saved += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {},
                exercise = Exercise("bench-press", "Bench Press", "press", "barbell", 2.5))
        } }
        val (bigDown, down, up) = works.windmill.gym.domain.Ladder.labels(-10.0)
        listOf(bigDown, down).forEach { compose.onNodeWithText(it).assertIsNotEnabled() }
        compose.onNodeWithContentDescription("Decrease Load").assertIsNotEnabled()
        compose.onNodeWithText(up).performClick()
        compose.onNodeWithContentDescription("Load, kg total").assertTextEquals("Load", "kg total", "0")
    }

    @Test fun aBodyweightLoadBelowZeroKeepsItsSign() {
        val saved = mutableListOf<SetFix>()
        loadedSheet(saved, Exercise("chin-up", "Chin Up", "pull", "bodyweight", 2.5))
        compose.onNodeWithContentDescription("Load, kg added").performClick().performTextReplacement("-12.5")
        compose.onNodeWithText("Enter 0 or more, or cancel to keep 75").assertDoesNotExist()
        compose.onNodeWithText("Save fix").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = -12.5)), saved) }
    }

    @Test fun signedCommaLoadCommitsOnDoneAndSaveContainsOnlyTheChangedFact() {
        val saved = mutableListOf<SetFix>()
        val sensations = mutableListOf<HapticFeedbackType>()
        sheet(saved, sensations)
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("-102,505")
        compose.onNodeWithContentDescription("Load, kg").performImeAction()
        compose.onNodeWithContentDescription("Load, kg").assertTextEquals("Load", "kg", "−102.51")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(weightKg = -102.51)), saved)
            assertEquals(listOf(HapticFeedbackType.TextHandleMove), sensations)
        }
    }

    @Test fun saveValidatesAndUsesTheStillFocusedBufferWithoutASeparateDone() {
        val saved = mutableListOf<SetFix>()
        val sensations = mutableListOf<HapticFeedbackType>()
        sheet(saved, sensations)
        compose.onNodeWithContentDescription("Reps, reps").performClick().performTextReplacement("8")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(reps = 8)), saved)
            assertEquals(emptyList<HapticFeedbackType>(), sensations)
        }
    }

    @Test fun invalidSaveRetainsRawInputAndCannotWriteThePreviousValue() {
        val saved = mutableListOf<SetFix>()
        sheet(saved)
        val field = compose.onNodeWithContentDescription("Load, kg")
        field.performClick().performTextReplacement("1e999")
        compose.onNodeWithText("Save fix").performClick()
        compose.onNodeWithText("That is not a number yet.").performScrollTo().assertExists()
        field.assertTextEquals("Load", "kg", "1e999").assertIsFocused()
        compose.runOnIdle { assertEquals(emptyList<SetFix>(), saved) }
        field.performTextReplacement("-499.99")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = -499.99)), saved) }
    }

    @Test fun invalidDoneRetainsFocusAndRepsRefusalThenAcceptsCorrection() {
        val saved = mutableListOf<SetFix>()
        sheet(saved)
        val field = compose.onNodeWithContentDescription("Reps, reps")
        field.performClick().performTextReplacement("100")
        field.performImeAction()
        field.assertTextEquals("Reps", "reps", "100").assertIsFocused()
        compose.onNodeWithText("Whole reps, 1 to 99.").assertExists()
        field.performTextReplacement("99")
        field.performImeAction()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(reps = 99)), saved) }
    }

    @Test fun leavingTheLoadCommitsItSilentlyAndAnUnreadableOneKeepsItsRefusal() {
        val saved = mutableListOf<SetFix>()
        val sensations = mutableListOf<HapticFeedbackType>()
        sheet(saved, sensations)
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("1e999")
        compose.onNodeWithContentDescription("Reps, reps").performClick()
        compose.onNodeWithContentDescription("Load, kg").assertTextEquals("Load", "kg", "1e999")
        compose.onNodeWithText(works.windmill.gym.domain.NumberEntry.notANumber).assertExists()
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("-12.5")
        compose.onNodeWithContentDescription("Reps, reps").performClick()
        compose.onNodeWithContentDescription("Load, kg").assertTextEquals("Load", "kg", "−12.5")
        compose.onNodeWithText(works.windmill.gym.domain.NumberEntry.notANumber).assertDoesNotExist()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(weightKg = -12.5)), saved)
            assertEquals(emptyList<HapticFeedbackType>(), sensations)
        }
    }

    @Test fun cancellingNativeEntryRestoresTheLastCommittedValue() {
        val saved = mutableListOf<SetFix>()
        var cancel: (() -> Unit)? = null
        sheet(saved, entryCancel = { cancel = it })
        val field = compose.onNodeWithContentDescription("Load, kg")
        field.performClick().performTextReplacement("-12.5")
        field.performImeAction()
        field.performClick().performTextReplacement("-")
        compose.runOnIdle { assertNotNull(cancel); cancel!!() }
        field.assertTextEquals("Load", "kg", "−12.5")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = -12.5)), saved) }
    }

    @Test fun ladderAndStepperChangesTickOnceWhileRefusedAndUnchangedActionsStayQuiet() {
        val saved = mutableListOf<SetFix>()
        val sensations = mutableListOf<HapticFeedbackType>()
        sheet(saved, sensations)
        compose.onNodeWithText("+2.5").performClick()
        compose.onNodeWithContentDescription("Increase Reps").performClick()
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("-")
        compose.onNodeWithText("+2.5").performClick()
        compose.onNodeWithText("Enter a number, or cancel to keep 85").assertExists()
        compose.onNodeWithContentDescription("Load, kg").performTextReplacement("85")
        compose.onNodeWithContentDescription("Load, kg").performImeAction()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(weightKg = 85.0, reps = 6)), saved)
            assertEquals(List(2) { HapticFeedbackType.TextHandleMove }, sensations)
        }
    }

    @Test fun rawLoadBandsAndRepsBoundsDescribeTheStepThatWillBeApplied() {
        val saved = mutableListOf<SetFix>()
        val sensations = mutableListOf<HapticFeedbackType>()
        sheet(saved, sensations)
        val load = compose.onNodeWithContentDescription("Load, kg")
        load.performClick().performTextReplacement("10")
        compose.onNodeWithText("+1").performClick()
        load.assertTextEquals("Load", "kg", "11")
        val reps = compose.onNodeWithContentDescription("Reps, reps")
        reps.performClick().performTextReplacement("99")
        reps.performImeAction()
        compose.onNodeWithContentDescription("Increase Reps").assertIsNotEnabled()
        reps.performClick().performTextReplacement("5")
        compose.onNodeWithContentDescription("Increase Reps").assertIsEnabled().performClick()
        reps.assertTextEquals("Reps", "reps", "6")
        reps.performTextReplacement("1")
        reps.performImeAction()
        compose.onNodeWithContentDescription("Decrease Reps").assertIsNotEnabled()
        reps.performClick().performTextReplacement("5")
        compose.onNodeWithContentDescription("Decrease Reps").assertIsEnabled().performClick()
        reps.assertTextEquals("Reps", "reps", "4")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetFix(weightKg = 11.0, reps = 4)), saved)
            assertEquals(List(5) { HapticFeedbackType.TextHandleMove }, sensations)
        }
    }

    @Test fun recreationRetainsAnUncommittedRawDraftForExplicitSave() {
        val saved = mutableListOf<SetFix>()
        val restoration = StateRestorationTester(compose)
        sheet(saved, restoration = restoration)
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("-12,5")
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Load, kg").assertTextEquals("Load", "kg", "−12,5")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = -12.5)), saved) }
    }
    @Test fun anInvalidSaveEmitsOneRefusalWithoutTheRawNumberOrNote() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                error("validation is not a technical failure")
            }
        }
        var saves = 0
        val set = TrainingSet("set_1", "bench-press", weightKg = 75.0, reps = 8, completedAtMs = 0)
        compose.setContent { CompositionLocalProvider(LocalTelemetry provides telemetry) { GymMaterial {
            FixSheet(set, "Private movement", 1, null, origin = FixOrigin.Workout,
                onSave = { saves++; FixOutcome.Corrected(set) }, onDelete = {})
        } } }
        compose.onNodeWithText("Set note").performTextReplacement("private note")
        val field = compose.onNodeWithContentDescription("Load, kg")
        field.performClick().performTextReplacement("1e999")
        field.performImeAction()
        compose.runOnIdle { assertEquals(emptyList<Pair<String, Map<String, String>>>(), events) }
        compose.onNodeWithText("Save fix").performClick()
        field.assertTextEquals("Load", "kg", "1e999").assertIsFocused()
        compose.runOnIdle {
            assertEquals(0, saves)
            assertEquals(listOf("gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "refused")), events)
        }
    }

}
