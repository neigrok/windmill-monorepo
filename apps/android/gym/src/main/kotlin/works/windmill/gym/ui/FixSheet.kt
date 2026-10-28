package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.NumberEntry
import works.windmill.gym.domain.LoggedSetLimits
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.SetEffort
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius

@Composable
fun FixSheet(
    set: TrainingSet,
    movement: String,
    setNumber: Int,
    routine: String?,
    onSave: suspend (SetFix) -> FixOutcome,
    onDelete: () -> Unit,
    onSaved: () -> Unit = {},
    onGone: (String) -> Unit = {},
    onBusy: (Boolean) -> Unit = {},
    draftKey: String = set.id,
    onEntryCancel: ((() -> Unit)?) -> Unit = {},
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var weightKg by rememberSaveable(draftKey) { mutableDoubleStateOf(set.weightKg) }
    var reps by rememberSaveable(draftKey) { mutableIntStateOf(set.reps) }
    var rpe by rememberSaveable(draftKey) { mutableStateOf(set.rpe) }
    var note by rememberSaveable(draftKey) { mutableStateOf(set.note) }
    val load = rememberNumberDraft(draftKey, NumberEntry.Field.Load, weightKg)
    val count = rememberNumberDraft(draftKey, NumberEntry.Field.Reps, reps.toDouble())
    val loadFeedback = rememberNumberStepperFeedback()
    var effortOpen by rememberSaveable(draftKey) { mutableStateOf(false) }
    var refusal by rememberSaveable(draftKey) { mutableStateOf<String?>(null) }
    var busy by remember(draftKey) { mutableStateOf(false) }
    val tooLong = SetEffort.noteOverlong(note)
    val cancelEntry: () -> Unit = remember(load, count, focus, keyboard) { {
        load.focus(false)
        count.focus(false)
        focus.clearFocus()
        keyboard?.hide()
    } }
    val entryOpen = load.focused || count.focused || load.isEdited || count.isEdited
    DisposableEffect(draftKey, entryOpen) {
        onEntryCancel(if (entryOpen) cancelEntry else null)
        onDispose { onEntryCancel(null) }
    }
    BackHandler(enabled = entryOpen && !busy, onBack = cancelEntry)
    BackHandler(enabled = busy) {}

    fun acceptLoad(value: Double): NumberEditResult {
        weightKg = value
        return load.accept(value)
    }
    fun acceptReps(value: Double): NumberEditResult {
        reps = value.toInt()
        return count.accept(value)
    }

    Column(
        Modifier.fillMaxWidth().background(skin.surface)
            .verticalScroll(rememberScrollState()).imePadding()
            .padding(horizontal = GymLayout.gutter)
            .padding(bottom = GymLayout.sheetBottom),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Fix set", style = WindmillFont.display(26, FontWeight.ExtraBold).copy(lineHeight = 34.sp),
            color = skin.ink, modifier = Modifier.semantics { heading() })
        Text("$movement · Set $setNumber", style = WindmillFont.body(14).copy(lineHeight = 18.sp),
            color = skin.inkDim)
        NumberStepper(load.text, load::edit, "Load", "kg",
            onStep = { step ->
                load.read()?.let { acceptLoad(Ladder.bump(it, if (step == NumberStep.Increase) 1 else -1, false)) }
                    ?: NumberEditResult.Refused
            },
            onCommit = { load.read()?.let(::acceptLoad) ?: NumberEditResult.Refused },
            size = NumberStepperSize.Display, input = NumberStepperInput.SignedDecimal,
            refusal = load.refusal, enabled = !busy, feedback = loadFeedback, onFocusChange = load::focus)
        LadderRow(load.reading.value ?: load.committed, onDial = { step, big ->
            val value = load.read()
            if (value != null) loadFeedback.accept(
                acceptLoad(Ladder.bump(value, if (step == NumberStep.Increase) 1 else -1, big)), step)
        }, enabled = !busy)
        NumberStepper(count.text, count::edit, "Reps", "reps",
            onStep = { step ->
                count.read()?.let {
                    acceptReps(Ladder.bumpReps(it.toInt(), if (step == NumberStep.Increase) 1 else -1)
                        .coerceAtMost(LoggedSetLimits.maxReps).toDouble())
                } ?: NumberEditResult.Refused
            },
            onCommit = { count.read()?.let(::acceptReps) ?: NumberEditResult.Refused },
            refusal = count.refusal, enabled = !busy, onFocusChange = count::focus,
            decreaseEnabled = count.reading.value != 1.0, increaseEnabled = count.reading.value != LoggedSetLimits.maxReps.toDouble())
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Effort", style = WindmillFont.body(14).copy(lineHeight = 18.sp), color = skin.inkDim,
                modifier = Modifier.weight(1f))
            Box {
                FilledTonalButton(
                    onClick = { effortOpen = true }, enabled = !busy,
                    modifier = Modifier.widthIn(min = 128.dp).heightIn(min = 48.dp),
                    shape = RoundedCornerShape(WindmillRadius.lg),
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = skin.raised, contentColor = skin.ink),
                ) {
                    Text(rpe?.let(SetEffort::rpeReading) ?: SetEffort.rpeUnrated,
                        style = WindmillFont.body(16, FontWeight.Bold))
                }
                DropdownMenu(expanded = effortOpen, onDismissRequest = { effortOpen = false },
                    containerColor = skin.raised) {
                    (listOf<Double?>(null) + SetEffort.rpeBand).forEach { value ->
                        val label = value?.let(SetEffort::rpeReading) ?: SetEffort.rpeUnrated
                        DropdownMenuItem(
                            text = { Text(label, style = WindmillFont.body(16), color = skin.ink) },
                            onClick = { rpe = value; effortOpen = false },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { selected = rpe == value },
                        )
                    }
                }
            }
        }
        refusal?.let { message ->
            Text(message, style = WindmillFont.body(14).copy(lineHeight = 18.sp), color = skin.alarmInk,
                modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
        }
        BasicTextField(
            value = note, onValueChange = { note = it }, enabled = !busy,
            textStyle = WindmillFont.body(16).copy(lineHeight = 21.sp, color = skin.ink),
            cursorBrush = SolidColor(skin.accent), maxLines = 6,
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
                .background(skin.raised, RoundedCornerShape(WindmillRadius.md))
                .padding(10.dp).semantics {
                    stateDescription = SetEffort.noteCaption
                    if (tooLong) error(SetEffort.noteTooLong)
                },
            decorationBox = { field ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(SetEffort.noteLabel, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim)
                    Box {
                        if (note.isEmpty()) Text("Add a note", style = WindmillFont.body(16).copy(lineHeight = 21.sp),
                            color = skin.inkDim)
                        field()
                    }
                }
            },
        )
        if (tooLong) {
            Text(SetEffort.noteTooLong, style = WindmillFont.body(14), color = skin.alarmInk,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        SetEffort.noteCounter(note)?.let { counter ->
            Text(counter, style = GymType.numeral(12), color = if (tooLong) skin.alarmInk else skin.inkDim)
        }
        Button(
            onClick = {
                if (busy || tooLong) return@Button
                val loadValue = load.read() ?: return@Button
                val repsValue = count.read() ?: return@Button
                acceptLoad(loadValue)
                acceptReps(repsValue)
                focus.clearFocus()
                keyboard?.hide()
                val fix = SetFix(set, weightKg = loadValue, reps = repsValue.toInt(), rpe = rpe, note = note)
                busy = true
                onBusy(true)
                refusal = null
                scope.launch {
                    try {
                        when (val outcome = onSave(fix)) {
                            is FixOutcome.Corrected -> onSaved()
                            is FixOutcome.Gone -> onGone(outcome.said)
                            is FixOutcome.Failed -> refusal = when (val why = outcome.why) {
                                WriteFailure.NoAnswer -> "The log didn’t answer — that set wasn’t changed."
                                WriteFailure.UnconfirmedDelete -> why.line("")
                                is WriteFailure.Refused -> why.said
                            }
                        }
                    } finally {
                        busy = false
                        onBusy(false)
                    }
                }
            },
            enabled = !busy && !tooLong,
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
            shape = RoundedCornerShape(WindmillRadius.lg),
            colors = ButtonDefaults.buttonColors(
                containerColor = skin.accent, contentColor = skin.onAccent,
                disabledContainerColor = skin.accent.copy(alpha = 0.4f), disabledContentColor = skin.onAccent,
            ),
        ) { Text(if (busy) "Saving…" else "Save fix", style = WindmillFont.body(16, FontWeight.Bold)) }
        TextButton(
            onClick = onDelete, enabled = !busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = skin.ink),
        ) { Text("Delete set", style = WindmillFont.body(16, FontWeight.Bold)) }
        routine?.let {
            Text("$it keeps its planned targets.", style = WindmillFont.body(13).copy(lineHeight = 17.sp),
                color = skin.inkDim)
        }
    }
}
