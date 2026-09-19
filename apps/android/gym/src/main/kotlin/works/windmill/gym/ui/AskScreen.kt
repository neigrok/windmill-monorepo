package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.withFrameNanos
import works.windmill.gym.domain.Ask
import works.windmill.gym.R
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.CoachDraft
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Threads
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.ProposalRead
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.LocalShellActions
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.net.WindmillJson

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
) {
    val skin = LocalGymColors.current
    val nowMs = System.currentTimeMillis()
    val scroll = rememberScrollState()
    val web = LocalUriHandler.current
    val telemetry = LocalTelemetry.current
    val shell = LocalShellActions.current
    var menu by remember { mutableStateOf(false) }
    var draftFailure by remember { mutableStateOf<String?>(null) }
    fun newChat() {
        try { store.abandonCoach(conversationId.ifEmpty { "new" }); onAskNew() }
        catch (_: Exception) { draftFailure = "Your draft couldn’t be cleared. Try again." }
    }


    // Read back off the log: the reply carries ids only. A proposal moves when anybody decides, and a
    // decision taken in this room overrides the copy read here, so the card and the receipt agree.
    val minted = remember { mutableStateMapOf<String, Proposal>() }
    val failures = remember { mutableStateMapOf<String, String>() }
    val missing = remember { mutableStateMapOf<String, Boolean>() }
    var attempt by remember { mutableStateOf(0) }
    val wanted = (thread.flatMap { it.answer?.proposals.orEmpty() } + proposalIds).distinct()
    LaunchedEffect(wanted, attempt) {
        wanted.forEach { id ->
            if (minted.containsKey(id) || missing.containsKey(id)) return@forEach
            val read = store.proposal(id)
            when (read) {
                is ProposalRead.Found -> { minted[id] = read.proposal; failures.remove(id) }
                ProposalRead.Gone -> { missing[id] = true; failures.remove(id) }
                is ProposalRead.Failed -> failures[id] = read.why.line("the proposal wasn’t read")
            }
        }
    }

    val scope = rememberCoroutineScope()
    var tailTop by remember(conversationId, thread.isEmpty()) { mutableIntStateOf(0) }
    var viewportHeight by remember(conversationId) { mutableIntStateOf(0) }
    var followEnd by remember(conversationId) { mutableStateOf(true) }
    LaunchedEffect(scroll) {
        snapshotFlow { scroll.isScrollInProgress to scroll.value }.collect { (moving, at) ->
            if (moving) followEnd = tailTop - at <= viewportHeight + 48
        }
    }
    val revision = thread.lastOrNull()?.generation?.revision
    LaunchedEffect(conversationId, revision) {
        if (revision != null && (followEnd || tailTop - scroll.value <= viewportHeight + 48)) {
            withFrameNanos { }
            withFrameNanos { }
            scroll.scrollTo(scroll.maxValue)
        }
    }

    val questionPositions = remember(conversationId, thread.isEmpty()) { mutableStateMapOf<Int, Int>() }
    val lastQuestion = questionPositions[thread.lastIndex] ?: 0
    var visibleQuestion by remember(conversationId) { mutableStateOf<Pair<String, String>?>(null) }
    val latestQuestion = thread.lastOrNull()?.let { it.requestId to it.question }
    LaunchedEffect(conversationId, latestQuestion) {
        if (latestQuestion != null && latestQuestion != visibleQuestion) {
            val top = snapshotFlow {
                questionPositions[thread.lastIndex]?.takeIf { scroll.maxValue >= it }
            }.filterNotNull().first()
            scroll.animateScrollTo(top)
        }
        visibleQuestion = latestQuestion
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
        },
    ) {
      Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
      ) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().onSizeChanged { viewportHeight = it.height }) {
            // The latest question can reach the top while its reply is short or still pending.
            val tailHeight = (maxHeight - with(LocalDensity.current) { (tailTop - lastQuestion).toDp() }).coerceAtLeast(0.dp)
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scroll)
                    .padding(horizontal = GymLayout.gutter)
                    .padding(top = GymLayout.contentTop, bottom = WindmillSpace.x2),
            ) {
                onOlder?.let { older -> CoachAction(if (olderBusy) "Reading messages…" else "Earlier messages", older, enabled = !olderBusy && !asking) }
                (historyFailure ?: draftFailure)?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim) }
                thread.forEachIndexed { index, exchange ->
                    if (upload != null && index == thread.lastIndex && exchange.generation == null) return@forEachIndexed
                    Box(Modifier.fillMaxWidth().onGloballyPositioned {
                        questionPositions[index] = it.positionInParent().y.toInt()
                    }) {
                        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            exchange.attachments.forEach { CoachPhoto(store, conversationId, it, Modifier.size(160.dp)) }
                            if (exchange.question.isNotEmpty()) CoachQuestion(exchange.question)
                        }
                    }
                    if (exchange.pending && exchange.generation?.answer.isNullOrEmpty()) {
                        Text(Ask.waiting, style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
                    }
                    exchange.answer?.let { answered ->
                        Answer(answered, minted + store.settledProposals, store.catalog, nowMs, lookedAt, onReview, onOpenRoutine)
                        answered.proposals.filter { it !in minted && it !in store.settledProposals }.forEach { id ->
                            if (id in missing) Trouble(ProposalRead.Gone.line, null)
                            else failures[id]?.let { Trouble(it) { failures.remove(id); attempt += 1 } }
                                ?: Text("Reading proposal…", style = WindmillFont.body(14), color = skin.inkDim)
                        }
                    }
                    if (exchange.answer == null) exchange.generation?.let { partial ->
                        CoachAnswer(partial.answer, partial.receipt, store.catalog, nowMs, results = partial.results, onOpenRoutine = onOpenRoutine)
                    }
                    exchange.trouble?.let { said ->
                        // The cap-reached state says this refusal once, at the end of the thread just
                        // below; it is not drawn twice.
                        if ((cap != null || exchange.needsNew) && index == thread.lastIndex) return@let
                        Trouble(
                            said = said,
                            // Only the NEWEST question may be asked again.
                            onRetry = onRetry.takeIf {
                                exchange.again && !asking && index == thread.lastIndex
                            },
                        )
                    }
                }
                val attached = thread.flatMap { it.answer?.proposals.orEmpty() }.toSet()
                proposalIds.filterNot { it in attached }.forEach { id ->
                    (store.settledProposals[id] ?: minted[id])?.let { proposal ->
                        Minted(proposal, store.catalog, nowMs, id in lookedAt) { onReview(proposal) }
                    }
                    if (id in missing) Trouble(ProposalRead.Gone.line, null)
                    failures[id]?.let { Trouble(it) { failures.remove(id); attempt++ } }
                }
                val shown = (minted + store.settledProposals).values.mapNotNull { it.receipt }.toSet()
                receipts.filterNot { it in shown }.forEach { ReceiptLine(it) }
                // The moment the allowance ran out, at the end of the conversation it stopped. It reads
                // INSIDE the scroller, because the block below does not scroll and anything pinned there
                // comes off the thread: with this sentence scrolling, the thread keeps 283.5dp at
                // fontScale 2.0 — measured in `LargestTypeTests`, the one file in this suite with real
                // font metrics.
                cap?.let {
                    Text(
                        thread.lastOrNull()?.trouble ?: it.wordless,
                        style = WindmillFont.body(15).copy(lineHeight = 22.sp),
                        color = skin.ink,
                    )
                }
                if (thread.isNotEmpty()) Spacer(Modifier.fillMaxWidth().height(tailHeight)
                    .onGloballyPositioned { tailTop = it.positionInParent().y.toInt() })
            }
            if (!followEnd && thread.isNotEmpty() && tailTop - scroll.value > viewportHeight + 48) TextButton(onClick = {
                followEnd = true
                scope.launch { scroll.animateScrollTo(scroll.maxValue) }
            }, modifier = Modifier.align(Alignment.BottomCenter).heightIn(min = 48.dp)
                .background(skin.surface, RoundedCornerShape(24.dp)).padding(horizontal = 12.dp)) {
                Text("Jump to latest", style = WindmillFont.body(14), color = skin.accent)
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
                else -> CoachComposer(store, conversationId.ifEmpty { "new" }, seed, asking || olderBusy,
                    onSend = { text, photo ->
                        val last = thread.lastOrNull()
                        if (last?.again == true && last.question == text && last.attachments.map { it.id } == listOfNotNull(photo?.id)) onRetry()
                        else if (onPhotoAsk != null) onPhotoAsk(text, photo)
                        else { onAsk(text); store.saveCoachDraft(conversationId.ifEmpty { "new" }, CoachDraft()) }
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
    minted: Map<String, Proposal>,
    catalog: List<Exercise>,
    nowMs: Long,
    lookedAt: Set<String>,
    onReview: (Proposal) -> Unit,
    onOpenRoutine: ((String) -> Unit)?,
) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        CoachAnswer(answer.answer, answer.receipt, catalog, nowMs, answer.read, answer.steps, answer.results, onOpenRoutine)
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

// A real ceiling: a `rememberSaveable` rides in the Bundle crossing to the system, and past the
// process-wide cap the app dies with TransactionTooLargeException.
private const val savedThreadBytes = 32_000

// The live thread through an activity recreation, as JSON: the TAIL that fits, and a failed save or
// restore is EMPTY rather than a crash.
fun askThreadSaver(telemetry: Telemetry): Saver<List<AskExchange>, String> =
    Saver(save = { savedThread(it, telemetry) }, restore = { readThread(it, telemetry) })

internal fun savedThread(thread: List<AskExchange>, telemetry: Telemetry = Telemetry.None): String? = runCatching {
    var kept = thread
    var written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    while (kept.size > 1 && written.toByteArray(Charsets.UTF_8).size > savedThreadBytes) {
        kept = kept.drop(1)
        written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    }
    written
}.onFailure { telemetry.failure("gym.saveConversation", it) }.getOrNull()

internal fun readThread(written: String, telemetry: Telemetry = Telemetry.None): List<AskExchange> = runCatching {
    WindmillJson.decodeFromString(ListSerializer(AskExchange.serializer()), written)
}.onFailure { telemetry.failure("gym.restoreConversation", it) }.getOrDefault(emptyList())
