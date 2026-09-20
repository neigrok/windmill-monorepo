package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
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
    fun reorder(next: List<Note>) {
        if (savingOrder) return
        savingOrder = true
        order = next
        say(null)
        scope.launch {
            try {
                val result = store.reorderNotes(next.map { it.id })
                if (result is GymResult.Failed) say(result.why.line("The order stayed as it was."))
            } finally { order = null; savingOrder = false }
        }
    }
    GymScreen(title = Notes.title, onBack = onBack, backTo = backTo) {
        Column(Modifier.fillMaxSize()) {
            NoteList(order ?: store.notes, enabled = !savingOrder,
                modifier = Modifier.weight(1f), onOpen = { onEdit(it, "") },
                onMove = { if (!savingOrder) order = it }, onSettle = ::reorder,
                header = {
                    Text(Notes.sub, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                    Text(Notes.honesty, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.ink)
                    when {
                        !isSignedIn -> Text(Notes.signedOut, style = WindmillFont.body(16), color = skin.inkDim)
                        failure != null -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("Notes unavailable", style = WindmillFont.body(20, FontWeight.Bold), color = skin.ink)
                            Text(failure!!, style = WindmillFont.body(16), color = skin.inkDim)
                            TextButton(onClick = { attempt++ }, enabled = !reading) { Text("Try again") }
                        }
                        !read -> Text("Reading your notes…", style = WindmillFont.body(16), color = skin.inkDim)
                    }
                    if (isSignedIn && read && failure == null && store.noteCount == 0) {
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
                }, showRows = isSignedIn && read && failure == null,
                footer = {
                    if (isSignedIn && read && failure == null) {
                        if (store.notes.size > 1) Text(Notes.topWins, style = WindmillFont.body(14), color = skin.inkDim)
                        if (store.noteCount >= Notes.maxNotes) Text(Notes.full, style = WindmillFont.body(14), color = skin.inkDim)
                    }
                })
            if (!isSignedIn || (read && failure == null && store.noteCount < Notes.maxNotes)) {
                Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
                    Button(onClick = { if (isSignedIn) onEdit(null, "") else onSignIn() },
                        enabled = !savingOrder, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = skin.raised, contentColor = skin.ink)) {
                        Text(if (isSignedIn) Notes.add else "Sign in", style = WindmillFont.body(16, FontWeight.Bold))
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
    onSettle: (List<Note>) -> Unit,
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
        contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item("head") { Column(verticalArrangement = Arrangement.spacedBy(20.dp), content = header) }
        if (showRows) itemsIndexed(notes, key = { _, note -> note.id }) { index, note ->
            val focus = remember(note.id) { FocusRequester() }
            LaunchedEffect(focused, enabled) {
                if (focused == note.id && enabled) focus.requestFocus()
            }
            val actions = if (!enabled) emptyList() else buildList {
                fun move(to: Int) {
                    focused = note.id
                    onSettle(Notes.moved(standing, index, to))
                    if (list.layoutInfo.visibleItemsInfo.none { it.index == to + 1 }) {
                        scope.launch { list.scrollToItem(to + 1) }
                    }
                }
                if (index > 0) add(CustomAccessibilityAction("Move up") { move(index - 1); true })
                if (index < notes.lastIndex) add(CustomAccessibilityAction("Move down") { move(index + 1); true })
            }
            Row(Modifier.fillMaxWidth().zIndex(if (dragged == note.id) 1f else 0f)
                .graphicsLayer { translationY = if (dragged == note.id) offset else 0f }
                .heightIn(min = 70.dp).background(if (dragged == note.id) skin.raised else Color.Transparent)
                .focusRequester(focus).clickable(enabled = enabled, role = Role.Button, onClickLabel = "Open note") { onOpen(note) }
                .semantics { customActions = actions }.padding(vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (notes.size > 1) Icon(painterResource(R.drawable.gym_reorder), "Reorder ${note.title}", tint = skin.inkDim,
                    modifier = Modifier.size(48.dp).pointerInput(note.id) {
                        var order = standing
                        var moved = false
                        detectDragGesturesAfterLongPress(
                            onDragStart = {
                                if (mayMove) { dragged = note.id; offset = 0f; order = standing; moved = false }
                            },
                            onDragEnd = { dragged = null; offset = 0f; if (moved) onSettle(order) },
                            onDragCancel = { dragged = null; offset = 0f; onMove(null) },
                            onDrag = { change, amount ->
                                if (!mayMove || dragged != note.id) return@detectDragGesturesAfterLongPress
                                change.consume()
                                offset += amount.y
                                val from = order.indexOfFirst { it.id == note.id }
                                val visible = list.layoutInfo.visibleItemsInfo
                                val row = visible.firstOrNull { it.key == note.id } ?: return@detectDragGesturesAfterLongPress
                                val center = row.offset + row.size / 2f + offset
                                val above = order.getOrNull(from - 1)?.let { adjacent -> visible.firstOrNull { it.key == adjacent.id } }
                                val below = order.getOrNull(from + 1)?.let { adjacent -> visible.firstOrNull { it.key == adjacent.id } }
                                val to = when {
                                    above != null && center < above.offset + above.size / 2f -> from - 1
                                    below != null && center > below.offset + below.size / 2f -> from + 1
                                    else -> return@detectDragGesturesAfterLongPress
                                }
                                val neighbor = if (to < from) above!! else below!!
                                order = Notes.moved(order, from, to)
                                moved = true
                                onMove(order)
                                offset += row.offset - if (to < from) neighbor.offset else neighbor.offset + neighbor.size - row.size
                            },
                        )
                    })
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(note.title, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
                    Text(note.firstLine ?: "empty · tap to write", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                }
                Chevron()
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
    BackHandler(saving) {}
    fun save() {
        if (saving || !Notes.savable(title)) return
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
    GymScreen(title = if (note == null) "New note" else "Note", onBack = { if (!saving) onBack() }, backTo = backTo,
        actions = {
            TextButton(onClick = ::save, enabled = Notes.savable(title) && !saving,
                modifier = Modifier.widthIn(min = 88.dp).heightIn(min = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = skin.accent, disabledContentColor = skin.inkFaint)) {
                Text(if (saving) "Saving…" else Notes.save, style = WindmillFont.body(13, FontWeight.Bold))
            }
        }) {
        Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)) {
            NoteField("Title", title, { title = it; said = null }, seedTitle.ifBlank { Notes.titlePlaceholder },
                enabled = !saving, minimum = 56.dp, problem = said?.takeIf { Notes.titleOver(title) })
            Notes.titleCounter(title)?.let {
                Text(it, style = WindmillFont.body(14), color = if (Notes.titleOver(title)) skin.alarmInk else skin.inkDim)
            }
            NoteField(if (note == null) "Body" else "Note", body, { body = it; said = null }, Notes.bodyPlaceholder,
                enabled = !saving, minimum = 240.dp, problem = said?.takeIf { !Notes.titleOver(title) && Notes.over(body) })
            Notes.counter(body)?.let {
                Text(it, style = WindmillFont.body(14), color = if (Notes.over(body)) skin.alarmInk else skin.inkDim)
            }
            said?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            if (note == null) Text(Notes.honesty, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            if (note != null) TextButton(onClick = { if (!saving) { store.withhold(Deletion.Note(note.id)); onDone() } },
                enabled = !saving, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text(Notes.delete, style = WindmillFont.body(16), color = skin.alarmInk)
            }
        }
    }
}

@Composable
private fun NoteField(label: String, value: String, onValue: (String) -> Unit, placeholder: String,
    enabled: Boolean, minimum: androidx.compose.ui.unit.Dp, problem: String?) {
    val skin = LocalGymColors.current
    Text(label, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
    OutlinedTextField(value, onValueChange = onValue, enabled = enabled,
        textStyle = WindmillFont.body(18).copy(lineHeight = 24.sp),
        placeholder = { Text(placeholder, style = WindmillFont.body(18).copy(lineHeight = 24.sp)) },
        shape = RoundedCornerShape(20.dp), isError = problem != null,
        colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = skin.raised, unfocusedContainerColor = skin.raised,
            disabledContainerColor = skin.raised, focusedBorderColor = skin.accent, unfocusedBorderColor = Color.Transparent,
            focusedTextColor = skin.ink, unfocusedTextColor = skin.ink, cursorColor = skin.accent),
        modifier = Modifier.fillMaxWidth().heightIn(min = minimum).semantics {
            contentDescription = "$label field"
            problem?.let { error(it) }
        })
}
