package works.windmill.gym.coach

import works.windmill.platform.design.WindmillType
import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import works.windmill.gym.ui.GymScreen
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.IconButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.drop
import works.windmill.gym.R
import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.store.HistoryReads
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WorkoutProposalsStore
import works.windmill.gym.store.WorkoutSession
import works.windmill.sync.engine.Pulls
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.ui.DarkAndDaylight
import works.windmill.gym.ui.GymPreview
import works.windmill.platform.design.WindmillSpace
import works.windmill.gym.telemetry.coachAction
import works.windmill.gym.telemetry.coachSetupStep

// What a conversation draws: Coach's chats, and the training its answers name.
@Stable
interface AskState {
    val coach: CoachChats
    val catalog: List<Exercise>
    val settledProposals: Map<String, Proposal>
    val replicaReadRevision: Long
    val pulled: Pulls
    fun proposalRecorded(id: String): Boolean
    // Coach's changes to the open workout this phone holds, and whether a workout is open, so a routine's change reads for next time.
    val workoutProposals: Map<String, Proposal>
    val workoutOpen: Boolean
}

// What a conversation asks of the training stores.
interface AskEvents {
    suspend fun proposal(id: String): ProposalRead
    suspend fun pullAgain(): Boolean
    // How far this phone has read into the account, off the main thread, since the engine's lock waits behind whatever a turn is reading.
    suspend fun caughtUpTo(): Long?
}

// A conversation over the room's stores.
class AskBinding(
    override val coach: CoachChats,
    private val seat: TrainingSeat,
    private val routines: RoutinesStore,
    private val history: HistoryReads,
    private val workout: WorkoutSession,
    private val proposals: WorkoutProposalsStore,
) : AskState, AskEvents {
    constructor(store: TrainingStore) : this(store.coach, store.seat, store.routines, store.history, store.workout, store.workoutProposals)

    override val catalog: List<Exercise> get() = routines.catalog
    override val settledProposals: Map<String, Proposal> get() = routines.settledProposals
    override val replicaReadRevision: Long get() = seat.replicaReadRevision
    override val pulled: Pulls get() = history.pulled
    override fun proposalRecorded(id: String): Boolean = routines.proposalRecorded(id)
    override val workoutProposals: Map<String, Proposal> get() = proposals.held
    override val workoutOpen: Boolean get() = workout.session != null
    override suspend fun proposal(id: String): ProposalRead = routines.proposal(id)
    override suspend fun pullAgain(): Boolean = history.pullAgain()
    override suspend fun caughtUpTo(): Long? = seat.tried("gym.readConversation") { seat.readTraining { routines.caughtUpTo } }
}

@Composable
fun AskScreen(
    state: AskState,
    events: AskEvents,
    thread: List<CoachExchange>,
    // Ephemeral lines derived from the server's apply reply; they die with the conversation.
    receipts: List<String>,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    asking: Boolean,
    refusal: CoachTurnRefusal?,
    onAsk: (String, CoachAttachment?) -> Unit,
    seat: String? = null,
    onThreads: () -> Unit,
    onReview: (Proposal) -> Unit,
    onConnections: () -> Unit = {},
    conversationId: String = "",
    onOpenRoutine: ((String) -> Unit)? = null,
    onStop: (() -> Unit)? = null,
    onOpenChat: ((String) -> Unit)? = null,
    composerEnabled: Boolean = true,
    composerVisible: Boolean = true,
    onSignIn: (() -> Unit)? = null,
    onBuildRoutine: (() -> Unit)? = null,
    // The same room as a sheet over the open workout: its head is the sheet's, and its account stays with the tabs.
    overWorkout: Boolean = false,
) {
    val colors = MaterialTheme.colorScheme
    val coach = state.coach
    val nowMs = remember(conversationId) { coach.now() }
    val savedPosition = coach.chat(conversationId)
    val account = coach.accountKey
    val keptDrafts = coach.keptDrafts(conversationId)
    val greeting = savedPosition?.setup == true && thread.isEmpty() && composerVisible && keptDrafts.isEmpty()
    val draftKey = conversationId.ifEmpty { "new" }
    val accountChangingAlone = coach.accountChanging && thread.isEmpty() && !greeting
    val pending = coach.pendingChat(conversationId)?.takeIf { thread.isEmpty() }
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
        if (greeting && !greetingCounted) telemetry.coachSetupStep("shown")
        greetingCounted = greeting
    }
    var draftFailure by remember { mutableStateOf<Int?>(null) }
    val reconnecting = asking && coach.conversations?.reconnecting == true
    val fault = coach.fault(conversationId)
    val stopNotice = fault?.takeIf { it in stopFaults }
    LaunchedEffect(reconnecting) { if (reconnecting) telemetry.coachAction("reconnecting") }
    LaunchedEffect(stopNotice) { if (stopNotice != null) telemetry.coachAction("stop_notice") }
    val signInForCall = onSignIn?.let { signIn -> {
        telemetry.coachSetupStep("sign_in")
        signIn()
    } }
    val keepRoutines = onSignIn?.let { signIn -> {
        telemetry.coachSetupStep("keep_routines")
        signIn()
    } }
    val openRoutine = onOpenRoutine?.let { open -> { id: String ->
        telemetry.coachSetupStep("open_routine")
        open(id)
    } }

    // Read back off the replica: an answer's receipt carries ids only. A proposal moves when anybody decides, and a decision taken in this room overrides the copy read here, so the card and the receipt agree.
    val proposals = remember { AnsweredProposals(state, events, telemetry) }
    val minted = proposals.minted
    val waitedHere = remember { mutableSetOf<String>() }
    thread.forEach { if (it.waiting) waitedHere += it.id }
    proposals.fresh = thread.filter { it.id in waitedHere }.flatMap { it.answer?.proposals.orEmpty() + it.answer?.workoutProposals.orEmpty() }.toSet()
    val wanted = thread.flatMap { it.answer?.proposals.orEmpty() + it.answer?.workoutProposals.orEmpty().filter { id -> id !in state.workoutProposals } }.distinct()
    LaunchedEffect(wanted, state.replicaReadRevision, state.pulled.caughtUp) { proposals.read(wanted) }
    proposals.missing.keys.forEach { id -> key(id) { LaunchedEffect(Unit) { proposals.settle(id) } } }

    AskFrame(overWorkout, fresh = thread.isEmpty() && keptDrafts.isEmpty(), seat, onThreads) {
      Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
      ) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().onGloballyPositioned { viewportBottom = (it.positionOnScreen().y + it.size.height).roundToInt() }) {
            // The thread's padding is the scroller's content, so what stands in it, the read line's touch among it, stands inside what scrolls.
            val viewport = maxHeight
            Box(Modifier.fillMaxSize().testTag("coach-thread").nestedScroll(presentation.gestures)
                .then(if (greeting) Modifier else presentation.anchoring).verticalScroll(presentation.scroll)) {
              Column(
                verticalArrangement = Arrangement.spacedBy(12.dp, if (greeting && !keyboardVisible) Alignment.Top else Alignment.Bottom),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = viewport)
                    .padding(horizontal = 16.dp)
                    .padding(top = 8.dp, bottom = 8.dp + sourcesSpace),
              ) {
                if (greeting) CoachGreeting(!coach.anonymous, composerEnabled && !asking,
                    onScreenshot = {
                        telemetry.coachSetupStep("screenshot")
                        photoRequest++
                    }, onBuild = {
                        telemetry.coachSetupStep("build_manually")
                        onBuildRoutine?.invoke()
                    })
                (draftFailure?.let { stringResource(it) } ?: coach.failure(draftKey) ?: fault?.takeUnless { it in stopFaults }?.sentence)?.let { Text(it, style = WindmillType.supporting, color = colors.onSurfaceVariant) }
                thread.forEachIndexed { index, exchange ->
                    key(messageKeys[index]) {
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            if (!overWorkout) ChatTimestamp(exchange.atMs, nowMs)
                            if (exchange.question.isNotEmpty() || exchange.pictures.isNotEmpty()) LifterGroup(coach, exchange)
                            if (exchange.sending) CoachTyping()
                            exchange.answer?.let { answer ->
                                Answer(answer, exchange.retained, minted + state.settledProposals, proposals::gone, state, nowMs, lookedAt, onReview, openRoutine, conversationId, !asking,
                                    onSignIn = signInForCall.takeIf { coach.anonymous && index == thread.lastIndex }, onKeep = keepRoutines.takeIf { coach.anonymous }, overWorkout = overWorkout) { sourcesTop = it }
                                answer.proposals.filter { it !in minted && it !in state.settledProposals }.forEach { id ->
                                    if (proposals.gone(id)) Trouble(ProposalRead.Gone.line)
                                    else if (id !in proposals.missing) Text(stringResource(R.string.gym_coach_reading_proposal), style = WindmillType.supporting, color = colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp))
                                }
                            }
                            exchange.retained?.let { held ->
                                if (held.accountRequired) {
                                    val accountRequired = stringResource(R.string.gym_coach_account_required)
                                    CoachBubble(copyText = { accountRequired }) {
                                        Text(accountRequired, style = GymType.coachParagraph, color = colors.onSurface)
                                    }
                                    onSignIn?.let { CoachAction(stringResource(R.string.gym_coach_sign_in), it, primary = true) }
                                }
                                held.line?.let { Trouble(it) }
                            }
                        }
                    }
                }
                val shown = (minted + state.settledProposals).values.mapNotNull { it.receipt }.toSet()
                receipts.filterNot { it in shown }.forEach { receipt ->
                    Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) { ReceiptLine(receipt) }
                }
                keptDrafts.forEach { kept ->
                    key(kept.id) { CoachKeptDraft(kept.draft, composerVisible && composerEnabled && !asking && syncDraft != null) {
                        if (coach.accountKey == account && coach.draftChangeReady(conversationId) && syncDraft?.invoke() == true) {
                            try { coach.continueDraft(conversationId, kept.id); draftFailure = null }
                            catch (_: Exception) { draftFailure = R.string.gym_coach_draft_unsaved }
                        }
                    } }
                }
                (coach.tooLong(draftKey).takeIf { composerVisible } ?: refusal)?.let {
                    CoachRefusalNotice(it, anonymous = coach.anonymous,
                        onSignIn = signInForCall, onConnections = {
                            telemetry.coachSetupStep("connect")
                            onConnections()
                        }, onTryAgain = {
                            if (syncDraft?.invoke() != false) coach.draft(draftKey).let { draft -> onAsk(draft.text.trim(), draft.photo) }
                        })
                }
                if (coach.accountChanging && !accountChangingAlone) CoachAccountChanging(alone = false)
                pending?.let { AnswerInProgress(it, onOpenChat) }
              }
            }
            if (accountChangingAlone) CoachAccountChanging(alone = true, Modifier.align(Alignment.Center))
            if (!presentation.followEnd && thread.isNotEmpty() && presentation.awayFromEnd) ElevatedButton(onClick = {
                telemetry.coachAction("jump_latest")
                scope.launch { presentation.jumpToLatest() }
            }, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).heightIn(min = 40.dp),
                colors = ButtonDefaults.elevatedButtonColors(containerColor = colors.surfaceContainer, contentColor = colors.primary),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
                Icon(painterResource(R.drawable.gym_coach_down), null, Modifier.size(20.dp))
                Text(stringResource(R.string.gym_coach_jump_latest), style = GymType.coachStrong, modifier = Modifier.padding(start = 8.dp))
            }
        }
        if (reconnecting) Band(stringResource(R.string.gym_coach_reconnecting))
        else if (stopNotice != null) Band(stopNotice.sentence, onClose = {
            coach.closeFault(stopNotice)
            telemetry.coachAction("stop_notice_closed")
        })
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = if (overWorkout) 12.dp else 0.dp),
        ) {
            if (composerVisible) CoachComposer(coach, draftKey, asking,
                onSend = onAsk, onStop = onStop, enabled = composerEnabled, photoRequest = photoRequest, holdSend = coach.sendHeld || pending != null, onDraftSync = { syncDraft = it })
        }
      }
    }
}

// A Stop that never reached the server, which the band says with the turn already ended on this phone.
private val stopFaults = setOf(CoachTurnFault.stoppedOffline, CoachTurnFault.stopUnheard)

// The band over the composer, on the platform's snackbar: what this phone's own turn is doing or did.
@Composable
private fun Band(said: String, onClose: (() -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    // Material's snackbar fills its width by itself; a fixed width reaches its close button too and stands it over the words.
    Snackbar(
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 4.dp).testTag("coach-band"),
        shape = MaterialTheme.shapes.extraSmall,
        containerColor = colors.surfaceContainerHighest,
        contentColor = colors.onSurface,
        dismissAction = onClose?.let { close -> {
            IconButton(onClick = close, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.gym_coach_close), stringResource(R.string.gym_coach_close), Modifier.size(24.dp), tint = colors.onSurfaceVariant)
            }
        } },
    ) { Text(said, style = GymType.coachDetail) }
}

// The lifter's turn: each picture its own bubble, then the words in the bubble that closes the group, at the trailing edge.
@Composable
private fun LifterGroup(coach: CoachChats, exchange: CoachExchange) {
    val count = exchange.pictures.size + if (exchange.question.isNotEmpty()) 1 else 0
    fun group(index: Int) = when {
        count == 1 -> CoachGroup.Single
        index == 0 -> CoachGroup.First
        index == count - 1 -> CoachGroup.Last
        else -> CoachGroup.Middle
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        exchange.pictures.forEachIndexed { index, picture ->
            if (picture.onThisPhone) CoachPhoto(coach, picture.photo, Modifier.size(200.dp, 180.dp), group(index).shape(fromLifter = true))
            else CoachPictureElsewhere(group(index))
        }
        if (exchange.question.isNotEmpty()) CoachQuestion(exchange.question, group(count - 1))
    }
}

// The room's head: the screen's own bar, or the sheet's over the workout.
@Composable
private fun AskFrame(overWorkout: Boolean, fresh: Boolean, seat: String?, onThreads: () -> Unit, content: @Composable BoxScope.() -> Unit) {
    if (overWorkout) {
        CoachSheetFrame(fresh, onThreads, content)
        return
    }
    GymScreen(title = stringResource(R.string.gym_coach_title), actions = { CoachHead(seat, onThreads) }, content = content)
}

// An answer as it stands this moment. It reads the running words itself, so only this answer draws again at every delta. Drawn from the LOG's own copy and never from what the model said about it, its proposals follow what it read.
@Composable
private fun Answer(
    record: CoachReply,
    retained: RetainedAnswer?,
    minted: Map<String, Proposal>,
    gone: (String) -> Boolean,
    state: AskState,
    nowMs: Long,
    lookedAt: Set<String>,
    onReview: (Proposal) -> Unit,
    onOpenRoutine: ((String) -> Unit)?,
    chat: String,
    canSave: Boolean,
    onSignIn: (() -> Unit)?,
    onKeep: (() -> Unit)?,
    overWorkout: Boolean,
    onSourcesTop: (Int?) -> Unit,
) {
    val answer = state.coach.conversations?.standing(record) ?: record
    val text = rememberRevealedText(answer.id, answer.text, answer.state.isTerminal && answer.state != MessageState.completed)
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        CoachAnswer(text, answer, state.catalog, onOpenRoutine,
            routineDrafts = retained?.drafts.orEmpty(),
            onSaveDrafts = if (canSave && retained != null) { { state.coach.saveRetainedDrafts(chat, retained.requestId) } } else null,
            onSignIn = onSignIn, onKeep = onKeep, saysWhatItRead = retained == null || answer.routines.isNotEmpty(),
            withDetails = { rows -> state.coach.conversations?.withDetails(answer.id, rows) ?: rows }, onSourcesTop = onSourcesTop)
        AnswerProposals(answer, minted, state, nowMs, lookedAt, overWorkout, gone, onReview)
    }
}

// What the server said it did, the moment it said so. Not stored: reopening the thread does not draw it again, and nothing here pretends otherwise.
@Composable
fun ReceiptLine(line: String) {
    val colors = MaterialTheme.colorScheme
    val applied = line.startsWith("Applied")
    Text(line, style = GymType.button,
        color = if (applied) colors.primary else colors.onSurface,
        modifier = Modifier.fillMaxWidth().then(if (applied) Modifier.background(colors.surfaceContainer, MaterialTheme.shapes.large).padding(16.dp) else Modifier.padding(vertical = 8.dp)))
}

@Composable
private fun Trouble(said: String) {
    Text(said, style = GymType.quietParagraph, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp))
}

// The proposals a room's answers name, a routine's and a workout's alike. Coach can answer before its proposal reaches this phone, so an id not found is read again each time the replica changes or a pull lands caught up. A proposal the phone holds a dead row of is gone at once. One it holds no row of is gone once its miss settles: 10 s after its first miss, and once the phone, caught up at or after that miss, has read further into the account, or a pull sent after the wait ended has landed caught up. The wait's end asks for that pull once. One named by an answer this visit waited for and gone that way is reported once.
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
        missing.keys.removeAll(state.workoutProposals.keys)
        val unread = wanted.filterNot(minted::containsKey)
        val caughtUpTo = if (unread.isEmpty()) null else events.caughtUpTo()
        val caughtUpPull = state.pulled.caughtUp
        for (id in unread) when (val read = events.proposal(id)) {
            is ProposalRead.Found -> { minted[id] = read.proposal; missing.remove(id) }
            ProposalRead.Gone -> missing[id] = (missing[id] ?: Miss()).read(state.proposalRecorded(id), caughtUpTo, caughtUpPull)
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
    override val coach: CoachChats,
    override val catalog: List<Exercise> = emptyList(),
    override val settledProposals: Map<String, Proposal> = emptyMap(),
    override val replicaReadRevision: Long = 0,
    override val pulled: Pulls = Pulls(),
    override val workoutProposals: Map<String, Proposal> = emptyMap(),
    override val workoutOpen: Boolean = false,
) : AskState {
    override fun proposalRecorded(id: String): Boolean = false
}

private object PreviewAskEvents : AskEvents {
    override suspend fun proposal(id: String): ProposalRead = ProposalRead.Gone
    override suspend fun pullAgain(): Boolean = false
    override suspend fun caughtUpTo(): Long? = null
}

@Composable
private fun AskPreview(setup: Boolean, thread: List<CoachExchange>) {
    val scope = rememberCoroutineScope()
    val coach = remember {
        CoachChats({ "preview-lifter" }, {}, null, null, null, null, { AnonymousCoachAccess.Unavailable }, Telemetry.None, scope)
            .also { it.freshChat(id = "preview-chat", setup = setup) }
    }
    GymPreview {
        AskScreen(PreviewAsk(coach), PreviewAskEvents, thread, receipts = emptyList(), lookedAt = emptySet(), asking = false,
            refusal = null, onAsk = { _, _ -> }, seat = "M",
            onThreads = {}, onReview = {}, conversationId = "preview-chat")
    }
}

private fun previewAnswer(id: String, text: String, read: ReadTally = ReadTally()) = CoachReply(id, text, MessageState.completed, truncated = false, onThisPhone = true,
    calls = emptyList(), receipt = CoachReceipt(read, created = emptyList()), routines = emptyList())

private val previewConversation: List<CoachExchange> get() {
    val now = System.currentTimeMillis()
    return listOf(
        CoachExchange("preview-1", "How should I come back to squats after a deload week?", now - 360_000,
            answer = previewAnswer("preview-1a", "Start at about 90% of your last top set for the first week. Then add 2.5 kg a session while every set still leaves two reps in reserve.",
                ReadTally(sets = 24, sessions = 6, weeks = 3))),
        CoachExchange("preview-2", "And if a session feels heavy?", now - 120_000,
            answer = previewAnswer("preview-2a", "Repeat the weight next time instead of adding. One heavy day is noise; two in a row means stay put for a week.")),
    )
}

@DarkAndDaylight
@Composable
private fun AskConversationPreview() = AskPreview(setup = false, thread = previewConversation)

@DarkAndDaylight
@Composable
private fun AskGreetingPreview() = AskPreview(setup = true, thread = emptyList())
