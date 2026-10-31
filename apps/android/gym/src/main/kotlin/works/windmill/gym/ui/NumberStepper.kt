package works.windmill.gym.ui

import android.animation.ValueAnimator
import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.Alignment
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
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import works.windmill.gym.R
import works.windmill.platform.design.WindmillMotion

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
    val skin = LocalGymColors.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    var hadFocus by remember { mutableStateOf(false) }
    var editor by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    var flash by remember { mutableStateOf(false) }
    val motion = remember { Animatable(1f) }
    var focusedLayout by remember { mutableStateOf(NumberFieldLayout.Inline) }
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
    val baseStyle = TextStyle(fontFamily = if (display) GymNativeType.sans else GymNativeType.mono,
        fontWeight = if (display) FontWeight.ExtraBold else FontWeight.Medium,
        fontSize = if (display) 88.sp else 20.sp, lineHeight = if (display) 92.sp else 24.sp,
        fontFeatureSettings = "tnum", color = if (flash) skin.accent else skin.ink)
    val unitStyle = TextStyle(fontFamily = GymNativeType.sans, fontSize = if (display) 22.sp else 16.sp,
        lineHeight = if (display) 28.sp else 24.sp)
    val fill = if (flash) skin.accentSoft.compositeOver(skin.raised) else skin.raised
    val fieldShape = RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp)
    val colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
        disabledContainerColor = Color.Transparent, errorContainerColor = Color.Transparent,
        focusedIndicatorColor = skin.accent, unfocusedIndicatorColor = if (flash) skin.accent else skin.inkDim,
        errorIndicatorColor = skin.accent)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val gap = with(density) { 4.dp.roundToPx() }
            val button = with(density) { 48.dp.roundToPx() }
            val padding = with(density) { 32.dp.roundToPx() }
            val unitGap = with(density) { (if (display) 8.dp else 6.dp).roundToPx() }
            val sideWidth = (constraints.maxWidth - button * 2 - gap * 2 - padding).coerceAtLeast(0)
            val unitWidth = textMeasurer.measure(unit, unitStyle).size.width
            val measured = baseStyle.copy(color = Color.Unspecified)
            fun numeralWidth(size: Int) = textMeasurer.measure(measuredValue, measured.copy(fontSize = size.sp)).size.width
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
            val baseWidth = numeralWidth(if (display) 88 else 20)
            // The Display numeral first fits beside its unit, from 88 sp down to 64 sp; only below that does the unit go under it.
            val inlineSize = if (display) largest(64..88) { numeralWidth(it) + gap + unitGap + unitWidth <= sideWidth } else null
            val requiredLayout = when {
                !display && (input != NumberStepperInput.SignedDecimal ||
                    baseWidth + gap + unitGap + unitWidth <= sideWidth) -> NumberFieldLayout.Inline
                !display -> NumberFieldLayout.UnitBelow
                inlineSize != null -> NumberFieldLayout.Inline
                numeralWidth(32) + gap <= sideWidth && unitWidth <= sideWidth -> NumberFieldLayout.UnitBelow
                else -> NumberFieldLayout.FullWidth
            }
            val fieldLayout = if (focused) maxOf(focusedLayout, requiredLayout) else requiredLayout
            SideEffect { focusedLayout = if (focused) fieldLayout else NumberFieldLayout.Inline }
            val contentWidth = if (fieldLayout == NumberFieldLayout.FullWidth)
                (constraints.maxWidth - padding).coerceAtLeast(0) else sideWidth
            val numeralSize = when {
                !display -> 20
                fieldLayout == NumberFieldLayout.Inline -> inlineSize ?: 64
                else -> largest(32..88) { numeralWidth(it) + gap <= contentWidth } ?: 32
            }
            val valueStyle = baseStyle.copy(fontSize = numeralSize.sp,
                lineHeight = (numeralSize + 4).sp)
            val numeralWidth = textMeasurer.measure(measuredValue, valueStyle).size.width
            // A numeral fitted below 88 sp keeps the 88 sp line, so stepping never changes the field's height.
            val numeralLine = if (display && fieldLayout == NumberFieldLayout.Inline) textMeasurer.measure(measuredValue, measured).size.height else 0
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
                        contentDescription = "$label, $unit"
                        refusal?.let { error(it) }
                        customActions = listOf(
                            CustomAccessibilityAction("Decrease") { step(NumberStep.Decrease) },
                            CustomAccessibilityAction("Increase") { step(NumberStep.Increase) },
                        )
                    }, enabled = enabled, singleLine = true, textStyle = valueStyle,
                        interactionSource = interaction, cursorBrush = SolidColor(skin.accent),
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
                                TextFieldDefaults.Container(enabled, false, interaction, Modifier.matchParentSize(), colors,
                                    fieldShape, focusedIndicatorLineThickness = 3.dp)
                                Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp,
                                    bottom = if (display && fieldLayout == NumberFieldLayout.Inline) 4.dp else 8.dp)) {
                                    Text(label, style = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp, lineHeight = 16.sp),
                                        color = if (focused || flash) skin.accent else skin.inkDim)
                                    Layout(content = {
                                        Box(Modifier.clipToBounds()) {
                                            Box(Modifier.fillMaxWidth().graphicsLayer {
                                                val progress = if (animateValue) motion.value else 1f
                                                alpha = progress
                                                translationY = (1f - progress) * valueStyle.fontSize.toPx() / 4 *
                                                    (if (feedback.direction == NumberStep.Increase) 1 else -1)
                                            }) {
                                                if (value.isEmpty() && placeholder.isNotEmpty()) Text(placeholder, style = valueStyle, color = skin.inkDim)
                                                innerTextField()
                                            }
                                        }
                                        Text(unit, color = if (flash) skin.accent else skin.inkDim, style = unitStyle, maxLines = 1)
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
                style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 14.sp, lineHeight = 20.sp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StepperButton(step: NumberStep, label: String, enabled: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val ink = LocalGymColors.current.inkDim
    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(40.dp).background(if (pressed) ink.copy(alpha = 0.08f) else Color.Transparent,
            if (pressed) RoundedCornerShape(8.dp) else CircleShape))
        CompositionLocalProvider(LocalRippleConfiguration provides RippleConfiguration(color = ink,
            rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.08f, hoveredAlpha = 0.08f, pressedAlpha = 0.08f))) {
            IconButton(onClick, modifier = Modifier.size(48.dp), enabled = enabled, interactionSource = interaction,
                colors = IconButtonDefaults.iconButtonColors(contentColor = LocalGymColors.current.ink)) {
                Icon(painterResource(if (step == NumberStep.Decrease) R.drawable.gym_native_remove else R.drawable.gym_native_add),
                    "${if (step == NumberStep.Decrease) "Decrease" else "Increase"} $label", Modifier.size(24.dp))
            }
        }
    }
}
