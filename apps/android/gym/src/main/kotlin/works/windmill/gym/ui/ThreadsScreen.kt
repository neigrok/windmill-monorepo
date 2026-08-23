package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AskTurn
import works.windmill.gym.domain.ThreadProposal
import works.windmill.gym.domain.Threads
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Not an inbox: no unread count, no badge, no notification, no search and no folders — and a list that
// could not be read is not an empty one.
@Composable
fun ThreadsScreen(
    store: TrainingStore,
    backLabel: String,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    onAskNew: () -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    var threads by remember { mutableStateOf<List<AskThread>?>(null) }
    var outOfReach by remember { mutableStateOf(false) }

    // Read on the way in and held only while the screen stands: an outcome moves when a proposal is.
    LaunchedEffect(Unit) {
        when (val read = store.threads()) {
            is GymResult.Ok -> {
                threads = read.value
                outOfReach = false
            }
            is GymResult.Failed -> outOfReach = true
        }
    }

    val held = threads.orEmpty()
    Column(Modifier.fillMaxSize()) {
        ThreadsHead(
            backLabel = backLabel,
            onBack = onBack,
            title = Threads.title,
            beneath = if (threads == null) null else Threads.counted(held.size),
        )
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WindmillSpace.x4)
                .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x4),
        ) {
            if (outOfReach) {
                Text(Threads.outOfReach, style = GymType.numeral(12), color = GymSkin.inkDim)
            }
            if (threads != null && held.isEmpty() && !outOfReach) {
                Text(
                    Threads.none,
                    style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                    color = GymSkin.inkDim,
                )
            }
            Threads.months(held, nowMs).forEach { month ->
                Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                    month.label?.let {
                        Text(it, style = GymType.numeral(11), color = GymSkin.inkFaint)
                    }
                    month.threads.forEach { thread ->
                        ThreadRow(thread, nowMs) { onOpen(thread.id) }
                    }
                }
            }
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = WindmillSpace.x4)
                .padding(bottom = WindmillSpace.x4)
                .heightIn(min = GymTap.primary)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable(onClick = onAskNew),
        ) {
            Text(Threads.open, style = WindmillFont.body(16, FontWeight.Bold), color = GymSkin.onAccent)
        }
    }
}

// A row whose outcome this build cannot name draws the title alone.
@Composable
private fun ThreadRow(thread: AskThread, nowMs: Long, onOpen: () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WindmillRadius.lg))
            .background(GymSkin.surface)
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .clickable(onClick = onOpen)
            .padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x3),
    ) {
        // VERBATIM: nothing trims for meaning, sentence-cases or adds a full stop.
        Text(
            thread.title,
            style = WindmillFont.body(15, FontWeight.SemiBold).copy(lineHeight = 21.sp),
            color = GymSkin.ink,
            maxLines = 2,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier.fillMaxWidth(),
        ) {
            thread.outcome.label?.let { OutcomeChip(it, applied = thread.outcome.moved) }
            thread.outcome.detail?.let { detail ->
                Text(detail, style = GymType.numeral(11), color = GymSkin.inkDim, maxLines = 1)
            }
            Spacer(Modifier.weight(1f))
            thread.day(nowMs)?.let {
                Text(it, style = GymType.numeral(11), color = GymSkin.inkFaint, maxLines = 1)
            }
        }
    }
}

@Composable
private fun OutcomeChip(label: String, applied: Boolean) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .clip(RoundedCornerShape(WindmillRadius.full))
            .background(if (applied) GymSkin.accentSoft else GymSkin.raised)
            .padding(horizontal = WindmillSpace.x2, vertical = 3.dp),
    ) {
        Text(
            label.uppercase(),
            style = GymType.numeral(10, FontWeight.Bold),
            color = if (applied) GymSkin.accent else GymSkin.inkDim,
            maxLines = 1,
        )
    }
}

// READ-ONLY: there is no composer, because a thread is titled by its first message.
@Composable
fun ThreadScreen(
    threadId: String,
    store: TrainingStore,
    backLabel: String,
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    onReview: (ThreadProposal) -> Unit,
    say: (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    var thread by remember(threadId) { mutableStateOf<AskThread?>(null) }
    var deleting by remember(threadId) { mutableStateOf(false) }

    LaunchedEffect(threadId) {
        when (val read = store.thread(threadId)) {
            is GymResult.Ok -> thread = read.value
            // A thread that could not be read and one with nothing in it are two different evenings.
            is GymResult.Failed -> say(read.why.line("that conversation didn’t open"))
        }
    }

    val held = thread
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = WindmillSpace.x8),
    ) {
        ThreadsHead(
            backLabel = backLabel,
            onBack = onBack,
            title = held?.title ?: Threads.title,
            beneath = held?.outcome?.detail,
        )
        if (held == null) return@Column
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
        ) {
            Text(Threads.past, style = GymType.numeral(12), color = GymSkin.inkFaint)
            held.turns.forEach { turn -> Turn(turn) }
            held.proposals.forEach { proposal ->
                Minted(proposal, nowMs) { onReview(proposal) }
            }
            Text(Threads.deleteRule, style = GymType.numeral(11).copy(lineHeight = 17.sp), color = GymSkin.inkFaint)
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.lg))
                    .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(enabled = !deleting) {
                        // The screen only leaves once the log says the conversation is gone.
                        scope.launch {
                            if (deleting) return@launch
                            deleting = true
                            try {
                                say(null)
                                when (val gone = store.deleteThread(held.id)) {
                                    is GymResult.Ok -> onDeleted()
                                    is GymResult.Failed ->
                                        say(gone.why.line("that conversation is still here"))
                                }
                            } finally {
                                deleting = false
                            }
                        }
                    },
            ) {
                Text(
                    Threads.deletes,
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = GymSkin.inkDim,
                )
            }
        }
    }
}

@Composable
private fun Turn(turn: AskTurn) {
    if (!turn.fromLifter) {
        Text(
            turn.text,
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.ink,
            modifier = Modifier.fillMaxWidth(),
        )
        return
    }
    val bubble = RoundedCornerShape(17.dp, 17.dp, 6.dp, 17.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Spacer(Modifier.weight(0.2f))
        Text(
            turn.text,
            style = WindmillFont.body(15).copy(lineHeight = 22.sp),
            color = GymSkin.ink,
            modifier = Modifier
                .weight(0.8f, fill = false)
                .background(GymSkin.accentSoft, bubble)
                .border(1.dp, GymSkin.accent, bubble)
                .padding(horizontal = WindmillSpace.x3 + 2.dp, vertical = WindmillSpace.x3),
        )
    }
}

@Composable
private fun Minted(proposal: ThreadProposal, nowMs: Long, onReview: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(GymSkin.raised)
            .clickable(onClick = onReview)
            .padding(horizontal = WindmillSpace.x3, vertical = WindmillSpace.x2),
    ) {
        Text(
            proposal.line(nowMs),
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkDim,
            modifier = Modifier.weight(1f),
        )
        Text("›", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
    }
}

@Composable
private fun ThreadsHead(backLabel: String, onBack: () -> Unit, title: String, beneath: String?) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.padding(bottom = WindmillSpace.x2),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            modifier = Modifier
                .heightIn(min = GymTap.minimum)
                .padding(horizontal = WindmillSpace.x4)
                .clickable(onClick = onBack),
        ) {
            Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text(backLabel, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
        }
        Column(
            verticalArrangement = Arrangement.spacedBy(1.dp),
            modifier = Modifier.padding(horizontal = WindmillSpace.x4),
        ) {
            Text(title, style = WindmillFont.display(22), color = GymSkin.ink, maxLines = 3)
            beneath?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkFaint, maxLines = 1) }
        }
    }
}
