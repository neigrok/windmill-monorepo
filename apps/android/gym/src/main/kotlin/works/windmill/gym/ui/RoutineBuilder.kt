package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
import androidx.activity.compose.BackHandler
import works.windmill.gym.BackGuard
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.SheetValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.semantics.disabled
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
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.RoutineMovement
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.domain.sync.RoutineRules
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.GymResult
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.net.WindmillJson
import androidx.compose.runtime.setValue

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
    data class Target(
        val exerciseId: String,
        val scheme: TargetEntry.Draft,
        val movement: RoutineMovement? = null,
        val opening: RoutineMovement? = movement,
        val initialScheme: TargetEntry.Draft = scheme,
        val adding: Boolean = false,
        val creating: Boolean = false,
        val discarding: Boolean = false,
    ) : BuilderSheet {
        val dirty: Boolean get() = movement != opening || scheme.rows != initialScheme.rows || scheme.sets != initialScheme.sets
        // The floor the save will hold this line to, by the domain's own rule.
        fun floor(of: RoutineMovement): Double? = RoutineRules.targetFloor(
            retargeted = adding || creating || scheme.rows != initialScheme.rows || scheme.sets != initialScheme.sets,
            equipment = of.current.equipment, loadCount = of.current.loadCount,
            base = of.base?.let { it.equipment to it.loadCount })
    }
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
    val telemetry = LocalTelemetry.current
    var closing by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { value ->
        val form = sheet as? BuilderSheet.Target
        if (value == SheetValue.Hidden && !closing && form?.dirty == true) {
            sheet = form.copy(discarding = true)
            false
        } else true
    })
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    fun close() {
        closing = true
        scope.launch {
            try { sheetState.hide(); sheet = null }
            finally { closing = false }
        }
    }
    fun leaveForm() {
        val form = sheet as? BuilderSheet.Target
        telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "cancel", "outcome" to "ok"))
        if (form?.adding == true) {
            sheet = BuilderSheet.Picker
            scope.launch { if (sheet == BuilderSheet.Picker) sheetState.show() }
        } else close()
    }
    fun requestClose() {
        val form = sheet as? BuilderSheet.Target
        if (form?.dirty == true) sheet = form.copy(discarding = true)
        else if (form != null) leaveForm() else close()
    }

    LaunchedEffect((sheet as? BuilderSheet.Target)?.exerciseId, sheet == BuilderSheet.Picker) {
        if (sheet == null) return@LaunchedEffect
        focusManager.clearFocus()
        keyboard?.hide()
        val form = sheet as? BuilderSheet.Target ?: return@LaunchedEffect
        telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "open", "outcome" to "ok"))
        if (form.movement == null) {
            draft.movement(form.exerciseId, store.catalog)?.let { movement ->
                sheet = form.copy(movement = movement, opening = movement,
                    initialScheme = TargetEntry.Draft(draft.entry(form.exerciseId)?.sets.orEmpty()))
            }
        }
    }

    var history by remember(store.accountKey, store.editReplica, draft.id) { mutableStateOf(emptyList<SessionSummary>()) }
    LaunchedEffect(store.accountKey, store.editReplica, store.replicaReadRevision, store.accountReady, store.withheldIds, draft.id) {
        val id = draft.id ?: return@LaunchedEffect
        if (!store.accountReady) { history = emptyList(); return@LaunchedEffect }
        history = when (val read = store.routineHistory(id)) {
            is GymResult.Ok -> read.value
            is GymResult.Failed -> emptyList()
        }
    }

    val editing = draft.id != null
    // Asked over the draft, so a recreation mid-question keeps both the question and the draft.
    var discarding by rememberSaveable { mutableStateOf(false) }
    // A lambda rather than a local fun: Compose remembers it against the draft it reads, never a stale one.
    val leave: () -> Unit = leave@{
        if (saving) return@leave
        if (!draft.unsaved) return@leave onClose()
        discarding = true
        telemetry.event("gym_action", mapOf("screen" to "routine_editor", "action" to "discard", "state" to "shown"))
    }
    // While a save is in flight Back does nothing; while the draft holds work it asks.
    BackGuard(enabled = saving || draft.unsaved, ask = leave)
    LaunchedEffect(saving) {
        if (saving) { focusManager.clearFocus(); keyboard?.hide() }
    }

    BuildStep(
        draft = draft, store = store, history = history, editing = editing, editable = !saving,
        savable = draft.savable && draft.changed && !saving,
        onDraft = { if (!saving) onDraft(it) },
        onOpenTarget = { id ->
            val movement = draft.movement(id, store.catalog)
            if (movement == null) say("That movement is no longer on the log.")
            else sheet = BuilderSheet.Target(id, TargetEntry.Draft(draft.entry(id)?.sets.orEmpty()), movement)
        },
        onRemove = { onDraft(draft.removing(it)) }, onAdd = { sheet = BuilderSheet.Picker },
        onSave = onSave, onCancel = leave,
    )

    val open = sheet
    if (open != null) {
        WindmillSheet(onDismissRequest = ::requestClose, onBack = ::requestClose, sheetState = sheetState,
            containerColor = skin.surface, scrimColor = skin.scrim,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            dragHandle = {
                Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.width(32.dp).height(4.dp).background(skin.inkDim, RoundedCornerShape(2.dp)))
                }
            }) {
            val sheetKeyboard = LocalSoftwareKeyboardController.current
            BackHandler(enabled = WindowInsets.isImeVisible) { sheetKeyboard?.hide() }
            when (open) {
                is BuilderSheet.Target -> {
                    val movement = open.movement ?: draft.movement(open.exerciseId, store.catalog)
                    if (movement != null) MovementForm(movement, open.scheme,
                        title = when { open.creating -> "Create movement"; open.adding -> "Add movement"; else -> "Edit movement" },
                        commitLabel = if (open.adding) "Add" else "Done",
                        onMovement = { changed ->
                            val latest = sheet as? BuilderSheet.Target
                            if (latest != null) sheet = latest.copy(movement = changed, opening = latest.opening ?: movement)
                        },
                        onScheme = { changed ->
                            val latest = sheet as? BuilderSheet.Target
                            if (latest != null) sheet = latest.copy(scheme = changed)
                        }, onCancel = ::requestClose,
                        onCommit = commit@ {
                            if (closing || saving) return@commit
                            val latest = sheet as? BuilderSheet.Target
                            val edited = latest?.movement ?: movement
                            val reading = (latest?.scheme ?: open.scheme).reading((latest ?: open).floor(edited))
                            val valid = Program.nameProblem(edited.current.name) == null && reading !is TargetEntry.Reading.Refused
                            telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "stage",
                                "outcome" to if (valid) "ok" else "refused"))
                            if (valid) {
                                focusManager.clearFocus(); keyboard?.hide()
                                onDraft(draft.staging(edited, reading))
                                close()
                            }
                        }, creating = open.creating, busy = closing, floor = open.floor(movement))
                }
                BuilderSheet.Picker -> MovementPicker(
                    catalog = store.catalog, taken = draft.entries.map { it.exerciseId }, lastSets = null,
                    nowMs = 0, sessions = store.recent, title = "Add movement",
                    onPick = { id ->
                        val movement = draft.movement(id, store.catalog)
                        if (movement == null) say("That movement is no longer on the log.")
                        else sheet = BuilderSheet.Target(id, TargetEntry.Draft(emptyList<works.windmill.gym.domain.SetTarget>()), movement, adding = true)
                    }, onCreate = null,
                    onCreateDraft = { exercise, scheme ->
                        sheet = BuilderSheet.Target(exercise.id, scheme, RoutineMovement(null, exercise), adding = true, creating = true)
                    }, state = pickerState,
                    modifier = Modifier.heightIn(max = pickerMaxHeight()).padding(horizontal = GymLayout.gutter)
                        .padding(bottom = GymLayout.sheetBottom), onClose = ::close,
                )
            }
        }
    }
    val form = open as? BuilderSheet.Target
    if (form?.discarding == true) DiscardQuestion("Discard changes?", "Changes to this movement won’t be kept.",
        onKeepEditing = { sheet = form.copy(discarding = false) }, onDiscard = ::leaveForm)
    if (discarding) DiscardQuestion("Discard routine changes?",
        "${Program.named(draft.name) ?: "This routine"} won’t be saved.",
        onKeepEditing = {
            discarding = false
            telemetry.event("gym_action", mapOf("screen" to "routine_editor", "action" to "discard", "outcome" to "cancelled"))
        },
        onDiscard = {
            discarding = false
            telemetry.event("gym_action", mapOf("screen" to "routine_editor", "action" to "discard", "outcome" to "ok"))
            onClose()
        })
}

// The editor's two questions before work is let go: the movement form's and the whole draft's.
@Composable
private fun DiscardQuestion(title: String, text: String, onKeepEditing: () -> Unit, onDiscard: () -> Unit) {
    val skin = LocalGymColors.current
    AlertDialog(onDismissRequest = onKeepEditing, title = { Text(title) }, text = { Text(text) },
        confirmButton = { TextButton(onClick = onDiscard) { Text("Discard", color = skin.error) } },
        dismissButton = { TextButton(onClick = onKeepEditing) { Text("Keep editing", color = skin.accent) } },
        containerColor = skin.surface)
}

@Composable
private fun BuildStep(
    draft: RoutineDraft,
    store: TrainingStore,
    history: List<SessionSummary>,
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
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                NativeFieldType {
                    OutlinedTextField(draft.name, onValueChange = { onDraft(draft.named(it)) }, enabled = editable,
                        label = { Text("Name") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words,
                            autoCorrectEnabled = false, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { keyboard?.hide() }),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).focusRequester(focus)
                            .semantics { contentDescription = "Routine name" })
                }
                Program.counter(draft.name)?.let { Text(it, style = WindmillFont.body(13), color = skin.inkDim) }
            }
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
                        val movement = draft.movement(entry.exerciseId, store.catalog)?.current
                        val name = movement?.name ?: Readout.movement(entry.exerciseId, store.catalog)
                        DeleteSwipeRow(actionLabel = "Remove movement", enabled = editable,
                            onDelete = { onRemove(entry.exerciseId); true }) {
                            Row(Modifier.fillMaxWidth().heightIn(min = 72.dp)
                                .onGloballyPositioned { positions[entry.exerciseId] = it.positionInRoot().y + it.size.height / 2f + scroll.value }
                                .shadow(if (dragged == entry.exerciseId) 6.dp else 0.dp, RoundedCornerShape(12.dp), clip = false)
                                .background(if (dragged == entry.exerciseId) skin.raised else skin.canvas, RoundedCornerShape(12.dp))
                                .clickable(enabled = editable, role = Role.Button, onClickLabel = "edit this movement") { onOpenTarget(entry.exerciseId) }
                                .semantics { customActions = if (!editable) emptyList() else buildList {
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
                                    Text(Readout.targetWithUnit(entry.sets, movement), style = WindmillFont.body(15).copy(lineHeight = 21.sp), color = skin.inkDim)
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
            if (history.isNotEmpty()) Column(Modifier.fillMaxWidth().testTag("routine-history"),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("History", style = WindmillFont.body(17, FontWeight.Bold).copy(lineHeight = 23.sp), color = skin.ink)
                Column(Modifier.fillMaxWidth()) {
                    val dates = java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d", java.util.Locale.getDefault())
                    history.forEachIndexed { index, workout ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 7.dp).testTag("routine-history-row"),
                            verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(dates.format(java.time.Instant.ofEpochMilli(workout.startedAtMs).atZone(java.time.ZoneId.systemDefault())),
                                style = WindmillFont.body(17, FontWeight.Bold).copy(lineHeight = 23.sp), color = skin.ink)
                            val sets = if (workout.setCount == 1) "set" else "sets"
                            val movements = if (workout.exercises.size == 1) "movement" else "movements"
                            Text("${workout.setCount} $sets · ${workout.exercises.size} $movements",
                                style = GymType.numeral(13).copy(lineHeight = 18.sp), color = skin.inkDim)
                        }
                        if (index != history.lastIndex) HorizontalDivider(color = skin.line)
                    }
                }
            }
            Text(said, style = WindmillFont.body(13), color = skin.inkDim,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
    }
}
