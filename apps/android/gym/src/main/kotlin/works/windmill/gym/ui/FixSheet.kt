package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.platform.LocalDensity
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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LoggedSetLimits
import works.windmill.gym.domain.NumberEntry
import works.windmill.gym.domain.SetEffort
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.FixOrigin
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.telemetry.LocalTelemetry

@OptIn(ExperimentalMaterial3Api::class)
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
    exercise: Exercise? = null,
    origin: FixOrigin? = null,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val telemetry = LocalTelemetry.current
    val unit = works.windmill.gym.domain.sync.Readout.loadUnit(exercise?.equipment, exercise?.loadCount ?: 1)
    val noteInteraction = remember(draftKey) { MutableInteractionSource() }
    val noteFocused by noteInteraction.collectIsFocusedAsState()
    val fieldColors = TextFieldDefaults.colors(
        focusedContainerColor = skin.raised, unfocusedContainerColor = skin.raised,
        disabledContainerColor = skin.raised, errorContainerColor = skin.raised,
        focusedTextColor = skin.ink, unfocusedTextColor = skin.ink, disabledTextColor = skin.inkDim,
        focusedIndicatorColor = skin.accent, unfocusedIndicatorColor = skin.inkDim,
        focusedLabelColor = skin.accent, unfocusedLabelColor = skin.inkDim,
        focusedTrailingIconColor = skin.inkDim, unfocusedTrailingIconColor = skin.inkDim,
        cursorColor = skin.accent, errorIndicatorColor = skin.error, errorCursorColor = skin.error,
    )
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var weightKg by rememberSaveable(draftKey) { mutableDoubleStateOf(set.weightKg) }
    var reps by rememberSaveable(draftKey) { mutableIntStateOf(set.reps) }
    var rpe by rememberSaveable(draftKey) { mutableStateOf(set.rpe) }
    var note by rememberSaveable(draftKey) { mutableStateOf(set.note) }
    val load = rememberNumberDraft(draftKey, NumberEntry.Field.Load, weightKg, exercise?.loadFloor)
    val count = rememberNumberDraft(draftKey, NumberEntry.Field.Reps, reps.toDouble())
    val loadFeedback = rememberNumberStepperFeedback()
    var effortOpen by rememberSaveable(draftKey) { mutableStateOf(false) }
    var refusal by rememberSaveable(draftKey) { mutableStateOf<String?>(null) }
    var busy by remember(draftKey) { mutableStateOf(false) }
    val tooLong = SetEffort.noteOverlong(note)
    val cancelEntry: () -> Unit = remember(load, count, focus, keyboard) { {
        load.cancel()
        count.cancel()
        load.focus(false) { NumberEditResult.Unchanged }
        count.focus(false) { NumberEditResult.Unchanged }
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

    @Composable
    fun SaveFix(modifier: Modifier) {
        Button(
            onClick = {
                if (busy || tooLong || load.reading.belowFloor) return@Button
                val loadValue = load.read()
                val repsValue = count.read()
                if (loadValue == null || repsValue == null) {
                    origin?.let { telemetry.event("gym_action", mapOf("screen" to it.screen, "action" to "fix", "outcome" to "refused")) }
                    return@Button
                }
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
            enabled = !busy && !tooLong && !load.reading.belowFloor,
            modifier = modifier.heightIn(min = 64.dp),
            shape = RoundedCornerShape(WindmillRadius.lg),
            colors = ButtonDefaults.buttonColors(
                containerColor = skin.accent, contentColor = skin.onAccent,
                disabledContainerColor = skin.accent.copy(alpha = 0.4f), disabledContentColor = skin.onAccent,
            ),
        ) { Text(if (busy) "Saving…" else "Save fix", style = WindmillFont.body(16, FontWeight.Bold)) }
    }

    @Composable
    fun DeleteAndPlanNote() {
        GymErrorTextButton("Delete set", onClick = onDelete, enabled = !busy,
            modifier = Modifier.fillMaxWidth(), minimumHeight = 48.dp)
        routine?.let {
            Text("$it keeps its planned targets.", style = WindmillFont.body(14).copy(lineHeight = 18.sp),
                color = skin.inkDim)
        }
    }

    // Save fix stands below the scrolling fields, so the keyboard never covers it, as it never covers Log set or
    // Done. While the keyboard is up, Delete set and the routine line scroll with the fields to leave them room.
    val typing = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    Column(Modifier.fillMaxWidth().background(skin.surface).padding(bottom = GymLayout.sheetBottom)) {
        Column(
            Modifier.fillMaxWidth().weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = GymLayout.gutter),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Fix set", style = WindmillFont.display(28, FontWeight.Bold).copy(lineHeight = 36.sp),
                    color = skin.ink, modifier = Modifier.semantics { heading() })
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    exercise?.let { EquipmentIcon(it.equipment, tint = skin.inkDim) }
                    Text("$movement · Set $setNumber", style = WindmillFont.body(16).copy(lineHeight = 21.sp), color = skin.inkDim)
                }
            }
            fun commitLoad(): NumberEditResult = load.read()?.let(::acceptLoad) ?: NumberEditResult.Refused
            fun commitReps(): NumberEditResult = count.read()?.let(::acceptReps) ?: NumberEditResult.Refused
            NumberStepper(load.text, load::edit, "Load", unit,
                onStep = { step -> load.bumped(if (step == NumberStep.Increase) 1 else -1, false)?.let(::acceptLoad) ?: NumberEditResult.Refused },
                onCommit = ::commitLoad,
                size = NumberStepperSize.Display, input = NumberStepperInput.SignedDecimal,
                refusal = load.shownRefusal, enabled = !busy, decreaseEnabled = load.canDecrease, feedback = loadFeedback,
                onFocusChange = { load.focus(it, ::commitLoad) })
            LadderRow(load.reading.value ?: load.committed, onDial = { step, big ->
                load.bumped(if (step == NumberStep.Increase) 1 else -1, big)?.let { loadFeedback.accept(acceptLoad(it), step) }
            }, enabled = !busy, decreaseEnabled = load.canDecrease)
            NumberStepper(count.text, count::edit, "Reps", "reps",
                onStep = { step ->
                    count.read()?.let {
                        acceptReps(Ladder.bumpReps(it.toInt(), if (step == NumberStep.Increase) 1 else -1)
                            .coerceAtMost(LoggedSetLimits.maxReps).toDouble())
                    } ?: NumberEditResult.Refused
                },
                onCommit = ::commitReps,
                refusal = count.refusal, enabled = !busy, onFocusChange = { count.focus(it, ::commitReps) },
                decreaseEnabled = count.reading.value != 1.0, increaseEnabled = count.reading.value != LoggedSetLimits.maxReps.toDouble())
            ExposedDropdownMenuBox(expanded = effortOpen, onExpandedChange = { if (!busy) effortOpen = it }) {
                TextField(value = rpe?.let(SetEffort::rpeReading) ?: SetEffort.rpeUnrated,
                    onValueChange = {}, readOnly = true, enabled = !busy, singleLine = true,
                    modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
                    label = { Text("Effort", style = WindmillFont.body(12).copy(lineHeight = 16.sp)) }, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(effortOpen) },
                    colors = fieldColors)
                ExposedDropdownMenu(expanded = effortOpen, onDismissRequest = { effortOpen = false }, containerColor = skin.raised) {
                    (listOf<Double?>(null) + SetEffort.rpeBand).forEach { value ->
                        val label = value?.let(SetEffort::rpeReading) ?: SetEffort.rpeUnrated
                        DropdownMenuItem(text = { Text(label, style = WindmillFont.body(16), color = skin.ink) },
                            onClick = { rpe = value; effortOpen = false },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { selected = rpe == value })
                    }
                }
            }
            refusal?.let { message ->
                Text(message, style = WindmillFont.body(14).copy(lineHeight = 18.sp), color = skin.alarmInk,
                    modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
            }
            BasicTextField(
                value = note, onValueChange = { note = it }, enabled = !busy,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = skin.ink, lineHeight = 24.sp),
                cursorBrush = SolidColor(skin.accent), maxLines = 6, interactionSource = noteInteraction,
                modifier = Modifier.fillMaxWidth().semantics {
                    stateDescription = SetEffort.noteCaption
                    if (tooLong) error(SetEffort.noteTooLong)
                },
                decorationBox = { field ->
                    Box(Modifier.heightIn(min = 56.dp)) {
                        TextFieldDefaults.Container(!busy, tooLong, noteInteraction, Modifier.matchParentSize(), fieldColors)
                        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                            Text(SetEffort.noteLabel, style = WindmillFont.body(12).copy(lineHeight = 16.sp),
                                color = if (tooLong) skin.error else if (noteFocused) skin.accent else skin.inkDim)
                            Box {
                                if (note.isEmpty()) Text("Add a note", style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp), color = skin.inkDim)
                                field()
                            }
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
            if (typing) DeleteAndPlanNote()
        }
        Column(Modifier.padding(horizontal = GymLayout.gutter).padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SaveFix(Modifier.fillMaxWidth())
            if (!typing) DeleteAndPlanNote()
        }
    }
}
