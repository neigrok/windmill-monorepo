package works.windmill.gym.ui

import android.animation.ValueAnimator
import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import works.windmill.gym.R
import works.windmill.platform.design.WindmillMotion
import androidx.compose.foundation.shape.ZeroCornerSize

enum class NumberStepperSize { Regular, Display }
enum class NumberStepperInput { Count, SignedDecimal }
enum class NumberStep { Decrease, Increase }
enum class NumberEditResult { Changed, Unchanged, Refused }

private val numberStepperBuffer = Regex("[-+−]?(?:(?:[0-9]+(?:[.,][0-9]*)?|[.,][0-9]+)(?:[eE][-+−]?[0-9]*)?|[.,])?")

// A typed hyphen becomes the minus sign U+2212, the one every load readout draws.
internal fun numberStepperEdit(current: TextFieldValue, typed: TextFieldValue): TextFieldValue {
    val next = if ('-' in typed.text) typed.copy(text = typed.text.replace('-', '−')) else typed
    if (next.text == current.text || numberStepperBuffer.matches(next.text.trim())) return next
    if (next.text.length < current.text.length) {
        var from = 0
        for (character in next.text) {
            val found = current.text.indexOf(character, from)
            if (found < 0) return current
            from = found + 1
        }
        return next
    }
    return current
}

class NumberStepperFeedback(private val tick: () -> Unit) {
    var revision by mutableIntStateOf(0)
        private set
    var direction by mutableStateOf(NumberStep.Increase)
        private set

    fun accept(result: NumberEditResult, step: NumberStep = NumberStep.Increase, haptics: Boolean = true) {
        if (result != NumberEditResult.Changed) return
        direction = step
        revision += 1
        if (haptics) tick()
    }
}

@Composable
fun rememberNumberStepperFeedback(): NumberStepperFeedback {
    val haptics = rememberGymHaptics()
    return remember(haptics) { NumberStepperFeedback(haptics::ticked) }
}

private enum class NumberFieldLayout { Inline, UnitBelow, FullWidth }

@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun NumberStepper(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    unit: String,
    onStep: (NumberStep) -> NumberEditResult,
    onCommit: () -> NumberEditResult,
    modifier: Modifier = Modifier,
    size: NumberStepperSize = NumberStepperSize.Regular,
    input: NumberStepperInput = NumberStepperInput.Count,
    refusal: String? = null,
    enabled: Boolean = true,
    decreaseEnabled: Boolean = true,
    increaseEnabled: Boolean = true,
    commitEnabled: Boolean = true,
    hapticsEnabled: Boolean = true,
    reducedMotion: Boolean = !ValueAnimator.areAnimatorsEnabled(),
    feedback: NumberStepperFeedback = rememberNumberStepperFeedback(),
    placeholder: String = "",
    onFocusChange: (Boolean) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    var hadFocus by remember { mutableStateOf(false) }
    var editor by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    var flash by remember { mutableStateOf(false) }
    val motion = remember { Animatable(1f) }
    var restingLayout by remember { mutableStateOf<NumberFieldLayout?>(null) }
    val labelWithUnit = stringResource(R.string.gym_logger_stepper_spoken, label, unit)
    val decreaseAction = stringResource(R.string.gym_logger_decrease)
    val increaseAction = stringResource(R.string.gym_logger_increase)
    SideEffect {
        if (editor.text != value) editor = editor.copy(text = value,
            selection = TextRange(editor.selection.start.coerceAtMost(value.length), editor.selection.end.coerceAtMost(value.length)))
    }
    LaunchedEffect(focused) {
        if (focused) editor = editor.copy(selection = TextRange(editor.text.length))
        if (focused != hadFocus) {
            hadFocus = focused
            onFocusChange(focused)
        }
    }
    LaunchedEffect(feedback.revision) {
        if (feedback.revision == 0) return@LaunchedEffect
        flash = true
        val slide = !reducedMotion && !focused
        if (slide) {
            motion.snapTo(0f)
            motion.animateTo(1f, tween(WindmillMotion.fastMs))
        } else motion.snapTo(1f)
        delay((300 - if (slide) WindmillMotion.fastMs else 0).toLong())
        flash = false
    }
    fun step(change: NumberStep): Boolean {
        if (!enabled || (change == NumberStep.Decrease && !decreaseEnabled) ||
            (change == NumberStep.Increase && !increaseEnabled)) return false
        val result = onStep(change)
        feedback.accept(result, change, hapticsEnabled)
        return result != NumberEditResult.Refused
    }
    val inputInterceptor = remember(input) {
        PlatformTextInputInterceptor { request, next ->
            next.startInputMethod(object : PlatformTextInputMethodRequest {
                override fun createInputConnection(outAttributes: EditorInfo) = request.createInputConnection(outAttributes).also {
                    if (input == NumberStepperInput.SignedDecimal)
                        outAttributes.inputType = outAttributes.inputType or InputType.TYPE_NUMBER_FLAG_SIGNED or InputType.TYPE_NUMBER_FLAG_DECIMAL
                }
            })
        }
    }
    val measuredValue = value.ifEmpty { placeholder }
    val display = size == NumberStepperSize.Display
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()
    val baseStyle = (if (display) GymType.stepperDisplay else GymType.stepperInline)
        .copy(color = if (flash) colors.primary else colors.onSurface)
    val unitStyle = if (display) GymType.stepperUnitDisplay else GymType.stepperUnitInline
    val fill = if (flash) colors.primaryContainer.compositeOver(colors.surfaceContainerHighest) else colors.surfaceContainerHighest
    val fieldShape = MaterialTheme.shapes.extraSmall.copy(bottomStart = ZeroCornerSize, bottomEnd = ZeroCornerSize)
    val fieldColors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
        disabledContainerColor = Color.Transparent, errorContainerColor = Color.Transparent,
        focusedIndicatorColor = colors.primary, unfocusedIndicatorColor = if (flash) colors.primary else colors.onSurfaceVariant,
        errorIndicatorColor = colors.primary)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val gap = with(density) { 4.dp.roundToPx() }
            val button = with(density) { 48.dp.roundToPx() }
            val padding = with(density) { 32.dp.roundToPx() }
            val unitGap = with(density) { (if (display) 8.dp else 6.dp).roundToPx() }
            val sideWidth = (constraints.maxWidth - button * 2 - gap * 2 - padding).coerceAtLeast(0)
            val unitWidth = textMeasurer.measure(unit, unitStyle).size.width
            val measured = baseStyle.copy(color = Color.Unspecified)
            val roleSize = baseStyle.fontSize.value.toInt()
            fun numeralWidth(size: Int) = textMeasurer.measure(measuredValue, GymType.stepperValue(measured, size)).size.width
            // Width grows with size, so the largest size that fits is found by halving the range.
            fun largest(range: IntRange, fits: (Int) -> Boolean): Int? {
                var low = range.first
                var high = range.last
                var found: Int? = null
                while (low <= high) {
                    val middle = (low + high) / 2
                    if (fits(middle)) { found = middle; low = middle + 1 } else high = middle - 1
                }
                return found
            }
            val baseWidth = numeralWidth(roleSize)
            val besideUnit = { size: Int -> numeralWidth(size) + gap + unitGap + unitWidth <= sideWidth }
            // The Display numeral first fits beside its unit, from its role's size down; only below that does the unit go under it.
            val inlineSize = if (display) largest(GymType.stepperDisplayBesideUnit..roleSize, besideUnit) else null
            val requiredLayout = when {
                !display && (input != NumberStepperInput.SignedDecimal ||
                    baseWidth + gap + unitGap + unitWidth <= sideWidth) -> NumberFieldLayout.Inline
                !display -> NumberFieldLayout.UnitBelow
                inlineSize != null -> NumberFieldLayout.Inline
                numeralWidth(GymType.stepperDisplayFloor) + gap <= sideWidth && unitWidth <= sideWidth -> NumberFieldLayout.UnitBelow
                else -> NumberFieldLayout.FullWidth
            }
            // Focus never moves the field: it keeps the layout it had at rest, so a longer typed value shrinks its numeral
            // beside the unit, down to its floor, and the field fits itself again once focus leaves on Done or Log set.
            val fieldLayout = if (focused) restingLayout ?: requiredLayout else requiredLayout
            SideEffect { restingLayout = if (focused) fieldLayout else null }
            val contentWidth = if (fieldLayout == NumberFieldLayout.FullWidth)
                (constraints.maxWidth - padding).coerceAtLeast(0) else sideWidth
            val floor = if (display) GymType.stepperDisplayFloor else GymType.stepperInlineFloor
            val numeralSize = when {
                fieldLayout == NumberFieldLayout.Inline -> inlineSize ?: largest(floor..roleSize, besideUnit) ?: floor
                !display -> roleSize
                else -> largest(floor..roleSize) { numeralWidth(it) + gap <= contentWidth } ?: floor
            }
            val valueStyle = GymType.stepperValue(baseStyle, numeralSize)
            val numeralWidth = textMeasurer.measure(measuredValue, valueStyle).size.width
            // A numeral fitted below its role's size keeps the role's line, so stepping never changes the field's height.
            val numeralLine = if (fieldLayout == NumberFieldLayout.Inline) textMeasurer.measure(measuredValue, measured).size.height else 0
            val animateValue = !focused && !reducedMotion && numeralWidth + gap <= contentWidth
            Layout(content = {
                StepperButton(NumberStep.Decrease, label, enabled && decreaseEnabled) {
                    step(NumberStep.Decrease)
                }
                InterceptPlatformTextInput(inputInterceptor) {
                    BasicTextField(editor, { next ->
                        val previous = editor
                        val accepted = numberStepperEdit(previous, next)
                        editor = accepted
                        if (accepted.text != previous.text) onValueChange(accepted.text)
                    }, Modifier.semantics {
                        // The label once and the unit only when it adds to it: "Sets", "Load, kg total". TalkBack
                        // reads the typed value from the field itself, so the drawn label and unit stay silent.
                        contentDescription = if (unit.equals(label, ignoreCase = true)) label else labelWithUnit
                        refusal?.let { error(it) }
                        customActions = listOf(
                            CustomAccessibilityAction(decreaseAction) { step(NumberStep.Decrease) },
                            CustomAccessibilityAction(increaseAction) { step(NumberStep.Increase) },
                        )
                    }, enabled = enabled, singleLine = true, textStyle = valueStyle,
                        interactionSource = interaction, cursorBrush = SolidColor(colors.primary),
                        keyboardOptions = KeyboardOptions(keyboardType = if (input == NumberStepperInput.Count) KeyboardType.Number else KeyboardType.Decimal,
                            autoCorrectEnabled = false, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = {
                            if (!enabled || !commitEnabled) return@KeyboardActions
                            val result = onCommit()
                            feedback.accept(result, haptics = hapticsEnabled)
                            if (result != NumberEditResult.Refused) {
                                keyboard?.hide()
                                focusManager.clearFocus()
                            }
                        }),
                        decorationBox = { innerTextField ->
                            Box(Modifier.heightIn(min = when {
                                display && fieldLayout != NumberFieldLayout.Inline -> 156.dp
                                display -> 120.dp
                                else -> 56.dp
                            }).background(fill, fieldShape)) {
                                TextFieldDefaults.Container(enabled, false, interaction, Modifier.matchParentSize(), fieldColors,
                                    fieldShape, focusedIndicatorLineThickness = 3.dp)
                                Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp,
                                    bottom = if (display && fieldLayout == NumberFieldLayout.Inline) 4.dp else 8.dp)) {
                                    Text(label, style = GymType.stepperLabel,
                                        color = if (focused || flash) colors.primary else colors.onSurfaceVariant, modifier = Modifier.clearAndSetSemantics { testTag = "stepper-label" })
                                    Layout(content = {
                                        Box(Modifier.clipToBounds()) {
                                            Box(Modifier.fillMaxWidth().graphicsLayer {
                                                val progress = if (animateValue) motion.value else 1f
                                                alpha = progress
                                                translationY = (1f - progress) * valueStyle.fontSize.toPx() / 4 *
                                                    (if (feedback.direction == NumberStep.Increase) 1 else -1)
                                            }) {
                                                if (value.isEmpty() && placeholder.isNotEmpty()) Text(placeholder, style = valueStyle, color = colors.onSurfaceVariant)
                                                innerTextField()
                                            }
                                        }
                                        Text(unit, color = if (flash) colors.primary else colors.onSurfaceVariant, style = unitStyle, maxLines = 1,
                                            modifier = Modifier.clearAndSetSemantics { testTag = "stepper-unit" })
                                    }) { children, limits ->
                                        val unitPlaceable = children[1].measure(limits.copy(minWidth = 0, minHeight = 0))
                                        val below = fieldLayout != NumberFieldLayout.Inline
                                        val valueWidth = if (below) limits.maxWidth else
                                            minOf(numeralWidth + gap, (limits.maxWidth - unitPlaceable.width - unitGap).coerceAtLeast(0))
                                        val valuePlaceable = children[0].measure(limits.copy(minWidth = 0, minHeight = numeralLine.coerceAtMost(limits.maxHeight), maxWidth = valueWidth))
                                        val unitY = if (below) valuePlaceable.height + gap else
                                            (valuePlaceable[FirstBaseline] - unitPlaceable[FirstBaseline]).coerceAtLeast(0)
                                        layout(limits.maxWidth, maxOf(valuePlaceable.height, unitY + unitPlaceable.height)) {
                                            valuePlaceable.placeRelative(0, 0)
                                            unitPlaceable.placeRelative(if (below) 0 else valuePlaceable.width + unitGap, unitY)
                                        }
                                    }
                                }
                            }
                        })
                }
                StepperButton(NumberStep.Increase, label, enabled && increaseEnabled) {
                    step(NumberStep.Increase)
                }
            }) { children, limits ->
                val decrease = children[0].measure(Constraints.fixed(button, button))
                val increase = children[2].measure(Constraints.fixed(button, button))
                val below = fieldLayout == NumberFieldLayout.FullWidth
                val fieldWidth = if (below) limits.maxWidth else (limits.maxWidth - button * 2 - gap * 2).coerceAtLeast(0)
                val field = children[1].measure(limits.copy(minWidth = fieldWidth, maxWidth = fieldWidth, minHeight = 0))
                val height = if (below) field.height + 8.dp.roundToPx() + button else maxOf(field.height, button)
                layout(limits.maxWidth, height) {
                    field.placeRelative(if (below) 0 else button + gap, 0)
                    decrease.placeRelative(if (below) limits.maxWidth - button * 2 - gap else 0,
                        if (below) height - button else (height - button) / 2)
                    increase.placeRelative(limits.maxWidth - button,
                        if (below) height - button else (height - button) / 2)
                }
            }
        }
        refusal?.let {
            Text(it, color = MaterialTheme.colorScheme.error,
                style = GymType.stepperRefusal)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StepperButton(step: NumberStep, label: String, enabled: Boolean, onClick: () -> Unit) {
    val ink = MaterialTheme.colorScheme.onSurfaceVariant
    CompositionLocalProvider(LocalRippleConfiguration provides RippleConfiguration(color = ink,
        rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.08f, hoveredAlpha = 0.08f, pressedAlpha = 0.08f))) {
        IconButton(onClick, modifier = Modifier.size(48.dp), enabled = enabled,
            colors = IconButtonDefaults.iconButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) {
            Icon(painterResource(if (step == NumberStep.Decrease) R.drawable.gym_native_remove else R.drawable.gym_native_add),
                stringResource(if (step == NumberStep.Decrease) R.string.gym_logger_decrease_named else R.string.gym_logger_increase_named, label),
                Modifier.size(24.dp))
        }
    }
}
