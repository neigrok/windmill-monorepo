package works.windmill.gym.coach

import works.windmill.gym.ui.Chevron
import works.windmill.gym.ui.GymLayout
import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.GymTap
import works.windmill.gym.ui.LocalGymColors
import works.windmill.gym.ui.ProposalCard
import works.windmill.gym.ui.TopAction
import works.windmill.gym.ui.YouSeat
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.key
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.drop
import works.windmill.gym.R
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Proposal
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.ProposalRead
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.LocalShellActions
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace

@Composable
fun AskScreen(
    store: TrainingStore,
    thread: List<AskExchange>,
    // Ephemeral lines derived from the server's apply reply; they die with the conversation.
    receipts: List<String>,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    asking: Boolean,
    cap: AskCap?,
    onAsk: (String) -> Unit,
    onRetry: () -> Unit,
    onAskNew: () -> Unit,
    seed: String,
    origin: String,
    backTo: String? = null,
    onBack: (() -> Unit)? = null,
    seat: String? = null,
    onThreads: () -> Unit,
    onNotes: () -> Unit,
    onReview: (Proposal) -> Unit,
    onConnections: (() -> Unit)? = null,
    onNewDraft: (String) -> Unit = { onAskNew() },
    conversationId: String = "",
    onOpenRoutine: ((String) -> Unit)? = null,
    onOlder: (() -> Unit)? = null,
    olderBusy: Boolean = false,
    historyFailure: String? = null,
    proposalIds: List<String> = emptyList(),
    onPhotoAsk: ((String, CoachAttachment?) -> Unit)? = null,
    onStop: (() -> Unit)? = null,
    upload: Float? = null,
    onOpenWorkout: ((String) -> Unit)? = null,
    onOpenChat: ((String) -> Unit)? = null,
) {
    val skin = LocalGymColors.current
    val nowMs = remember(conversationId) { System.currentTimeMillis() }
    val savedPosition = store.coach.chat(conversationId)
    val account = store.coach.accountKey
    val presentation = rememberCoachPresentation(conversationId, thread, account, savedPosition?.scroll ?: 0, savedPosition?.followEnd ?: true)
    var sourcesHeight by remember(conversationId) { mutableStateOf(0) }
    val sourcesSpace = with(LocalDensity.current) { sourcesHeight.toDp() } + if (sourcesHeight > 0) 24.dp else 0.dp
    DisposableEffect(presentation, account) {
        onDispose {
            if (store.coach.accountKey == account) store.coach.keepPosition(conversationId, presentation.scroll.value, presentation.followEnd)
        }
    }
    LaunchedEffect(presentation, account) {
        snapshotFlow { presentation.scroll.isScrollInProgress }.drop(1).collect { scrolling ->
            if (!scrolling && store.coach.accountKey == account)
                store.coach.keepPosition(conversationId, presentation.scroll.value, presentation.followEnd)
        }
    }
    val messageKeys = presentation.keys
    presentation.tolerance = with(LocalDensity.current) { 48.dp.roundToPx() }
    val scope = rememberCoroutineScope()
    val web = LocalUriHandler.current
    val telemetry = LocalTelemetry.current
    val shell = LocalShellActions.current
    var menu by remember { mutableStateOf(false) }
    var draftFailure by remember { mutableStateOf<String?>(null) }
    fun newChat() { onAskNew() }


    // Read back off the log: the reply carries ids only. A proposal moves when anybody decides, and a
    // decision taken in this room overrides the copy read here, so the card and the receipt agree.
    val minted = remember { mutableStateMapOf<String, Proposal>() }
    val missing = remember { mutableStateMapOf<String, Boolean>() }
    val attachedProposals = thread.flatMap { it.answer?.proposals.orEmpty() }.toSet()
    val headerProposals = proposalIds.filterNot { it in attachedProposals }
    val wanted = (attachedProposals + proposalIds).toList()
    LaunchedEffect(wanted) {
        wanted.forEach { id ->
            if (minted.containsKey(id) || missing.containsKey(id)) return@forEach
            when (val read = store.proposal(id)) {
                is ProposalRead.Found -> minted[id] = read.proposal
                ProposalRead.Gone -> missing[id] = true
            }
        }
    }

    GymScreen(
        title = Ask.title,
        onBack = onBack,
        backTo = backTo,
        actions = {
            TopAction(Threads.door, onClick = onThreads)
            Box {
                IconButton(onClick = { menu = true }) {
                    Icon(painterResource(R.drawable.gym_more), "More", tint = skin.inkDim, modifier = Modifier.size(24.dp))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = skin.raised) {
                    DropdownMenuItem(text = { Text("Notes") }, onClick = { menu = false; onNotes() })
                    DropdownMenuItem(text = { Text("Connected log") }, onClick = {
                        menu = false
                        if (onConnections != null) onConnections()
                        else runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }.onFailure { telemetry.failure("gym.openConnections", it) }
                    })
                    if (thread.isNotEmpty()) DropdownMenuItem(text = { Text("New chat") }, enabled = !asking,
                        onClick = { menu = false; newChat() })
                    DropdownMenuItem(text = { Text("Account") }, onClick = { menu = false; shell.openYou() })
                }
            }
            if (onBack == null) seat?.let { YouSeat(it) }
        },
    ) {
      Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
      ) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val latestHeight = (maxHeight - GymLayout.contentTop - WindmillSpace.x2).coerceAtLeast(0.dp)
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
                modifier = Modifier
                    .fillMaxSize()
                    .nestedScroll(presentation.gestures)
                    .then(presentation.anchoring)
                    .verticalScroll(presentation.scroll)
                    .padding(horizontal = GymLayout.gutter)
                    .padding(top = GymLayout.contentTop, bottom = WindmillSpace.x2 + sourcesSpace),
            ) {
                onOlder?.let { older -> CoachAction(if (olderBusy) "Reading messages…" else "Earlier messages", older, enabled = !olderBusy && !asking) }
                (historyFailure ?: draftFailure ?: store.coach.archiveFailure)?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim) }
                thread.forEachIndexed { index, exchange ->
                    if (upload != null && index == thread.lastIndex && exchange.generation == null) return@forEachIndexed
                    key(messageKeys[index]) {
                        Column(Modifier.fillMaxWidth()
                            .heightIn(min = if (index == thread.lastIndex && cap == null) latestHeight else 0.dp),
                            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4)) {
                            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                exchange.attachments.forEach { CoachPhoto(store.coach, conversationId, it, Modifier.size(160.dp)) }
                                if (exchange.question.isNotEmpty()) CoachQuestion(exchange.question)
                            }
                            val answered = exchange.answer ?: exchange.generation?.response()
                            val running = exchange.generation?.takeIf { exchange.answer == null && it.status == "running" }
                            val text = if (running != null) rememberRevealedText(messageKeys[index], running) else answered?.answer.orEmpty()
                            if (exchange.pending && text.isEmpty()) {
                                Text(Ask.waiting, style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
                            }
                            answered?.let { answer ->
                                Answer(answer.copy(answer = text), exchange.answer != null, minted + store.settledProposals, store.catalog, nowMs, lookedAt, onReview, onOpenRoutine, store.coach, conversationId, exchange.requestId, !asking, onOpenWorkout, index == thread.lastIndex && headerProposals.isNotEmpty()) { sourcesHeight = it }
                                answer.proposals.filter { it !in minted && it !in store.settledProposals }.forEach { id ->
                                    if (id in missing) Trouble(ProposalRead.Gone.line, null)
                                    else Text("Reading proposal…", style = WindmillFont.body(14), color = skin.inkDim)
                                }
                            }
                            exchange.trouble?.let { said ->
                                if ((cap != null || exchange.needsNew) && index == thread.lastIndex) return@let
                                Trouble(
                                    said = said,
                                    onRetry = onRetry.takeIf {
                                        exchange.again && !asking && index == thread.lastIndex
                                    },
                                )
                            }
                        }
                    }
                }
                headerProposals.forEach { id ->
                    (store.settledProposals[id] ?: minted[id])?.let { proposal ->
                        Minted(proposal, store.catalog, nowMs, id in lookedAt) { onReview(proposal) }
                    }
                    if (id in missing) Trouble(ProposalRead.Gone.line, null)
                }
                val shown = (minted + store.settledProposals).values.mapNotNull { it.receipt }.toSet()
                receipts.filterNot { it in shown }.forEach { ReceiptLine(it) }
                cap?.let {
                    Text(
                        thread.lastOrNull()?.trouble ?: it.wordless,
                        style = WindmillFont.body(15).copy(lineHeight = 22.sp),
                        color = skin.ink,
                    )
                }
            }
            if (!presentation.followEnd && thread.isNotEmpty() && presentation.awayFromEnd) TextButton(onClick = {
                scope.launch { presentation.jumpToLatest() }
            }, modifier = Modifier.align(Alignment.BottomCenter).heightIn(min = 48.dp)
                .background(skin.surface, RoundedCornerShape(24.dp)).padding(horizontal = 12.dp)) {
                Text("Jump to latest", style = WindmillFont.body(14), color = skin.accent)
            }
        }
        store.coach.pendingChat(conversationId)?.takeIf { thread.isEmpty() }?.let { pending ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Reply pending", style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.ink)
                    Text(pending.title, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                }
                TextButton(onClick = { onOpenChat?.invoke(pending.id) }, enabled = onOpenChat != null) { Text("View chat") }
            }
        }
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = GymLayout.gutter)
                .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3),
        ) {
            when {
                cap != null -> Column {
                    if (thread.lastOrNull()?.again == true) CoachAction("Try again", onRetry)
                    CapDoors(cap, origin, ::newChat, onConnections)
                }
                Ask.needsNew(thread) -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(thread.lastOrNull()?.takeIf { it.needsNew }?.trouble ?: Ask.threadFull, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                    CoachAction("Ask new", onClick = {
                        onNewDraft(thread.lastOrNull()?.takeIf { it.answer == null && !it.pending }?.question.orEmpty())
                    })
                }
                else -> CoachComposer(store.coach, conversationId.ifEmpty { "new" }, seed, asking || olderBusy,
                    onSend = { text, photo ->
                        val last = thread.lastOrNull()
                        if (last?.again == true && last.question == text && last.attachments.map { it.id } == listOfNotNull(photo?.id)) onRetry()
                        else if (onPhotoAsk != null) onPhotoAsk(text, photo)
                        else { onAsk(text); store.coach.saveDraft(conversationId.ifEmpty { "new" }, CoachDraft()) }
                    }, onStop = onStop, upload = upload, retainDraft = onPhotoAsk != null)
            }
        }
      }
    }
}

@Composable
fun AskSignedOutStance(seat: String, onSignIn: () -> Unit) {
    val skin = LocalGymColors.current
    GymScreen(title = Ask.title, actions = { YouSeat(seat) }) {
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp)) {
                Text(Ask.signedOut, style = WindmillFont.body(26, FontWeight.Bold).copy(lineHeight = 36.sp), color = skin.ink)
            }
            CoachAction("Sign in", onSignIn, primary = true, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
    }
}

// A bare 404 means the feature is not configured, so there is nothing to retry.
@Composable
fun AskAbsentStance(seat: String, onNotes: (() -> Unit)? = null, onConnections: (() -> Unit)? = null) {
    val skin = LocalGymColors.current
    GymScreen(title = Ask.title, actions = { YouSeat(seat) }) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier.fillMaxSize(),
        ) {
            if (onNotes != null) {
                Column(Modifier.padding(horizontal = 20.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
                            .clickable(role = Role.Button, onClick = onNotes).padding(vertical = 12.dp),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("Notes", style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
                            Text("What Coach should know", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                        }
                        Chevron()
                    }
                    Box(Modifier.fillMaxWidth().heightIn(min = 1.dp).background(skin.line))
                }
            }
            Text(
                Ask.notHere,
                style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                color = skin.inkDim,
                modifier = Modifier.padding(horizontal = GymLayout.gutter),
            )
            onConnections?.let { CoachAction("Connected log", it, modifier = Modifier.padding(horizontal = 20.dp)) }
        }
    }
}

@Composable
private fun ConnectDoor(origin: String, onConnections: (() -> Unit)?, label: String = "Connected log") {
    val skin = LocalGymColors.current
    val web = LocalUriHandler.current
    val telemetry = LocalTelemetry.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button) {
            if (onConnections != null) onConnections() else runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }
                .onFailure { telemetry.failure("gym.openConnections", it) }
        }.padding(vertical = 12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
            Text("Use your own AI tool", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        }
        Chevron()
    }
}

@Composable
private fun CapDoors(cap: AskCap, origin: String, onAskNew: () -> Unit, onConnections: (() -> Unit)?) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        if (cap == AskCap.Ceiling) ConnectDoor(origin, onConnections, "Connect own agent")
        CoachAction(Threads.open, onAskNew)
        if (cap == AskCap.Daily) ConnectDoor(origin, onConnections, "Connect own agent")
    }
}

@Composable
private fun Answer(
    answer: AskAnswer,
    settled: Boolean,
    minted: Map<String, Proposal>,
    catalog: List<Exercise>,
    nowMs: Long,
    lookedAt: Set<String>,
    onReview: (Proposal) -> Unit,
    onOpenRoutine: ((String) -> Unit)?,
    coach: CoachStore,
    threadId: String,
    requestId: String,
    canConfirm: Boolean,
    onOpenWorkout: ((String) -> Unit)?,
    hasHeaderProposals: Boolean,
    onSourcesHeight: (Int) -> Unit,
) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        val current = answer.confirmedBy(coach.confirmedGeneration(requestId))
        CoachAnswer(current.answer, current.receipt, catalog, nowMs, current.read.takeIf { settled }, current.steps, current.results, onOpenRoutine,
            routineDrafts = current.routineDrafts,
            onConfirmRoutine = if (canConfirm && requestId.isNotBlank()) { draft -> coach.confirmRoutine(threadId, requestId, draft) } else null,
            hasProposals = hasHeaderProposals || current.proposals.isNotEmpty(), onOpenWorkout = onOpenWorkout, onSourcesHeight = onSourcesHeight)
        // Drawn from the LOG's own copy and never from what the model said about it.
        answer.proposals.mapNotNull { minted[it] }.forEach { proposal ->
            Minted(proposal, catalog, nowMs, stillWaiting = proposal.id in lookedAt) { onReview(proposal) }
        }
    }
}

// What the server said it did, the moment it said so. Not stored: reopening the thread does not
// draw it again, and nothing here pretends otherwise.
@Composable
fun ReceiptLine(line: String) {
    val skin = LocalGymColors.current
    val applied = line.startsWith("Applied")
    Text(line, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp),
        color = if (applied) skin.accent else skin.ink,
        modifier = Modifier.fillMaxWidth().then(if (applied) Modifier.background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp) else Modifier.padding(vertical = 8.dp)))
}

@Composable
private fun Minted(proposal: Proposal, catalog: List<Exercise>, nowMs: Long, stillWaiting: Boolean, onReview: () -> Unit) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        ProposalCard(proposal, proposal.routineName, nowMs, stillWaiting, onReview)
        if (proposal.isPending) Text(Ask.promise, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        proposal.receipt?.let { ReceiptLine(it) }
    }
}

@Composable
private fun Trouble(said: String, onRetry: (() -> Unit)?) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Text(
            said,
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = skin.inkDim,
        )
        onRetry?.let { retry ->
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(role = Role.Button, onClick = retry),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text("Try again", style = WindmillFont.body(14, FontWeight.SemiBold), color = skin.accent)
            }
        }
    }
}
