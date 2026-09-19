package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.CoachDraft
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.ThreadProposal
import works.windmill.gym.domain.Threads
import works.windmill.gym.store.AskOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace
import kotlinx.coroutines.launch

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
    val scope = rememberCoroutineScope()

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
                store.nextThreadCursor?.let { cursor -> item("older") {
                    CoachAction(if (loading) "Reading conversations…" else "Earlier conversations", enabled = !loading, onClick = {
                        loading = true
                        scope.launch {
                            outOfReach = store.readThreads(cursor) is GymResult.Failed
                            loading = false
                        }
                    })
                } }
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
            val outcome = thread.outcome.detail?.replaceFirstChar { it.uppercase() }
            val metadata = listOfNotNull(thread.day(nowMs), outcome).joinToString(" · ")
            if (metadata.isNotEmpty()) Text(metadata, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        }
        Chevron()
    }
}

@Composable
fun ThreadScreen(
    threadId: String,
    store: TrainingStore,
    receipts: List<String>,
    lookedAt: Set<String>,
    backTo: String,
    onBack: () -> Unit,
    onReview: (ThreadProposal) -> Unit,
    say: (String?) -> Unit,
    onAskNew: () -> Unit = onBack,
    origin: String = "https://windmill.works",
    onThreads: () -> Unit = onBack,
    onNotes: () -> Unit = {},
    onConnections: (() -> Unit)? = null,
    onOpenRoutine: ((String) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    var history by remember(threadId, store.accountKey) { mutableStateOf<AskThread?>(null) }
    var conversation by remember(threadId, store.accountKey) { mutableStateOf(emptyList<AskExchange>()) }
    var failure by remember(threadId, store.accountKey) { mutableStateOf<String?>(null) }
    var attempt by remember(threadId) { mutableIntStateOf(0) }
    var asking by remember(threadId) { mutableStateOf(false) }
    var olderBusy by remember(threadId) { mutableStateOf(false) }
    var cap by remember(threadId) { mutableStateOf<AskCap?>(null) }

    var coachJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    var upload by remember { mutableStateOf<Float?>(null) }
    var stopPending by remember { mutableStateOf(false) }
    fun ask(question: String, requestId: String = Ids.thread(), retry: Boolean = false, photo: CoachAttachment? = null) {
        if (asking) return
        val owner = store.accountKey
        val previous = if (retry) conversation.dropLast(1) else conversation
        cap = null
        val last = conversation.lastOrNull()?.takeIf { it.requestId == requestId }
        val attachments = last?.attachments.orEmpty().ifEmpty { listOfNotNull(photo) }
        val pending = AskExchange(question, requestId = requestId, generation = last?.generation, attachments = attachments)
        try { store.saveCoachDraft(threadId, CoachDraft(question, attachments.firstOrNull())) }
        catch (_: Exception) { say("Your message couldn’t be saved. Try again."); return }
        asking = true
        upload = if (attachments.isNotEmpty() && last?.generation == null) 0f else null
        conversation = previous + pending
        coachJob = scope.launch {
            try {
                val outcome = store.ask(threadId, question, requestId, attachments.firstOrNull(), stream = true,
                    onSnapshot = { snapshot ->
                        if (store.accountKey == owner) {
                            conversation = previous + snapshot.exchange().copy(attachments = snapshot.attachments.ifEmpty { attachments })
                            store.saveCoachDraft(threadId, CoachDraft())
                        }
                    }, onUpload = { upload = it })
                if (store.accountKey != owner) return@launch
                conversation = previous + outcome.exchange(pending)
                if (outcome is AskOutcome.Capped) cap = outcome.cap
                if (outcome is AskOutcome.Answered) store.saveCoachDraft(threadId, CoachDraft())
            } finally { if (store.accountKey == owner) { asking = false; upload = null; stopPending = false } }
        }
    }

    fun stop() {
        if (stopPending) return
        val last = conversation.lastOrNull() ?: return
        if (upload != null) {
            coachJob?.cancel()
            conversation = conversation.dropLast(1) + last.copy(trouble = "Upload cancelled. Retry to send this photo.", again = true)
            return
        }
        val owner = store.accountKey
        stopPending = true
        scope.launch {
            try {
                val snapshot = store.stopAsk(threadId, last.requestId)
                if (store.accountKey == owner) {
                    conversation = conversation.dropLast(1) + snapshot.exchange()
                    if (snapshot.terminal) { store.saveCoachDraft(threadId, CoachDraft()); coachJob?.cancel(); asking = false }
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { say("The stop request didn’t reach Coach. Try again.") }
            finally { stopPending = false }
        }
    }

    LaunchedEffect(threadId, store.accountKey, attempt) {
        failure = null
        when (val read = store.thread(threadId)) {
            is GymResult.Ok -> {
                history = read.value
                conversation = read.value.exchanges()
                val pending = store.pendingQuestions().firstOrNull { it.thread == threadId }
                if (pending != null && read.value.generation?.requestId != pending.requestId) {
                    conversation = conversation + store.pendingExchange(pending)
                }
                read.value.generation?.takeIf { it.status == "running" }?.let { ask(it.question, it.requestId, retry = true) }
            }
            is GymResult.Failed -> failure = read.why.line("that conversation didn’t open")
        }
    }

    if (history == null) {
        GymScreen(title = Threads.conversation, onBack = onBack, backTo = backTo) {
            Column(Modifier.padding(GymLayout.gutter)) {
                Text(failure ?: "Reading conversation…", color = LocalGymColors.current.inkDim)
                if (failure != null) CoachAction("Try again", { attempt++ })
            }
        }
        return
    }
    AskScreen(
        store = store, thread = conversation, conversationId = threadId,
        receipts = receipts, lookedAt = lookedAt, asking = asking, cap = cap,
        onAsk = { ask(it) }, onPhotoAsk = { text, photo -> ask(text, photo = photo) }, onStop = ::stop, upload = upload,
        onRetry = { conversation.lastOrNull()?.let { ask(it.question, it.requestId.ifEmpty { Ids.thread() }, retry = true, photo = it.attachments.firstOrNull()) } },
        onAskNew = onAskNew, seed = "", origin = origin, backTo = backTo, onBack = onBack,
        onThreads = onThreads, onNotes = onNotes, onConnections = onConnections, onOpenRoutine = onOpenRoutine,
        onReview = { onReview(ThreadProposal(it.id, it.state, it.changeCount, it.routineId, it.routineName, it.createdAtMs)) },
        onOlder = history?.nextCursor?.let { cursor -> {
            if (!olderBusy) {
                olderBusy = true
                scope.launch {
                    when (val read = store.thread(threadId, cursor)) {
                        is GymResult.Ok -> {
                            val old = requireNotNull(history)
                            val page = old.copy(turns = (read.value.turns + old.turns).distinctBy { it.position }, nextCursor = read.value.nextCursor)
                            history = page
                            conversation = read.value.copy(generation = null).exchanges() + conversation
                            failure = null
                        }
                        is GymResult.Failed -> failure = read.why.line("Earlier messages didn’t open.")
                    }
                    olderBusy = false
                }
            }
        } },
        olderBusy = olderBusy, historyFailure = failure,
        proposalIds = history?.proposals.orEmpty().map { it.id },
    )
}
