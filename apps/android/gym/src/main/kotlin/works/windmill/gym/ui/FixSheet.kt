package works.windmill.gym.ui

import works.windmill.platform.design.WindmillType
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Ladder
import works.windmill.gym.presentation.LoggedSetLimits
import works.windmill.gym.presentation.NumberEntry
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.SetEffort
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.store.FixOrigin
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.telemetry.LocalTelemetry
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.size

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FixSheet(
    set: TrainingSet,
    movement: String,
    position: Int,
    routine: String?,
    onSave: suspend (SetFix) -> FixOutcome,
    onDelete: () -> Unit,
    onClose: () -> Unit,
    onSaved: () -> Unit = {},
    onGone: (String) -> Unit = {},
    onBusy: (Boolean) -> Unit = {},
    draftKey: String = set.id,
    onEntryCancel: ((() -> Unit)?) -> Unit = {},
    exercise: Exercise? = null,
    origin: FixOrigin? = null,
) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val scope = rememberCoroutineScope()
    val telemetry = LocalTelemetry.current
    val noAnswer = stringResource(R.string.gym_fix_no_answer)
    val unit = Readout.loadUnit(exercise)
    val fieldColors = TextFieldDefaults.colors(
        focusedContainerColor = colors.surfaceContainerHighest, unfocusedContainerColor = colors.surfaceContainerHighest,
        disabledContainerColor = colors.surfaceContainerHighest, errorContainerColor = colors.surfaceContainerHighest,
        focusedTextColor = colors.onSurface, unfocusedTextColor = colors.onSurface, disabledTextColor = colors.onSurfaceVariant,
        focusedIndicatorColor = colors.primary, unfocusedIndicatorColor = colors.onSurfaceVariant,
        focusedLabelColor = colors.primary, unfocusedLabelColor = colors.onSurfaceVariant,
        focusedTrailingIconColor = colors.onSurfaceVariant, unfocusedTrailingIconColor = colors.onSurfaceVariant,
        cursorColor = colors.primary, errorIndicatorColor = colors.error, errorCursorColor = colors.error,
    )
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var weightKg by rememberSaveable(draftKey) { mutableDoubleStateOf(set.weightKg) }
    var reps by rememberSaveable(draftKey) { mutableIntStateOf(set.reps) }
    var rpe by rememberSaveable(draftKey) { mutableStateOf(set.rpe) }
    var note by rememberSaveable(draftKey) { mutableStateOf(set.note) }
    val load = rememberNumberDraft(draftKey, NumberEntry.Field.Load, weightKg, exercise?.loadFloor)
    val count = rememberNumberDraft(draftKey, NumberEntry.Field.Reps, reps.toDouble())
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

    fun save() {
        if (busy || tooLong || load.reading.belowFloor) return
        val loadValue = load.read()
        val repsValue = count.read()
        if (loadValue == null || repsValue == null) {
            origin?.let { telemetry.event("gym_action", mapOf("screen" to it.screen, "action" to "fix", "outcome" to "refused")) }
            return
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
                        WriteFailure.NoAnswer -> noAnswer
                        WriteFailure.UnconfirmedDelete -> why.line("")
                        is WriteFailure.Refused -> why.said
                    }
                }
            } finally {
                busy = false
                onBusy(false)
            }
        }
    }

    // Save fix stands below the scrolling body in thumb reach, so the keyboard never covers it; Delete set and the
    // routine's line end the body, so the keyboard never moves a control from one place to another.
    Column(Modifier.fillMaxWidth().background(colors.surfaceContainer)) {
        GymSheetBar(
            title = stringResource(R.string.gym_fix_title),
            onClose = onClose,
            closeEnabled = !busy,
            subtitle = stringResource(R.string.gym_fix_subtitle, movement, position.toString()),
            subtitleSpoken = stringResource(R.string.gym_fix_subtitle_spoken, movement, position.toString()),
            subtitleIcon = exercise?.let { { EquipmentIcon(it.equipment, Modifier.size(16.dp), tint = colors.onSurfaceVariant) } },
        )
        Column(
            Modifier.fillMaxWidth().weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = GymLayout.gutter),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SetNumbers(load, count, unit,
                stepLoad = { step, big -> load.bumped(if (step == NumberStep.Increase) 1 else -1, big)?.let(::acceptLoad) ?: NumberEditResult.Refused },
                stepReps = { step ->
                    count.read()?.let {
                        acceptReps(Ladder.bumpReps(it.toInt(), if (step == NumberStep.Increase) 1 else -1)
                            .coerceAtMost(LoggedSetLimits.maxReps).toDouble())
                    } ?: NumberEditResult.Refused
                },
                commit = { field ->
                    if (field === load) load.read()?.let(::acceptLoad) ?: NumberEditResult.Refused
                    else count.read()?.let(::acceptReps) ?: NumberEditResult.Refused
                },
                enabled = !busy)
            ExposedDropdownMenuBox(expanded = effortOpen, onExpandedChange = { if (!busy) effortOpen = it }) {
                TextField(value = rpe?.let(SetEffort::rpeReading) ?: SetEffort.rpeUnrated,
                    onValueChange = {}, readOnly = true, enabled = !busy, singleLine = true,
                    modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
                    textStyle = GymType.noteInput,
                    label = { Text(stringResource(R.string.gym_fix_effort), style = WindmillType.caption) }, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(effortOpen) },
                    colors = fieldColors)
                ExposedDropdownMenu(expanded = effortOpen, onDismissRequest = { effortOpen = false }, containerColor = colors.surfaceContainerHighest) {
                    (listOf<Double?>(null) + SetEffort.rpeBand).forEach { value ->
                        val label = value?.let(SetEffort::rpeReading) ?: SetEffort.rpeUnrated
                        DropdownMenuItem(text = { Text(label, style = WindmillType.body, color = colors.onSurface) },
                            onClick = { rpe = value; effortOpen = false },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { selected = rpe == value })
                    }
                }
            }
            refusal?.let { message ->
                Text(message, style = GymType.supportingTight, color = gymColors.alarmInk,
                    modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
            }
            val noteCounter = SetEffort.noteCounter(note)
            TextField(
                value = note, onValueChange = { note = it }, enabled = !busy, maxLines = 6, isError = tooLong,
                textStyle = GymType.noteInput,
                label = { Text(SetEffort.noteLabel, style = WindmillType.caption) },
                placeholder = { Text(stringResource(R.string.gym_fix_add_note), style = GymType.noteInput) },
                supportingText = if (!tooLong && noteCounter == null) null else { {
                    Column {
                        if (tooLong) Text(SetEffort.noteTooLong, style = WindmillType.supporting, color = gymColors.alarmInk,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                        noteCounter?.let { Text(it, style = GymType.numeralSmall, color = if (tooLong) gymColors.alarmInk else colors.onSurfaceVariant) }
                    }
                } },
                colors = fieldColors,
                modifier = Modifier.fillMaxWidth().semantics {
                    stateDescription = SetEffort.noteCaption
                    if (tooLong) error(SetEffort.noteTooLong)
                },
            )
            GymErrorTextButton(stringResource(R.string.gym_fix_delete_set), onClick = onDelete, enabled = !busy,
                modifier = Modifier.fillMaxWidth(), minimumHeight = 48.dp)
            routine?.let {
                Text(stringResource(R.string.gym_fix_routine_keeps_targets, it), style = GymType.supportingTight,
                    color = colors.onSurfaceVariant)
            }
        }
        GymSheetCommit(stringResource(R.string.gym_fix_save), enabled = !busy && !tooLong && !load.reading.belowFloor, onClick = ::save, busy = busy,
            modifier = Modifier.padding(horizontal = GymLayout.gutter).padding(top = 12.dp, bottom = GymLayout.sheetBottom))
    }
}
