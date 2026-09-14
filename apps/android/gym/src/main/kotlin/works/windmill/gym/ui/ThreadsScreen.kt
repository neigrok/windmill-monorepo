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
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.mutableIntStateOf
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
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AskTurn
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ThreadProposal
import works.windmill.gym.domain.Threads
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.ProposalRead
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Not an inbox: no unread count, no badge, no notification, no search and no folders — and a list that
// could not be read is not an empty one.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadsScreen(
    store: TrainingStore,
    backTo: String,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
    onAskNew: () -> Unit,
) {
    val skin = LocalGymColors.current
    val nowMs = System.currentTimeMillis()
    var read by remember { mutableStateOf(false) }
    var outOfReach by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }

    // Read on the way in, into the STORE: an outcome moves when a proposal does, and a list this
    // screen held itself would draw a deleted conversation back the moment its window settled.
    LaunchedEffect(store.accountKey, attempt) {
        loading = true
        read = false
        outOfReach = false
        when (store.readThreads()) {
            is GymResult.Ok -> {
                read = true
                outOfReach = false
            }
            is GymResult.Failed -> outOfReach = true
        }
        loading = false
    }

    // A conversation inside its undo window is off the list and nothing has been sent. The STANCE
    // below reads the account and these rows read the window: an account holding one conversation the
    // window has taken off the screen is not an account with none.
    //
    // Drawn only off a read THIS entry landed, because an outcome the server derives goes stale the
    // moment a proposal is decided elsewhere — a list nobody re-read would say `waiting` days after
    // somebody applied it, and saying that under `out of reach` claims more than a failed read
    // allows. `read` is the read's own status and not a window, so the stance is untouched.
    val held = if (read) store.threads else emptyList()
    GymScreen(title = Threads.title, onBack = onBack, backTo = backTo) {
        Column(Modifier.fillMaxSize()) {
            PullToRefreshBox(isRefreshing = loading, onRefresh = { attempt++ }, modifier = Modifier.weight(1f)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = GymLayout.gutter,
                    end = GymLayout.gutter,
                    top = GymLayout.contentTop,
                    bottom = GymLayout.scrollTailBand,
                ),
                verticalArrangement = Arrangement.spacedBy(GymLayout.cardGap),
            ) {
                // The count captions the rows below it, so it is drawn where there are rows. Between
                // the two stances — rows held by a window over an account that still has them — the
                // room draws neither line.
                if (held.isNotEmpty()) {
                    item("counted") {
                        Text(
                            "Your conversations",
                            style = WindmillFont.body(14).copy(lineHeight = 20.sp),
                            color = skin.inkDim,
                        )
                    }
                }
                if (outOfReach) {
                    item("outOfReach") {
                        Text(Threads.outOfReach, style = GymType.numeral(12), color = skin.inkDim)
                    }
                }
                if (read && store.allThreads.isEmpty() && !outOfReach) {
                    item("none") {
                        Text(
                            Threads.none,
                            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                            color = skin.inkDim,
                        )
                    }
                }
                items(held, key = { it.id }) { thread ->
                    SwipeableThreadRow(thread, nowMs, { onOpen(thread.id) }, { onDelete(thread.id) })
                }
            }
            }
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = GymLayout.gutter)
                    .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3)
                    .heightIn(min = GymTap.primary)
                    .background(skin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(role = Role.Button, onClick = onAskNew),
            ) {
                Text(Threads.open, style = WindmillFont.body(16, FontWeight.Bold), color = skin.onAccent)
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
    val skin = LocalGymColors.current
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 70.dp).background(skin.canvas)
            .clickable(role = Role.Button, onClickLabel = "Open conversation", onClick = onOpen).padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(thread.title, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
            val outcome = if (thread.outcome.kind == works.windmill.gym.domain.ThreadOutcome.readOnly) "Read only"
                else thread.outcome.detail?.replaceFirstChar { it.uppercase() }
            val metadata = listOfNotNull(thread.day(nowMs), outcome).joinToString(" · ")
            if (metadata.isNotEmpty()) Text(metadata, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        }
        Chevron()
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
    onAskNew: () -> Unit = onBack,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    var thread by remember(threadId) { mutableStateOf<AskThread?>(null) }
    var failure by remember(threadId) { mutableStateOf<String?>(null) }
    var attempt by remember(threadId) { mutableStateOf(0) }
    // Failed reads keep the counted fallback; confirmed missing proposals have no review action.
    var proposals by remember(threadId) { mutableStateOf<Map<String, ProposalRead>>(emptyMap()) }

    // Read on the way in, and again when a receipt lands: the rows' states and the outcome are the
    // server's, so a decision taken here is read back rather than crossed in by this screen.
    LaunchedEffect(threadId, receipts, attempt) {
        failure = null
        when (val read = store.thread(threadId)) {
            is GymResult.Ok -> {
                thread = read.value
                val ids = (read.value.proposals.map { it.id } +
                    read.value.turns.flatMap { it.receipt?.takeIf { receipt -> receipt.supported }?.proposals.orEmpty() }).distinct()
                proposals = ids.associateWith { store.proposal(it) }
            }
            // A thread that could not be read and one with nothing in it are two different evenings;
            // a re-read that missed leaves what is held.
            is GymResult.Failed -> failure = read.why.line("that conversation didn’t open")
        }
    }

    val held = thread
    // VERBATIM in the bar as it is in the list: a conversation's title is the lifter's first message.
    GymScreen(title = Threads.conversation, onBack = onBack, backTo = backTo) {
        Column(Modifier.fillMaxSize()) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = GymLayout.gutter)
                .padding(top = GymLayout.contentTop, bottom = GymLayout.scrollTail),
        ) {
            failure?.let { line ->
                Text(line, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                CoachAction("Try again", onClick = { attempt += 1 })
            }
            if (held == null) {
                if (failure == null) Text("Reading conversation…", style = WindmillFont.body(14), color = skin.inkDim)
                return@Column
            }
            Text(Threads.past, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            held.turns.forEach { turn ->
                if (turn.fromLifter) CoachQuestion(turn.text)
                else CoachAnswer(turn.text, turn.receipt, store.catalog, nowMs)
            }
            (held.proposals.map { it.id } + proposals.keys).distinct().forEach { id ->
                val header = held.proposals.firstOrNull { it.id == id }
                when (val read = proposals[id]) {
                    is ProposalRead.Found -> {
                        val row = header ?: read.proposal.let {
                            ThreadProposal(it.id, it.state, it.changeCount, it.routineId, it.routineName, it.createdAtMs)
                        }
                        Minted(row, read.proposal, nowMs, stillWaiting = id in lookedAt) { onReview(row) }
                    }
                    ProposalRead.Gone -> Text(ProposalRead.Gone.line,
                        style = WindmillFont.body(15).copy(lineHeight = 22.sp), color = skin.inkDim)
                    is ProposalRead.Failed -> {
                        if (header != null) Minted(header, null, nowMs, stillWaiting = id in lookedAt) { onReview(header) }
                        else {
                            Text(read.why.line("the proposal wasn’t read"),
                                style = WindmillFont.body(15).copy(lineHeight = 22.sp), color = skin.inkDim)
                            CoachAction("Try again", onClick = { attempt += 1 })
                        }
                    }
                    null -> header?.let { Minted(it, null, nowMs, stillWaiting = id in lookedAt) { onReview(it) } }
                }
            }
            val shown = proposals.values.mapNotNull { (it as? ProposalRead.Found)?.proposal?.receipt }.toSet()
            receipts.filterNot { it in shown }.forEach { ReceiptLine(it) }
            // The delete and everything said about it are off this screen: the list's own row carries
            // the swipe and the overflow-free custom action, and what the delete keeps is said by the
            // room's transient at the moment of the act — where somebody is actually standing.
        }
        CoachAction(Threads.open, onAskNew, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
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
    val skin = LocalGymColors.current
    val routineName = proposal.routine.ifBlank { read?.routineName ?: "this routine" }
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        CoachProposalCard(routineName, read?.summaryLine(routineName) ?: proposal.summaryLine,
            proposal.counted + if (stillWaiting && proposal.state == works.windmill.gym.domain.ProposalState.Pending) " · ${Proposal.stillWaiting}" else "", onReview)
        if (read?.isPending ?: (proposal.state == works.windmill.gym.domain.ProposalState.Pending)) {
            Text(Ask.promise, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        }
        read?.receipt?.let { ReceiptLine(it) }
    }
}
