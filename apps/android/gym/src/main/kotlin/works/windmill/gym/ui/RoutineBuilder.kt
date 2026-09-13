package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheetWindow
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import works.windmill.gym.R
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEvent
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
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

@Serializable
private sealed interface BuilderSheet {
    @Serializable
    data class Target(val exerciseId: String, val rows: List<TargetEntry.TypedSet>, val sets: String) : BuilderSheet
    @Serializable
    data object Picker : BuilderSheet
}

private val builderSheetSaver = Saver<BuilderSheet?, String>(
    save = { it?.let { sheet -> WindmillJson.encodeToString(BuilderSheet.serializer(), sheet) } ?: "" },
    restore = { it.takeIf(String::isNotEmpty)?.let { raw ->
        WindmillJson.decodeFromString(BuilderSheet.serializer(), raw) } },
)

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
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    var sheet by rememberSaveable(stateSaver = builderSheetSaver) { mutableStateOf<BuilderSheet?>(null) }
    val pickerState = rememberMovementPickerState()
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
    LaunchedEffect((sheet as? BuilderSheet.Target)?.exerciseId, sheet == BuilderSheet.Picker) {
        if (sheet == null) return@LaunchedEffect
        focusManager.clearFocus()
        keyboard?.hide()
    }

    val editing = draft.id != null
    BackHandler(enabled = saving) {}
    LaunchedEffect(saving) {
        if (saving) { focusManager.clearFocus(); keyboard?.hide() }
    }

    Column(Modifier.fillMaxSize()) {
        BuildStep(
            draft = draft,
            store = store,
            editing = editing,
            editable = !saving,
            // C19: while a target sheet stands over the list, the SHEET owns the open line's
            // sentence and the list's copy stands down — one state says it once, never a blessing
            // behind a scrim beside a refusal in front of it.
            savable = draft.savable && draft.changed && !saving,
            onDraft = { if (!saving) onDraft(it) },
            onOpenTarget = { id ->
                val rows = TargetEntry.rows(draft.entry(id)?.sets.orEmpty())
                sheet = BuilderSheet.Target(id, rows, rows.size.takeIf { it > 0 }?.toString().orEmpty())
            },
            onRemove = { onDraft(draft.removing(it)) },
            onAdd = { sheet = BuilderSheet.Picker },
            onSave = onSave,
            onCancel = { if (!saving) onClose() },
        )
    }

    val open = sheet
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = if (open == BuilderSheet.Picker) skin.raised else skin.surface,
            scrimColor = skin.scrim,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        ) {
            WindmillSheetWindow()
            // Back with the keyboard up puts the keyboard down and nothing else: read and hidden
            // inside the sheet's own window, ahead of the sheet's own back.
            val sheetKeyboard = LocalSoftwareKeyboardController.current
            BackHandler(enabled = WindowInsets.isImeVisible) { sheetKeyboard?.hide() }

            when (open) {
                is BuilderSheet.Target -> TargetSheet(
                    draft = draft,
                    state = open,
                    onState = { sheet = it },
                    store = store,
                    onCancel = { close() },
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
                    onCreate = { name, equipment, id -> store.create(name, equipment, id) },
                    state = pickerState,
                    modifier = Modifier
                        .heightIn(max = pickerMaxHeight())
                        .background(skin.raised)
                        .padding(horizontal = GymLayout.gutter)
                        .padding(bottom = GymLayout.sheetBottom),
                    onClose = { close() },
                )
            }
        }
    }
}

@Composable
internal fun PlanningNameField(
    value: String,
    onValue: (String) -> Unit,
    description: String,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    container: Color? = null,
) {
    val skin = LocalGymColors.current
    val keyboard = LocalSoftwareKeyboardController.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Name", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        OutlinedTextField(
            value, onValueChange = onValue, singleLine = true, enabled = enabled,
            placeholder = { Text(placeholder) }, textStyle = WindmillFont.body(18).copy(lineHeight = 25.sp),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words,
                autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { keyboard?.hide() }),
            shape = RoundedCornerShape(8.dp),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = container ?: skin.surface,
                unfocusedContainerColor = container ?: skin.surface, focusedBorderColor = skin.accent,
                unfocusedBorderColor = skin.line, focusedTextColor = skin.ink,
                unfocusedTextColor = skin.ink, cursorColor = skin.accent,
                focusedPlaceholderColor = skin.inkDim, unfocusedPlaceholderColor = skin.inkDim),
            modifier = modifier.fillMaxWidth().heightIn(min = 56.dp)
                .semantics { contentDescription = description },
        )
        Program.counter(value)?.let { Text(it, style = WindmillFont.body(13), color = skin.inkDim) }
    }
}

@Composable
private fun BuildStep(
    draft: RoutineDraft,
    store: TrainingStore,
    editing: Boolean,
    editable: Boolean,
    savable: Boolean,
    onDraft: (RoutineDraft) -> Unit,
    onOpenTarget: (String) -> Unit,
    onRemove: (String) -> Unit,
    onAdd: () -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    val skin = LocalGymColors.current
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val ordered = draft.entries.sortedBy { it.position }
    val currentDraft by rememberUpdatedState(draft)
    val changeDraft by rememberUpdatedState(onDraft)
    val positions = remember { mutableMapOf<String, Float>() }
    var dragged by remember { mutableStateOf<String?>(null) }
    var dragCenter by remember { mutableFloatStateOf(0f) }
    var viewport by remember { mutableStateOf(Rect.Zero) }
    var said by remember { mutableStateOf("") }
    val haptics = rememberGymHaptics()
    val scroll = rememberScrollState()
    val edgeSize = with(LocalDensity.current) { 56.dp.toPx() }
    val scrollSpeed = with(LocalDensity.current) { 600.dp.toPx() }
    var events by remember(draft.id) { mutableStateOf<List<RoutineEvent>>(emptyList()) }
    var historyFailure by remember(draft.id) { mutableStateOf<WriteFailure?>(null) }
    LaunchedEffect(draft.id) {
        val id = draft.id ?: return@LaunchedEffect
        when (val read = store.routineHistory(id)) {
            is GymResult.Ok -> { events = read.value.filterNot { it.isPending }; historyFailure = null }
            is GymResult.Failed -> historyFailure = read.why
        }
    }
    fun move(from: Int, to: Int) {
        val rows = currentDraft.entries.sortedBy { it.position }
        if (!editable || from !in rows.indices || to !in rows.indices || from == to) return
        changeDraft(currentDraft.moving(from, to))
        said = "${Readout.movement(rows[from].exerciseId, store.catalog)}, ${to + 1} of ${rows.size}"
    }
    fun placeDragged() {
        val id = dragged ?: return
        val rows = currentDraft.entries.sortedBy { it.position }
        val from = rows.indexOfFirst { it.exerciseId == id }
        val to = rows.indices.minByOrNull {
            abs((positions[rows[it].exerciseId] ?: dragCenter) - scroll.value - dragCenter)
        }
        if (to != null) move(from, to)
    }
    val edgeDirection = when {
        dragged == null || !editable || viewport.height <= 0 -> 0f
        dragCenter < viewport.top + edgeSize -> -1f
        dragCenter > viewport.bottom - edgeSize -> 1f
        else -> 0f
    }
    LaunchedEffect(dragged, edgeDirection) {
        if (edgeDirection == 0f) return@LaunchedEffect
        var previous = withFrameNanos { it }
        while (dragged != null) {
            val frame = withFrameNanos { it }
            val seconds = ((frame - previous) / 1_000_000_000f).coerceAtMost(0.032f)
            previous = frame
            if (scroll.scrollBy(edgeDirection * scrollSpeed * seconds) == 0f) break
            placeDragged()
        }
    }
    LaunchedEffect(editable) { if (!editable) dragged = null }
    GymScreen(
        title = if (editing) "Edit routine" else "New routine",
        navigation = {
            IconButton(onClick = onCancel, enabled = editable, modifier = Modifier.size(48.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to the routine you were on",
                    tint = if (editable) skin.ink else skin.inkDim, modifier = Modifier.size(24.dp))
            }
        },
        actions = { TopAction(if (editable) "Save" else "Saving…", enabled = savable, onClick = onSave) },
    ) {
        LaunchedEffect(Unit) {
            if (!editing && draft.name.isEmpty()) { focus.requestFocus(); keyboard?.show() }
        }
        Column(Modifier.fillMaxSize().imePadding()
            .onGloballyPositioned { viewport = it.boundsInRoot() }
            .testTag("routine-editor-body").verticalScroll(scroll).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)) {
            PlanningNameField(draft.name, { onDraft(draft.named(it)) }, "Routine name", "Routine name",
                modifier = Modifier.focusRequester(focus), enabled = editable)
            if (draft.name.isBlank() && (editing || draft.entries.isNotEmpty())) {
                Text(Program.nameItToSaveIt, style = WindmillFont.body(14), color = skin.inkDim)
            }
            if (draft.name.isNotBlank() && draft.entries.isEmpty()) {
                Text(Program.atLeastOneMovement, style = WindmillFont.body(14), color = skin.inkDim)
            }
            Column {
                Text("Movements", style = WindmillFont.body(18, FontWeight.Bold), color = skin.ink,
                    modifier = Modifier.padding(bottom = 8.dp))
                ordered.forEachIndexed { index, entry ->
                    key(entry.exerciseId) {
                        val name = Readout.movement(entry.exerciseId, store.catalog)
                        val swipe = rememberRowDismiss(settling = { it == SwipeToDismissBoxValue.EndToStart }) {
                            onRemove(entry.exerciseId)
                        }
                        SwipeToDismissBox(state = swipe, enableDismissFromStartToEnd = false,
                            enableDismissFromEndToStart = editable,
                            backgroundContent = { RowDeleteGround() }) {
                            Row(Modifier.fillMaxWidth().heightIn(min = 72.dp)
                                .onGloballyPositioned { positions[entry.exerciseId] = it.positionInRoot().y + it.size.height / 2f + scroll.value }
                                .background(if (dragged == entry.exerciseId) skin.raised else skin.canvas)
                                .clickable(enabled = editable, role = Role.Button, onClickLabel = "set this movement’s target") { onOpenTarget(entry.exerciseId) }
                                .semantics { customActions = if (!editable) emptyList() else buildList {
                                    add(CustomAccessibilityAction("Delete $name") { onRemove(entry.exerciseId); true })
                                    if (index > 0) add(CustomAccessibilityAction("Move up") { move(index, index - 1); true })
                                    if (index < ordered.lastIndex) add(CustomAccessibilityAction("Move down") { move(index, index + 1); true })
                                } }.padding(8.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Box(Modifier.size(48.dp).semantics {
                                    contentDescription = "Move $name, ${index + 1} of ${ordered.size}"
                                    if (!editable) disabled()
                                }
                                    .pointerInput(entry.exerciseId, editable) {
                                        if (editable) detectDragGesturesAfterLongPress(
                                            onDragStart = {
                                                dragged = entry.exerciseId
                                                dragCenter = (positions[entry.exerciseId] ?: 0f) - scroll.value
                                                haptics.revealed()
                                            },
                                            onDragEnd = { dragged = null }, onDragCancel = { dragged = null },
                                            onDrag = { change, amount ->
                                                change.consume()
                                                dragCenter += amount.y
                                                placeDragged()
                                            },
                                        )
                                    }) {
                                    Icon(painterResource(R.drawable.gym_reorder), null, Modifier.size(48.dp), tint = skin.inkDim)
                                }
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(name, style = WindmillFont.body(17, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.ink)
                                    Text(Readout.target(entry.sets), style = WindmillFont.body(15).copy(lineHeight = 21.sp), color = skin.inkDim)
                                }
                            }
                        }
                        HorizontalDivider(color = skin.line)
                    }
                }
                if (!draft.full) TextButton(onClick = onAdd, enabled = editable, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Icon(Icons.Filled.Add, null, tint = skin.ink)
                    Spacer(Modifier.width(8.dp))
                    Text("Add movement", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                }
            }
            Text(said, style = WindmillFont.body(13), color = skin.inkDim,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            if (events.isNotEmpty() || historyFailure != null) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Recent changes", style = WindmillFont.body(18, FontWeight.Bold), color = skin.ink)
                    historyFailure?.let { Text(it.line("this routine’s history is out of reach"),
                        style = WindmillFont.body(14), color = skin.inkDim) }
                    events.mapNotNull { it.line(System.currentTimeMillis()) }.forEach {
                        Text(it, style = WindmillFont.body(14), color = skin.inkDim)
                    }
                }
            }
        }
    }
}

// Raw target rows live on the builder route; committing applies their validated scheme.
@Composable
private fun TargetSheet(
    draft: RoutineDraft,
    state: BuilderSheet.Target,
    onState: (BuilderSheet.Target) -> Unit,
    store: TrainingStore,
    onCancel: () -> Unit,
    onSet: (TargetEntry.Reading) -> Unit,
) {
    val skin = LocalGymColors.current
    val exerciseId = state.exerciseId
    val rows = state.rows
    val sets = state.sets
    // Add set was tapped at the ceiling; the next keystroke anywhere on the sheet clears it.
    var atCeiling by remember(exerciseId) { mutableStateOf(false) }
    // A deleted row's neighbours are NEW rows with their own settled swipe (`RowSwipe.kt`): the
    // ladder's row keys carry the count of deletions so no row inherits a spent one.
    var deletions by remember(exerciseId) { mutableIntStateOf(0) }
    var fillMenuOnHead by remember { mutableStateOf(false) }
    var fillMenuOnRow by remember { mutableStateOf<Int?>(null) }

    val bandAssisted = store.catalog.firstOrNull { it.id == exerciseId }?.equipment == "bodyweight"
    val broadFields = LocalDensity.current.fontScale > 1.3f || LocalConfiguration.current.screenWidthDp < 360
    val stackedLadder = broadFields && bandAssisted
    val shown = TargetEntry.shown(rows, sets)
    val reading = TargetEntry.reading(sets, rows)
    val refused = reading as? TargetEntry.Reading.Refused
    val headFault = refused?.takeIf { TargetEntry.inTheHead(it, shown) }
    val rowFault = refused?.takeIf { headFault == null }
    val ladderShown = sets.isNotBlank()

    fun count(typed: String) {
        val count = typed.trim().toIntOrNull()?.takeIf { it in TargetEntry.setsBand }
        onState(state.copy(sets = typed, rows = count?.let { TargetEntry.grown(rows, it) } ?: rows))
        atCeiling = false
    }
    fun headTyped(reps: String? = null, weight: String? = null) {
        atCeiling = false
        onState(state.copy(rows = when {
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
            onState(state.copy(sets = (shown.size + 1).toString()))
            return
        }
        val grown = TargetEntry.resized(rows, shown.size + 1)
        onState(state.copy(rows = grown, sets = grown.size.toString()))
    }
    fun delete(index: Int) {
        onState(state.copy(rows = rows.filterIndexed { at, _ -> at != index },
            sets = (shown.size - 1).takeIf { it > 0 }?.toString().orEmpty()))
        atCeiling = false
        deletions += 1
    }
    fun rowTyped(index: Int, reps: String = rows[index].reps, weight: String = rows[index].weight) {
        atCeiling = false
        onState(state.copy(rows = rows.mapIndexed { at, row -> if (at == index) row.copy(reps = reps, weight = weight) else row }))
    }
    // Fill works the shown rows; the hidden tail stands as it was.
    fun fill(filled: List<TargetEntry.TypedSet>) {
        onState(state.copy(rows = filled + rows.drop(shown.size)))
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

    val countField: @Composable (Modifier) -> Unit = { modifier ->
        TargetField(
            label = "Sets",
            value = sets,
            placeholder = TargetEntry.setsPlaceholder,
            decimal = false,
            bad = headFault?.field == TargetEntry.Field.Sets,
            description = "Sets target",
            last = false,
            modifier = modifier,
            onTyped = ::count,
        )
    }
    val repsField: @Composable (Modifier) -> Unit = { modifier ->
        TargetField(
            label = "Reps",
            value = TargetEntry.sharedReps(shown),
            placeholder = if (TargetEntry.repsVary(shown)) TargetEntry.varies else TargetEntry.repsPlaceholder,
            decimal = false,
            bad = headFault?.field == TargetEntry.Field.Reps,
            enabled = ladderShown,
            description = "Reps target",
            last = false,
            modifier = modifier,
            onTyped = { headTyped(reps = it) },
        )
    }
    val weightField: @Composable (Modifier) -> Unit = { modifier ->
        TargetField(
            label = "Weight",
            value = TargetEntry.sharedWeight(shown),
            placeholder = if (TargetEntry.weightVaries(shown)) TargetEntry.varies else TargetEntry.weightPlaceholder,
            decimal = true,
            bad = headFault?.field == TargetEntry.Field.Weight,
            enabled = ladderShown,
            description = "Weight target",
            last = !ladderShown,
            modifier = modifier,
            onTyped = { headTyped(weight = it) },
        )
    }
    Column(Modifier.fillMaxWidth().heightIn(max = pickerMaxHeight()).imePadding().background(skin.surface)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(Readout.movement(exerciseId, store.catalog), style = WindmillFont.body(22, FontWeight.Bold), color = skin.ink)
                draft.placeOf(exerciseId)?.let {
                    Text("$it of ${draft.entries.size} · ${draft.name}", style = WindmillFont.body(14), color = skin.inkDim)
                }
            }
            TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Cancel", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
            }
        }
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
            .testTag("target-sheet-body").padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            // What leaving the count empty MEANS, said here and nowhere else — the lists behind
            // this sheet print the compact `open` token per row and no sentence. Said ABOVE the
            // fields: everything drawn UNDER a field is that field's own note, while this is a
            // statement about the whole line.
            if (!ladderShown) {
                Text(
                    TargetEntry.openLine,
                    style = WindmillFont.body(16).copy(lineHeight = 22.sp),
                    color = skin.inkDim,
                )
            }
            SectionHead(TargetEntry.everySet)

            if (broadFields) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                    countField(Modifier.weight(1f))
                    repsField(Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                    weightField(Modifier.weight(1f))
                    if (bandAssisted) SignKey(enabled = ladderShown) {
                        headTyped(weight = signFlipped(TargetEntry.sharedWeight(shown)))
                    }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                    countField(Modifier.weight(1f))
                    repsField(Modifier.weight(1f))
                    weightField(Modifier.weight(1f))
                    if (bandAssisted) SignKey(enabled = ladderShown) {
                        headTyped(weight = signFlipped(TargetEntry.sharedWeight(shown)))
                    }
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
                                    modifier = modifier,
                                    onTyped = { rowTyped(index, weight = it) },
                                )
                            }
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
                                                color = skin.inkDim,
                                                modifier = Modifier.width(40.dp),
                                            )
                                            if (stackedLadder) {
                                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                                    rowReps(Modifier.fillMaxWidth())
                                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                                                        rowWeight(Modifier.weight(1f))
                                                        SignKey { rowTyped(index, weight = signFlipped(row.weight)) }
                                                    }
                                                }
                                            } else {
                                                rowReps(Modifier.weight(1f))
                                                rowWeight(Modifier.weight(1f))
                                                if (bandAssisted) SignKey { rowTyped(index, weight = signFlipped(row.weight)) }
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
                            .clickable(role = Role.Button, onClick = ::addSet),
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = null, tint = skin.accent)
                        Text(TargetEntry.addSet, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    }
                    if (atCeiling) FaultLine(TargetEntry.outsideSets)
                }
            }
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp)
                .heightIn(min = 56.dp)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(if (refused == null) skin.accent else skin.raised)
                .clickable(enabled = refused == null, role = Role.Button) { onSet(reading) },
        ) {
            Text(
                TargetEntry.commitLabel(reading),
                style = WindmillFont.body(16, FontWeight.Bold),
                color = if (refused == null) skin.onAccent else skin.inkDim,
            )
        }
    }
}

@Composable
private fun SectionHead(words: String) {
    val skin = LocalGymColors.current
    Text(words, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
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