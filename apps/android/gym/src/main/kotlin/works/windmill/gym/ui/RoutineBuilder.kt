package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
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

// No pad over a sheet over a screen: the target sheet's fields take the platform's own keyboard.
// The picker's create step is drawn by the picker itself, so minting stacks a sheet rather than
// swapping one out from under a typed search.
private sealed interface BuilderSheet {
    data class Target(val exerciseId: String) : BuilderSheet
    data object Picker : BuilderSheet
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
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
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    // Compose fires no dismiss callback on a programmatic close, so nothing waits for one.
    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { sheet = null }
    }

    // A sheet is its own window, and Material pads that window by whatever keyboard is up when it
    // opens. The keyboard belongs to the screen underneath — the name field opens with it up — so
    // a sheet raised over it painted its fields a keyboard's height higher than the same sheet
    // raised a moment later with the keyboard down. The screen gives its keyboard up as the sheet
    // rises, and the sheet's first paint is the same every time.
    LaunchedEffect(sheet) {
        if (sheet == null) return@LaunchedEffect
        focusManager.clearFocus()
        keyboard?.hide()
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
            // Back with the keyboard up puts the keyboard down and nothing else: read and hidden
            // inside the sheet's own window, ahead of the sheet's own back.
            val sheetKeyboard = LocalSoftwareKeyboardController.current
            BackHandler(enabled = WindowInsets.isImeVisible) { sheetKeyboard?.hide() }

            when (open) {
                is BuilderSheet.Target -> TargetSheet(
                    draft = draft,
                    exerciseId = open.exerciseId,
                    store = store,
                    onSet = { reading ->
                        when (reading) {
                            TargetEntry.Reading.Open -> onDraft(draft.opening(open.exerciseId))
                            is TargetEntry.Reading.Scheme -> onDraft(
                                draft.targeting(open.exerciseId, reading.sets)
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
                        .padding(horizontal = GymLayout.gutter)
                        .padding(bottom = GymLayout.sheetBottom),
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
    val ordered = draft.entries.sortedBy { it.position }
    // The reorder rail, the web's three paths less the drag: a tap on a handle picks the row up, the
    // next tap on any handle places it there, the same handle again puts it down where it stands;
    // and Move up / Move down are the row's own custom actions. `picked` is the row's id, so a row
    // that travels stays held. Every path says the move ONCE, on the line under the list.
    var picked by remember { mutableStateOf<String?>(null) }
    var said by remember { mutableStateOf("") }
    val nameOf = { index: Int -> Readout.movement(ordered[index].exerciseId, store.catalog) }
    val placeOf = { index: Int -> "${index + 1} of ${ordered.size}" }
    fun move(from: Int, to: Int) {
        if (to < 0 || to > ordered.lastIndex) return
        said = "${nameOf(from)}, ${placeOf(to)}"
        onDraft(draft.moving(from, to))
    }
    fun heldIndex(): Int? =
        picked?.let { id -> ordered.indexOfFirst { it.exerciseId == id } }?.takeIf { it >= 0 }
    // A row that leaves the list is no longer held, and a sentence about holding it is no longer
    // true: the line goes quiet rather than stale. The removal itself is not said — the web says
    // nothing there either.
    fun remove(exerciseId: String) {
        if (picked == exerciseId) {
            picked = null
            said = ""
        }
        onRemove(exerciseId)
    }
    fun handleTapped(index: Int) {
        val held = heldIndex()
        if (held == null) {
            picked = ordered[index].exerciseId
            said = "${nameOf(index)}, ${placeOf(index)} — picked up"
            return
        }
        picked = null
        if (held == index) {
            said = "${nameOf(index)}, ${placeOf(index)} — put back"
            return
        }
        move(held, index)
    }
    // What the handle does next, in its own name — the web's `nameFor`.
    fun handleName(index: Int): String {
        val held = heldIndex()
        if (held == index) return "Move ${nameOf(index)}, ${placeOf(index)} — picked up"
        if (held != null) return "Place ${nameOf(held)} at ${placeOf(index)}"
        return "Move ${nameOf(index)}, ${placeOf(index)}"
    }

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
            .padding(horizontal = GymLayout.gutter)
            .padding(top = GymLayout.contentTop, bottom = GymLayout.scrollTail),
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

        ordered.forEachIndexed { index, entry ->
            var swipe by remember(entry.exerciseId) { mutableFloatStateOf(0f) }
            val held = picked == entry.exerciseId
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.row)
                    .graphicsLayer {
                        translationX = swipe
                        alpha = 1f - (abs(swipe) / (dropAt * 2f)).coerceAtMost(0.6f)
                    }
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(GymSkin.surface)
                    .border(
                        1.dp,
                        if (held) GymSkin.accent else GymSkin.line,
                        RoundedCornerShape(WindmillRadius.md),
                    )
                    .pointerInput(entry.exerciseId) {
                        detectHorizontalDragGestures(
                            onDragEnd = {
                                if (abs(swipe) >= dropAt) remove(entry.exerciseId) else swipe = 0f
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
                    // The two moves ride the same list, in the web's words, and the ends are not
                    // wrapped: a row at the top has nowhere above it. A held row is what the two
                    // moves move, whichever row's action was invoked — the web's `step`.
                    .semantics {
                        customActions = buildList {
                            add(CustomAccessibilityAction("Remove") {
                                remove(entry.exerciseId)
                                true
                            })
                            if (index > 0) add(CustomAccessibilityAction("Move up") {
                                move(heldIndex() ?: index, (heldIndex() ?: index) - 1)
                                true
                            })
                            if (index < ordered.lastIndex) add(CustomAccessibilityAction("Move down") {
                                move(heldIndex() ?: index, (heldIndex() ?: index) + 1)
                                true
                            })
                        }
                    }
                    .padding(end = WindmillSpace.x4),
            ) {
                IconButton(onClick = { handleTapped(index) }) {
                    Icon(
                        Icons.Filled.DragHandle,
                        contentDescription = handleName(index),
                        tint = if (held) GymSkin.accent else GymSkin.inkFaint,
                    )
                }
                Text(
                    Readout.movement(entry.exerciseId, store.catalog),
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = GymSkin.ink,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    Readout.target(entry.sets),
                    style = GymType.numeral(13),
                    color = if (entry.isOpen) GymSkin.inkFaint else GymSkin.targetInk,
                )
            }
        }

        // The move is said here, once, for every path alike — the web's `role="status"` line. The
        // node stands before there is anything to say, because a live region announces a change
        // and not an arrival.
        Text(
            said,
            style = GymType.numeral(12),
            color = GymSkin.inkFaint,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )

        // The dashed slot goes at the ceiling the log itself refuses past.
        if (!draft.full) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.secondary)
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
// One scheme at two zooms, both always on the sheet: the head speaks about every set at once and
// the ladder gives each set its own row. The sheet holds TEXT until the commit — `TargetEntry` reads
// it — and the head is derived from the rows: Reps and Weight print what every shown row shares and
// write every row when typed; Sets is the count of rows shown, the rows past it hidden rather than
// lost, so a count typed low and back high keeps the ladder; a blank Sets hides the ladder the same
// way. The plate ladder belongs at the rack; here you already know the number you want. The `±` is
// drawn only on the load fields of a movement loaded by bodyweight, where a negative load — band
// assistance — is a plan a lifter can mean.
//
// The body — head, ladder, Add set — is ONE scroll container and the commit is pinned under it;
// on a 412 × 731 phone the ramp's five rows and Add set stand inside the first paint
// (`TargetSheetLayoutTests`), which is why the ladder's fields are the compact kind.
@Composable
private fun TargetSheet(
    draft: RoutineDraft,
    exerciseId: String,
    store: TrainingStore,
    onSet: (TargetEntry.Reading) -> Unit,
) {
    val entry = draft.entry(exerciseId)
    var rows by remember(exerciseId) { mutableStateOf(TargetEntry.rows(entry?.sets.orEmpty())) }
    var sets by remember(exerciseId) { mutableStateOf(rows.size.takeIf { it > 0 }?.toString().orEmpty()) }
    // Add set was tapped at the ceiling; the next keystroke anywhere on the sheet clears it.
    var atCeiling by remember(exerciseId) { mutableStateOf(false) }
    // A deleted row's neighbours are NEW rows with their own settled swipe (`RowSwipe.kt`): the
    // ladder's row keys carry the count of deletions so no row inherits a spent one.
    var deletions by remember(exerciseId) { mutableIntStateOf(0) }
    var fillMenuOnHead by remember { mutableStateOf(false) }
    var fillMenuOnRow by remember { mutableStateOf<Int?>(null) }

    val bandAssisted = store.catalog.firstOrNull { it.id == exerciseId }?.equipment == "bodyweight"
    val shown = TargetEntry.shown(rows, sets)
    val reading = TargetEntry.reading(sets, rows)
    val refused = reading as? TargetEntry.Reading.Refused
    val headFault = refused?.takeIf { TargetEntry.inTheHead(it, shown) }
    val rowFault = refused?.takeIf { headFault == null }
    val ladderShown = sets.isNotBlank()

    fun count(typed: String) {
        sets = typed
        atCeiling = false
        typed.trim().toIntOrNull()?.takeIf { it in TargetEntry.setsBand }?.let { rows = TargetEntry.grown(rows, it) }
    }
    fun headTyped(reps: String? = null, weight: String? = null) {
        atCeiling = false
        reps?.let { rows = TargetEntry.withReps(rows, it) }
        weight?.let { rows = TargetEntry.withWeight(rows, it) }
    }
    // The next hidden row is revealed before a new one is copied off the last shown.
    fun addSet() {
        if (shown.size >= Program.maxSets) {
            atCeiling = true
            return
        }
        if (shown.size < rows.size) {
            sets = (shown.size + 1).toString()
            return
        }
        rows = TargetEntry.resized(rows, shown.size + 1)
        sets = rows.size.toString()
    }
    fun delete(index: Int) {
        rows = rows.filterIndexed { at, _ -> at != index }
        sets = (shown.size - 1).takeIf { it > 0 }?.toString().orEmpty()
        atCeiling = false
        deletions += 1
    }
    fun rowTyped(index: Int, reps: String = rows[index].reps, weight: String = rows[index].weight) {
        atCeiling = false
        rows = rows.mapIndexed { at, row -> if (at == index) row.copy(reps = reps, weight = weight) else row }
    }
    // Fill works the shown rows; the hidden tail stands as it was.
    fun fill(filled: List<TargetEntry.TypedSet>) {
        rows = filled + rows.drop(shown.size)
    }
    val fillMenu: @Composable (Boolean, () -> Unit) -> Unit = { expanded, dismiss ->
        DropdownMenu(expanded = expanded, onDismissRequest = dismiss) {
            DropdownMenuItem(
                text = { Text(TargetEntry.rampUp) },
                enabled = TargetEntry.canRamp(shown),
                onClick = {
                    fill(TargetEntry.rampUp(shown))
                    dismiss()
                },
            )
            DropdownMenuItem(
                text = { Text(TargetEntry.matchSetOne) },
                onClick = {
                    fill(TargetEntry.matchFirst(shown))
                    dismiss()
                },
            )
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .padding(horizontal = GymLayout.gutter)
            .padding(bottom = GymLayout.sheetBottom),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .testTag("target-sheet-body"),
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
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
            }

            SectionHead(TargetEntry.everySet)

            // What leaving the count empty MEANS, said here and nowhere else — the lists behind
            // this sheet print the compact `open` token per row and no sentence. Said ABOVE the
            // fields: everything drawn UNDER a field is that field's own note, while this is a
            // statement about the whole line.
            if (!ladderShown) {
                Text(
                    TargetEntry.openLine,
                    style = WindmillFont.body(14).copy(lineHeight = 20.sp),
                    color = GymSkin.inkDim,
                )
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                verticalAlignment = Alignment.Bottom,
            ) {
                TargetField(
                    label = "Sets",
                    value = sets,
                    placeholder = TargetEntry.setsPlaceholder,
                    decimal = false,
                    bad = headFault?.field == TargetEntry.Field.Sets,
                    description = "Sets target",
                    last = false,
                    modifier = Modifier.weight(1f),
                    onTyped = ::count,
                )
                TargetField(
                    label = "Reps",
                    value = TargetEntry.sharedReps(shown),
                    placeholder = if (TargetEntry.repsVary(shown)) TargetEntry.varies else TargetEntry.repsPlaceholder,
                    decimal = false,
                    bad = headFault?.field == TargetEntry.Field.Reps,
                    enabled = ladderShown,
                    description = "Reps target",
                    last = false,
                    modifier = Modifier.weight(1.1f),
                    onTyped = { headTyped(reps = it) },
                )
                TargetField(
                    label = "Weight",
                    value = TargetEntry.sharedWeight(shown),
                    placeholder = if (TargetEntry.weightVaries(shown)) TargetEntry.varies else TargetEntry.weightPlaceholder,
                    decimal = true,
                    bad = headFault?.field == TargetEntry.Field.Weight,
                    enabled = ladderShown,
                    description = "Weight target",
                    last = !ladderShown,
                    modifier = Modifier.weight(1.3f),
                    onTyped = { headTyped(weight = it) },
                )
                if (bandAssisted) {
                    SignKey { headTyped(weight = signFlipped(TargetEntry.sharedWeight(shown))) }
                }
            }

            // The head's own refusal, under the head; a row's fault is drawn under its row.
            headFault?.let { FaultLine(it.said) }

            if (ladderShown) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    SectionHead(TargetEntry.setBySet)
                    Spacer(Modifier.weight(1f))
                    Box {
                        TextButton(onClick = { fillMenuOnHead = true }) {
                            Text(TargetEntry.fill, style = WindmillFont.body(14, FontWeight.SemiBold), color = GymSkin.accent)
                        }
                        fillMenu(fillMenuOnHead) { fillMenuOnHead = false }
                    }
                }

                Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                    shown.forEachIndexed { index, row ->
                        key("row-$deletions-$index") {
                            val fault = rowFault?.takeIf { it.row == index }
                            val swipe = rememberRowDismiss(settling = { it == SwipeToDismissBoxValue.EndToStart }) {
                                delete(index)
                            }
                            Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
                                SwipeToDismissBox(
                                    state = swipe,
                                    enableDismissFromStartToEnd = false,
                                    // The lane is drawn once the stroke begins: at rest the row says
                                    // nothing about leaving.
                                    backgroundContent = {
                                        if (swipe.dismissDirection == SwipeToDismissBoxValue.EndToStart) RowDeleteGround()
                                    },
                                ) {
                                    Box {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .heightIn(min = GymTap.minimum)
                                                .background(GymSkin.surface)
                                                // Law 1: the swipe is half-built until its custom
                                                // action exists. The long press is a shortcut to
                                                // Fill, never the only path, so it carries no
                                                // action of its own.
                                                .semantics {
                                                    customActions = listOf(CustomAccessibilityAction(TargetEntry.delete) {
                                                        delete(index)
                                                        true
                                                    })
                                                }
                                                .pointerInput(index) {
                                                    detectTapGestures(onLongPress = { fillMenuOnRow = index })
                                                },
                                        ) {
                                            Text(
                                                "${index + 1}",
                                                style = GymType.numeral(13),
                                                color = GymSkin.inkFaint,
                                                modifier = Modifier.width(24.dp),
                                            )
                                            TargetField(
                                                label = null,
                                                value = row.reps,
                                                placeholder = TargetEntry.repsPlaceholder,
                                                decimal = false,
                                                bad = fault?.field == TargetEntry.Field.Reps,
                                                description = "Set ${index + 1} reps",
                                                last = false,
                                                modifier = Modifier.weight(1f),
                                                onTyped = { rowTyped(index, reps = it) },
                                            )
                                            TargetField(
                                                label = null,
                                                value = row.weight,
                                                placeholder = TargetEntry.weightPlaceholder,
                                                decimal = true,
                                                bad = fault?.field == TargetEntry.Field.Weight,
                                                description = "Set ${index + 1} load",
                                                last = index == shown.lastIndex,
                                                modifier = Modifier.weight(1.3f),
                                                onTyped = { rowTyped(index, weight = it) },
                                            )
                                            if (bandAssisted) {
                                                SignKey { rowTyped(index, weight = signFlipped(row.weight)) }
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
                        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = GymTap.minimum)
                            .clickable(role = Role.Button, onClick = ::addSet),
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = null, tint = GymSkin.accent)
                        Text(TargetEntry.addSet, style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
                    }
                    if (atCeiling) FaultLine(TargetEntry.outsideSets)
                }
            }
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
                TargetEntry.commitLabel(reading),
                style = WindmillFont.body(17, FontWeight.Bold),
                color = if (refused == null) GymSkin.onAccent else GymSkin.inkFaint,
            )
        }
    }
}

@Composable
private fun SectionHead(words: String) {
    Text(words, style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
}

// One refusal at a time, in the alarm ink, under the field or the row that carries it.
@Composable
private fun FaultLine(said: String) {
    Text(said, style = GymType.numeral(12).copy(lineHeight = 18.sp), color = GymSkin.alarmInk)
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
private fun SignKey(onFlip: () -> Unit) {
    Box(
        Modifier
            .sizeIn(minWidth = GymTap.minimum, minHeight = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(GymSkin.raised)
            .clickable(role = Role.Button, onClickLabel = KeypadEntry.signName, onClick = onFlip)
            // The glyph reads as nothing out loud, so the control says what it is — and what a
            // negative load is, since no sentence beside the fields says it.
            .semantics(mergeDescendants = true) { contentDescription = KeypadEntry.signName },
        contentAlignment = Alignment.Center,
    ) {
        Text("±", style = WindmillFont.display(20, FontWeight.SemiBold), color = GymSkin.ink)
    }
}

// The head's three labelled fields and the ladder's compact pair are one field. A label stands
// ABOVE the field rather than floating inside it, so an empty head field still reads its
// placeholder — `varies` is the one word the head has to say about a ladder that disagrees. The
// unlabelled kind is the ladder's: the same outline at the room's minimum tap height, so five
// rows and Add set fit a small phone's first paint. `last` is the one field whose keyboard action
// is Done — every other field's Next walks the sheet top to bottom, reps before load on each row,
// without leaving the keyboard.
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
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val interaction = remember { MutableInteractionSource() }
    val colours = gymFieldColours()
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
    val described = Modifier.fillMaxWidth().semantics { contentDescription = description }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(GymLayout.pair)) {
        if (label == null) {
            BasicTextField(
                value = value,
                onValueChange = typed,
                singleLine = true,
                enabled = enabled,
                textStyle = GymType.numeral(17, FontWeight.Bold).copy(color = GymSkin.ink),
                keyboardOptions = keyboardOptions,
                keyboardActions = keyboardActions,
                interactionSource = interaction,
                cursorBrush = SolidColor(GymSkin.accent),
                modifier = described.height(GymTap.minimum),
                decorationBox = { inner ->
                    OutlinedTextFieldDefaults.DecorationBox(
                        value = value,
                        innerTextField = inner,
                        enabled = enabled,
                        singleLine = true,
                        visualTransformation = VisualTransformation.None,
                        interactionSource = interaction,
                        isError = bad,
                        placeholder = { Text(placeholder, maxLines = 1) },
                        colors = colours,
                        contentPadding = PaddingValues(horizontal = WindmillSpace.x3, vertical = WindmillSpace.x2),
                        container = {
                            OutlinedTextFieldDefaults.Container(
                                enabled = enabled,
                                isError = bad,
                                interactionSource = interaction,
                                colors = colours,
                                shape = shape,
                            )
                        },
                    )
                },
            )
            return@Column
        }
        Text(
            label,
            style = GymType.numeral(11).copy(letterSpacing = 0.07.em),
            color = if (enabled) GymSkin.inkFaint else GymSkin.inkFaint.copy(alpha = 0.5f),
        )
        OutlinedTextField(
            value = value,
            onValueChange = typed,
            singleLine = true,
            enabled = enabled,
            isError = bad,
            placeholder = { Text(placeholder, maxLines = 1) },
            textStyle = GymType.numeral(19, FontWeight.Bold),
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            interactionSource = interaction,
            shape = shape,
            colors = colours,
            modifier = described,
        )
    }
}
