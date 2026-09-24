package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheetWindow
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import works.windmill.gym.R
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.net.WindmillJson

// Save enables when the draft is savable — named and holding at least one movement — and for an edit
// only once something actually changed: a Save that rewrote a document with itself would move the
// revision and supersede a pending proposal for nothing.
fun routineDraftSaver(telemetry: Telemetry): Saver<RoutineDraft?, String> = Saver(
    save = { draft -> draft?.let { runCatching { WindmillJson.encodeToString(RoutineDraft.serializer(), it) }
        .onFailure { telemetry.failure("gym.saveRoutineDraft", it) }.getOrNull() } ?: "" },
    restore = { written ->
        if (written.isEmpty()) null
        else runCatching { WindmillJson.decodeFromString(RoutineDraft.serializer(), written) }
            .onFailure { telemetry.failure("gym.restoreRoutineDraft", it) }.getOrNull()
    },
)

@Serializable
internal sealed interface BuilderSheet {
    @Serializable
    data class Target(val exerciseId: String, val scheme: TargetEntry.Draft) : BuilderSheet
    @Serializable
    data object Picker : BuilderSheet
}

internal val builderSheetSaver = Saver<BuilderSheet?, String>(
    save = { it?.let { sheet -> WindmillJson.encodeToString(BuilderSheet.serializer(), sheet) } ?: "" },
    restore = { raw ->
        runCatching {
            val saved = WindmillJson.parseToJsonElement(raw).jsonObject
            if (saved["type"]?.jsonPrimitive?.content == "works.windmill.gym.ui.BuilderSheet.Target" && "scheme" !in saved) {
                BuilderSheet.Target(saved.getValue("exerciseId").jsonPrimitive.content,
                    TargetEntry.Draft(
                        rows = WindmillJson.decodeFromJsonElement(ListSerializer(TargetEntry.TypedSet.serializer()), saved.getValue("rows")),
                        sets = saved.getValue("sets").jsonPrimitive.content,
                        varyBySet = true,
                    ))
            } else WindmillJson.decodeFromString(BuilderSheet.serializer(), raw)
        }.getOrNull()
    },
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
                sheet = BuilderSheet.Target(id, TargetEntry.Draft(draft.entry(id)?.sets.orEmpty()))
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
                    onCreateTarget = { exercise, targets ->
                        onDraft(draft.adding(exercise.id, targets))
                        close()
                    },
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
                                    Text(Readout.targetWithUnit(entry.sets), style = WindmillFont.body(15).copy(lineHeight = 21.sp), color = skin.inkDim)
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
        }
    }
}

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
    val reading = state.scheme.reading
    val valid = reading !is TargetEntry.Reading.Refused
    Column(Modifier.fillMaxWidth().heightIn(max = pickerMaxHeight()).imePadding().background(skin.surface)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(Readout.movement(state.exerciseId, store.catalog), style = WindmillFont.body(22, FontWeight.Bold), color = skin.ink)
                draft.placeOf(state.exerciseId)?.let {
                    Text("$it of ${draft.entries.size} · ${draft.name}", style = WindmillFont.body(14), color = skin.inkDim)
                }
            }
            TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Cancel", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
            }
        }
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
            .testTag("target-sheet-body").padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 24.dp)) {
            TargetBlock(state.scheme, { onState(state.copy(scheme = it)) },
                bandAssisted = store.catalog.firstOrNull { it.id == state.exerciseId }?.equipment == "bodyweight")
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)
                .heightIn(min = 56.dp).clip(RoundedCornerShape(WindmillRadius.lg))
                .background(if (valid) skin.accent else skin.raised)
                .clickable(enabled = valid, role = Role.Button) { onSet(reading) },
        ) {
            Text(TargetEntry.commitLabel(reading), style = WindmillFont.body(16, FontWeight.Bold),
                color = if (valid) skin.onAccent else skin.inkDim)
        }
    }
}
