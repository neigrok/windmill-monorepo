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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
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
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AskTurn
import works.windmill.gym.domain.Proposal
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
    backTo: String,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
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

    // A conversation inside its undo window is off the list and nothing has been sent.
    val held = threads.orEmpty().filterNot { it.id in store.withheldIds }
    GymScreen(title = Threads.title, onBack = onBack, backTo = backTo) {
        Column(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(
                    start = WindmillSpace.x4,
                    end = WindmillSpace.x4,
                    bottom = WindmillSpace.x4,
                ),
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            ) {
                if (threads != null) {
                    item("counted") {
                        Text(
                            Threads.counted(held.size),
                            style = GymType.numeral(12),
                            color = GymSkin.inkFaint,
                            maxLines = 1,
                        )
                    }
                }
                if (outOfReach) {
                    item("outOfReach") {
                        Text(Threads.outOfReach, style = GymType.numeral(12), color = GymSkin.inkDim)
                    }
                }
                if (threads != null && held.isEmpty() && !outOfReach) {
                    item("none") {
                        Text(
                            Threads.none,
                            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                            color = GymSkin.inkDim,
                        )
                    }
                }
                Threads.months(held, nowMs).forEach { month ->
                    month.label?.let { label ->
                        item("month:$label") {
                            Text(
                                label,
                                style = GymType.numeral(11),
                                color = GymSkin.inkFaint,
                                modifier = Modifier.padding(top = WindmillSpace.x2),
                            )
                        }
                    }
                    items(month.threads, key = { it.id }) { thread ->
                        SwipeableThreadRow(
                            thread = thread,
                            nowMs = nowMs,
                            onOpen = { onOpen(thread.id) },
                            onDelete = { onDelete(thread.id) },
                        )
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
                    .clickable(role = Role.Button, onClick = onAskNew),
            ) {
                Text(Threads.open, style = WindmillFont.body(16, FontWeight.Bold), color = GymSkin.onAccent)
            }
        }
    }
}

// Trailing swipe, one action, and it is Delete. LAW 1, the Android half: TalkBack sees a drag, and
// this row carries no overflow to inherit a real button from, so the action is declared again BY
// HAND beside it.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableThreadRow(
    thread: AskThread,
    nowMs: Long,
    onOpen: () -> Unit,
    onDelete: () -> Unit,
) {
    val haptics = rememberGymHaptics()
    // A row put back by a refusal or an Undo arrives with no act owed: `rememberRowDismiss` spends
    // the delete only on a value this composition watched change.
    val swipe = rememberRowDismiss(settling = { it == SwipeToDismissBoxValue.EndToStart }) {
        haptics.revealed()
        onDelete()
    }
    SwipeToDismissBox(
        state = swipe,
        enableDismissFromStartToEnd = false,
        backgroundContent = { RowDeleteGround() },
        modifier = Modifier.semantics {
            customActions = listOf(CustomAccessibilityAction("Delete") { onDelete(); true })
        },
    ) {
        ThreadRow(thread, nowMs, onOpen)
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
            .clickable(role = Role.Button, onClickLabel = "open this conversation", onClick = onOpen)
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
    // Ephemeral lines from the server's apply reply, alive only while this screen stands.
    receipts: List<String>,
    lookedAt: Set<String>,
    backTo: String,
    onBack: () -> Unit,
    onReview: (ThreadProposal) -> Unit,
    say: (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    var thread by remember(threadId) { mutableStateOf<AskThread?>(null) }
    // The proposals' own rows, read after the thread: the card carries the model's prose, which the
    // thread's line does not. A read that missed leaves the counted fallback standing.
    var minted by remember(threadId) { mutableStateOf<Map<String, Proposal>>(emptyMap()) }

    // Read on the way in, and again when a receipt lands: the rows' states and the outcome are the
    // server's, so a decision taken here is read back rather than crossed in by this screen.
    LaunchedEffect(threadId, receipts) {
        when (val read = store.thread(threadId)) {
            is GymResult.Ok -> {
                thread = read.value
                minted = read.value.proposals.mapNotNull { row ->
                    (store.proposal(row.id) as? GymResult.Ok)?.value?.let { row.id to it }
                }.toMap()
            }
            // A thread that could not be read and one with nothing in it are two different evenings;
            // a re-read that missed leaves what is held.
            is GymResult.Failed -> if (thread == null) say(read.why.line("that conversation didn’t open"))
        }
    }

    val held = thread
    // VERBATIM in the bar as it is in the list: a conversation's title is the lifter's first message.
    GymScreen(title = held?.title ?: Threads.title, onBack = onBack, backTo = backTo) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WindmillSpace.x4)
                .padding(bottom = WindmillSpace.x8),
        ) {
            if (held == null) return@Column
            held.outcome.detail?.let {
                Text(it, style = GymType.numeral(12), color = GymSkin.inkFaint, maxLines = 1)
            }
            Text(Threads.past, style = GymType.numeral(12), color = GymSkin.inkFaint)
            held.turns.forEach { turn -> Turn(turn) }
            held.proposals.forEach { proposal ->
                Minted(proposal, minted[proposal.id], nowMs, stillWaiting = proposal.id in lookedAt) { onReview(proposal) }
            }
            receipts.forEach { ReceiptLine(it) }
            // The delete and everything said about it are off this screen: the list's own row carries
            // the swipe and the overflow-free custom action, and what the delete keeps is said by the
            // room's transient at the moment of the act — where somebody is actually standing.
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

// The card, as the Coach room draws it: the summary, the counted line dated by when the proposal was
// written, and one affordance, Review. Nothing on it decides anything.
@Composable
private fun Minted(
    proposal: ThreadProposal,
    read: Proposal?,
    nowMs: Long,
    stillWaiting: Boolean,
    onReview: () -> Unit,
) {
    val routineName = proposal.routine.ifBlank { read?.routineName ?: "this routine" }
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(GymSkin.accent))
            Spacer(Modifier.size(WindmillSpace.x2))
            Text(
                "Proposal · $routineName",
                style = GymType.numeral(11, FontWeight.Bold),
                color = GymSkin.accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            read?.summaryLine(routineName) ?: proposal.summaryLine,
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = GymSkin.ink,
        )
        Text(
            proposal.line(nowMs, stillWaiting),
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkDim,
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.md))
                .clickable(role = Role.Button, onClick = onReview),
        ) {
            Text(Proposal.review, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.onAccent)
        }
    }
}
