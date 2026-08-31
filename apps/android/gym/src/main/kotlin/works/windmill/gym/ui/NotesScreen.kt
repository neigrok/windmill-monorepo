package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Notes
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// What the lifter writes for Coach, in precedence order. The head says the one surprising thing —
// every connected agent reads these — and nothing else. Account-only: read on the way in, nothing
// on this phone's disk, and the ceiling is said where it bites rather than in a caption. The list
// itself belongs to the STORE, so a delete inside its window drops the row and the cap together
// when the clock fires.
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
    val scope = rememberCoroutineScope()
    // The STORE owns the notebook, so a delete that settles takes the row and the cap with it. This
    // screen keeps one thing of its own: the order under the finger, which is nobody's until the
    // finger lifts and the log takes it.
    var dragOrder by remember { mutableStateOf<List<Note>?>(null) }
    // Whether the read on the way in landed. An empty notebook is not the same fact as an unread one.
    var read by remember { mutableStateOf(false) }
    // A list that could not be read is not an empty one: the screen says so in place, in the log's
    // words where it has them.
    var outOfReach by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(isSignedIn) {
        if (!isSignedIn) return@LaunchedEffect
        when (val served = store.readNotes()) {
            is GymResult.Ok -> {
                read = true
                outOfReach = null
            }
            is GymResult.Failed -> outOfReach = served.why.line("your notes are out of reach")
        }
    }

    // The order is the lifter's instruction: it lands on the log before it is believed here, and a
    // refusal drops back to whatever the log last said — never to what the drag had already drawn.
    // What goes over is the DRAWN order; a note inside its window is named back into it by the
    // store, which is where the standing list lives.
    fun reorder(order: List<Note>) {
        dragOrder = order
        scope.launch {
            say(null)
            try {
                val written = store.reorderNotes(order.map { it.id })
                if (written is GymResult.Failed) say(written.why.line("the order stayed as it was"))
            } finally {
                dragOrder = null
            }
        }
    }

    GymScreen(title = Notes.title, onBack = onBack, backTo = backTo) {
      Column(Modifier.fillMaxSize()) {
        Column(
            verticalArrangement = Arrangement.spacedBy(2.dp),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = WindmillSpace.x4)
                .padding(bottom = WindmillSpace.x4),
        ) {
            Text(Notes.honesty, style = WindmillFont.display(22), color = GymSkin.ink)
            Text(Notes.sub, style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
        if (!isSignedIn) {
            SignedOut(onSignIn)
            return@Column
        }
        outOfReach?.let {
            Text(
                it,
                style = GymType.numeral(12).copy(lineHeight = 18.sp),
                color = GymSkin.inkDim,
                modifier = Modifier.padding(horizontal = WindmillSpace.x4),
            )
        }
        if (!read) return@Column
        // A note inside its undo window is off the list; the CAP still counts it, because the store
        // will refuse the eleventh whether or not this screen is drawing the tenth.
        val held = dragOrder ?: store.notes
        if (store.noteCount == 0) {
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                modifier = Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
            ) {
                Notes.placeholders.forEach { title ->
                    PlaceholderRow(title) { onEdit(null, title) }
                }
                AddRow(count = store.noteCount) { onEdit(null, "") }
            }
            return@Column
        }
        NoteList(
            notes = held,
            onOpen = { onEdit(it, "") },
            onMove = { dragOrder = it },
            onSettle = ::reorder,
        ) {
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
                modifier = Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
            ) {
                // With the second note there is an order to explain; one note has none.
                if (held.size > 1) Text(Notes.topWins, style = GymType.numeral(12), color = GymSkin.inkFaint)
                AddRow(count = store.noteCount) { onEdit(null, "") }
            }
        }
      }
    }
}

@Composable
private fun SignedOut(onSignIn: () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
    ) {
        Text(
            Notes.signedOut,
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = GymSkin.inkFaint,
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable(role = Role.Button, onClick = onSignIn),
        ) {
            Text("Sign in", style = WindmillFont.body(16, FontWeight.Bold), color = GymSkin.onAccent)
        }
    }
}

// Placeholder text inside an empty row, never a stored note: nothing is written until the lifter
// saves.
@Composable
private fun PlaceholderRow(title: String, onOpen: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum + 6.dp)
            .dashedEdge(GymSkin.lineStrong, WindmillRadius.lg)
            .clip(RoundedCornerShape(WindmillRadius.lg))
            .clickable(role = Role.Button, onClickLabel = "write this note", onClick = onOpen)
            .padding(horizontal = WindmillSpace.x4),
    ) {
        Text(title, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
        Spacer(Modifier.weight(1f))
        Chevron()
    }
}

// At ten the row stops offering and says so, in the body face: a sentence with a number in it.
@Composable
private fun AddRow(count: Int, onAdd: () -> Unit) {
    if (count >= Notes.maxNotes) {
        Text(
            Notes.full,
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = GymSkin.inkDim,
            modifier = Modifier.fillMaxWidth().padding(vertical = WindmillSpace.x3),
        )
        return
    }
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.primary - 8.dp)
            .dashedEdge(GymSkin.lineStrong, WindmillRadius.md)
            .clickable(role = Role.Button, onClick = onAdd),
        contentAlignment = Alignment.Center,
    ) {
        Text(Notes.add, style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
    }
}

// The same drag the session assembly uses: one step at a time, past a neighbour's midpoint, moved on
// screen at once (`onMove`) and handed to the log when the finger lifts (`onSettle`). The gesture
// keeps its own copy of the order: a finger that lifts before the last move has recomposed still
// settles what it moved. Every row also offers Move up / Move down as custom actions, so a screen
// reader can change precedence without the drag.
@Composable
private fun NoteList(
    notes: List<Note>,
    onOpen: (Note) -> Unit,
    onMove: (List<Note>) -> Unit,
    onSettle: (List<Note>) -> Unit,
    foot: @Composable () -> Unit,
) {
    val listState = rememberLazyListState()
    val standing by rememberUpdatedState(notes)
    // The handle appears with the second note, beside the caption that says what dragging decides.
    val handles = notes.size > 1
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        contentPadding = PaddingValues(bottom = WindmillSpace.x6),
    ) {
        itemsIndexed(notes, key = { _, note -> note.id }) { index, note ->
            val held = dragging == note.id
            val steps = buildList {
                if (index > 0) add(CustomAccessibilityAction("Move up") {
                    onSettle(Notes.moved(standing, index, index - 1))
                    true
                })
                if (index < notes.lastIndex) add(CustomAccessibilityAction("Move down") {
                    onSettle(Notes.moved(standing, index, index + 1))
                    true
                })
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                modifier = Modifier
                    .fillMaxWidth()
                    .zIndex(if (held) 1f else 0f)
                    .graphicsLayer { translationY = if (held) dragOffset else 0f }
                    .clip(RoundedCornerShape(WindmillRadius.lg))
                    .background(GymSkin.surface)
                    .border(1.dp, if (held) GymSkin.accent else GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(role = Role.Button, onClickLabel = "open this note") { onOpen(note) }
                    .semantics { customActions = steps }
                    .padding(start = if (handles) 0.dp else WindmillSpace.x4, end = WindmillSpace.x4)
                    .padding(vertical = WindmillSpace.x2),
            ) {
                if (handles) GrabRail(
                    lit = held,
                    modifier = Modifier.pointerInput(note.id) {
                        var order = standing
                        var moved = false
                        detectDragGesturesAfterLongPress(
                            onDragStart = {
                                dragging = note.id
                                dragOffset = 0f
                                order = standing
                                moved = false
                            },
                            onDragEnd = {
                                dragging = null
                                dragOffset = 0f
                                if (moved) onSettle(order)
                            },
                            onDragCancel = {
                                dragging = null
                                dragOffset = 0f
                                if (moved) onSettle(order)
                            },
                            onDrag = { change, amount ->
                                change.consume()
                                dragOffset += amount.y
                                val from = order.indexOfFirst { it.id == note.id }
                                val visible = listState.layoutInfo.visibleItemsInfo
                                val card = visible.firstOrNull { it.index == from }
                                    ?: return@detectDragGesturesAfterLongPress
                                val centre = card.offset + card.size / 2f + dragOffset
                                val above = visible.firstOrNull { it.index == from - 1 }
                                val below = visible.firstOrNull { it.index == from + 1 }
                                val over = when {
                                    above != null && centre < above.offset + above.size / 2f -> above
                                    below != null && centre > below.offset + below.size / 2f -> below
                                    else -> return@detectDragGesturesAfterLongPress
                                }
                                moved = true
                                order = Notes.moved(order, from, over.index)
                                onMove(order)
                                val landed = if (over.index < from) over.offset
                                    else over.offset + over.size - card.size
                                dragOffset += (card.offset - landed)
                            },
                        )
                    },
                )
                Column(
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        note.title,
                        style = WindmillFont.body(15, FontWeight.SemiBold),
                        color = GymSkin.ink,
                        maxLines = 1,
                    )
                    note.firstLine?.let {
                        Text(it, style = GymType.numeral(12), color = GymSkin.inkFaint, maxLines = 1)
                    }
                }
                Chevron()
            }
        }
        item { foot() }
    }
}

// A title and a body, stored verbatim. The id is minted once per editor so a save whose reply was
// lost replays as the same note; a refusal — the ten cap, the two bounds — shows in the log's words.
// Delete asks nothing: the editor closes and the room's window holds the note for nine seconds with
// Undo on the transient, which is the same way back every other delete in this room takes.
@Composable
fun NoteEditorScreen(
    note: Note?,
    seedTitle: String,
    store: TrainingStore,
    backTo: String,
    onBack: () -> Unit,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val id = rememberSaveable { note?.id ?: Ids.note() }
    var title by rememberSaveable { mutableStateOf(note?.title ?: seedTitle) }
    var body by rememberSaveable { mutableStateOf(note?.body ?: "") }
    var saving by remember { mutableStateOf(false) }
    var said by remember { mutableStateOf<String?>(null) }

    fun save() {
        scope.launch {
            if (saving) return@launch
            saving = true
            try {
                said = null
                when (val written = store.saveNote(id, NoteWrite(title.trim(), body.trim()))) {
                    is GymResult.Ok -> onDone()
                    is GymResult.Failed -> said = written.why.line("the note stayed as it was")
                }
            } finally {
                saving = false
            }
        }
    }

    GymScreen(
        title = if (note == null) "New note" else "Note",
        onBack = onBack,
        backTo = backTo,
    ) {
      Column(
        Modifier
            .fillMaxSize()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(bottom = WindmillSpace.x8),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
      ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
        ) {
            Field(
                value = title,
                onChange = { title = it },
                placeholder = Notes.titlePlaceholder,
                style = WindmillFont.body(17, FontWeight.SemiBold),
                singleLine = true,
                enabled = !saving,
            )
            // Chrome only in the last fifth, and alarm past the bound; Save stays tappable and the
            // log's sentence refuses in place.
            Notes.titleCounter(title)?.let {
                Text(
                    it,
                    style = GymType.numeral(12),
                    color = if (Notes.titleOver(title)) GymSkin.alarmInk else GymSkin.inkFaint,
                )
            }
            Field(
                value = body,
                onChange = { body = it },
                placeholder = Notes.bodyPlaceholder,
                style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                singleLine = false,
                enabled = !saving,
                minHeight = 160.dp,
            )
            Notes.counter(body)?.let {
                Text(
                    it,
                    style = GymType.numeral(12),
                    color = if (Notes.over(body)) GymSkin.alarmInk else GymSkin.inkFaint,
                )
            }
            said?.let {
                Text(it, style = WindmillFont.body(14).copy(lineHeight = 21.sp), color = GymSkin.inkDim)
            }
            val ready = Notes.savable(title) && !saving
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary)
                    .alpha(if (ready) 1f else 0.4f)
                    .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(enabled = ready, role = Role.Button) { save() },
            ) {
                Text(Notes.save, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
            }
            if (note != null) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = GymTap.minimum + 6.dp)
                        .clickable(enabled = !saving, role = Role.Button) {
                            // Nothing is sent: the window holds it and the editor leaves at once, so
                            // the Undo is on the room's transient rather than behind this screen.
                            store.withhold(Deletion.Note(note.id))
                            onDone()
                        },
                ) {
                    Text(Notes.delete, style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.alarmInk)
                }
            }
        }
      }
    }
}

@Composable
private fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    style: androidx.compose.ui.text.TextStyle,
    singleLine: Boolean,
    enabled: Boolean,
    minHeight: androidx.compose.ui.unit.Dp = 54.dp,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        textStyle = style,
        singleLine = singleLine,
        enabled = enabled,
        placeholder = { Text(placeholder, style = style) },
        shape = RoundedCornerShape(WindmillRadius.lg),
        colors = gymFieldColours(),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = minHeight),
    )
}
