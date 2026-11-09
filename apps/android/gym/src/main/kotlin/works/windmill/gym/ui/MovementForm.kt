package works.windmill.gym.ui

import works.windmill.platform.R as PlatformR
import works.windmill.platform.design.WindmillType
import androidx.compose.material3.MaterialTheme
import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import works.windmill.gym.R
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import works.windmill.gym.presentation.Program
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.RoutineMovement
import works.windmill.gym.presentation.TargetEntry
import works.windmill.gym.domain.sync.SetTarget as DomainSetTarget
import works.windmill.platform.i18n.text
import works.windmill.platform.i18n.pluralString

@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun MovementForm(
    movement: RoutineMovement,
    scheme: TargetEntry.Draft?,
    title: String,
    commitLabel: String,
    onMovement: (RoutineMovement) -> Unit,
    onScheme: (TargetEntry.Draft) -> Unit,
    onCancel: () -> Unit,
    onCommit: () -> Unit,
    creating: Boolean = false,
    busy: Boolean = false,
    refusal: String? = null,
    movementEditable: Boolean = true,
    floor: Double? = movement.current.loadFloor,
) {
    val colors = MaterialTheme.colorScheme
    val problem = Program.nameRefusal(movement.current.name)?.let { stringResource(it) }
    val valid = problem == null && scheme?.reading(floor) !is TargetEntry.Reading.Refused
    val input = remember {
        PlatformTextInputInterceptor { request, next ->
            next.startInputMethod(object : PlatformTextInputMethodRequest {
                override fun createInputConnection(outAttributes: EditorInfo) = request.createInputConnection(outAttributes).also {
                    if (outAttributes.inputType and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_NUMBER &&
                        outAttributes.inputType and InputType.TYPE_NUMBER_FLAG_DECIMAL != 0)
                        outAttributes.inputType = outAttributes.inputType or InputType.TYPE_NUMBER_FLAG_SIGNED
                }
            })
        }
    }
    InterceptPlatformTextInput(input) {
        Column(Modifier.fillMaxWidth().heightIn(max = pickerMaxHeight()).imePadding()) {
            GymSheetBar(title, onClose = onCancel, closeEnabled = !busy)
            Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState())
                .testTag("movement-form-body")) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MovementFields(movement.current.name, movement.current.equipment, movement.current.loadCount,
                        onName = { onMovement(movement.named(it)) }, onEquipment = { onMovement(movement.equipped(it)) },
                        enabled = !busy && movementEditable, problem = problem.takeIf { movement.current.name.isNotEmpty() })
                    scheme?.let { RoutineTargets(it, movement, floor, onScheme, enabled = !busy, creating = creating) }
                    refusal?.let { Text(it, style = WindmillType.supportingParagraph, color = colors.error,
                        modifier = Modifier.semantics { error(it) }) }
                }
            }
            GymSheetCommit(commitLabel, enabled = valid && !busy, onClick = onCommit,
                modifier = Modifier.padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 8.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoutineTargets(
    scheme: TargetEntry.Draft,
    movement: RoutineMovement,
    floor: Double?,
    onChange: (TargetEntry.Draft) -> Unit,
    enabled: Boolean,
    creating: Boolean,
) {
    val colors = MaterialTheme.colorScheme
    val shown = TargetEntry.shown(scheme.rows, scheme.sets)
    val reading = scheme.reading(floor)
    val refused = reading as? TargetEntry.Reading.Refused
    val perSet = scheme.varyBySet && scheme.sets.isNotBlank() && refused?.field != TargetEntry.Field.Sets
    val headFault = refused?.takeIf { !perSet && (TargetEntry.inTheHead(it, shown) || it.field == TargetEntry.Field.Sets) }
    val unit = works.windmill.gym.domain.sync.Readout.loadUnit(movement.current.equipment, movement.current.loadCount)
    var fill by remember { mutableStateOf(false) }
    var ceiling by remember { mutableStateOf(false) }
    var removals by remember { mutableIntStateOf(0) }
    fun update(next: TargetEntry.Draft) { ceiling = false; onChange(next) }
    fun filled(rows: List<TargetEntry.TypedSet>) = update(scheme.copy(rows = rows + scheme.rows.drop(shown.size)))
    fun stepped(field: TargetEntry.Field, direction: Int): NumberEditResult {
        if (reading is TargetEntry.Reading.Refused) return NumberEditResult.Refused
        val next = scheme.stepped(field, direction, floor)
        if (next == scheme) return NumberEditResult.Unchanged
        update(next)
        return NumberEditResult.Changed
    }
    val summary = when (reading) {
        is TargetEntry.Reading.Refused -> stringResource(when (reading.field) {
            TargetEntry.Field.Sets -> R.string.gym_movement_check_sets
            TargetEntry.Field.Reps -> R.string.gym_movement_check_reps
            TargetEntry.Field.Weight -> R.string.gym_movement_check_load
        })
        TargetEntry.Reading.Open -> Readout.open.text()
        is TargetEntry.Reading.Scheme -> if (scheme.varyBySet && !DomainSetTarget.straight(reading.sets.map { it.domain }))
            pluralString(R.plurals.gym_movement_sets_vary, reading.sets.size, reading.sets.size.toString())
            else Readout.scheme(reading.sets, movement.current).text()
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.gym_movement_target), style = WindmillType.detailCompact, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(summary, style = GymType.numeral, color = colors.onSurfaceVariant)
        }
        if (!perSet) {
            RoutineStepper(stringResource(R.string.gym_movement_stepper_sets), scheme.sets, stringResource(R.string.gym_movement_unit_sets),
                stringResource(R.string.gym_program_sets_placeholder),
                headFault?.takeIf { it.field == TargetEntry.Field.Sets }?.let {
                    if (scheme.sets.trim() == "0") TargetEntry.outsideSetsBand else it.why
                }?.text(), enabled, decimal = false, onTyped = { update(scheme.withCount(it)) },
                onStep = { stepped(TargetEntry.Field.Sets, it) }, reading = reading)
            RoutineStepper(stringResource(R.string.gym_movement_stepper_reps), TargetEntry.sharedReps(shown), stringResource(R.string.gym_movement_unit_reps),
                stringResource(if (TargetEntry.repsVary(shown)) R.string.gym_program_varies else R.string.gym_program_reps_placeholder),
                headFault?.takeIf { it.field == TargetEntry.Field.Reps }?.why?.text(),
                enabled && scheme.sets.isNotBlank(), decimal = false,
                onTyped = { update(scheme.copy(rows = TargetEntry.withReps(scheme.rows, it))) },
                onStep = { stepped(TargetEntry.Field.Reps, it) }, reading = reading)
            RoutineStepper(stringResource(R.string.gym_movement_stepper_load), TargetEntry.sharedWeight(shown), unit,
                if (TargetEntry.weightVaries(shown)) stringResource(R.string.gym_program_varies) else "—",
                headFault?.takeIf { it.field == TargetEntry.Field.Weight }?.why?.text(),
                enabled && scheme.sets.isNotBlank(), decimal = true,
                onTyped = { update(scheme.copy(rows = TargetEntry.withWeight(scheme.rows, it))) },
                onStep = { stepped(TargetEntry.Field.Weight, it) }, reading = reading)
            if (!creating && shown.all { it.weight.isBlank() }) Text(stringResource(R.string.gym_movement_kg_blank),
                style = WindmillType.detail, color = colors.onSurfaceVariant)
        }
        if (!creating || scheme.varyBySet) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SuggestionChip(onClick = { update(scheme.copy(
                    rows = TargetEntry.rampUp(shown) + scheme.rows.drop(shown.size), varyBySet = true)) },
                    label = { Text(stringResource(R.string.gym_program_ramp_up), style = WindmillType.supporting) },
                    enabled = enabled && TargetEntry.canRamp(shown), modifier = Modifier.heightIn(min = 48.dp))
                FilterChip(selected = scheme.varyBySet, onClick = { update(scheme.copy(varyBySet = !scheme.varyBySet)) },
                    label = { Text(stringResource(R.string.gym_movement_vary_by_set), style = if (scheme.varyBySet) GymType.groupLabel else WindmillType.supporting) },
                    enabled = enabled && scheme.sets.isNotBlank(), modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        if (perSet) {
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.gym_program_set_by_set), style = WindmillType.label, color = colors.onSurface, modifier = Modifier.weight(1f))
                Box {
                    TextButton(onClick = { fill = true }, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.gym_program_fill), style = GymType.groupLabel)
                    }
                    DropdownMenu(expanded = fill && enabled, onDismissRequest = { fill = false }) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.gym_program_ramp_up)) }, enabled = TargetEntry.canRamp(shown),
                            onClick = { filled(TargetEntry.rampUp(shown)); fill = false })
                        DropdownMenuItem(text = { Text(stringResource(R.string.gym_program_match_set_one)) },
                            onClick = { filled(TargetEntry.matchFirst(shown)); fill = false })
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.gym_movement_column_set), style = WindmillType.captionCompact, color = colors.onSurfaceVariant, modifier = Modifier.width(32.dp))
                Text(stringResource(R.string.gym_movement_column_reps), style = WindmillType.captionCompact, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
                Text(unit, style = WindmillType.captionCompact, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
            }
            shown.forEachIndexed { index, row -> key(removals, index) {
                val fault = refused?.takeIf { it.row == index && headFault == null }
                DeleteSwipeRow(actionLabel = stringResource(PlatformR.string.platform_delete), enabled = enabled, onDelete = {
                    update(scheme.copy(rows = scheme.rows.filterIndexed { at, _ -> at != index },
                        sets = (shown.size - 1).takeIf { it > 0 }?.toString().orEmpty()))
                    removals += 1
                    true
                }) {
                    Row(Modifier.fillMaxWidth().background(colors.surfaceContainer), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text("${index + 1}", style = GymType.numeral, color = colors.onSurfaceVariant, modifier = Modifier.width(32.dp))
                        RoutineTargetField(row.reps, stringResource(R.string.gym_program_reps_placeholder), stringResource(R.string.gym_movement_set_reps, (index + 1).toString()), false,
                            fault?.takeIf { it.field == TargetEntry.Field.Reps }?.why?.text(), enabled, Modifier.weight(1f)) {
                            update(scheme.copy(rows = scheme.rows.mapIndexed { at, value -> if (at == index) value.copy(reps = it) else value }))
                        }
                        RoutineTargetField(row.weight, "—", stringResource(R.string.gym_movement_set_load, (index + 1).toString()), true,
                            fault?.takeIf { it.field == TargetEntry.Field.Weight }?.why?.text(), enabled, Modifier.weight(1f)) {
                            update(scheme.copy(rows = scheme.rows.mapIndexed { at, value -> if (at == index) value.copy(weight = it) else value }))
                        }
                    }
                }
            } }
            TextButton(onClick = {
                if (shown.size >= Program.maxSets) ceiling = true
                else update(scheme.copy(rows = TargetEntry.grown(scheme.rows, shown.size + 1), sets = (shown.size + 1).toString()))
            }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Icon(painterResource(R.drawable.gym_native_add), null, Modifier.size(24.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.gym_program_add_set))
            }
            if (ceiling) Text(TargetEntry.outsideSetsBand.text(), color = colors.error, style = WindmillType.supporting)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoutineStepper(
    label: String, value: String, unit: String, placeholder: String, refusal: String?, enabled: Boolean,
    decimal: Boolean, onTyped: (String) -> Unit, onStep: (Int) -> NumberEditResult, reading: TargetEntry.Reading,
) {
    val intoView = remember { BringIntoViewRequester() }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(focused, refusal) {
        if (focused) { withFrameNanos { }; intoView.bringIntoView() }
    }
    NumberStepper(value, onTyped, label, unit,
        onStep = { direction -> onStep(if (direction == NumberStep.Increase) 1 else -1) }, onCommit = { if (reading is TargetEntry.Reading.Refused) NumberEditResult.Refused else NumberEditResult.Unchanged },
        modifier = Modifier.fillMaxWidth().bringIntoViewRequester(intoView),
        input = if (decimal) NumberStepperInput.SignedDecimal else NumberStepperInput.Count,
        refusal = refusal, placeholder = placeholder, enabled = enabled, onFocusChange = { focused = it })
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoutineTargetField(
    value: String, placeholder: String, description: String, decimal: Boolean, refusal: String?,
    enabled: Boolean, modifier: Modifier, onTyped: (String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val intoView = remember { BringIntoViewRequester() }
    var focused by remember { mutableStateOf(false) }
    var editor by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    SideEffect {
        if (editor.text != value) editor = editor.copy(text = value,
            selection = TextRange(editor.selection.start.coerceAtMost(value.length), editor.selection.end.coerceAtMost(value.length)))
    }
    LaunchedEffect(focused, refusal) {
        if (focused) { withFrameNanos { }; intoView.bringIntoView() }
    }
    Column(modifier.bringIntoViewRequester(intoView), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedTextField(editor, onValueChange = { next ->
            val previous = editor
            val accepted = numberStepperEdit(previous, next)
            editor = accepted
            if (accepted.text != previous.text) onTyped(accepted.text)
        }, enabled = enabled, singleLine = true,
            placeholder = { Text(placeholder) }, isError = refusal != null,
            textStyle = GymType.stockFieldInput,
            keyboardOptions = KeyboardOptions(keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number,
                autoCorrectEnabled = false, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).onFocusChanged { focused = it.isFocused }
                .semantics { contentDescription = description; refusal?.let { error(it) } })
        refusal?.let { Text(it, style = WindmillType.supportingParagraph, color = colors.error) }
    }
}
