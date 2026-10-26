package works.windmill.gym.ui

import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextReplacement
import kotlinx.coroutines.awaitCancellation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NumberStepperTests {
    @get:Rule val compose = createComposeRule()

    @Test fun rawInputStaysWithTheOwnerAndOnlyAcceptedCommitsTick() {
        val drafts = mutableListOf<String>()
        val commits = mutableListOf<String>()
        val sensations = mutableListOf<HapticFeedbackType>()
        val feedback = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { sensations += hapticFeedbackType }
        }
        compose.setContent {
            var value by remember { mutableStateOf("20") }
            CompositionLocalProvider(LocalHapticFeedback provides feedback) {
                GymMaterial {
                    NumberStepper(value, { value = it; drafts += it }, "Load", "kg total",
                        onStep = { NumberEditResult.Unchanged }, onCommit = { commits += value; NumberEditResult.Changed },
                        input = NumberStepperInput.SignedDecimal)
                }
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg total")
        field.performClick().performTextReplacement("-12.5")
        compose.runOnIdle {
            assertEquals(listOf("-12.5"), drafts)
            assertEquals(emptyList<String>(), commits)
            assertEquals(emptyList<HapticFeedbackType>(), sensations)
        }
        field.performImeAction()
        compose.runOnIdle {
            assertEquals(listOf("-12.5"), commits)
            assertEquals(listOf(HapticFeedbackType.TextHandleMove), sensations)
        }
    }

    @Test fun refusedAndUnchangedStepsDoNotTickAndExternalValuesStaySilent() {
        val sensations = mutableListOf<HapticFeedbackType>()
        val feedback = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { sensations += hapticFeedbackType }
        }
        val text = mutableStateOf("8")
        val haptics = mutableStateOf(true)
        var attempt = 0
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides feedback) {
                GymMaterial {
                    NumberStepper(text.value, { text.value = it }, "Reps", "reps", onStep = {
                        when (++attempt) {
                            1 -> NumberEditResult.Refused
                            2 -> NumberEditResult.Unchanged
                            else -> { text.value = "9"; NumberEditResult.Changed }
                        }
                    }, onCommit = { NumberEditResult.Unchanged }, reducedMotion = true, hapticsEnabled = haptics.value)
                }
            }
        }
        repeat(3) { compose.onNodeWithContentDescription("Increase Reps").performClick() }
        compose.runOnIdle { text.value = "12" }
        compose.onNodeWithContentDescription("Reps, reps").assertTextEquals("Reps", "reps", "12")
        compose.runOnIdle { haptics.value = false }
        compose.onNodeWithContentDescription("Increase Reps").performClick()
        compose.runOnIdle { assertEquals(listOf(HapticFeedbackType.TextHandleMove), sensations) }
    }

    @Test fun refusedDoneKeepsFocusAndSupportingText() {
        var commits = 0
        compose.setContent {
            GymMaterial {
                NumberStepper("0", {}, "Sets", "sets", onStep = { NumberEditResult.Refused },
                    onCommit = { commits += 1; NumberEditResult.Refused }, refusal = "Sets, 1 to 20.")
            }
        }
        val field = compose.onNodeWithContentDescription("Sets, sets")
        field.performClick().performImeAction()
        field.assertIsFocused()
        compose.onNodeWithText("Sets, 1 to 20.").assertExists()
        compose.runOnIdle { assertEquals(1, commits) }
    }

    @Test fun disabledCommitAndDisabledSteppingDoNotCallTheOwner() {
        var calls = 0
        compose.setContent {
            GymMaterial {
                NumberStepper("0", {}, "Sets", "sets", onStep = { calls++; NumberEditResult.Changed },
                    onCommit = { calls++; NumberEditResult.Changed }, refusal = "Sets, 1 to 20.",
                    commitEnabled = false, decreaseEnabled = false, increaseEnabled = false)
            }
        }
        compose.onNodeWithContentDescription("Decrease Sets").performClick()
        compose.onNodeWithContentDescription("Increase Sets").performClick()
        val field = compose.onNodeWithContentDescription("Sets, sets")
        field.performClick().performImeAction()
        field.assertIsFocused()
        compose.runOnIdle { assertEquals(0, calls) }
    }

    @Test fun aLongSignedDisplayValueRemainsTheEditorsCompleteAccessibleValue() {
        compose.setContent {
            GymMaterial {
                NumberStepper("-102.5", {}, "Load", "kg each", onStep = { NumberEditResult.Unchanged },
                    onCommit = { NumberEditResult.Unchanged }, size = NumberStepperSize.Display,
                    input = NumberStepperInput.SignedDecimal)
            }
        }
        compose.onNodeWithContentDescription("Load, kg each").assertTextEquals("Load", "kg each", "-102.5")
        compose.onNodeWithText("kg each").assertExists()
    }

    @Test fun validSignedDisplayValuesFitAtBothWidthsAndTextScalesAtEitherCaretEnd() {
        val text = mutableStateOf("24")
        val width = mutableStateOf(372)
        val scale = mutableStateOf(1f)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, scale.value)) {
                GymMaterial {
                    NumberStepper(text.value, { text.value = it }, "Load", "kg added",
                        onStep = { NumberEditResult.Unchanged }, onCommit = { NumberEditResult.Unchanged },
                        modifier = Modifier.width(width.value.dp), size = NumberStepperSize.Display,
                        input = NumberStepperInput.SignedDecimal)
                }
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg added")
        for (controlWidth in listOf(372, 280)) for (fontScale in listOf(1f, 2f)) {
            compose.runOnIdle { width.value = controlWidth; scale.value = fontScale }
            for (value in listOf("24", "-12.5", "-102.5", "-499.99")) {
                compose.runOnIdle { text.value = value }
                field.assertTextEquals("Load", "kg added", value)
                val layouts = mutableListOf<TextLayoutResult>()
                field.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
                val layout = layouts.single()
                val available = field.fetchSemanticsNode().boundsInRoot.width - 64f
                assertTrue("$value at $controlWidth dp / $fontScale scale: ${layout.size.width} > $available",
                    layout.size.width <= available)
                assertTrue(layout.layoutInput.style.fontSize >= 32.sp)
                field.performClick()
                for (caret in listOf(0, value.length)) {
                    field.performSemanticsAction(SemanticsActions.SetSelection) { it(caret, caret, false) }
                    field.assertIsFocused()
                    assertEquals(TextRange(caret), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
                }
                field.performImeAction()
            }
        }
    }

    @Test fun focusExpansionKeepsTheSameEditorAndSelectionUntilBlur() {
        var commits = 0
        val width = mutableStateOf(372)
        val scale = mutableStateOf(1f)
        compose.setContent {
            var text by remember { mutableStateOf("24") }
            CompositionLocalProvider(LocalDensity provides Density(2f, scale.value)) {
                GymMaterial {
                    Column {
                        NumberStepper(text, { text = it }, "Load", "kg added",
                            onStep = { NumberEditResult.Unchanged }, onCommit = { commits++; NumberEditResult.Unchanged },
                            modifier = Modifier.width(width.value.dp), size = NumberStepperSize.Display,
                            input = NumberStepperInput.SignedDecimal)
                        NumberStepper("8", {}, "Reps", "reps", onStep = { NumberEditResult.Unchanged },
                            onCommit = { NumberEditResult.Unchanged })
                    }
                }
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg added")
        val inlineHeight = field.fetchSemanticsNode().boundsInRoot.height
        field.performClick().performTextReplacement("-499.99")
        field.assertIsFocused()
        assertTrue(field.fetchSemanticsNode().boundsInRoot.height > inlineHeight)
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(2, 5, false) }
        compose.runOnIdle { width.value = 280; scale.value = 2f }
        field.assertIsFocused()
        assertEquals(TextRange(2, 5), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        val expanded = field.fetchSemanticsNode().boundsInRoot
        val increase = compose.onNodeWithContentDescription("Increase Load").fetchSemanticsNode().boundsInRoot
        assertTrue(increase.top >= expanded.bottom)
        field.performTextReplacement("24")
        compose.runOnIdle { width.value = 372; scale.value = 1f }
        field.assertIsFocused()
        assertTrue(compose.onNodeWithContentDescription("Increase Load").fetchSemanticsNode().boundsInRoot.top >=
            field.fetchSemanticsNode().boundsInRoot.bottom)
        field.performImeAction()
        compose.runOnIdle { assertEquals(1, commits) }
        compose.onNodeWithContentDescription("Reps, reps").performClick()
        field.assertIsNotFocused()
        field.assertTextEquals("Load", "kg added", "24")
        compose.waitUntil { field.fetchSemanticsNode().boundsInRoot.height == inlineHeight }
        assertEquals(inlineHeight, field.fetchSemanticsNode().boundsInRoot.height)
    }

    @Test fun arbitraryRawOverflowRetainsTheValueAndFontFloorForConsumerValidation() {
        compose.setContent {
            var text by remember { mutableStateOf("24") }
            GymMaterial {
                NumberStepper(text, { text = it }, "Load", "kg added",
                    onStep = { NumberEditResult.Refused }, onCommit = { NumberEditResult.Refused },
                    modifier = Modifier.width(280.dp), size = NumberStepperSize.Display,
                    input = NumberStepperInput.SignedDecimal)
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg added")
        field.performClick().performTextReplacement("-12345678901234567890.12345")
        field.assertTextEquals("Load", "kg added", "-12345678901234567890.12345")
        val layouts = mutableListOf<TextLayoutResult>()
        field.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(32.sp, layouts.single().layoutInput.style.fontSize)
        field.performImeAction()
        field.assertIsFocused()
    }

    @OptIn(ExperimentalComposeUiApi::class)
    @Test fun nativeInputFlagsFollowTheConsumersInputKind() {
        val editor = EditorInfo()
        val input = mutableStateOf(NumberStepperInput.SignedDecimal)
        compose.setContent {
            InterceptPlatformTextInput(interceptor = { request, _ ->
                request.createInputConnection(editor)
                awaitCancellation()
            }) {
                GymMaterial {
                    NumberStepper("20", {}, "Load", "kg total", onStep = { NumberEditResult.Unchanged },
                        onCommit = { NumberEditResult.Unchanged }, input = input.value)
                }
            }
        }
        compose.onNodeWithContentDescription("Load, kg total").performClick()
        compose.runOnIdle {
            assertEquals(InputType.TYPE_CLASS_NUMBER, editor.inputType and InputType.TYPE_MASK_CLASS)
            assertTrue(editor.inputType and InputType.TYPE_NUMBER_FLAG_SIGNED != 0)
            assertTrue(editor.inputType and InputType.TYPE_NUMBER_FLAG_DECIMAL != 0)
        }
        compose.runOnIdle { input.value = NumberStepperInput.Count }
        compose.runOnIdle {
            assertEquals(InputType.TYPE_CLASS_NUMBER, editor.inputType and InputType.TYPE_MASK_CLASS)
            assertEquals(0, editor.inputType and InputType.TYPE_NUMBER_FLAG_SIGNED)
            assertEquals(0, editor.inputType and InputType.TYPE_NUMBER_FLAG_DECIMAL)
        }
    }
}
