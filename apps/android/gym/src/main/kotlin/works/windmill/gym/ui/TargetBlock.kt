package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.TargetEntry
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TargetBlock(
    scheme: TargetEntry.Draft,
    onChange: (TargetEntry.Draft) -> Unit,
    enabled: Boolean = true,
    bandAssisted: Boolean = false,
) {
    val skin = LocalGymColors.current
    val rows = scheme.rows
    val sets = scheme.sets
    // Add set was tapped at the ceiling; the next keystroke anywhere on the sheet clears it.
    var atCeiling by remember { mutableStateOf(false) }
    // A deleted row's neighbours are NEW rows with their own settled swipe (`RowSwipe.kt`): the
    // ladder's row keys carry the count of deletions so no row inherits a spent one.
    var deletions by remember { mutableIntStateOf(0) }
    var fillMenuOnHead by remember { mutableStateOf(false) }
    var fillMenuOnRow by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(enabled) {
        if (!enabled) {
            fillMenuOnHead = false
            fillMenuOnRow = null
        }
    }

    val broadFields = LocalDensity.current.fontScale > 1.3f || LocalConfiguration.current.screenWidthDp < 360
    val stackedLadder = broadFields && bandAssisted
    val shown = TargetEntry.shown(rows, sets)
    val reading = TargetEntry.reading(sets, rows)
    val refused = reading as? TargetEntry.Reading.Refused
    val headFault = refused?.takeIf { TargetEntry.inTheHead(it, shown) }
    val rowFault = refused?.takeIf { headFault == null }
    val ladderShown = sets.isNotBlank()

    fun count(typed: String) {
        onChange(scheme.withCount(typed))
        atCeiling = false
    }
    fun headTyped(reps: String? = null, weight: String? = null) {
        atCeiling = false
        onChange(scheme.copy(rows = when {
            reps != null -> TargetEntry.withReps(rows, reps)
            weight != null -> TargetEntry.withWeight(rows, weight)
            else -> rows
        }))
    }
    // The next hidden row is revealed before a new one is copied off the last shown.
    fun addSet() {
        if (shown.size >= Program.maxSets) {
            atCeiling = true
            return
        }
        if (shown.size < rows.size) {
            onChange(scheme.copy(sets = (shown.size + 1).toString()))
            return
        }
        val grown = TargetEntry.resized(rows, shown.size + 1)
        onChange(scheme.copy(rows = grown, sets = grown.size.toString()))
    }
    fun delete(index: Int) {
        onChange(scheme.copy(rows = rows.filterIndexed { at, _ -> at != index },
            sets = (shown.size - 1).takeIf { it > 0 }?.toString().orEmpty()))
        atCeiling = false
        deletions += 1
    }
    fun rowTyped(index: Int, reps: String = rows[index].reps, weight: String = rows[index].weight) {
        atCeiling = false
        onChange(scheme.copy(rows = rows.mapIndexed { at, row -> if (at == index) row.copy(reps = reps, weight = weight) else row }))
    }
    // Fill works the shown rows; the hidden tail stands as it was.
    fun fill(filled: List<TargetEntry.TypedSet>) {
        if (!enabled) return
        onChange(scheme.copy(rows = filled + rows.drop(shown.size)))
    }
    val fillMenu: @Composable (Boolean, () -> Unit) -> Unit = { expanded, dismiss ->
        DropdownMenu(expanded = enabled && expanded, onDismissRequest = dismiss) {
            DropdownMenuItem(
                text = { Text(TargetEntry.rampUp) },
                enabled = enabled && TargetEntry.canRamp(shown),
                onClick = {
                    fill(TargetEntry.rampUp(shown))
                    dismiss()
                },
            )
            DropdownMenuItem(
                text = { Text(TargetEntry.matchSetOne) },
                enabled = enabled,
                onClick = {
                    fill(TargetEntry.matchFirst(shown))
                    dismiss()
                },
            )
        }
    }


    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Target", style = WindmillFont.body(14), color = skin.inkDim, modifier = Modifier.weight(1f))
            TargetEntry.commit(reading)?.let { Text(it, style = GymType.numeral(14), color = skin.ink) }
        }
        if (!ladderShown) Text(TargetEntry.openLine, style = WindmillFont.body(16), color = skin.inkDim)
        TargetStepperRow("Sets", sets, TargetEntry.setsPlaceholder, "Sets target", false,
            enabled = enabled, bad = headFault?.field == TargetEntry.Field.Sets,
            onTyped = ::count, onStep = { onChange(scheme.stepped(TargetEntry.Field.Sets, it)) })
        TargetStepperRow("Reps", TargetEntry.sharedReps(shown),
            if (TargetEntry.repsVary(shown)) TargetEntry.varies else TargetEntry.repsPlaceholder,
            "Reps target", false, enabled = enabled && ladderShown,
            bad = headFault?.field == TargetEntry.Field.Reps,
            onTyped = { headTyped(reps = it) }, onStep = { onChange(scheme.stepped(TargetEntry.Field.Reps, it)) })
        TargetStepperRow("kg", TargetEntry.sharedWeight(shown),
            if (TargetEntry.weightVaries(shown)) TargetEntry.varies else "—",
            "Weight target", true, enabled = enabled && ladderShown,
            bad = headFault?.field == TargetEntry.Field.Weight,
            onTyped = { headTyped(weight = it) }, onStep = { onChange(scheme.stepped(TargetEntry.Field.Weight, it)) })
        if (bandAssisted) SignKey(enabled = enabled && ladderShown) {
            headTyped(weight = signFlipped(TargetEntry.sharedWeight(shown)))
        }
        headFault?.let { FaultLine(it.said) }
        Text("kg blank: pick it at the rack the first time; after that, last time fills it.",
            style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(
                onClick = {
                    val ramp = TargetEntry.rampUp(shown)
                    onChange(scheme.copy(rows = ramp + rows.drop(shown.size), varyBySet = true))
                },
                enabled = enabled && ladderShown && TargetEntry.canRamp(shown),
                shape = RoundedCornerShape(8.dp),
                colors = androidx.compose.material3.ButtonDefaults.textButtonColors(containerColor = skin.raised, contentColor = skin.ink),
                modifier = Modifier.heightIn(min = 40.dp),
            ) { Text(TargetEntry.rampUp, style = WindmillFont.body(14, FontWeight.Bold)) }
            TextButton(
                onClick = { onChange(scheme.copy(varyBySet = !scheme.varyBySet)) },
                enabled = enabled && ladderShown,
                shape = RoundedCornerShape(8.dp),
                colors = androidx.compose.material3.ButtonDefaults.textButtonColors(containerColor = skin.raised, contentColor = skin.ink),
                modifier = Modifier.heightIn(min = 40.dp),
            ) { Text("Vary by set", style = WindmillFont.body(14, FontWeight.Bold)) }
        }
        if (ladderShown && scheme.varyBySet) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(TargetEntry.setBySet, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                Spacer(Modifier.weight(1f))
                Box {
                    TextButton(onClick = { fillMenuOnHead = true }, enabled = enabled) {
                        Text(TargetEntry.fill, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    }
                    fillMenu(fillMenuOnHead) { fillMenuOnHead = false }
                }
            }

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Set", style = WindmillFont.body(13), color = skin.inkDim, modifier = Modifier.width(40.dp))
                if (stackedLadder) {
                    Text("Targets", style = WindmillFont.body(13), color = skin.inkDim, modifier = Modifier.weight(1f))
                } else {
                    Text("Reps", style = WindmillFont.body(13), color = skin.inkDim, modifier = Modifier.weight(1f))
                    Text("kg", style = WindmillFont.body(13), color = skin.inkDim, modifier = Modifier.weight(1f))
                    if (bandAssisted) Spacer(Modifier.width(48.dp))
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                shown.forEachIndexed { index, row ->
                    key("row-$deletions-$index") {
                        val fault = rowFault?.takeIf { it.row == index }
                        val rowReps: @Composable (Modifier) -> Unit = { modifier ->
                            TargetField(
                                label = if (stackedLadder) "Reps" else null,
                                value = row.reps,
                                placeholder = TargetEntry.repsPlaceholder,
                                decimal = false,
                                bad = fault?.field == TargetEntry.Field.Reps,
                                description = "Set ${index + 1} reps",
                                last = false,
                                enabled = enabled,
                                modifier = modifier,
                                onTyped = { rowTyped(index, reps = it) },
                            )
                        }
                        val rowWeight: @Composable (Modifier) -> Unit = { modifier ->
                            TargetField(
                                label = if (stackedLadder) "kg" else null,
                                value = row.weight,
                                placeholder = TargetEntry.weightPlaceholder,
                                decimal = true,
                                bad = fault?.field == TargetEntry.Field.Weight,
                                description = "Set ${index + 1} load",
                                last = index == shown.lastIndex,
                                enabled = enabled,
                                modifier = modifier,
                                onTyped = { rowTyped(index, weight = it) },
                            )
                        }
                        val swipe = rememberRowDismiss(settling = { it == SwipeToDismissBoxValue.EndToStart }) {
                            if (enabled) delete(index)
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
                            SwipeToDismissBox(
                                state = swipe,
                                enableDismissFromStartToEnd = false,
                                enableDismissFromEndToStart = enabled,
                                // The lane is drawn once the stroke begins: at rest the row says
                                // nothing about leaving.
                                backgroundContent = {
                                    if (swipe.dismissDirection == SwipeToDismissBoxValue.EndToStart) RowDeleteGround()
                                },
                            ) {
                                Box {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .heightIn(min = GymTap.minimum)
                                            .background(skin.surface)
                                            // Law 1: the swipe is half-built until its custom
                                            // action exists. The long press is a shortcut to
                                            // Fill, never the only path, so it carries no
                                            // action of its own.
                                            .semantics {
                                                customActions = if (!enabled) emptyList() else listOf(CustomAccessibilityAction(TargetEntry.delete) {
                                                    if (enabled) delete(index)
                                                    enabled
                                                })
                                            }
                                            .pointerInput(index, enabled) {
                                                detectTapGestures(onLongPress = { if (enabled) fillMenuOnRow = index })
                                            },
                                    ) {
                                        Text(
                                            "${index + 1}",
                                            style = GymType.numeral(13),
                                            color = skin.inkDim,
                                            modifier = Modifier.width(40.dp),
                                        )
                                        if (stackedLadder) {
                                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                                rowReps(Modifier.fillMaxWidth())
                                                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                                                    rowWeight(Modifier.weight(1f))
                                                    SignKey(enabled = enabled) { rowTyped(index, weight = signFlipped(row.weight)) }
                                                }
                                            }
                                        } else {
                                            rowReps(Modifier.weight(1f))
                                            rowWeight(Modifier.weight(1f))
                                            if (bandAssisted) SignKey(enabled = enabled) { rowTyped(index, weight = signFlipped(row.weight)) }
                                        }
                                    }
                                    fillMenu(fillMenuOnRow == index) { fillMenuOnRow = null }
                                }
                            }
                            fault?.let { FaultLine(it.said) }
                        }
                    }
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp)
                        .clickable(enabled = enabled, role = Role.Button, onClick = ::addSet),
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, tint = skin.accent)
                    Text(TargetEntry.addSet, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                }
                if (atCeiling) FaultLine(TargetEntry.outsideSets)
            }
        }
    }
}

@Composable
private fun TargetStepperRow(
    label: String,
    value: String,
    placeholder: String,
    description: String,
    decimal: Boolean,
    enabled: Boolean,
    bad: Boolean,
    onTyped: (String) -> Unit,
    onStep: (Int) -> Unit,
) {
    val skin = LocalGymColors.current
    val keyboard = LocalSoftwareKeyboardController.current
    val large = LocalDensity.current.fontScale > 1.3f || LocalConfiguration.current.screenWidthDp < 360
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (large) Text(label, style = WindmillFont.body(16), color = skin.ink)
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!large) Text(label, style = WindmillFont.body(16), color = skin.ink, modifier = Modifier.weight(1f))
            TargetStepKey(label, -1, enabled, onStep)
            BasicTextField(
                value = value, onValueChange = { if (it.length <= 8) onTyped(it) },
                enabled = enabled, singleLine = true,
                textStyle = GymType.numeral(28, FontWeight.Medium).copy(color = skin.ink,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center),
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number,
                    autoCorrectEnabled = false, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { keyboard?.hide() }),
                cursorBrush = SolidColor(skin.accent),
                modifier = (if (large) Modifier.weight(1f) else Modifier.width(88.dp))
                    .heightIn(min = 48.dp).semantics {
                        contentDescription = description
                        if (bad) error("Check this target")
                    },
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.Center) {
                        if (value.isEmpty()) Text(placeholder,
                            style = GymType.numeral(if (placeholder.length > 2) 14 else 28),
                            color = if (placeholder == "—") skin.ink else skin.inkDim)
                        inner()
                    }
                },
            )
            TargetStepKey(label, 1, enabled, onStep)
        }
    }
}

@Composable
private fun TargetStepKey(label: String, direction: Int, enabled: Boolean, onStep: (Int) -> Unit) {
    val skin = LocalGymColors.current
    Box(Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(skin.raised)
        .clickable(enabled = enabled, role = Role.Button) { onStep(direction) }
        .semantics { contentDescription = "${if (direction < 0) "Decrease" else "Increase"} $label" },
        contentAlignment = Alignment.Center) {
        Text(if (direction < 0) "−" else "+", style = WindmillFont.body(22, FontWeight.Bold),
            color = if (enabled) skin.ink else skin.inkDim)
    }
}

// One refusal at a time, in the alarm ink, under the field or the row that carries it.
@Composable
private fun FaultLine(said: String) {
    val skin = LocalGymColors.current
    Text(said, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.alarmInk)
}

// A sign the lifter can reach without a keyboard that has one. Empty stays empty: a sign with no
// number behind it is not a load, and an empty load already means `last time`.
private fun signFlipped(typed: String): String {
    val text = typed.trim()
    if (text.isEmpty()) return typed
    if (text.startsWith("-") || text.startsWith("−")) return text.drop(1)
    return "−$text"
}

@Composable
private fun SignKey(enabled: Boolean = true, onFlip: () -> Unit) {
    val skin = LocalGymColors.current
    Box(
        Modifier
            .sizeIn(minWidth = GymTap.minimum, minHeight = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(skin.raised)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = KeypadEntry.signName, onClick = onFlip)
            // The glyph reads as nothing out loud, so the control says what it is — and what a
            // negative load is, since no sentence beside the fields says it.
            .semantics(mergeDescendants = true) { contentDescription = KeypadEntry.signName },
        contentAlignment = Alignment.Center,
    ) {
        Text("±", style = WindmillFont.display(20, FontWeight.SemiBold), color = skin.ink)
    }
}

// Header and ladder fields share validation, native keyboard actions, and error semantics.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TargetField(
    label: String?,
    value: String,
    placeholder: String,
    decimal: Boolean,
    bad: Boolean,
    description: String,
    last: Boolean,
    modifier: Modifier,
    enabled: Boolean = true,
    onTyped: (String) -> Unit,
) {
    val skin = LocalGymColors.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val interaction = remember { MutableInteractionSource() }
    val colours = gymFieldColours().copy(unfocusedIndicatorColor = Color.Transparent,
        disabledIndicatorColor = Color.Transparent)
    val shape = RoundedCornerShape(WindmillRadius.md)
    val keyboardOptions = KeyboardOptions(
        keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number,
        autoCorrectEnabled = false,
        imeAction = if (last) ImeAction.Done else ImeAction.Next,
    )
    val keyboardActions = KeyboardActions(
        onNext = { focusManager.moveFocus(FocusDirection.Next) },
        onDone = { keyboard?.hide() },
    )
    // A keystroke that does not fit is refused WHOLE rather than truncated: a field that silently
    // drops the last character types a number nobody chose.
    val typed = { it: String -> if (it.length <= 8) onTyped(it) }
    // `Sets` alone is ambiguous read out of its row; the field says what it targets.
    val described = Modifier.fillMaxWidth().semantics {
        contentDescription = description
        if (bad) error("Check this target")
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (label != null) Text(label, style = WindmillFont.body(14), color = skin.inkDim)
        BasicTextField(
            value = value, onValueChange = typed, singleLine = true, enabled = enabled,
            textStyle = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 25.sp, color = skin.ink),
            keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
            interactionSource = interaction, cursorBrush = SolidColor(skin.accent),
            modifier = described.heightIn(min = 52.dp),
            decorationBox = { inner ->
                OutlinedTextFieldDefaults.DecorationBox(
                    value = value, innerTextField = inner, enabled = enabled, singleLine = true,
                    visualTransformation = VisualTransformation.None, interactionSource = interaction,
                    isError = bad, placeholder = { Text(placeholder, style = WindmillFont.body(16), maxLines = 1) },
                    colors = colours, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    container = { OutlinedTextFieldDefaults.Container(enabled = enabled, isError = bad, interactionSource = interaction, colors = colours, shape = shape) },
                )
            },
        )
    }
}
