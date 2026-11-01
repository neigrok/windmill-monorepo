package works.windmill.gym.ui

import works.windmill.platform.design.WindmillType
import androidx.compose.material3.MaterialTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.Ids
import works.windmill.gym.presentation.Note
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.presentation.Notes
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeletionsStore
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.NotesStore
import works.windmill.gym.store.RefusedWrite
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure

// What the notes list draws: the seat's notes, how many, whether they are read, and the writes the log refused.
@Stable
interface NotesState {
    val notes: List<Note>
    val noteCount: Int
    val notesRead: Boolean
    val noteRefusals: List<RefusedWrite>
    val catalog: List<Exercise>
}

// What the notes list asks of the stores.
interface NotesEvents {
    suspend fun readNotes(): GymResult<List<Note>>
    suspend fun reorderNotes(moved: String, drawn: List<String>): GymResult<List<Note>>
    suspend fun delete(deletion: Deletion.Note): WriteFailure?
    fun clearRefusals()
}

// What the note editor asks of the stores.
interface NoteEditorEvents {
    suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note>
    suspend fun delete(deletion: Deletion.Note): WriteFailure?
}

// The notes list and the note editor over the room's stores.
class NotesBinding(
    private val notebook: NotesStore,
    private val routines: RoutinesStore,
    private val deletions: DeletionsStore,
    private val dismissRefusals: () -> Unit,
) : NotesState, NotesEvents, NoteEditorEvents {
    constructor(store: TrainingStore) : this(store.notes, store.routines, store.deletions, store::clearRefusals)

    override val notes: List<Note> get() = notebook.all
    override val noteCount: Int get() = notebook.noteCount
    override val notesRead: Boolean get() = notebook.notesRead
    override val noteRefusals: List<RefusedWrite> get() = notebook.noteRefusals
    override val catalog: List<Exercise> get() = routines.catalog

    override suspend fun readNotes(): GymResult<List<Note>> = notebook.readNotes()
    override suspend fun reorderNotes(moved: String, drawn: List<String>): GymResult<List<Note>> = notebook.reorderNotes(moved, drawn)
    override suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note> = notebook.saveNote(id, write)
    override suspend fun delete(deletion: Deletion.Note): WriteFailure? = deletions.delete(deletion)
    override fun clearRefusals() = dismissRefusals()
}

@Composable
fun NotesScreen(
    state: NotesState,
    events: NotesEvents,
    isSignedIn: Boolean,
    backTo: String,
    onBack: () -> Unit,
    onEdit: (Note?, String) -> Unit,
    onSignIn: () -> Unit,
    say: (String?) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    var attempt by remember { mutableIntStateOf(0) }
    var read by remember { mutableStateOf(false) }
    var reading by remember { mutableStateOf(isSignedIn) }
    var failure by remember { mutableStateOf<String?>(null) }
    var order by remember { mutableStateOf<List<Note>?>(null) }
    var savingOrder by remember { mutableStateOf(false) }
    val hasRead = read && state.notesRead
    LaunchedEffect(events, isSignedIn, attempt) {
        if (!isSignedIn) return@LaunchedEffect
        reading = true
        failure = null
        try {
            when (val result = events.readNotes()) {
                is GymResult.Ok -> read = true
                is GymResult.Failed -> failure = result.why.line("Your notes could not be read.")
            }
        } finally { reading = false }
    }
    fun reorder(moved: String, next: List<Note>) {
        if (savingOrder) return
        savingOrder = true
        order = next
        say(null)
        scope.launch {
            try {
                val result = events.reorderNotes(moved, next.map { it.id })
                if (result is GymResult.Failed) say(result.why.line("The order stayed as it was."))
            } finally { order = null; savingOrder = false }
        }
    }
    GymScreen(title = Notes.title, onBack = onBack, backTo = backTo) {
        Column(Modifier.fillMaxSize()) {
            NoteList(order ?: state.notes, enabled = !savingOrder,
                modifier = Modifier.weight(1f), onOpen = { onEdit(it, "") },
                onMove = { if (!savingOrder) order = it }, onSettle = ::reorder,
                onDelete = { note ->
                    val problem = events.delete(Deletion.Note(note.id))
                    problem?.line("that note is still here")
                },
                header = {
                    Text(Notes.honesty, style = GymType.nativeBody, color = colors.onSurface)
                    if (isSignedIn) Refusals(state.noteRefusals, state.catalog, events::clearRefusals)
                    when {
                        !isSignedIn -> Text(Notes.signedOut, style = GymType.nativeBody, color = colors.onSurfaceVariant)
                        failure != null -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("Notes unavailable", style = GymType.cardTitle, color = colors.onSurface)
                            Text(failure!!, style = WindmillType.body, color = colors.onSurfaceVariant)
                            TextButton(onClick = { attempt++ }, enabled = !reading) { Text("Try again") }
                        }
                        !hasRead -> Text("Reading your notes…", style = WindmillType.body, color = colors.onSurfaceVariant)
                    }
                    if (isSignedIn && hasRead && failure == null && state.noteCount == 0) {
                        Notes.placeholders.forEach { title ->
                            Row(Modifier.fillMaxWidth().heightIn(min = 70.dp)
                                .clickable(role = Role.Button, onClickLabel = "Write a note") { onEdit(null, title) }
                                .padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(title, style = WindmillType.labelParagraph,
                                    color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
                                Chevron()
                            }
                        }
                    }
                }, showRows = isSignedIn && hasRead && failure == null,
                footer = {
                    if (isSignedIn && hasRead && failure == null) {
                        if (state.noteCount >= Notes.maxNotes) Text(Notes.full, style = WindmillType.supporting, color = colors.onSurfaceVariant)
                    }
                })
            if (!isSignedIn || (hasRead && failure == null && state.noteCount < Notes.maxNotes)) {
                Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
                    Button(onClick = { if (isSignedIn) onEdit(null, "") else onSignIn() },
                        enabled = !savingOrder, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface)) {
                        Text(if (isSignedIn) Notes.add else "Sign in", style = GymType.button)
                    }
                }
            }
        }
    }
}

@Composable
private fun NoteList(
    notes: List<Note>,
    enabled: Boolean,
    modifier: Modifier,
    onOpen: (Note) -> Unit,
    onMove: (List<Note>?) -> Unit,
    onSettle: (String, List<Note>) -> Unit,
    onDelete: suspend (Note) -> String?,
    header: @Composable ColumnScope.() -> Unit,
    showRows: Boolean,
    footer: @Composable ColumnScope.() -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val standing by rememberUpdatedState(notes)
    val mayMove by rememberUpdatedState(enabled)
    var dragged by remember { mutableStateOf<String?>(null) }
    var offset by remember { mutableFloatStateOf(0f) }
    var focused by remember { mutableStateOf<String?>(null) }
    LazyColumn(state = list, modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item("head") { Column(verticalArrangement = Arrangement.spacedBy(12.dp), content = header) }
        if (showRows) itemsIndexed(notes, key = { _, note -> note.id }) { index, note ->
            val focus = remember(note.id) { FocusRequester() }
            LaunchedEffect(focused, enabled) {
                if (focused == note.id && enabled) focus.requestFocus()
            }
            val actions = if (!enabled) emptyList() else buildList {
                fun move(to: Int) {
                    focused = note.id
                    onSettle(note.id, Notes.moved(standing, index, to))
                    if (list.layoutInfo.visibleItemsInfo.none { it.index == to + 1 }) {
                        scope.launch { list.scrollToItem(to + 1) }
                    }
                }
                if (index > 0) add(CustomAccessibilityAction("Move up") { move(index - 1); true })
                if (index < notes.lastIndex) add(CustomAccessibilityAction("Move down") { move(index + 1); true })
            }
            var problem by remember(note.id) { mutableStateOf<String?>(null) }
            DeleteSwipeRow(actionLabel = Notes.delete, onDelete = {
                problem = onDelete(note)
                problem == null
            }, enabled = enabled && dragged == null,
                modifier = Modifier.zIndex(if (dragged == note.id) 1f else 0f)
                    .graphicsLayer { translationY = if (dragged == note.id) offset else 0f }) {
                Box(Modifier.fillMaxWidth().background(if (dragged == note.id) colors.surfaceContainerHighest else colors.surfaceContainer)) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 68.dp)
                        .focusRequester(focus).clickable(enabled = enabled, role = Role.Button, onClickLabel = "Open note") { onOpen(note) }
                        .semantics { customActions = actions }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (notes.size > 1) Spacer(Modifier.size(24.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(note.title, style = GymType.noteTitle, color = colors.onSurface)
                            Text(problem ?: note.firstLine ?: "empty · tap to write",
                                style = GymType.nativeDetail,
                                color = if (problem == null) colors.onSurfaceVariant else colors.error,
                                modifier = Modifier.semantics { if (problem != null) liveRegion = LiveRegionMode.Polite })
                        }
                        Icon(painterResource(R.drawable.gym_note_chevron), null, Modifier.size(24.dp), tint = colors.onSurfaceVariant)
                    }
                    if (notes.size > 1) Box(Modifier.size(48.dp).align(Alignment.CenterStart)
                        .semantics { contentDescription = "Reorder ${note.title}" }
                        .pointerInput(note.id) {
                            awaitEachGesture {
                                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                down.consume()
                                var order = standing
                                var moved = false
                                var started = false
                                var cancelled = !mayMove
                                try {
                                    do {
                                        val event = awaitPointerEvent(PointerEventPass.Initial)
                                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                        if (change.isConsumed) break
                                        event.changes.forEach { it.consume() }
                                        if (!change.pressed) {
                                            if (moved && mayMove) onSettle(note.id, order)
                                            break
                                        }
                                        if (!started && !cancelled) {
                                            if (change.uptimeMillis - down.uptimeMillis >= viewConfiguration.longPressTimeoutMillis) {
                                                started = true
                                                dragged = note.id
                                                offset = 0f
                                            } else if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) {
                                                cancelled = true
                                            }
                                        }
                                        val amount = change.position - change.previousPosition
                                        if (!started || !mayMove) continue
                                        offset += amount.y
                                        val from = order.indexOfFirst { it.id == note.id }
                                        val visible = list.layoutInfo.visibleItemsInfo
                                        val row = visible.firstOrNull { it.key == note.id } ?: continue
                                        if (row.index != from + 1) continue
                                        val center = row.offset + row.size / 2f + offset
                                        val above = order.getOrNull(from - 1)?.let { adjacent -> visible.firstOrNull { it.key == adjacent.id } }
                                        val below = order.getOrNull(from + 1)?.let { adjacent -> visible.firstOrNull { it.key == adjacent.id } }
                                        val to = when {
                                            above != null && center < above.offset + above.size / 2f -> from - 1
                                            below != null && center > below.offset + below.size / 2f -> from + 1
                                            else -> continue
                                        }
                                        val neighbor = if (to < from) above!! else below!!
                                        order = Notes.moved(order, from, to)
                                        moved = true
                                        onMove(order)
                                        offset += row.offset - if (to < from) neighbor.offset else neighbor.offset + neighbor.size - row.size
                                    } while (true)
                                } finally {
                                    dragged = null
                                    offset = 0f
                                    onMove(null)
                                }
                            }
                        }, contentAlignment = Alignment.Center) {
                        Icon(painterResource(R.drawable.gym_note_drag), null, Modifier.size(24.dp), tint = colors.onSurfaceVariant)
                    }
                }
            }
        }
        item("foot") { Column(verticalArrangement = Arrangement.spacedBy(20.dp), content = footer) }
    }
}

@Composable
fun NoteEditorScreen(
    events: NoteEditorEvents,
    note: Note?,
    seedTitle: String,
    backTo: String,
    onBack: () -> Unit,
    onDone: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    val id = rememberSaveable { note?.id ?: Ids.note() }
    var title by rememberSaveable { mutableStateOf(note?.title ?: "") }
    var body by rememberSaveable { mutableStateOf(note?.body ?: "") }
    var saving by remember { mutableStateOf(false) }
    var said by rememberSaveable { mutableStateOf<String?>(null) }
    val changed = note == null || title.trim() != note.title || body.trim() != note.body
    val canSave = Notes.savable(title) && changed && !saving
    BackHandler(saving) {}
    fun save() {
        if (!canSave) return
        saving = true
        said = null
        scope.launch {
            try {
                when (val result = events.saveNote(id, NoteWrite(title.trim(), body.trim()))) {
                    is GymResult.Ok -> onDone()
                    is GymResult.Failed -> said = result.why.line("The note stayed as it was.")
                }
            } finally { saving = false }
        }
    }
    GymScreen(title = "Note", onBack = { if (!saving) onBack() }, backTo = backTo,
        actions = { TopAction(if (saving) "Saving…" else Notes.save, enabled = canSave, onClick = ::save) }) {
        Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)) {
            NoteField("Title", title, { title = it; said = null }, seedTitle.ifBlank { Notes.titlePlaceholder },
                enabled = !saving, minimum = 56.dp, problem = said?.takeIf { Notes.titleOver(title) })
            Notes.titleCounter(title)?.let {
                Text(it, style = WindmillType.supporting, color = if (Notes.titleOver(title)) colors.error else colors.onSurfaceVariant)
            }
            NoteField("Note", body, { body = it; said = null }, Notes.bodyPlaceholder,
                enabled = !saving, minimum = 240.dp, problem = said?.takeIf { !Notes.titleOver(title) && Notes.over(body) })
            Notes.counter(body)?.let {
                Text(it, style = WindmillType.supporting, color = if (Notes.over(body)) colors.error else colors.onSurfaceVariant)
            }
            said?.let { Text(it, style = WindmillType.supporting, color = colors.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            if (note == null) Text(Notes.honesty, style = WindmillType.supportingParagraph, color = colors.onSurfaceVariant)
            if (note != null) GymErrorTextButton(Notes.delete, onClick = { if (!saving) {
                saving = true
                scope.launch {
                    try {
                        val failure = events.delete(Deletion.Note(note.id, Deletion.Note.Origin.Editor))
                        if (failure == null) onDone() else said = failure.line("that note is still here")
                    } finally { saving = false }
                }
            } },
                enabled = !saving, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun NoteField(label: String, value: String, onValue: (String) -> Unit, placeholder: String,
    enabled: Boolean, minimum: androidx.compose.ui.unit.Dp, problem: String?) {
    val colors = MaterialTheme.colorScheme
    MaterialTheme(typography = MaterialTheme.typography.withStockFields(FontFamily.Default)) {
        OutlinedTextField(value, onValueChange = onValue, enabled = enabled,
            label = { Text(label) }, placeholder = { Text(placeholder) }, isError = problem != null,
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent, disabledContainerColor = Color.Transparent,
                focusedBorderColor = colors.primary, unfocusedBorderColor = colors.outlineVariant,
                focusedTextColor = colors.onSurface, unfocusedTextColor = colors.onSurface, cursorColor = colors.primary),
            modifier = Modifier.fillMaxWidth().heightIn(min = minimum).semantics {
                contentDescription = "$label field"
                problem?.let { error(it) }
            })
    }
}

private data class NotesPreviewState(override val notes: List<Note>) : NotesState {
    override val noteCount: Int get() = notes.size
    override val notesRead: Boolean = true
    override val noteRefusals: List<RefusedWrite> = emptyList()
    override val catalog: List<Exercise> = emptyList()
}

// Answers the list's read with the preview's notes; writes change nothing.
private class NotesPreviewEvents(private val notes: List<Note>) : NotesEvents, NoteEditorEvents {
    override suspend fun readNotes(): GymResult<List<Note>> = GymResult.Ok(notes)
    override suspend fun reorderNotes(moved: String, drawn: List<String>): GymResult<List<Note>> = GymResult.Ok(notes)
    override suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note> = GymResult.Ok(Note(id, title = write.title, body = write.body))
    override suspend fun delete(deletion: Deletion.Note): WriteFailure? = null
    override fun clearRefusals() = Unit
}

private val notesPreviewNotes = listOf(
    Note("note_goal", 0, "What I am training for", "A 100 kg bench by spring.\nStay pain-free in the left shoulder."),
    Note("note_knee", 1, "Knee", "Box squats when it aches; no lunges."),
    Note("note_tone", 2, "Tone"),
)

@DarkAndDaylight
@Composable
private fun NotesListPreview() {
    GymPreview {
        val events = NotesPreviewEvents(notesPreviewNotes)
        NotesScreen(NotesPreviewState(notesPreviewNotes), events, isSignedIn = true, backTo = "Coach", onBack = {},
            onEdit = { _, _ -> }, onSignIn = {}, say = {})
    }
}

@DarkAndDaylight
@Composable
private fun NoteEditorPreview() {
    GymPreview {
        NoteEditorScreen(NotesPreviewEvents(notesPreviewNotes), notesPreviewNotes.first(), "", backTo = Notes.title,
            onBack = {}, onDone = {})
    }
}
