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
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
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

// The three numbers on the target sheet are carried by the sheet stack, because typing a weight leaves
// that sheet for the pad and comes back.
private data class Dial(val sets: Int, val reps: Int, val weightKg: Double)

private sealed interface BuilderSheet {
    data class Target(val exerciseId: String, val dialled: Dial? = null) : BuilderSheet
    data class Weight(val exerciseId: String, val dialled: Dial) : BuilderSheet
    data object Picker : BuilderSheet
    data class Create(val name: String) : BuilderSheet
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutineBuilder(
    draft: RoutineDraft,
    store: TrainingStore,
    saving: Boolean,
    onDraft: (RoutineDraft) -> Unit,
    onSave: () -> Unit,
    onDelete: (String) -> Unit,
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
            savable = draft.savable && changed && !saving,
            onDraft = onDraft,
            onOpenTarget = { sheet = BuilderSheet.Target(it) },
            onRemove = { onDraft(draft.removing(it)) },
            onAdd = { sheet = BuilderSheet.Picker },
            onSave = onSave,
            onCancel = onClose,
            onDuplicate = { onDraft(draft.duplicated(position = store.routines.size)) },
            onDelete = { draft.id?.let(onDelete) },
        )
    }

    val open = sheet
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
            dragHandle = null,
        ) {
            when (open) {
                is BuilderSheet.Target -> TargetSheet(
                    draft = draft,
                    exerciseId = open.exerciseId,
                    dialled = open.dialled,
                    store = store,
                    onType = { sheet = BuilderSheet.Weight(open.exerciseId, it) },
                    onSet = {
                        onDraft(draft.targeting(open.exerciseId, it.sets, it.reps, it.weightKg))
                        close()
                    },
                    onOpen = {
                        onDraft(draft.opening(open.exerciseId))
                        close()
                    },
                )
                is BuilderSheet.Weight -> KeypadSheet(
                    mode = KeypadEntry.Mode.Weight,
                    current = open.dialled.weightKg,
                    onCommit = { typed ->
                        sheet = BuilderSheet.Target(open.exerciseId, open.dialled.copy(weightKg = typed))
                    },
                    onCancel = { sheet = BuilderSheet.Target(open.exerciseId, open.dialled) },
                )
                BuilderSheet.Picker -> MovementPicker(
                    catalog = store.catalog,
                    taken = draft.entries.map { it.exerciseId },
                    lastSets = null,
                    nowMs = 0,
                    title = "Add movement",
                    catalogUnread = store.catalogUnread,
                    onPick = {
                        onDraft(draft.adding(it))
                        close()
                    },
                    onCreate = { sheet = BuilderSheet.Create(it) },
                    modifier = Modifier
                        .fillMaxHeight(0.92f)
                        .background(GymSkin.surface)
                        .padding(WindmillSpace.x5),
                    onClose = { close() },
                )
                is BuilderSheet.Create -> CreateMovementSheet(
                    name = open.name,
                    onCancel = { sheet = BuilderSheet.Picker },
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
    savable: Boolean,
    onDraft: (RoutineDraft) -> Unit,
    onOpenTarget: (String) -> Unit,
    onRemove: (String) -> Unit,
    onAdd: () -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    onDuplicate: () -> Unit,
    onDelete: () -> Unit,
) {
    val dropAt = with(LocalDensity.current) { 108.dp.toPx() }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

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
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Box(
                contentAlignment = Alignment.CenterStart,
                modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onCancel),
            ) {
                Text("Cancel", style = WindmillFont.body(15), color = GymSkin.inkDim)
            }
            Text(
                if (editing) "Edit routine" else "New routine",
                style = WindmillFont.body(16, FontWeight.Bold),
                color = GymSkin.ink,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                textAlign = TextAlign.Center,
            )
            Box(
                contentAlignment = Alignment.CenterEnd,
                modifier = Modifier
                    .heightIn(min = GymTap.minimum)
                    .clickable(enabled = savable, onClick = onSave),
            ) {
                Text(
                    "Save",
                    style = WindmillFont.body(15, FontWeight.Bold),
                    color = if (savable) GymSkin.accent else GymSkin.inkFaint,
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Text("Name", style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
            Row(verticalAlignment = Alignment.CenterVertically) {
                BasicTextField(
                    value = draft.name,
                    onValueChange = { onDraft(draft.named(it)) },
                    singleLine = true,
                    textStyle = WindmillFont.display(24).copy(color = GymSkin.ink),
                    cursorBrush = SolidColor(GymSkin.accent),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Words,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { keyboard?.hide() }),
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum + 4.dp)
                        .focusRequester(focus),
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (draft.name.isEmpty()) {
                                Text("Heavy Thursday", style = WindmillFont.display(24), color = GymSkin.inkFaint)
                            }
                            inner()
                        }
                    },
                )
                Text(
                    Program.counter(draft.name),
                    style = GymType.numeral(12),
                    color = GymSkin.inkFaint,
                )
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(GymSkin.lineStrong))
        }

        if (draft.name.isEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                Program.suggestions.forEach { suggestion ->
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum - 8.dp)
                            .clip(RoundedCornerShape(WindmillRadius.full))
                            .background(GymSkin.raised)
                            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.full))
                            .clickable { onDraft(draft.named(suggestion)) }
                            .padding(horizontal = WindmillSpace.x4),
                    ) {
                        Text(suggestion, style = WindmillFont.body(14), color = GymSkin.inkDim)
                    }
                }
            }
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
                    .clickable { onOpenTarget(entry.exerciseId) }
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

        // The dashed slot goes at the ceiling the log itself refuses past.
        if (!draft.full) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary - 8.dp)
                    .dashedEdge(GymSkin.lineStrong, WindmillRadius.md)
                    .clickable(onClick = onAdd),
            ) {
                Text("+ Add movement", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }

        if (editing) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                modifier = Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum)
                        .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                        .clickable(onClick = onDuplicate),
                ) {
                    Text("Duplicate", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
                }
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum)
                        .border(1.dp, GymSkin.alarmInk, RoundedCornerShape(WindmillRadius.lg))
                        .clickable(onClick = onDelete),
                ) {
                    Text("Delete routine", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.alarmInk)
                }
            }
            Text(
                "Deleting removes the routine from your program. Every session you logged with it stays in the log.",
                style = GymType.numeral(11).copy(lineHeight = 16.sp),
                color = GymSkin.inkFaint,
            )
        }
    }
}

// `Never logged — these are your numbers.` is a fact about this ROUTINE and not the movement.
@Composable
private fun TargetSheet(
    draft: RoutineDraft,
    exerciseId: String,
    dialled: Dial?,
    store: TrainingStore,
    onType: (Dial) -> Unit,
    onSet: (Dial) -> Unit,
    onOpen: () -> Unit,
) {
    val entry = draft.entry(exerciseId)
    // The dial opens on what came back from the pad, then the row's own targets, then three fives.
    var sets by remember(exerciseId, dialled) {
        mutableIntStateOf(dialled?.sets ?: entry?.targetSets ?: RoutineDraft.startingSets)
    }
    var reps by remember(exerciseId, dialled) {
        mutableIntStateOf(dialled?.reps ?: entry?.targetReps ?: RoutineDraft.startingReps)
    }
    var weightKg by remember(exerciseId, dialled) {
        mutableDoubleStateOf(dialled?.weightKg ?: entry?.targetWeightKg ?: Prefill.EMPTY_BAR_KG)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
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

        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
            Counted("Sets", sets, Modifier.weight(1f)) {
                sets = (sets + it).coerceIn(1, Program.maxSets)
            }
            Counted("Reps", reps, Modifier.weight(1f)) {
                reps = Ladder.bumpReps(reps, it).coerceAtMost(Program.maxReps)
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Text("Target weight", style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
            Row(
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                verticalAlignment = Alignment.Bottom,
            ) {
                BasicText(
                    Readout.weight(weightKg),
                    maxLines = 1,
                    autoSize = TextAutoSize.StepBased(minFontSize = 28.sp, maxFontSize = 48.sp),
                    style = GymType.weight.copy(fontSize = 48.sp, lineHeight = 48.sp, color = GymSkin.weightInk),
                    modifier = Modifier.clickable { onType(Dial(sets, reps, weightKg)) },
                )
                Text("kg", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.inkFaint)
                Spacer(Modifier.weight(1f))
            }
        }

        LadderRow(weightKg, onDial = { weightKg = it })

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(GymSkin.accent)
                .clickable { onSet(Dial(sets, reps, weightKg)) },
        ) {
            Text(
                "Set  ·  ${Readout.target(sets, reps, weightKg)}",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }

        // It clears the whole row: the log refuses reps or a weight on a line with no sets.
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum + 6.dp)
                .clickable(onClick = onOpen)
                .padding(top = WindmillSpace.x1),
        ) {
            Text("Leave it open", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text("decide at the rack", style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
    }
}

@Composable
private fun Counted(label: String, value: Int, modifier: Modifier, onStep: (Int) -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
        Text(label, style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Step("−") { onStep(-1) }
            Box(
                Modifier.weight(1f).sizeIn(minHeight = GymTap.minimum),
                contentAlignment = Alignment.Center,
            ) {
                Text(value.toString(), style = GymType.numeral(20, FontWeight.Bold), color = GymSkin.ink)
            }
            Step("+") { onStep(1) }
        }
    }
}
