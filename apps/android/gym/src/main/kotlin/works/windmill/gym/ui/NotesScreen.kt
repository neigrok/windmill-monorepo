package works.windmill.gym.ui

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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Notes
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont

@Composable
fun NotesScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    backTo: String,
    onBack: () -> Unit,
    onEdit: (Note?, String) -> Unit,
    onSignIn: () -> Unit,
    say: (String?) -> Unit,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    var attempt by remember { mutableIntStateOf(0) }
    var read by remember { mutableStateOf(false) }
    var reading by remember { mutableStateOf(isSignedIn) }
    var failure by remember { mutableStateOf<String?>(null) }
    var order by remember { mutableStateOf<List<Note>?>(null) }
    var savingOrder by remember { mutableStateOf(false) }
    val hasRead = read && store.notesRead
    LaunchedEffect(store, isSignedIn, attempt) {
        if (!isSignedIn) return@LaunchedEffect
        reading = true
        failure = null
        try {
            when (val result = store.readNotes()) {
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
                val result = store.reorderNotes(moved, next.map { it.id })
                if (result is GymResult.Failed) say(result.why.line("The order stayed as it was."))
            } finally { order = null; savingOrder = false }
        }
    }
    GymScreen(title = Notes.title, onBack = onBack, backTo = backTo) {
        Column(Modifier.fillMaxSize()) {
            NoteList(order ?: store.notes, enabled = !savingOrder,
                modifier = Modifier.weight(1f), onOpen = { onEdit(it, "") },
                onMove = { if (!savingOrder) order = it }, onSettle = ::reorder,
                onDelete = { note ->
                    val problem = store.delete(Deletion.Note(note.id))
                    problem?.line("that note is still here")
                },
                header = {
                    Text(Notes.honesty, style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 16.sp, lineHeight = 24.sp), color = skin.ink)
                    if (isSignedIn) Refusals(store.noteRefusals, store.catalog, store::clearRefusals)
                    when {
                        !isSignedIn -> Text(Notes.signedOut, style = WindmillFont.body(16), color = skin.inkDim)
                        failure != null -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("Notes unavailable", style = WindmillFont.body(20, FontWeight.Bold), color = skin.ink)
                            Text(failure!!, style = WindmillFont.body(16), color = skin.inkDim)
                            TextButton(onClick = { attempt++ }, enabled = !reading) { Text("Try again") }
                        }
                        !hasRead -> Text("Reading your notes…", style = WindmillFont.body(16), color = skin.inkDim)
                    }
                    if (isSignedIn && hasRead && failure == null && store.noteCount == 0) {
                        Notes.placeholders.forEach { title ->
                            Row(Modifier.fillMaxWidth().heightIn(min = 70.dp)
                                .clickable(role = Role.Button, onClickLabel = "Write a note") { onEdit(null, title) }
                                .padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(title, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp),
                                    color = skin.inkDim, modifier = Modifier.weight(1f))
                                Chevron()
                            }
                        }
                    }
                }, showRows = isSignedIn && hasRead && failure == null,
                footer = {
                    if (isSignedIn && hasRead && failure == null) {
                        if (store.noteCount >= Notes.maxNotes) Text(Notes.full, style = WindmillFont.body(14), color = skin.inkDim)
                    }
                })
            if (!isSignedIn || (hasRead && failure == null && store.noteCount < Notes.maxNotes)) {
                Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
                    Button(onClick = { if (isSignedIn) onEdit(null, "") else onSignIn() },
                        enabled = !savingOrder, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = skin.raised, contentColor = skin.ink)) {
                        Text(if (isSignedIn) Notes.add else "Sign in", style = GymNativeType.button)
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
    val skin = LocalGymColors.current
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
                Box(Modifier.fillMaxWidth().background(if (dragged == note.id) skin.raised else skin.surface)) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 68.dp)
                        .focusRequester(focus).clickable(enabled = enabled, role = Role.Button, onClickLabel = "Open note") { onOpen(note) }
                        .semantics { customActions = actions }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (notes.size > 1) Spacer(Modifier.size(24.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(note.title, style = GymNativeType.button.copy(fontSize = 15.sp), color = skin.ink)
                            Text(problem ?: note.firstLine ?: "empty · tap to write",
                                style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 13.sp, lineHeight = 18.sp),
                                color = if (problem == null) skin.inkDim else skin.error,
                                modifier = Modifier.semantics { if (problem != null) liveRegion = LiveRegionMode.Polite })
                        }
                        Icon(painterResource(R.drawable.gym_note_chevron), null, Modifier.size(24.dp), tint = skin.inkDim)
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
                        Icon(painterResource(R.drawable.gym_note_drag), null, Modifier.size(24.dp), tint = skin.inkDim)
                    }
                }
            }
        }
        item("foot") { Column(verticalArrangement = Arrangement.spacedBy(20.dp), content = footer) }
    }
}

@Composable
fun NoteEditorScreen(
    note: Note?,
    seedTitle: String,
    store: TrainingStore,
    backTo: String,
    onBack: () -> Unit,
    onDone: () -> Unit,
) {
    val skin = LocalGymColors.current
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
                when (val result = store.saveNote(id, NoteWrite(title.trim(), body.trim()))) {
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
                Text(it, style = WindmillFont.body(14), color = if (Notes.titleOver(title)) skin.error else skin.inkDim)
            }
            NoteField("Note", body, { body = it; said = null }, Notes.bodyPlaceholder,
                enabled = !saving, minimum = 240.dp, problem = said?.takeIf { !Notes.titleOver(title) && Notes.over(body) })
            Notes.counter(body)?.let {
                Text(it, style = WindmillFont.body(14), color = if (Notes.over(body)) skin.error else skin.inkDim)
            }
            said?.let { Text(it, style = WindmillFont.body(14), color = skin.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            if (note == null) Text(Notes.honesty, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            if (note != null) GymErrorTextButton(Notes.delete, onClick = { if (!saving) {
                saving = true
                scope.launch {
                    try {
                        val failure = store.delete(Deletion.Note(note.id, Deletion.Note.Origin.Editor))
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
    val skin = LocalGymColors.current
    val type = MaterialTheme.typography
    MaterialTheme(typography = type.copy(
        bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = .5.sp),
        bodySmall = TextStyle(fontFamily = FontFamily.Default, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = .4.sp),
    )) {
        OutlinedTextField(value, onValueChange = onValue, enabled = enabled,
            label = { Text(label) }, placeholder = { Text(placeholder) }, isError = problem != null,
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent, disabledContainerColor = Color.Transparent,
                focusedBorderColor = skin.accent, unfocusedBorderColor = skin.line,
                focusedTextColor = skin.ink, unfocusedTextColor = skin.ink, cursorColor = skin.accent),
            modifier = Modifier.fillMaxWidth().heightIn(min = minimum).semantics {
                contentDescription = "$label field"
                problem?.let { error(it) }
            })
    }
}
