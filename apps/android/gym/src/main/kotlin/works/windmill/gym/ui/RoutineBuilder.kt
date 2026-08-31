package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.net.WindmillJson

// Save enables when the draft is savable — named and holding at least one movement — and for an edit
// only once something actually changed: a Save that rewrote a document with itself would move the
// revision and supersede a pending proposal for nothing.
val routineDraftSaver: Saver<RoutineDraft?, String> = Saver(
    save = { draft -> draft?.let { runCatching { WindmillJson.encodeToString(RoutineDraft.serializer(), it) }.getOrNull() } ?: "" },
    restore = { written ->
        if (written.isEmpty()) null
        else runCatching { WindmillJson.decodeFromString(RoutineDraft.serializer(), written) }.getOrNull()
    },
)

// No pad over a sheet over a screen: the target sheet's three fields take the platform's own
// keyboard. The picker's create step is drawn by the picker itself, so minting stacks a sheet
// rather than swapping one out from under a typed search.
private sealed interface BuilderSheet {
    data class Target(val exerciseId: String) : BuilderSheet
    data object Picker : BuilderSheet
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutineBuilder(
    draft: RoutineDraft,
    store: TrainingStore,
    saving: Boolean,
    onDraft: (RoutineDraft) -> Unit,
    onSave: () -> Unit,
    onClose: () -> Unit,
    say: (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var sheet by remember { mutableStateOf<BuilderSheet?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Compose fires no dismiss callback on a programmatic close, so nothing waits for one.
    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { sheet = null }
    }

    // `savable` is the domain's (named, ≥1 movement); `changed` is read against the routine as it stands.
    val standing = draft.id?.let { store.routine(it) }
    val changed = standing == null || draft != RoutineDraft.of(standing)
    val editing = draft.id != null

    Column(Modifier.fillMaxSize()) {
        BuildStep(
            draft = draft,
            store = store,
            editing = editing,
            // C19: while a target sheet stands over the list, the SHEET owns the open line's
            // sentence and the list's copy stands down — one state says it once, never a blessing
            // behind a scrim beside a refusal in front of it.
            targeting = sheet is BuilderSheet.Target,
            savable = draft.savable && changed && !saving,
            onDraft = onDraft,
            onOpenTarget = { sheet = BuilderSheet.Target(it) },
            onRemove = { onDraft(draft.removing(it)) },
            onAdd = { sheet = BuilderSheet.Picker },
            onSave = onSave,
            onCancel = onClose,
        )
    }

    val open = sheet
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
        ) {
            when (open) {
                is BuilderSheet.Target -> TargetSheet(
                    draft = draft,
                    exerciseId = open.exerciseId,
                    store = store,
                    onSet = { reading ->
                        when (reading) {
                            TargetEntry.Reading.Open -> onDraft(draft.opening(open.exerciseId))
                            is TargetEntry.Reading.Targeted -> onDraft(
                                draft.targeting(open.exerciseId, reading.sets, reading.reps, reading.weightKg)
                            )
                            is TargetEntry.Reading.Refused -> return@TargetSheet
                        }
                        close()
                    },
                )
                BuilderSheet.Picker -> MovementPicker(
                    catalog = store.catalog,
                    taken = draft.entries.map { it.exerciseId },
                    lastSets = null,
                    nowMs = 0,
                    sessions = store.recent,
                    title = "Add movement",
                    catalogUnread = store.catalogUnread,
                    onPick = {
                        onDraft(draft.adding(it))
                        close()
                    },
                    onCreate = { name, equipment ->
                        say(null)
                        close()
                        scope.launch {
                            when (val made = store.create(name, equipment)) {
                                is GymResult.Ok -> onDraft(draft.adding(made.value.id))
                                is GymResult.Failed -> say(made.why.line("“$name” wasn’t created"))
                            }
                        }
                    },
                    modifier = Modifier
                        .heightIn(max = pickerMaxHeight())
                        .background(GymSkin.surface)
                        .padding(WindmillSpace.x5),
                    onClose = { close() },
                )
            }
        }
    }
}

@Composable
private fun BuildStep(
    draft: RoutineDraft,
    store: TrainingStore,
    editing: Boolean,
    targeting: Boolean,
    savable: Boolean,
    onDraft: (RoutineDraft) -> Unit,
    onOpenTarget: (String) -> Unit,
    onRemove: (String) -> Unit,
    onAdd: () -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    val dropAt = with(LocalDensity.current) { 108.dp.toPx() }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val missing = Program.missing(draft)

    GymScreen(
        title = if (editing) "Edit routine" else "New routine",
        onBack = onCancel,
        backTo = "the routine you were on",
        actions = { TopAction("Save", enabled = savable, onClick = onSave) },
    ) {
      // Inside the container, beside the field: `Scaffold` subcomposes its content during measure, so
      // an effect declared outside it asks a `FocusRequester` whose node is not attached yet and
      // throws out of the composition.
      LaunchedEffect(Unit) {
          if (draft.id == null && draft.name.isEmpty()) {
              focus.requestFocus()
              keyboard?.show()
          }
      }

      Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxSize()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x8),
      ) {
        // The name is the editor's first field and it opens with the keyboard up: there is no
        // screen in front of this one asking for a string this screen already has a field for.
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft.name,
                onValueChange = { onDraft(draft.named(it)) },
                singleLine = true,
                label = { Text("Name") },
                placeholder = { Text("Heavy Thursday") },
                textStyle = WindmillFont.body(19, FontWeight.Bold),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Words,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { keyboard?.hide() }),
                shape = RoundedCornerShape(WindmillRadius.md),
                colors = gymFieldColours(),
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focus)
                    // `Name` alone is ambiguous read out of the screen it is on.
                    .semantics { contentDescription = "Routine name" },
            )
            Program.counter(draft.name)?.let { counted ->
                Text(
                    counted,
                    style = GymType.numeral(12),
                    color = GymSkin.inkFaint,
                    modifier = Modifier.padding(start = WindmillSpace.x3),
                )
            }
        }

        // Why Save is grey, one refusal at a time and never concatenated. Naming it comes first
        // because no screen before this one asked for a name. The FAINT ink: the alarm ink is for a
        // write that failed, and a draft that is not finished has sent nothing to fail.
        missing?.let {
            Text(it, style = GymType.numeral(12).copy(lineHeight = 18.sp), color = GymSkin.inkFaint)
        }

        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("Movements", style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
            Spacer(Modifier.weight(1f))
            if (draft.entries.isNotEmpty()) {
                Text(draft.entries.size.toString(), style = GymType.numeral(11), color = GymSkin.inkFaint)
            }
        }

        if (draft.entries.isEmpty()) {
            Text("Nothing in this day yet.", style = WindmillFont.body(16), color = GymSkin.inkDim)
        }

        draft.entries.sortedBy { it.position }.forEach { entry ->
            var swipe by remember(entry.exerciseId) { mutableFloatStateOf(0f) }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .graphicsLayer {
                        translationX = swipe
                        alpha = 1f - (abs(swipe) / (dropAt * 2f)).coerceAtMost(0.6f)
                    }
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(GymSkin.surface)
                    .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                    .pointerInput(entry.exerciseId) {
                        detectHorizontalDragGestures(
                            onDragEnd = {
                                if (abs(swipe) >= dropAt) onRemove(entry.exerciseId) else swipe = 0f
                            },
                            onDragCancel = { swipe = 0f },
                            onHorizontalDrag = { change, amount ->
                                change.consume()
                                swipe += amount
                            },
                        )
                    }
                    .clickable(role = Role.Button, onClickLabel = "set this movement’s target") {
                        onOpenTarget(entry.exerciseId)
                    }
                    // Law 1: on Android a swipe is half-built until its custom action exists, and this
                    // swipe is the only way a movement leaves a routine. Law 3: a stroke that begins in
                    // the edge strip belongs to the system — it is back, which here leaves the draft —
                    // so the row's own swipe starts away from the edge and never competes for it.
                    .semantics {
                        customActions = listOf(
                            CustomAccessibilityAction("Remove") {
                                onRemove(entry.exerciseId)
                                true
                            },
                        )
                    }
                    .padding(horizontal = WindmillSpace.x4),
            ) {
                Text(
                    Readout.movement(entry.exerciseId, store.catalog),
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = GymSkin.ink,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
                    style = GymType.numeral(13),
                    color = if (entry.targetSets == null) GymSkin.inkFaint else GymSkin.targetInk,
                )
            }
        }

        // Once beneath the list and never per row: each open row already reads `open` in its own
        // target column — that word says WHICH, and this sentence says what it means. And never
        // while a target sheet stands over the list, because the sheet is saying it there.
        if (!targeting && draft.entries.any { it.targetSets == null }) {
            Text(
                TargetEntry.openLine,
                style = WindmillFont.body(14).copy(lineHeight = 21.sp),
                color = GymSkin.inkDim,
            )
        }

        // The dashed slot goes at the ceiling the log itself refuses past.
        if (!draft.full) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary - 8.dp)
                    .dashedEdge(GymSkin.lineStrong, WindmillRadius.md)
                    .clickable(role = Role.Button, onClick = onAdd),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, tint = GymSkin.accent)
                    Text("Add movement", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
                }
            }
        }

      }
    }
}

// `Never logged — these are your numbers.` is a fact about this ROUTINE and not the movement.
//
// Three fields and no escape hatch, because emptying a field IS the escape and the placeholder says
// what empty means: no sets is an open line, no reps is `max`, no load is `last time`. The plate
// LADDER belongs at the rack, where plate granularity is what you are reasoning about; here you
// already know the number you want. The SIGN is a different thing and stays: no number pad carries a
// minus, and without it a band-assisted target could not be planned at all.
@Composable
private fun TargetSheet(
    draft: RoutineDraft,
    exerciseId: String,
    store: TrainingStore,
    onSet: (TargetEntry.Reading) -> Unit,
) {
    val entry = draft.entry(exerciseId)
    // TEXT AND ITS SELECTION, not text alone: a refused clear has to hand the value back highlighted,
    // and a plain string cannot say where the caret went.
    var sets by remember(exerciseId) {
        mutableStateOf(TextFieldValue(entry?.targetSets?.toString().orEmpty()))
    }
    var reps by remember(exerciseId) {
        mutableStateOf(TextFieldValue(entry?.targetReps?.toString().orEmpty()))
    }
    var weight by remember(exerciseId) {
        mutableStateOf(TextFieldValue(entry?.targetWeightKg?.let { Readout.weight(it) }.orEmpty()))
    }
    // The clear that was refused, said until the lifter types again. It is not a reading: the field
    // kept its value, so nothing about the three numbers changed.
    var clearRefused by remember(exerciseId) { mutableStateOf<String?>(null) }

    val reading = TargetEntry.reading(sets.text, reps.text, weight.text)
    val refused = reading as? TargetEntry.Reading.Refused

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .imePadding()
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
            Text(
                Readout.movement(exerciseId, store.catalog),
                style = WindmillFont.display(22),
                color = GymSkin.ink,
                maxLines = 1,
                modifier = Modifier.weight(1f, fill = false),
            )
            draft.placeOf(exerciseId)?.let { place ->
                Text(
                    "$place of ${draft.entries.size} · ${draft.name}",
                    style = GymType.numeral(12),
                    color = GymSkin.inkFaint,
                    maxLines = 1,
                )
            }
        }

        if (!draft.trained) {
            Text(
                "Never logged — these are your numbers.",
                style = GymType.numeral(12),
                color = GymSkin.inkDim,
            )
        }

        // What leaving the fields empty MEANS, said where the lifter is deciding it — and said
        // ABOVE them, beside the never-logged line: everything drawn UNDER a field is that field's
        // own note, while this is a statement about the whole line. The row keeps the compact
        // `open` token. A refusal and a blessing of the same state are never drawn together.
        if (reading == TargetEntry.Reading.Open && clearRefused == null) {
            Text(
                TargetEntry.openLine,
                style = WindmillFont.body(14).copy(lineHeight = 20.sp),
                color = GymSkin.inkDim,
            )
        }

        // Four abreast on a phone: the gap is the tightest of the sheet so that three labels and the
        // sign key all keep their own line at the largest font scale.
        Row(
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TargetField(
                label = "Sets",
                value = sets,
                placeholder = TargetEntry.setsPlaceholder,
                decimal = false,
                bad = clearRefused != null || refused?.field == TargetEntry.Field.Sets,
                modifier = Modifier.weight(1f),
            ) { typed ->
                // Clearing sets is how a line is opened, and an open line names neither reps nor a
                // load — so the clear is refused rather than taking two numbers away silently. The
                // kept value comes back SELECTED, because the gesture this refusal interrupts is
                // backspace-then-retype: with the caret after the value the next digit would append
                // and earn a second refusal for a number nobody typed.
                val stop = if (typed.text.isBlank()) TargetEntry.clearingSets(reps.text, weight.text) else null
                clearRefused = stop
                sets = if (stop == null) typed else TextFieldValue(sets.text, TextRange(0, sets.text.length))
            }
            TargetField(
                label = "Reps",
                value = reps,
                placeholder = TargetEntry.repsPlaceholder,
                decimal = false,
                bad = refused?.field == TargetEntry.Field.Reps,
                modifier = Modifier.weight(1.1f),
            ) {
                clearRefused = null
                reps = it
            }
            TargetField(
                label = "Weight",
                value = weight,
                placeholder = TargetEntry.weightPlaceholder,
                decimal = true,
                bad = refused?.field == TargetEntry.Field.Weight,
                // The widest of the three: it holds a decimal and a sign.
                modifier = Modifier.weight(1.3f),
            ) {
                clearRefused = null
                weight = it
            }
            // The number pad has no minus key, so without this the plan cannot say what the rack can:
            // band-assisted work is a negative load. `±` and never a bare `−`, because the control is
            // also the way back to a loaded lift.
            SignKey {
                clearRefused = null
                weight = signFlipped(weight)
            }
        }

        // One refusal at a time, and the clear's own outranks the rest because it is what just
        // happened.
        val said = clearRefused ?: refused?.said
        if (said != null) {
            Text(said, style = GymType.numeral(12).copy(lineHeight = 18.sp), color = GymSkin.alarmInk)
        } else {
            Text(TargetEntry.decimalHint, style = GymType.numeral(12), color = GymSkin.inkFaint)
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(if (refused == null) GymSkin.accent else GymSkin.raised)
                .clickable(enabled = refused == null, role = Role.Button) { onSet(reading) },
        ) {
            Text(
                "Set  ·  ${preview(reading)}",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = if (refused == null) GymSkin.onAccent else GymSkin.inkFaint,
            )
        }
    }
}

// What the three fields name, in the words the row itself will print.
private fun preview(reading: TargetEntry.Reading): String = when (reading) {
    TargetEntry.Reading.Open -> Readout.openTarget
    is TargetEntry.Reading.Targeted -> Readout.target(reading.sets, reading.reps, reading.weightKg)
    is TargetEntry.Reading.Refused -> "—"
}

// A sign the lifter can reach without a keyboard that has one. Empty stays empty: a sign with no
// number behind it is not a load, and an empty weight field already means `last time`.
private fun signFlipped(typed: TextFieldValue): TextFieldValue {
    val text = typed.text.trim()
    if (text.isEmpty()) return typed
    val flipped = if (text.startsWith("-") || text.startsWith("−")) text.drop(1) else "−$text"
    return TextFieldValue(flipped, TextRange(flipped.length))
}

@Composable
private fun SignKey(onFlip: () -> Unit) {
    Box(
        Modifier
            .sizeIn(minWidth = GymTap.minimum, minHeight = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(GymSkin.raised)
            .clickable(role = Role.Button, onClickLabel = "Flip the sign", onClick = onFlip)
            // The glyph reads as nothing out loud, so the control says what it is.
            .semantics(mergeDescendants = true) { contentDescription = "Flip the sign" },
        contentAlignment = Alignment.Center,
    ) {
        Text("±", style = WindmillFont.display(20, FontWeight.SemiBold), color = GymSkin.ink)
    }
}

@Composable
private fun TargetField(
    label: String,
    value: TextFieldValue,
    placeholder: String,
    decimal: Boolean,
    bad: Boolean,
    modifier: Modifier,
    onTyped: (TextFieldValue) -> Unit,
) {
    OutlinedTextField(
        value = value,
        // A keystroke that does not fit is refused WHOLE rather than truncated: a field that
        // silently drops the last character types a number nobody chose.
        onValueChange = { if (it.text.length <= 8) onTyped(it) },
        singleLine = true,
        isError = bad,
        label = { Text(label) },
        placeholder = { Text(placeholder, maxLines = 1) },
        textStyle = GymType.numeral(19, FontWeight.Bold),
        keyboardOptions = KeyboardOptions(
            keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number,
            autoCorrectEnabled = false,
        ),
        shape = RoundedCornerShape(WindmillRadius.md),
        colors = gymFieldColours(),
        // `Sets` alone is ambiguous read out of its row; the field says what it targets.
        modifier = modifier.semantics { contentDescription = "$label target" },
    )
}
