package works.windmill.gym.coach

import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.GymTap
import works.windmill.gym.ui.LocalGymColors
import works.windmill.gym.ui.ProposalCard
import works.windmill.gym.ui.YouSeat
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.key
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.Stable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionOnScreen
import kotlin.math.roundToInt
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.drop
import works.windmill.gym.R
import works.windmill.gym.presentation.ConnectedLog
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.store.HistoryReads
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.sync.engine.Pulls
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace

// What a conversation draws: Coach's own store, and the training its answers name.
@Stable
interface AskState {
    val coach: CoachStore
    val catalog: List<Exercise>
    val settledProposals: Map<String, Proposal>
    val replicaReadRevision: Long
    val caughtUpTo: Long?
    val pulled: Pulls
    fun proposalRecorded(id: String): Boolean
}

// What a conversation asks of the training stores.
interface AskEvents {
    suspend fun proposal(id: String): ProposalRead
    suspend fun pullAgain(): Boolean
}

// A conversation over the room's stores.
class AskBinding(
    override val coach: CoachStore,
    private val seat: TrainingSeat,
    private val routines: RoutinesStore,
    private val history: HistoryReads,
) : AskState, AskEvents {
    constructor(store: TrainingStore) : this(store.coach, store.seat, store.routines, store.history)

    override val catalog: List<Exercise> get() = routines.catalog
    override val settledProposals: Map<String, Proposal> get() = routines.settledProposals
    override val replicaReadRevision: Long get() = seat.replicaReadRevision
    override val caughtUpTo: Long? get() = routines.caughtUpTo
    override val pulled: Pulls get() = history.pulled
    override fun proposalRecorded(id: String): Boolean = routines.proposalRecorded(id)
    override suspend fun proposal(id: String): ProposalRead = routines.proposal(id)
    override suspend fun pullAgain(): Boolean = history.pullAgain()
}

@Composable
fun AskScreen(
    state: AskState,
    events: AskEvents,
    thread: List<AskExchange>,
    // Ephemeral lines derived from the server's apply reply; they die with the conversation.
    receipts: List<String>,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    asking: Boolean,
    cap: AskCap?,
    onAsk: (String) -> Unit,
    onRetry: (AskExchange) -> Unit,
    onAskNew: () -> Unit,
    seed: String,
    origin: String,
    backTo: String? = null,
    onBack: (() -> Unit)? = null,
    seat: String? = null,
    onThreads: () -> Unit,
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
    composerEnabled: Boolean = true,
    composerVisible: Boolean = true,
    onSignIn: (() -> Unit)? = null,
    onBuildRoutine: (() -> Unit)? = null,
) {
    val skin = LocalGymColors.current
    val coach = state.coach
    val nowMs = remember(conversationId) { System.currentTimeMillis() }
    val savedPosition = coach.chat(conversationId)
    val account = coach.accountKey
    val keptDrafts = coach.keptDrafts(conversationId)
    val greeting = savedPosition?.setup == true && thread.isEmpty() && composerVisible && keptDrafts.isEmpty()
    var syncDraft by remember(account, conversationId) { mutableStateOf<(() -> Boolean)?>(null) }
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    var photoRequest by remember(account, conversationId) { mutableIntStateOf(0) }
    val presentation = rememberCoachPresentation(conversationId, thread, account, savedPosition?.scroll ?: 0, savedPosition?.followEnd ?: true)
    var sourcesTop by remember(conversationId) { mutableStateOf<Int?>(null) }
    var viewportBottom by remember(conversationId) { mutableIntStateOf(0) }
    val overlap = (viewportBottom - (sourcesTop ?: viewportBottom)).coerceAtLeast(0)
    val sourcesSpace = with(LocalDensity.current) { overlap.toDp() } + if (sourcesTop != null) 16.dp else 0.dp
    DisposableEffect(presentation, account) {
        onDispose {
            if (coach.accountKey == account) coach.keepPosition(conversationId, presentation.scroll.value, presentation.followEnd)
        }
    }
    LaunchedEffect(presentation, account) {
        snapshotFlow { presentation.scroll.isScrollInProgress }.drop(1).collect { scrolling ->
            if (!scrolling && coach.accountKey == account)
                coach.keepPosition(conversationId, presentation.scroll.value, presentation.followEnd)
        }
    }
    val messageKeys = presentation.keys
    presentation.tolerance = with(LocalDensity.current) { 48.dp.roundToPx() }
    val scope = rememberCoroutineScope()
    val telemetry = LocalTelemetry.current
    var greetingCounted by rememberSaveable(account, conversationId) { mutableStateOf(false) }
    LaunchedEffect(account, conversationId, greeting) {
        if (greeting && !greetingCounted) telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "shown"))
        greetingCounted = greeting
    }
    val web = LocalUriHandler.current
    var draftFailure by remember { mutableStateOf<String?>(null) }

    // Read back off the log: the reply carries ids only. A proposal moves when anybody decides, and a
    // decision taken in this room overrides the copy read here, so the card and the receipt agree.
    val proposals = remember { AnsweredProposals(state, events, telemetry) }
    val minted = proposals.minted
    val waitedHere = remember { mutableSetOf<String>() }
    thread.forEach { if (it.pending && it.requestId.isNotEmpty()) waitedHere += it.requestId }
    proposals.fresh = thread.filter { it.requestId in waitedHere }.flatMap { it.answer?.proposals.orEmpty() }.toSet()
    val attachedProposals = thread.flatMap { it.answer?.proposals.orEmpty() }.toSet()
    val headerProposals = proposalIds.filterNot { it in attachedProposals }
    val wanted = (attachedProposals + proposalIds).toList()
    LaunchedEffect(wanted, state.replicaReadRevision, state.pulled.caughtUp) { proposals.read(wanted) }
    proposals.missing.keys.forEach { id -> key(id) { LaunchedEffect(Unit) { proposals.settle(id) } } }

    GymScreen(
        title = Ask.title,
        actions = {
            IconButton(onClick = onThreads, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.gym_coach_history), "History", tint = skin.ink, modifier = Modifier.size(24.dp))
            }
            seat?.let { YouSeat(it) }
        },
    ) {
      Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
      ) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().onGloballyPositioned { viewportBottom = (it.positionOnScreen().y + it.size.height).roundToInt() }) {
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp, if (greeting && !keyboardVisible) Alignment.Top else Alignment.Bottom),
                modifier = Modifier
                    .fillMaxSize()
                    .testTag("coach-thread")
                    .nestedScroll(presentation.gestures)
                    .then(if (greeting) Modifier else presentation.anchoring)
                    .verticalScroll(presentation.scroll)
                    .heightIn(min = maxHeight)
                    .padding(horizontal = 16.dp)
                    .padding(top = 8.dp, bottom = 8.dp + sourcesSpace),
            ) {
                if (greeting) CoachGreeting(!coach.anonymous, composerEnabled && !asking,
                    onScreenshot = {
                        telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "screenshot"))
                        photoRequest++
                    }, onBuild = {
                        telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "build_manually"))
                        onBuildRoutine?.invoke()
                    })
                onOlder?.let { older -> CoachAction(if (olderBusy) "Reading messages…" else "Earlier messages", older, enabled = !olderBusy && !asking) }
                (historyFailure ?: draftFailure ?: coach.archiveFailure)?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim) }
                thread.forEachIndexed { index, exchange ->
                    if (upload != null && index == thread.lastIndex && exchange.generation == null) return@forEachIndexed
                    key(messageKeys[index]) {
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            val heldInComposer = cap != null && index == thread.lastIndex && exchange.answer == null &&
                                exchange.question == coach.draft(conversationId.ifEmpty { "new" }).text
                            if (!heldInComposer || exchange.attachments.isNotEmpty() || exchange.generation != null) ChatTimestamp(exchange.atMs, nowMs)
                            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                exchange.attachments.forEach { CoachPhoto(coach, conversationId, it, Modifier.size(160.dp)) }
                                if (exchange.question.isNotEmpty() && !heldInComposer) CoachQuestion(exchange.question, if (exchange.attachments.isEmpty()) CoachGroup.Single else CoachGroup.Last)
                            }
                            val answered = exchange.answer ?: exchange.generation?.response()
                            val text = rememberRevealedText(messageKeys[index], answered?.answer.orEmpty(), exchange.generation?.status in listOf("failed", "stopped"))
                            if (exchange.pending && text.isEmpty()) CoachTyping()
                            answered?.let { answer ->
                                val clarification = remember(answer.clarification) { CoachClarification.from(answer.clarification) }
                                val setupOnly = clarification != null && CoachSources.choicesAlone(answer.receipt?.steps ?: answer.steps,
                                    answer.receipt?.read ?: answer.read,
                                    acted = answer.proposals.isNotEmpty() || answer.results.isNotEmpty() || answer.routineDrafts.isNotEmpty())
                                if (setupOnly) CoachAnswer(text.ifEmpty { requireNotNull(clarification).question }, null, state.catalog, nowMs,
                                    copyText = answer.answer.ifEmpty { requireNotNull(clarification).question })
                                else Answer(answer, text, exchange.answer != null, minted + state.settledProposals, state.catalog, nowMs, lookedAt, onReview, onOpenRoutine, coach, conversationId, exchange.requestId, !asking, onOpenWorkout, index == thread.lastIndex && headerProposals.isNotEmpty()) { sourcesTop = it }
                                if (clarification != null) CoachChoices(clarification,
                                    coach.choices(conversationId, exchange.requestId, clarification.id),
                                    enabled = composerVisible && composerEnabled && !asking && syncDraft != null) { group, option ->
                                    if (coach.accountKey == account && coach.draftChangeReady(conversationId) && syncDraft?.invoke() == true) {
                                        try { coach.choose(conversationId, exchange.requestId, clarification, group, option); draftFailure = null }
                                        catch (_: Exception) { draftFailure = "Your draft couldn’t be saved. Try again." }
                                    }
                                }
                                answer.proposals.filter { it !in minted && it !in state.settledProposals }.forEach { id ->
                                    if (proposals.gone(id)) Trouble(ProposalRead.Gone.line, null)
                                    else if (id !in proposals.missing) Text("Reading proposal…", style = WindmillFont.body(14), color = skin.inkDim, modifier = Modifier.padding(horizontal = 4.dp))
                                }
                            }
                            if (exchange.refusalCode == "account_required") {
                                CoachBubble(copyText = { Ask.accountRequired }) {
                                    Text(Ask.accountRequired, style = CoachType.body(16).copy(lineHeight = 22.sp), color = skin.ink)
                                }
                                onSignIn?.let { CoachAction("Sign in", it, primary = true) }
                            }
                            exchange.trouble?.takeUnless { exchange.refusalCode == "account_required" }?.let { said ->
                                if ((cap != null || exchange.needsNew) && index == thread.lastIndex) return@let
                                Trouble(
                                    said = said,
                                    onRetry = if (exchange.again && !asking) ({ onRetry(exchange) }) else null,
                                )
                            }
                        }
                    }
                }
                headerProposals.forEach { id ->
                    (state.settledProposals[id] ?: minted[id])?.let { proposal ->
                        Minted(proposal, state.catalog, nowMs, id in lookedAt) { onReview(proposal) }
                    }
                    if (proposals.gone(id)) Trouble(ProposalRead.Gone.line, null)
                }
                val shown = (minted + state.settledProposals).values.mapNotNull { it.receipt }.toSet()
                receipts.filterNot { it in shown }.forEach { receipt ->
                    Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) { ReceiptLine(receipt) }
                }
                keptDrafts.forEach { kept ->
                    key(kept.id) { CoachKeptDraft(kept.draft, composerVisible && composerEnabled && !asking && syncDraft != null) {
                        if (coach.accountKey == account && coach.draftChangeReady(conversationId) && syncDraft?.invoke() == true) {
                            try { coach.continueDraft(conversationId, kept.id); draftFailure = null }
                            catch (_: Exception) { draftFailure = "Your draft couldn’t be saved. Try again." }
                        }
                    } }
                }
                cap?.let {
                    CoachCapNotice(it, thread.lastOrNull(), anonymous = coach.anonymous,
                        onSignIn = onSignIn?.let { signIn -> {
                            telemetry.event("gym_setup_step", mapOf("screen" to "coach", "action" to "sign_in"))
                            signIn()
                        } }) {
                        if (onConnections != null) onConnections() else runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }
                            .onFailure { telemetry.failure("gym.openConnections", it) }
                    }
                }
            }
            if (!presentation.followEnd && thread.isNotEmpty() && presentation.awayFromEnd) ElevatedButton(onClick = {
                telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "jump_latest", "outcome" to "ok"))
                scope.launch { presentation.jumpToLatest() }
            }, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).heightIn(min = 40.dp),
                colors = ButtonDefaults.elevatedButtonColors(containerColor = skin.surface, contentColor = skin.accent),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
                Icon(painterResource(R.drawable.gym_coach_down), null, Modifier.size(20.dp))
                Text("Jump to latest", style = CoachType.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), modifier = Modifier.padding(start = 8.dp))
            }
        }
        coach.pendingChat(conversationId)?.takeIf { thread.isEmpty() }?.let { pending ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Reply pending", style = CoachType.body(16, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.ink)
                    Text(pending.title, style = CoachType.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                }
                TextButton(onClick = { onOpenChat?.invoke(pending.id) }, enabled = onOpenChat != null) { Text("View chat") }
            }
        }
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .fillMaxWidth(),
        ) {
            when {
                Ask.needsNew(thread) -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(thread.lastOrNull()?.takeIf { it.needsNew }?.trouble ?: Ask.threadFull, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                    CoachAction("Ask new", onClick = {
                        onNewDraft(thread.lastOrNull()?.takeIf { it.answer == null && !it.pending }?.question.orEmpty())
                    })
                }
                else -> if (composerVisible) CoachComposer(coach, conversationId.ifEmpty { "new" }, seed, asking,
                    onSend = { text, photo ->
                        val last = thread.lastOrNull()
                        if (last?.again == true && last.question == text && last.attachments.map { it.id } == listOfNotNull(photo?.id)) onRetry(last)
                        else if (onPhotoAsk != null) onPhotoAsk(text, photo)
                        else { onAsk(text); coach.saveDraft(conversationId.ifEmpty { "new" }, CoachDraft()) }
                    }, onStop = onStop, upload = upload, retainDraft = onPhotoAsk != null, enabled = composerEnabled && !olderBusy, photoRequest = photoRequest, onDraftSync = { syncDraft = it })
            }
        }
      }
    }
}

@Composable
private fun Answer(
    answer: AskAnswer,
    text: String,
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
    onSourcesTop: (Int?) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        val current = answer.confirmedBy(coach.confirmedGeneration(requestId))
        CoachAnswer(text, current.receipt, catalog, nowMs, current.read.takeIf { settled }, current.steps, current.results, onOpenRoutine,
            routineDrafts = current.routineDrafts,
            onConfirmRoutine = if (canConfirm && requestId.isNotBlank()) { draft -> coach.confirmRoutine(threadId, requestId, draft) } else null,
            hasProposals = hasHeaderProposals || current.proposals.isNotEmpty(), onOpenWorkout = onOpenWorkout, copyText = current.answer, receiptInset = 4.dp, onSourcesTop = onSourcesTop)
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
    Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        ProposalCard(proposal, proposal.routineName, nowMs, stillWaiting, onReview)
        if (proposal.isPending) Text(Ask.promise, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        proposal.receipt?.let { ReceiptLine(it) }
    }
}

@Composable
private fun Trouble(said: String, onRetry: (() -> Unit)?) {
    val skin = LocalGymColors.current
    Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
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

// The proposals a room's answers name. Coach can answer before its proposal reaches this phone, so an id not found is
// read again each time the replica changes or a pull lands caught up. A proposal the phone holds a dead row of is gone at
// once. One it holds no row of is gone once its miss settles: 10 s after its first miss, and once the phone, caught up at
// or after that miss, has read further into the account, or a pull sent after the wait ended has landed caught up. The
// wait's end asks for that pull once. One named by an answer this visit waited for and gone that way is reported once.
internal class AnsweredProposals(private val state: AskState, private val events: AskEvents, private val telemetry: Telemetry) {
    data class Miss(val recorded: Boolean = false, val caughtUpAt: Long? = null, val readPast: Boolean = false,
        val waitedAt: Long? = null, val pulledPast: Boolean = false) {
        val settled: Boolean get() = waitedAt != null && (readPast || pulledPast)
        val gone: Boolean get() = recorded || settled

        fun read(recorded: Boolean, caughtUpTo: Long?, caughtUpPull: Long): Miss {
            val pulled = pulledPast || waitedAt != null && caughtUpPull > waitedAt
            return when {
                caughtUpTo == null -> copy(recorded = recorded, pulledPast = pulled)
                caughtUpAt == null -> copy(recorded = recorded, caughtUpAt = caughtUpTo, pulledPast = pulled)
                else -> copy(recorded = recorded, readPast = readPast || caughtUpTo > caughtUpAt, pulledPast = pulled)
            }
        }
    }

    val minted = mutableStateMapOf<String, Proposal>()
    val missing = mutableStateMapOf<String, Miss>()
    var fresh: Set<String> = emptySet()
    private val reported = mutableSetOf<String>()

    fun gone(id: String): Boolean = missing[id]?.gone == true

    suspend fun read(wanted: List<String>) {
        val caughtUpTo = state.caughtUpTo
        val caughtUpPull = state.pulled.caughtUp
        for (id in wanted) {
            if (minted.containsKey(id)) continue
            when (val read = events.proposal(id)) {
                is ProposalRead.Found -> { minted[id] = read.proposal; missing.remove(id) }
                ProposalRead.Gone -> missing[id] = (missing[id] ?: Miss()).read(state.proposalRecorded(id), caughtUpTo, caughtUpPull)
            }
        }
        report()
    }

    suspend fun settle(id: String) {
        delay(settleMs)
        val miss = missing[id] ?: return
        missing[id] = miss.copy(waitedAt = state.pulled.sent)
        report()
        if (missing[id]?.gone == false) events.pullAgain()
    }

    private fun report() {
        for ((id, miss) in missing.toMap())
            if (id in fresh && miss.settled && !miss.recorded && reported.add(id)) telemetry.event("gym_proposal_missing")
    }

    companion object { const val settleMs = 10_000L }
}

private data class PreviewAsk(
    override val coach: CoachStore,
    override val catalog: List<Exercise> = emptyList(),
    override val settledProposals: Map<String, Proposal> = emptyMap(),
    override val replicaReadRevision: Long = 0,
    override val caughtUpTo: Long? = null,
    override val pulled: Pulls = Pulls(),
) : AskState {
    override fun proposalRecorded(id: String): Boolean = false
}

private object PreviewAskEvents : AskEvents {
    override suspend fun proposal(id: String): ProposalRead = ProposalRead.Gone
    override suspend fun pullAgain(): Boolean = false
}

@Composable
private fun AskPreview(dark: Boolean, setup: Boolean, thread: List<AskExchange>) {
    val scope = rememberCoroutineScope()
    val coach = remember {
        CoachStore({ "preview-lifter" }, {}, { null }, null, Telemetry.None, { 0L }, scope)
            .also { it.freshChat(id = "preview-chat", setup = setup) }
    }
    CompositionLocalProvider(LocalWindmillDark provides dark) {
        GymMaterial {
            AskScreen(PreviewAsk(coach), PreviewAskEvents, thread, receipts = emptyList(), lookedAt = emptySet(), asking = false,
                cap = null, onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works", seat = "M",
                onThreads = {}, onReview = {}, conversationId = "preview-chat")
        }
    }
}

private val previewConversation: List<AskExchange> get() {
    val now = System.currentTimeMillis()
    return listOf(
        AskExchange("How should I come back to squats after a deload week?", requestId = "preview-1", atMs = now - 360_000,
            answer = AskAnswer("Start at about 90% of your last top set for the first week. Then add 2.5 kg a session while every set still leaves two reps in reserve.",
                ReadTally(sets = 24, sessions = 6, weeks = 3))),
        AskExchange("And if a session feels heavy?", requestId = "preview-2", atMs = now - 120_000,
            answer = AskAnswer("Repeat the weight next time instead of adding. One heavy day is noise; two in a row means stay put for a week.",
                ReadTally())),
    )
}

@Preview(name = "Ask · conversation · Dark")
@Composable
private fun AskConversationDark() = AskPreview(dark = true, setup = false, thread = previewConversation)

@Preview(name = "Ask · conversation · Daylight")
@Composable
private fun AskConversationDaylight() = AskPreview(dark = false, setup = false, thread = previewConversation)

@Preview(name = "Ask · greeting · Dark")
@Composable
private fun AskGreetingDark() = AskPreview(dark = true, setup = true, thread = emptyList())

@Preview(name = "Ask · greeting · Daylight")
@Composable
private fun AskGreetingDaylight() = AskPreview(dark = false, setup = true, thread = emptyList())
