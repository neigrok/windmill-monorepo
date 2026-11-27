package works.windmill.gym.coach.turn

import android.content.Context
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import works.windmill.agent.coach.AiAnswer
import works.windmill.agent.coach.AiClient
import works.windmill.agent.coach.AiFailure
import works.windmill.agent.coach.EndState
import works.windmill.agent.coach.Picture as TurnPicture
import works.windmill.agent.coach.Runtime
import works.windmill.agent.coach.Seat as TurnSeat
import works.windmill.agent.coach.SeatKind
import works.windmill.agent.coach.StopSignal
import works.windmill.agent.coach.TurnEnd
import works.windmill.agent.coach.TurnInput
import works.windmill.agent.coach.TurnRunner
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.refusal
import works.windmill.domain.kit.Seat
import works.windmill.domain.kit.TextSpec
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachRules
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.DeleteConversation
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.ForgetPicture
import works.windmill.gym.domain.coach.ForgetRunningTurn
import works.windmill.gym.domain.coach.ForgetUnclaimedPictures
import works.windmill.gym.domain.coach.KeepPicture
import works.windmill.gym.domain.coach.Mark
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.coach.OpenTurnOnce
import works.windmill.gym.domain.coach.Picture
import works.windmill.gym.domain.coach.WithdrawTurn
import works.windmill.gym.domain.coach.caughtUpWithItsLog
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.ReplicaPin
import works.windmill.gym.store.TrainingRefused
import works.windmill.platform.agent.CoachBackgroundLease
import works.windmill.platform.agent.CoachRuntime
import works.windmill.platform.ai.AiCredentials
import works.windmill.platform.ai.AiHttp
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiTransport
import works.windmill.platform.ai.CoachAiClient
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.TelemetryPolicy
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RecordID

// A turn that never began, the AI service admitting nothing of it: its records are gone, and this returns to the field. `thread` is null when the conversation went with the turn.
data class WithdrawnTurn(val question: String, val picture: ChosenPicture?, val thread: Id<CoachThread>?)

// The turn this phone is running, and whether its answer is being asked for again after a lost connection.
data class TurnActivity(val turnId: String, val reconnecting: Boolean)

// The phone's Coach turns: one per application, never bound to a screen. It admits a question (phone-hosted Coach abilities §4.1), records it, and runs the turn on the Coach engine's `TurnRunner` with gym's host and profile, each model round a call to the AI service; it recovers or ends what a process death left running, and ends what a seat change cuts off. All of it runs off the caller's thread, and admission, the sweeps and a seat change take turns.
class CoachTurns(
    private val training: EngineTraining,
    transport: AiTransport,
    private val installation: AiInstallation,
    private val accountToken: () -> String?,
    val pictures: PictureFiles,
    val catalog: Lazy<Catalog>,
    words: Lazy<CoachWords>,
    telemetry: Telemetry,
    private val lease: (Job) -> Unit,
    appBaseUrl: String,
    shares: () -> GymRest?,
    private val scope: CoroutineScope,
    private val storage: CoroutineDispatcher = Dispatchers.IO,
    runtime: Runtime = CoachRuntime(CoachBackgroundLease { AutoCloseable {} }),
    textEvery: Duration = 5.seconds,
    private val elapsedMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private class LiveTurn(val lease: GymTurn, val seat: SeatKind, val question: String, val picture: ChosenPicture?, val started: Long) {
        lateinit var work: Job
    }

    private val tells = GymTurnTelemetry(telemetry, catalog)
    private val profile = lazy { GymProfile(catalog.value, words.value) }
    private val host = GymTurnHost(training, catalog, profile, pictures, shares, appBaseUrl, tells, scope, storage, elapsedMs, textEvery)
    private val asking = MutableStateFlow(false)
    // What the pass door is asked with: the seat the running turn was admitted under.
    @Volatile internal var credentials = AiCredentials(null, null)
        private set
    private val ai = Witnessed(CoachAiClient(transport, tells, now = elapsedMs, wait = { ms, stop -> asking.value = true; stop.wait(ms) },
        connection = { training.engine.status.state.value.online }))
    private val runner = TurnRunner(host, ai, tells, runtime)
    private val engine = training.engine
    private val started = AtomicBoolean(false)
    private val admitting = Mutex()
    private val runningTurn = MutableStateFlow<OpenTurn.Turn?>(null)
    private val told = ConcurrentHashMap.newKeySet<Id<CoachMessage>>()
    @Volatile private var running: LiveTurn? = null
        set(value) {
            field = value
            runningTurn.value = value?.lease?.turn
            activities.value = value?.let { TurnActivity(it.lease.turnId, reconnecting = false) }
            stops.value = false
        }
    private val activities = MutableStateFlow<TurnActivity?>(null)
    private val stops = MutableStateFlow(false)
    private val refused = MutableStateFlow<CoachTurnRefusal?>(null)
    private val faulted = MutableStateFlow<CoachTurnFault?>(null)
    private val takenBack = MutableStateFlow<WithdrawnTurn?>(null)

    val activity: StateFlow<TurnActivity?> = activities.asStateFlow()
    // Whether Stop was asked of the running turn, which ends before its next round or its next call.
    val stopping: StateFlow<Boolean> = stops.asStateFlow()
    // The one turn running on this phone, whichever chat it belongs to.
    val turn: StateFlow<OpenTurn.Turn?> = runningTurn.asStateFlow()
    // What the room draws on the running message, from the engine's text. Its record takes the text every `textEvery`, at each round and at the end, since each commit syncs the whole text so far.
    val liveAnswer: StateFlow<LiveAnswer?> = host.answer
    // How the last send was refused, said once at the conversation's end.
    val refusal: StateFlow<CoachTurnRefusal?> = refused.asStateFlow()
    // A fault of this phone's own, said in the band.
    val fault: StateFlow<CoachTurnFault?> = faulted.asStateFlow()
    // The last turn that never began.
    val withdrawn: StateFlow<WithdrawnTurn?> = takenBack.asStateFlow()

    // The AI client the engine calls, which remembers the last failure it answered: the allowance a refusal carries, which says what holds a request and when a cap ends, is the product's to read, never the engine's. A text delta ends any asking again.
    private inner class Witnessed(private val client: CoachAiClient) : AiClient by client {
        @Volatile var failure: AiFailure? = null

        override suspend fun text(callId: String, request: Json, pictures: List<TurnPicture>, label: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer =
            witnessed(client.text(callId, request, pictures, label, use, version, stop) { asking.value = false; onText(it) })

        override suspend fun result(callId: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer =
            witnessed(client.result(callId, use, version, stop) { asking.value = false; onText(it) })

        private fun witnessed(answer: AiAnswer): AiAnswer {
            asking.value = false
            failure = (answer as? AiAnswer.Failure)?.failure ?: (answer as AiAnswer.Terminal).takeIf { it.event == "failed" }?.let {
                AiFailure("text", it.data.member("code").str(), works.windmill.agent.coach.Admission.admitted, it.data["allowance"]?.orNull())
            }
            return answer
        }
    }

    init {
        scope.launch(storage, start = CoroutineStart.UNDISPATCHED) {
            asking.collect { reconnecting -> activities.value = activities.value?.copy(reconnecting = reconnecting) }
        }
    }

    // At engine start: every change of the seat from here on, a rebind under the same id among them, with the subscriptions in place when this returns, and the sweep.
    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch(storage, start = CoroutineStart.UNDISPATCHED) {
            engine.activeReplicaChanges().collect { change -> attempted(Unit) { seatChanged(change.previous) { it.lease.pin.replica == change.previous } } }
        }
        scope.launch(storage, start = CoroutineStart.UNDISPATCHED) {
            engine.activeReplicaRebinds().collect { replica -> attempted(Unit) { seatChanged(replica) { it.lease.pin.replica == replica && it.lease.pin.anonymous } } }
        }
        scope.launch(storage, start = CoroutineStart.UNDISPATCHED) { engine.revisions().collect { accountSettled() } }
        sweep()
    }

    // At engine start, and when the account's transition ended or an account's replica went: what waited on them can be settled now, and a turn a process death left in its last round is recovered.
    fun sweep() {
        scope.launch(storage) {
            admitting.withLock {
                recoverNamed()
                sweepPictures()
                accountSettled()
            }
        }
    }

    // Phone-hosted Coach abilities §4.1, in order: the turn it opened, or null with the reason in `refusal` or `fault` and the draft kept. Nothing runs on the caller's thread. A question with `once` opens one turn however often it is asked, and answers that turn again. A question with `on` belongs to that replica, and opens on no other.
    suspend fun send(question: String, picture: ChosenPicture?, thread: Id<CoachThread>?, anonymous: Boolean, once: String? = null, on: String? = null): OpenTurn.Turn? = withContext(storage) {
        admitting.withLock { admit(question, picture, thread, anonymous, once, on) }
    }

    // Coach engine §5: Stop takes effect before the next round or the next call; the round in flight is read to its end.
    fun requestStop() {
        if (running == null) return
        stops.value = true
        runner.stop()
    }

    // The app stopped: a running turn's record takes its words now, off the main thread, since a death from here loses what it had not taken.
    fun appStopped() {
        val live = running ?: return
        scope.launch(storage) { attempted(Unit) { host.commitNow(live.lease) } }
    }

    // The seat is about to change (Coach engine §5): the running turn ends `interrupted` now, through `writer`, the training the change still lets write, before a sign-out sends what this phone holds, and the pass goes with the seat.
    suspend fun seatWillChange(writer: EngineTraining) {
        val live = running ?: return
        live.lease.writer = writer
        letGo(live)
    }

    // The engine hears of the change before the host lets go, so a write the host stops waiting on leaves the turn's end to the engine, which writes it through the lease's writer when it has one.
    private suspend fun letGo(live: LiveTurn) {
        try {
            coroutineScope {
                launch(start = CoroutineStart.UNDISPATCHED) { runner.seatWillChange() }
                live.lease.released = true
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (reported: Exception) {
            // The engine reported its host's fault under `agent-host`; the record left running is the sweep's to end.
        }
    }

    // A new seat hears nothing of the last one's sends, and the same words said to it again are news. A deployment without Coach is no seat's, and stays said.
    fun forgetSeat() {
        faulted.value = null
        refused.value = refused.value.takeIf { it == CoachTurnRefusal.Absent }
    }

    fun closeFault(fault: CoachTurnFault) { faulted.compareAndSet(fault, null) }

    // A send the room stopped on its way here ends in its one outcome as well.
    fun heldBack(fault: CoachTurnFault) = tells.heldBack(fault)

    // A conversation deleted from History; its pictures' files go after the commit. A conversation with a turn running stays.
    suspend fun deleteConversation(thread: Id<CoachThread>): Boolean = withContext(storage) {
        admitting.withLock {
            if (running?.lease?.turn?.thread == thread) return@withLock false
            onSeatInHand(false) { pin ->
                if (!training.mayWriteOn(pin)) return@onSeatInHand false
                training.pinnedOn(pin) { runner ->
                    when (val outcome = runner.run(DeleteConversation(thread))) {
                        is Outcome.Committed -> { pictures.delete(outcome.result); true }
                        is Outcome.Unchanged -> true
                        is Outcome.Refused -> false
                    }
                }
            }
        }
    }

    private suspend fun admit(question: String, picture: ChosenPicture?, thread: Id<CoachThread>?, anonymous: Boolean, once: String?, on: String?): OpenTurn.Turn? {
        // Each send answers for itself: what the last one met goes as this one is admitted.
        refused.value = null
        faulted.value = null
        if (running != null) return said(CoachTurnFault.busy)
        if (MeasureUnit.bytes.length(question) > CoachRules.maxQuestionBytes) return null
        if (!engine.status.state.value.online) return refusing(CoachTurnRefusal.Offline)
        val replica = engine.activeReplica()
        if (on != null && on != replica) return said(CoachTurnFault.accountChanging)
        val seat = try {
            seatCredentials(anonymous) ?: return said(CoachTurnFault.accountChanging)
        } catch (failure: Exception) {
            currentCoroutineContext().ensureActive()
            val answered = seatRefusal(failure)
            if (answered != null) return refusing(answered)
            return said(CoachTurnFault.noAnswer)
        }
        val pin = ReplicaPin(replica, anonymous)
        if (!training.mayWriteOn(pin)) return said(CoachTurnFault.accountChanging)
        val arriving = attempted(null) { training.pinnedOn(pin) { runner -> runner.read(CoachMessage.scope) { !it.firstPullComplete() } } }
        if (arriving == null) return said(CoachTurnFault.accountChanging)
        if (arriving) return refusing(CoachTurnRefusal.LogArriving)
        interruptNamed()
        return opened(question, picture, thread, pin, seat, once)
    }

    // gym Coach on the AI service §6: signed out, the pass is asked with the installation credential alone; signed in, with the session and the installation credential beside it, so the pass can name the installation it was. Null while the account is between seats.
    private suspend fun seatCredentials(anonymous: Boolean): AiCredentials? {
        if (anonymous) return AiCredentials(null, installation.forAnonymousSend())
        val token = accountToken() ?: return null
        val held = try { installation.held() } catch (unreadable: Exception) { currentCoroutineContext().ensureActive(); null }
        return AiCredentials(token, held)
    }

    // A seat the phone could not take: no connection, or the installation the server refused by code. Anything else is this phone's own, which `AiInstallation` has reported.
    private fun seatRefusal(failure: Exception): CoachTurnRefusal? = when {
        failure is WindmillApiException.Refused -> CoachTurnRefusal.of(AiFailure("pass", failure.refusal.code ?: "unavailable", works.windmill.agent.coach.Admission.none), anonymous = true)
        failure is WindmillApiException.Timeout || TelemetryPolicy.networkLoss(failure) -> CoachTurnRefusal.Offline
        else -> null
    }

    // §4.1 step 2, then the engine. Past the commit nothing may stop the turn from starting: a caller that went away leaves it running, and `running` tells the next send.
    private suspend fun opened(question: String, picture: ChosenPicture?, thread: Id<CoachThread>?, pin: ReplicaPin, seat: AiCredentials, once: String?): OpenTurn.Turn? {
        val row: CoachPictureRow?
        try {
            profile.value
            row = picture?.let(pictures::keep)
            // The model copy is what a turn sends; one this phone cannot read now never reaches the engine.
            row?.let { pictures.model(it.id) ?: throw IOException("A picture's model copy is missing.") }
        } catch (failure: IOException) {
            tells.failure(TurnFault.storage)
            return said(CoachTurnFault.pictureUnavailable)
        } catch (failure: Exception) {
            tells.failure(TurnFault.storage)
            return said(CoachTurnFault.unsaved)
        }
        return withContext(NonCancellable) {
            val (turn, fresh) = try {
                training.pinnedOn(pin) { runner ->
                    if (row != null && runner.run(KeepPicture(row)) is Outcome.Refused) return@pinnedOn null
                    val onMessage = listOfNotNull(row?.let { Picture(it.id, PictureFiles.modelMediaType, localOnly = true) })
                    val opening = OpenTurn(thread, question, onMessage)
                    when (val outcome = runner.run(if (once == null) opening else OpenTurnOnce(once, opening))) {
                        is Outcome.Committed -> outcome.result to true
                        is Outcome.Unchanged -> outcome.result to false
                        is Outcome.Refused -> {
                            if (row != null) {
                                runner.run(ForgetPicture(row.id))
                                pictures.delete(listOf(row.id))
                            }
                            null
                        }
                    }
                }
            } catch (changed: TrainingRefused) {
                return@withContext said(CoachTurnFault.accountChanging)
            } catch (failure: Exception) {
                tells.failure(TurnFault.storage)
                return@withContext said(CoachTurnFault.unsaved)
            } ?: return@withContext said(CoachTurnFault.unsaved)
            if (fresh) {
                credentials = seat
                tells.started()
                launched(LiveTurn(GymTurn(turn, pin), if (pin.anonymous) SeatKind.anon else SeatKind.bound, question, picture, elapsedMs()), recover = false)
            } else takenBack.value = null
            turn
        }
    }

    // `running` is taken before this returns, so a seat change that follows finds the turn to end, whether the engine has begun it or not. A blank question is the picture's alone, which the profile's words stand for.
    private fun launched(live: LiveTurn, recover: Boolean) {
        running = live
        takenBack.value = null
        host.prepare(live.lease)
        val seat = if (live.lease.pin.anonymous) Seat.anon else Seat.bound
        val question = if (TextSpec.isBlank(live.question)) "" else live.question
        live.work = scope.launch(storage) {
            try {
                val end = try {
                    runner.run(TurnInput(live.lease.turnId, TurnSeat(live.seat, live.lease.pin.replica), question, emptyList()), profile.value.of(seat), recover)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (fault: Exception) {
                    // The engine reported the fault under `agent-host`, and a turn it could not begin leaves its records here.
                    return@launch unbegun(live, recover)
                }
                if (!live.lease.released) settled(end, live, recover)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                tells.failure(TurnFault.storage)
            } finally {
                if (running === live) running = null
            }
        }
        lease(live.work)
    }

    // How the engine's run came back, as the room will say it: a turn withdrawn returns to the field with what refused it; a failed end says what failed it. A run that wrote no end is the seat change's, or the record's that went, to settle.
    private suspend fun settled(end: TurnEnd?, live: LiveTurn, recover: Boolean) {
        val failure = ai.failure
        ai.failure = null
        if (end == null) {
            if (recover) forgetIfEnded(live.lease)
            return
        }
        val anonymous = live.lease.pin.anonymous
        val refusal = when {
            live.lease.withdrawn -> failure?.takeIf { it.code != null }?.let { CoachTurnRefusal.of(it, anonymous) } ?: CoachTurnRefusal.Offline
            end.state == EndState.failed -> CoachTurnRefusal.of(failure?.takeIf { it.code == end.code } ?: AiFailure("engine", end.code, works.windmill.agent.coach.Admission.possible), anonymous)
            else -> null
        }
        failure?.code?.let { installationAnswered(it) }
        if (!recover) tells.settled(end.state, refusal, elapsedMs() - live.started)
        faulted.value = null
        if (live.lease.withdrawn) {
            refused.value = refusal
            takenBack.value = WithdrawnTurn(live.question, live.picture, live.lease.turn.thread.takeIf { live.lease.threadStands })
            return
        }
        refused.value = refusal.takeUnless { it == CoachTurnRefusal.Unanswered }
    }

    // A turn the host failed before the engine held it: a send goes back to the field, its records with it, and says Coach did not answer; a recovery ends interrupted.
    private suspend fun unbegun(live: LiveTurn, recover: Boolean) {
        val turn = live.lease.turn
        attempted(Unit) {
            withContext(NonCancellable) {
                training.pinnedOn(live.lease.pin) { runner ->
                    if (recover) runner.run(EndTurn(turn.coach, MessageState.interrupted))
                    else {
                        when (val withdrawn = runner.run(WithdrawTurn(turn))) {
                            is Outcome.Committed -> pictures.delete(withdrawn.result)
                            else -> Unit
                        }
                        live.lease.threadStands = runner.read(CoachMessage.scope) { it.repository(CoachThread).find(turn.thread, ViewMode.drawn) != null }
                    }
                }
            }
        }
        if (recover) return
        tells.settled(EndState.failed, null, elapsedMs() - live.started)
        faulted.value = CoachTurnFault.noAnswer
        takenBack.value = WithdrawnTurn(live.question, live.picture, turn.thread.takeIf { live.lease.threadStands })
    }

    // What the pass door or the AI service says of this installation stands across launches. `AiInstallation` reports a store that could not keep it.
    private suspend fun installationAnswered(code: String) {
        try {
            if (code == "device_bound") installation.markBound()
            if (code == "invalid_installation") installation.markInvalid()
        } catch (failure: Exception) {
            currentCoroutineContext().ensureActive()
        }
    }

    // Coach engine §5, the seat changes: the turn ends with it, and its round in flight may drain afterward with nothing left to write. A commit can outlive the change, so the record is read again before anything is written, under the seat now active. A turn opened since, under the seat that replaced this one, is not this change's.
    private suspend fun seatChanged(previous: String?, ranUnder: (LiveTurn) -> Boolean) {
        val left = admitting.withLock { running?.takeIf(ranUnder) }
        if (left != null) {
            letGo(left)
            if (running === left) running = null
        }
        admitting.withLock {
            if (left != null) interruptLeft(left, previous)
            interruptNamed()
            sweepPictures()
            accountSettled()
        }
    }

    // The account's change a send met is over once the seat in hand may write again, and its sentence goes with it, so Send comes back with no gesture: at every revision, and at each sweep for what no revision marks.
    private suspend fun accountSettled() {
        attempted(Unit) {
            if (faulted.value == CoachTurnFault.accountChanging && training.mayWrite) faulted.value = null
        }
    }

    // The engine told of the turn as it let go; the record left running under the seat that went ends here.
    private suspend fun interruptLeft(left: LiveTurn, previous: String?) {
        onSeatInHand(Unit) { pin ->
            training.pinnedOn(pin) { runner ->
                val found = runner.read(CoachMessage.scope) { it.repository(CoachMessage).find(left.lease.turn.coach, ViewMode.drawn) }
                if (found != null && found.replica == previous && training.mayWriteOn(pin)) interrupt(runner, found)
            }
        }
    }

    // Coach engine §5, the process ends: a turn the mark names, while its writer has not ended it, is recovered when its last round's answer can still be read, and ended `interrupted` otherwise; the engine decides which. A mark naming a message that ended lets go of it, and so does one naming a message gone from a replica that would know.
    private suspend fun recoverNamed() {
        if (running != null) return
        onSeatInHand(Unit) { pin ->
            if (!training.mayWriteOn(pin)) return@onSeatInHand
            val named = training.pinnedOn(pin) { runner ->
                val named = runner.read(CoachMessage.scope) { it.device(EndTurn.runningTurnKey)?.let(::messageId) } ?: return@pinnedOn null
                val message = runner.read(CoachMessage.scope) { it.repository(CoachMessage).find(named, ViewMode.drawn) }
                val replica = runner.read(CoachMessage.scope) { it.replica }
                when {
                    message == null -> { if (runner.read(CoachMessage.scope) { it.caughtUpWithItsLog }) runner.run(ForgetRunningTurn(named)); null }
                    message.writersOwn(replica, runner.read(CoachMessage.scope) { Mark.read(it) }) -> message
                    else -> { runner.run(ForgetRunningTurn(named)); null }
                }
            } ?: return@onSeatInHand
            val seat = try { seatCredentials(pin.anonymous) } catch (refused: Exception) { currentCoroutineContext().ensureActive(); null }
            if (seat == null) {
                val ended = training.pinnedOn(pin) { runner -> interrupt(runner, named) }
                if (ended && told.add(named.id)) tells.processEnded(if (pin.anonymous) SeatKind.anon else SeatKind.bound, named)
                return@onSeatInHand
            }
            credentials = seat
            launched(LiveTurn(GymTurn(OpenTurn.Turn(named.threadId, named.id, named.id), pin), if (pin.anonymous) SeatKind.anon else SeatKind.bound, "", null, elapsedMs()), recover = true)
        }
    }

    // A recovery the engine found nothing to run for: the mark goes once its message has ended.
    private suspend fun forgetIfEnded(lease: GymTurn) {
        onSeatInHand(Unit) { pin ->
            if (pin != lease.pin || !training.mayWriteOn(pin)) return@onSeatInHand
            training.pinnedOn(pin) { runner ->
                val message = runner.read(CoachMessage.scope) { it.repository(CoachMessage).find(lease.turn.coach, ViewMode.drawn) }
                if (message == null || !runner.read(CoachMessage.scope) { message.writersOwn(it.replica, Mark.read(it)) }) runner.run(ForgetRunningTurn(lease.turn.coach))
            }
        }
    }

    // A running Coach message the device row names, when nothing runs on this phone, ended with whatever ran it, and this tells of it unless this process already did. A row naming a message that ended lets go of it, and so does one naming a message gone from a replica that would know.
    private suspend fun interruptNamed() {
        if (running != null) return
        onSeatInHand(Unit) { pin ->
            if (!training.mayWriteOn(pin)) return@onSeatInHand
            val ended = training.pinnedOn(pin) { runner ->
                val named = runner.read(CoachMessage.scope) { it.device(EndTurn.runningTurnKey)?.let(::messageId) } ?: return@pinnedOn null
                val message = runner.read(CoachMessage.scope) { it.repository(CoachMessage).find(named, ViewMode.drawn) }
                when {
                    message == null -> if (runner.read(CoachMessage.scope) { it.caughtUpWithItsLog }) runner.run(ForgetRunningTurn(named))
                    interrupt(runner, message) -> return@pinnedOn message
                    else -> runner.run(ForgetRunningTurn(named))
                }
                null
            }
            if (ended != null && told.add(ended.id)) tells.processEnded(if (pin.anonymous) SeatKind.anon else SeatKind.bound, ended)
        }
    }

    // Whether this ended a message still running. A record that refuses its own end is a defect of this phone's turn.
    private fun interrupt(runner: ActionRunner, message: CoachMessage): Boolean {
        if (message.state != MessageState.running) return false
        if (runner.run(EndTurn(message.id, MessageState.interrupted)) is Outcome.Refused) tells.failure(TurnFault.refusal)
        return true
    }

    private fun messageId(named: Json): Id<CoachMessage>? = try {
        Id(RecordID(named), CoachMessage)
    } catch (_: JsonError) {
        null
    }

    // Rows no message claims go first, while the account allows a write; a pass that meets a message this build cannot read forgets nothing, says so, and the next sweep tries again. Then the files no row in any retained replica names, which takes no write and no permission.
    private suspend fun sweepPictures() {
        onSeatInHand(Unit) { pin ->
            if (engine.retainedDeviceKeys(gymProduct, pictureKeys).isNotEmpty() && training.mayWriteOn(pin)) {
                val pass = training.pinnedOn(pin) { it.run(ForgetUnclaimedPictures()) }
                if (pass.refusal == ForgetUnclaimedPictures.messageUnreadable) tells.pictureSweepHeld()
            }
            val held = pictures.held()
            if (held.isEmpty()) return@onSeatInHand
            val named = engine.retainedDeviceKeys(gymProduct, pictureKeys)
            pictures.delete(held.filter { CoachPictureRow.key(it) !in named })
        }
    }

    // One settling step on the seat in hand, which cancellation never cuts short.
    private suspend fun <T> onSeatInHand(otherwise: T, step: suspend (ReplicaPin) -> T): T = attempted(otherwise) {
        withContext(NonCancellable) { step(training.pin()) }
    }

    // A store that failed is reported; a transition that closed the door is no failure, and what waited on it runs at the next sweep.
    private suspend fun <T> attempted(otherwise: T, work: suspend () -> T): T = try {
        work()
    } catch (changed: TrainingRefused) {
        otherwise
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: Exception) {
        tells.failure(TurnFault.storage)
        otherwise
    }

    private fun refusing(refusal: CoachTurnRefusal): OpenTurn.Turn? {
        refused.value = refusal
        faulted.value = null
        tells.refused(refusal)
        return null
    }

    private fun said(fault: CoachTurnFault): OpenTurn.Turn? {
        faulted.value = fault
        tells.heldBack(fault)
        return null
    }

    companion object {
        private const val gymProduct = "gym"
        private const val catalogAsset = "gym-catalog.json"
        private val pictureKeys = CoachPictureRow.key("")

        // Composed for the application. Nothing here touches disk or the network: the catalog and the words parse, the picture folder appears and the AI service is first asked at the first send. The pass is asked with the seat the send admitted, and every AI call goes to the API origin the phone already talks to; a debug build may reach a local stack over plain HTTP.
        fun onThisDevice(context: Context, training: EngineTraining, baseUrl: HttpUrl, installation: AiInstallation, accountToken: () -> String?,
            shares: () -> GymRest?, lease: TurnLease, telemetry: Telemetry, scope: CoroutineScope, localHttp: Boolean): CoachTurns {
            val application = context.applicationContext
            lateinit var turns: CoachTurns
            val transport = AiHttp(baseUrl.newBuilder().encodedPath("/").query(null).build(), { turns.credentials }, allowLocalHttp = localHttp)
            turns = CoachTurns(training, transport, installation, accountToken,
                PictureFiles { File(application.noBackupFilesDir, "coach-pictures") },
                lazy { Catalog(application.assets.open(catalogAsset).use { Json.parse(it.readBytes()) }) },
                lazy { CoachWords.shipped(application.assets) },
                telemetry, lease::hold, baseUrl.toString().trimEnd('/'), shares, scope)
            return turns
        }
    }
}
