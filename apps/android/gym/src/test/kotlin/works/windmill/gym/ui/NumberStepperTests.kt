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
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.unit.width
import androidx.compose.ui.unit.height
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
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

    @Test fun newFocusStartsAfterTheValueAndAccessibilityStepsShareAcceptedFeedback() {
        val sensations = mutableListOf<HapticFeedbackType>()
        val feedback = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { sensations += hapticFeedbackType }
        }
        compose.setContent {
            var text by remember { mutableStateOf("-12.5") }
            CompositionLocalProvider(LocalHapticFeedback provides feedback) {
                GymMaterial {
                    NumberStepper(text, { text = it }, "Load", "kg added", onStep = {
                        text = if (it == NumberStep.Increase) "-11.5" else "-12.5"
                        NumberEditResult.Changed
                    }, onCommit = { NumberEditResult.Unchanged }, input = NumberStepperInput.SignedDecimal)
                }
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg added")
        field.performClick()
        assertEquals(TextRange(5), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(1, 4, false) }
        field.performTextReplacement("-499.99")
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(2, 5, false) }
        assertEquals(TextRange(2, 5), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        for (name in listOf("Decrease Load", "Increase Load")) {
            val bounds = compose.onNodeWithContentDescription(name).getBoundsInRoot()
            assertEquals(48.dp, bounds.width)
            assertEquals(48.dp, bounds.height)
        }
        val actions = field.fetchSemanticsNode().config[SemanticsActions.CustomActions]
        assertEquals(listOf("Decrease", "Increase"), actions.map { it.label })
        compose.runOnIdle { assertTrue(actions.last().action()) }
        field.assertTextEquals("Load", "kg added", "-11.5")
        compose.runOnIdle { assertTrue(actions.first().action()) }
        field.assertTextEquals("Load", "kg added", "-12.5")
        compose.runOnIdle { assertEquals(List(2) { HapticFeedbackType.TextHandleMove }, sensations) }
        field.performImeAction()
        field.performClick()
        assertEquals(TextRange(5), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
    }

    @Test fun changedNumeralsStayInsideTheirFieldAndFinishBeforeTheFlash() {
        lateinit var view: View
        fun picture(): Bitmap = compose.runOnIdle {
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        }
        fun frames(count: Int) = repeat(count) {
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
        }
        val text = mutableStateOf("82.5")
        val target = mutableStateOf("85")
        val reduced = mutableStateOf(false)
        compose.setContent {
            view = LocalView.current
            GymMaterial {
                NumberStepper(text.value, { text.value = it }, "Load", "kg", onStep = {
                    text.value = target.value
                    NumberEditResult.Changed
                }, onCommit = { NumberEditResult.Unchanged }, size = NumberStepperSize.Display,
                    reducedMotion = reduced.value, hapticsEnabled = false)
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg")
        for (reduceMotion in listOf(false, true)) for ((from, to) in listOf("82.5" to "85", "85" to "-102.5", "-102.5" to "85")) {
            compose.runOnIdle { text.value = from; target.value = to; reduced.value = reduceMotion }
            compose.mainClock.advanceTimeBy(400)
            val oldBounds = field.fetchSemanticsNode().boundsInRoot
            val buttonBounds = listOf("Decrease Load", "Increase Load").map {
                compose.onNodeWithContentDescription(it).fetchSemanticsNode().boundsInRoot
            }.toMutableList()
            val before = picture()
            compose.mainClock.autoAdvance = false
            val action = field.fetchSemanticsNode().config[SemanticsActions.CustomActions].last()
            compose.runOnIdle { assertTrue(action.action()) }
            frames(7)
            val bounds = field.fetchSemanticsNode().boundsInRoot
            buttonBounds += listOf("Decrease Load", "Increase Load").map {
                compose.onNodeWithContentDescription(it).fetchSemanticsNode().boundsInRoot
            }
            val during = picture()
            for (y in 0 until minOf(before.height, during.height)) for (x in 0 until before.width) {
                if ((x < minOf(oldBounds.left, bounds.left) || x >= maxOf(oldBounds.right, bounds.right)) &&
                    buttonBounds.none { x >= it.left && x < it.right && y >= it.top && y < it.bottom })
                    assertEquals("$from → $to, reduced=$reduceMotion: numeral escaped at $x,$y",
                        before.getPixel(x, y), during.getPixel(x, y))
            }
            frames(7)
            val changed = picture()
            frames(2)
            val settled = picture()
            assertEquals(changed.width, settled.width)
            assertEquals(changed.height, settled.height)
            assertTrue("$from → $to, reduced=$reduceMotion: numeral still moving during the settled flash",
                changed.sameAs(settled))
            field.assertTextEquals("Load", "kg", to)
            compose.mainClock.autoAdvance = true
            compose.mainClock.advanceTimeBy(400)
        }
    }

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

    @Test fun decimalEditsRejectTheWholeInsertionAndKeepSelectionWithoutDraftOrHapticFeedback() {
        val drafts = mutableListOf<String>()
        val sensations = mutableListOf<HapticFeedbackType>()
        val feedback = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { sensations += hapticFeedbackType }
        }
        compose.setContent {
            var value by remember { mutableStateOf("12.5") }
            CompositionLocalProvider(LocalHapticFeedback provides feedback) {
                GymMaterial {
                    NumberStepper(value, { value = it; drafts += it }, "Load", "kg",
                        onStep = { NumberEditResult.Unchanged }, onCommit = { NumberEditResult.Unchanged },
                        input = NumberStepperInput.SignedDecimal)
                }
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg")
        field.performClick().performTextInput(".")
        field.assertTextEquals("Load", "kg", "12.5")
        assertEquals(TextRange(4), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(2, 3, false) }
        field.performTextInput(",")
        field.assertTextEquals("Load", "kg", "12,5")
        assertEquals(TextRange(3), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(1, 3, false) }
        field.performTextReplacement("1,2.3")
        field.assertTextEquals("Load", "kg", "12,5")
        assertEquals(TextRange(1, 3), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        compose.runOnIdle {
            assertEquals(listOf("12,5"), drafts)
            assertEquals(emptyList<HapticFeedbackType>(), sensations)
        }
        field.performTextReplacement("1.25e+305")
        field.assertTextEquals("Load", "kg", "1.25e+305")
        field.performTextInput(".")
        field.assertTextEquals("Load", "kg", "1.25e+305")
        compose.runOnIdle { assertEquals(listOf("12,5", "1.25e+305"), drafts) }
    }

    @Test fun restoredMalformedTextAndDeletedExponentMantissasRemainRecoverable() {
        val drafts = mutableListOf<String>()
        compose.setContent {
            var value by remember { mutableStateOf("12...5") }
            GymMaterial {
                NumberStepper(value, { value = it; drafts += it }, "Load", "kg",
                    onStep = { NumberEditResult.Unchanged }, onCommit = { NumberEditResult.Refused },
                    input = NumberStepperInput.SignedDecimal)
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg")
        field.performClick().performSemanticsAction(SemanticsActions.SetSelection) { it(2, 3, false) }
        field.performTextInput("")
        field.assertTextEquals("Load", "kg", "12..5")
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(2, 3, false) }
        field.performTextInput("")
        field.assertTextEquals("Load", "kg", "12.5")
        field.performTextReplacement("1.25e+305")
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(0, 4, false) }
        field.performTextInput("")
        field.assertTextEquals("Load", "kg", "e+305")
        field.performImeAction()
        field.assertIsFocused()
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(0, 1, false) }
        field.performTextInput("")
        field.assertTextEquals("Load", "kg", "+305")
        compose.runOnIdle { assertEquals(listOf("12..5", "12.5", "1.25e+305", "e+305", "+305"), drafts) }
    }

    @Test fun countFieldsRejectMalformedPasteWithoutChangingTheirOwner() {
        val drafts = mutableListOf<String>()
        compose.setContent {
            var value by remember { mutableStateOf("5") }
            GymMaterial {
                NumberStepper(value, { value = it; drafts += it }, "Reps", "reps",
                    onStep = { NumberEditResult.Unchanged }, onCommit = { NumberEditResult.Unchanged })
            }
        }
        val field = compose.onNodeWithContentDescription("Reps, reps")
        field.performClick().performTextReplacement("3.5.1")
        field.assertTextEquals("Reps", "reps", "5")
        compose.runOnIdle { assertEquals(emptyList<String>(), drafts) }
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

    @Test fun regularLoadMovesItsUnitBelowWithoutShrinkingOrMovingSideControls() {
        var commits = 0
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 2f)) {
                GymMaterial {
                    var text by remember { mutableStateOf("-12.5") }
                    Column {
                        NumberStepper(text, { text = it }, "Load", "kg added",
                            onStep = { NumberEditResult.Unchanged }, onCommit = { commits++; NumberEditResult.Unchanged },
                            modifier = Modifier.width(288.dp), input = NumberStepperInput.SignedDecimal)
                        NumberStepper("8", {}, "Reps", "reps", onStep = { NumberEditResult.Unchanged },
                            onCommit = { NumberEditResult.Unchanged })
                    }
                }
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg added")
        val original = field.fetchSemanticsNode().boundsInRoot
        field.performClick()
        for (value in listOf("-12.5", "0", "82.4", "82,4", "-1.7976931348623157e+308")) {
            field.performTextReplacement(value)
            val layouts = mutableListOf<TextLayoutResult>()
            field.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val valueLayout = layouts.single()
            assertEquals(20.sp, valueLayout.layoutInput.style.fontSize)
            val bounds = field.fetchSemanticsNode().boundsInRoot
            assertEquals(original, bounds)
            val unit = compose.onNodeWithText("kg added", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val label = compose.onNodeWithText("Load", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertTrue(unit.top >= label.bottom + valueLayout.size.height)
            for (name in listOf("Decrease Load", "Increase Load")) {
                val button = compose.onNodeWithContentDescription(name).fetchSemanticsNode().boundsInRoot
                assertTrue(button.center.y > bounds.top && button.center.y < bounds.bottom)
                assertTrue(button.right <= bounds.left || button.left >= bounds.right)
            }
            for (caret in listOf(0, value.length)) {
                field.performSemanticsAction(SemanticsActions.SetSelection) { it(caret, caret, false) }
                assertEquals(TextRange(caret), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
            }
        }
        field.performTextReplacement("82.5")
        field.performSemanticsAction(SemanticsActions.SetSelection) { it(2, 3, false) }
        field.performTextInput(",")
        field.assertTextEquals("Load", "kg added", "82,5")
        field.performImeAction()
        assertEquals(1, commits)
        compose.onNodeWithContentDescription("Reps, reps").performClick()
        field.assertIsNotFocused()
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
