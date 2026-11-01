package works.windmill.gym.ui

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
import androidx.compose.foundation.shape.RoundedCornerShape
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
    val problem = Program.nameProblem(movement.current.name)
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
            Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState())
                .testTag("movement-form-body")) {
                Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text(title, style = WindmillType.headline,
                        color = colors.onSurface, modifier = Modifier.weight(1f))
                    TextButton(onClick = onCancel, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text("Cancel", style = WindmillType.label)
                    }
                }
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 16.dp, bottom = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MovementFields(movement.current.name, movement.current.equipment, movement.current.loadCount,
                        onName = { onMovement(movement.named(it)) }, onEquipment = { onMovement(movement.equipped(it)) },
                        enabled = !busy && movementEditable, problem = problem.takeIf { movement.current.name.isNotEmpty() })
                    scheme?.let { RoutineTargets(it, movement, floor, onScheme, enabled = !busy, creating = creating) }
                    refusal?.let { Text(it, style = WindmillType.supportingParagraph, color = colors.error,
                        modifier = Modifier.semantics { error(it) }) }
                }
            }
            Button(onClick = onCommit, enabled = valid && !busy,
                modifier = Modifier.padding(horizontal = 16.dp).padding(top = 16.dp, bottom = 8.dp)
                    .fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(disabledContainerColor = colors.primary.copy(alpha = .38f),
                    disabledContentColor = colors.onPrimary.copy(alpha = .38f))) {
                Text(commitLabel, style = WindmillType.label)
            }
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
        is TargetEntry.Reading.Refused -> "Check ${when (reading.field) { TargetEntry.Field.Sets -> "Sets"; TargetEntry.Field.Reps -> "Reps"; TargetEntry.Field.Weight -> "Load" }}"
        TargetEntry.Reading.Open -> Readout.openTarget
        is TargetEntry.Reading.Scheme -> if (scheme.varyBySet && !DomainSetTarget.straight(reading.sets.map { it.domain }))
            "${reading.sets.size} sets · varies" else Readout.targetWithUnit(reading.sets, movement.current)
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Target", style = WindmillType.detailCompact, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(summary, style = GymType.numeral, color = colors.onSurfaceVariant)
        }
        if (!perSet) {
            RoutineStepper("Sets", scheme.sets, "sets", TargetEntry.setsPlaceholder,
                headFault?.takeIf { it.field == TargetEntry.Field.Sets }?.let {
                    if (scheme.sets.trim() == "0") TargetEntry.outsideSets else it.said
                }, enabled, decimal = false, onTyped = { update(scheme.withCount(it)) },
                onStep = { stepped(TargetEntry.Field.Sets, it) }, reading = reading)
            RoutineStepper("Reps", TargetEntry.sharedReps(shown), "reps",
                if (TargetEntry.repsVary(shown)) TargetEntry.varies else TargetEntry.repsPlaceholder,
                headFault?.takeIf { it.field == TargetEntry.Field.Reps }?.said,
                enabled && scheme.sets.isNotBlank(), decimal = false,
                onTyped = { update(scheme.copy(rows = TargetEntry.withReps(scheme.rows, it))) },
                onStep = { stepped(TargetEntry.Field.Reps, it) }, reading = reading)
            RoutineStepper("Load", TargetEntry.sharedWeight(shown), unit,
                if (TargetEntry.weightVaries(shown)) TargetEntry.varies else "—",
                headFault?.takeIf { it.field == TargetEntry.Field.Weight }?.said,
                enabled && scheme.sets.isNotBlank(), decimal = true,
                onTyped = { update(scheme.copy(rows = TargetEntry.withWeight(scheme.rows, it))) },
                onStep = { stepped(TargetEntry.Field.Weight, it) }, reading = reading)
            if (!creating && shown.all { it.weight.isBlank() }) Text("kg blank: pick it at the rack the first time; after that, last time fills it.",
                style = WindmillType.detail, color = colors.onSurfaceVariant)
        }
        if (!creating || scheme.varyBySet) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SuggestionChip(onClick = { update(scheme.copy(
                    rows = TargetEntry.rampUp(shown) + scheme.rows.drop(shown.size), varyBySet = true)) },
                    label = { Text(TargetEntry.rampUp, style = WindmillType.supporting) },
                    enabled = enabled && TargetEntry.canRamp(shown), modifier = Modifier.heightIn(min = 48.dp))
                FilterChip(selected = scheme.varyBySet, onClick = { update(scheme.copy(varyBySet = !scheme.varyBySet)) },
                    label = { Text("Vary by set", style = if (scheme.varyBySet) GymType.groupLabel else WindmillType.supporting) },
                    enabled = enabled && scheme.sets.isNotBlank(), modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        if (perSet) {
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(TargetEntry.setBySet, style = WindmillType.label, color = colors.onSurface, modifier = Modifier.weight(1f))
                Box {
                    TextButton(onClick = { fill = true }, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(TargetEntry.fill, style = GymType.groupLabel)
                    }
                    DropdownMenu(expanded = fill && enabled, onDismissRequest = { fill = false }) {
                        DropdownMenuItem(text = { Text(TargetEntry.rampUp) }, enabled = TargetEntry.canRamp(shown),
                            onClick = { filled(TargetEntry.rampUp(shown)); fill = false })
                        DropdownMenuItem(text = { Text(TargetEntry.matchSetOne) },
                            onClick = { filled(TargetEntry.matchFirst(shown)); fill = false })
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Set", style = WindmillType.captionCompact, color = colors.onSurfaceVariant, modifier = Modifier.width(32.dp))
                Text("Reps", style = WindmillType.captionCompact, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
                Text(unit, style = WindmillType.captionCompact, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
            }
            shown.forEachIndexed { index, row -> key(removals, index) {
                val fault = refused?.takeIf { it.row == index && headFault == null }
                DeleteSwipeRow(actionLabel = TargetEntry.delete, enabled = enabled, onDelete = {
                    update(scheme.copy(rows = scheme.rows.filterIndexed { at, _ -> at != index },
                        sets = (shown.size - 1).takeIf { it > 0 }?.toString().orEmpty()))
                    removals += 1
                    true
                }) {
                    Row(Modifier.fillMaxWidth().background(colors.surfaceContainer), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text("${index + 1}", style = GymType.numeral, color = colors.onSurfaceVariant, modifier = Modifier.width(32.dp))
                        RoutineTargetField(row.reps, TargetEntry.repsPlaceholder, "Set ${index + 1} reps", false,
                            fault?.takeIf { it.field == TargetEntry.Field.Reps }?.said, enabled, Modifier.weight(1f)) {
                            update(scheme.copy(rows = scheme.rows.mapIndexed { at, value -> if (at == index) value.copy(reps = it) else value }))
                        }
                        RoutineTargetField(row.weight, "—", "Set ${index + 1} load", true,
                            fault?.takeIf { it.field == TargetEntry.Field.Weight }?.said, enabled, Modifier.weight(1f)) {
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
                Text(TargetEntry.addSet)
            }
            if (ceiling) Text(TargetEntry.outsideSets, color = colors.error, style = WindmillType.supporting)
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
            placeholder = { Text(placeholder) }, isError = refusal != null, shape = RoundedCornerShape(4.dp),
            textStyle = GymType.stockFieldInput,
            keyboardOptions = KeyboardOptions(keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number,
                autoCorrectEnabled = false, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).onFocusChanged { focused = it.isFocused }
                .semantics { contentDescription = description; refusal?.let { error(it) } })
        refusal?.let { Text(it, style = WindmillType.supportingParagraph, color = colors.error) }
    }
}
