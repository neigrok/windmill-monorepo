package works.windmill.gym.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace
import works.windmill.gym.presentation.Ladder
import works.windmill.gym.presentation.LoggedSetLimits
import works.windmill.gym.presentation.NumberEntry
import works.windmill.gym.presentation.Readout
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

internal class NumberDraft(val field: NumberEntry.Field, initial: Double, initialFloor: Double? = null) {
    var committed by mutableDoubleStateOf(initial)
        private set
    var text by mutableStateOf(Readout.weight(initial))
        private set
    var refusal by mutableStateOf<String?>(null)
        private set
    var focused by mutableStateOf(false)
        private set
    var floor by mutableStateOf(initialFloor)

    val reading: NumberEntry.Reading get() = NumberEntry.read(text, this.field, committed, floor)

    val shownRefusal: String? get() = refusal ?: reading.message.takeIf { reading.belowFloor }

    val isEdited: Boolean get() = text != Readout.weight(committed)

    val canDecrease: Boolean get() = floor.let { it == null || standing > it }

    fun edit(raw: String) {
        text = raw
        refusal = null
    }

    // Leaving commits what was typed, as Done does; a refusal keeps the committed value, shown again when unexplained.
    fun focus(active: Boolean, commit: () -> NumberEditResult) {
        focused = active
        if (!active && isEdited && commit() == NumberEditResult.Refused && refusal == null) cancel()
    }

    // The value this field stands for while another field commits: its reading, else what it last committed.
    val standing: Double get() = reading.value ?: committed

    fun read(): Double? {
        val result = reading
        refusal = result.message.takeUnless { result.isValid }
        return result.value
    }

    fun bumped(direction: Int, big: Boolean): Double? = read()?.let { NumberEntry.bumped(it, direction, big, floor) }

    fun accept(value: Double): NumberEditResult {
        val changed = value != committed
        committed = value
        cancel()
        return if (changed) NumberEditResult.Changed else NumberEditResult.Unchanged
    }

    fun refuse(message: String): NumberEditResult {
        refusal = message
        return NumberEditResult.Refused
    }

    fun cancel() {
        text = Readout.weight(committed)
        refusal = null
    }
}

@Composable
internal fun rememberNumberDraft(key: String, field: NumberEntry.Field, value: Double, floor: Double? = null): NumberDraft {
    val draft = rememberSaveable(key, field, saver = listSaver(
        save = { listOf(it.committed, it.text, it.refusal.orEmpty()) },
        restore = { NumberDraft(field, it[0] as Double, floor).apply {
            edit(it[1] as String)
            (it[2] as String).takeIf(String::isNotEmpty)?.let(::refuse)
        } },
    )) { NumberDraft(field, value, floor) }
    SideEffect {
        draft.floor = floor
        if (draft.committed != value) draft.accept(value)
    }
    return draft
}

// A logged set's two numbers, as the rack and Fix set both draw them: Load over its ladder of steps, then Reps. Each
// field types into its draft, commits on Done, and commits again as focus leaves it.
@Composable
internal fun SetNumbers(
    load: NumberDraft,
    count: NumberDraft,
    unit: String,
    stepLoad: (NumberStep, Boolean) -> NumberEditResult,
    stepReps: (NumberStep) -> NumberEditResult,
    commit: (NumberDraft) -> NumberEditResult,
    enabled: Boolean,
    loadRefusal: String? = load.shownRefusal,
    onFocusChange: () -> Unit = {},
) {
    val loadFeedback = rememberNumberStepperFeedback()
    NumberStepper(load.text, load::edit, "Load", unit,
        onStep = { stepLoad(it, false) }, onCommit = { commit(load) },
        size = NumberStepperSize.Display, input = NumberStepperInput.SignedDecimal,
        refusal = loadRefusal, enabled = enabled, decreaseEnabled = load.canDecrease, feedback = loadFeedback,
        onFocusChange = { load.focus(it) { commit(load) }; onFocusChange() })
    LadderRow(load.reading.value ?: load.committed, onDial = { step, big -> loadFeedback.accept(stepLoad(step, big), step) },
        enabled = enabled, decreaseEnabled = load.canDecrease)
    NumberStepper(count.text, count::edit, "Reps", "reps",
        onStep = stepReps, onCommit = { commit(count) }, refusal = count.refusal, enabled = enabled,
        decreaseEnabled = count.reading.value != 1.0, increaseEnabled = count.reading.value != LoggedSetLimits.maxReps.toDouble(),
        onFocusChange = { count.focus(it) { commit(count) }; onFocusChange() })
}

// Four steps in one row while their labels fit, two rows of two when large text needs the room.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LadderRow(weightKg: Double, onDial: (NumberStep, Boolean) -> Unit, enabled: Boolean = true, decreaseEnabled: Boolean = true) {
    val colors = MaterialTheme.colorScheme
    val measurer = rememberTextMeasurer()
    val labels = Ladder.labels(weightKg)
    val style = WindmillFont.body(16, FontWeight.Bold)
    CompositionLocalProvider(LocalRippleConfiguration provides RippleConfiguration(color = colors.onSurface,
        rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.12f, hoveredAlpha = 0.08f, pressedAlpha = 0.12f))) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val gap = WindmillSpace.x2
            val widest = with(LocalDensity.current) { labels.maxOf { measurer.measure(it, style).size.width }.toDp() }
            val perRow = if (widest + 24.dp <= (maxWidth - gap * 3) / 4) 4 else 2
            Column(verticalArrangement = Arrangement.spacedBy(gap)) {
                labels.withIndex().chunked(perRow).forEach { line ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                        line.forEach { (index, label) ->
                            val step = if (index < 2) NumberStep.Decrease else NumberStep.Increase
                            FilledTonalButton(
                                onClick = { onDial(step, index == 0 || index == 3) },
                                enabled = enabled && (step == NumberStep.Increase || decreaseEnabled), modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                                contentPadding = PaddingValues(vertical = 10.dp), shape = RoundedCornerShape(16.dp),
                                colors = ButtonDefaults.filledTonalButtonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface),
                            ) { Text(label, style = style, maxLines = 1) }
                        }
                    }
                }
            }
        }
    }
}

