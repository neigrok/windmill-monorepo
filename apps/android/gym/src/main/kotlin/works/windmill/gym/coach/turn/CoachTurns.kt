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
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import works.windmill.agent.SeatKind
import works.windmill.agent.TurnActivity
import works.windmill.agent.TurnDriver
import works.windmill.agent.TurnExit
import works.windmill.agent.TurnFailure
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnState
import works.windmill.agent.TurnTransport
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
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
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.coach.OpenTurnOnce
import works.windmill.gym.domain.coach.Picture
import works.windmill.gym.domain.coach.caughtUpWithItsLog
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.ReplicaPin
import works.windmill.gym.store.TrainingRefused
import works.windmill.platform.agent.TurnHttp
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.TelemetryPolicy
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RecordID
import works.windmill.sync.schema.SyncSchema

// The answer so far on the running Coach message, ahead of what its record holds.
data class LiveAnswer(val message: Id<CoachMessage>, val text: String)

// A turn that never began, refused before any frame or never reaching the server: its records are gone, and this returns to the field. `thread` is null when the conversation went with the turn.
data class WithdrawnTurn(val question: String, val picture: ChosenPicture?, val thread: Id<CoachThread>?)

// The phone's Coach turns: one per application, never bound to a screen. It admits a question (§4.1), records it, runs the turn through the driver on a host pinned to its replica, and ends what a process death or a seat change left running (§4.5). All of it runs off the caller's thread, and admission, the sweeps and a seat change take turns.
class CoachTurns(
    private val training: EngineTraining,
    transport: TurnTransport,
    private val installation: AiInstallation,
    private val accountToken: () -> String?,
    val pictures: PictureFiles,
    val catalog: Lazy<Catalog>,
    telemetry: Telemetry,
    private val lease: (Job) -> Unit,
    private val appBaseUrl: String,
    private val scope: CoroutineScope,
    private val storage: CoroutineDispatcher = Dispatchers.IO,
    beat: Duration = 1.seconds,
    private val elapsedMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private class LiveTurn(val turn: OpenTurn.Turn, val pin: ReplicaPin, val seat: TurnSeat, val question: String, val picture: ChosenPicture?, val started: Long) {
        lateinit var work: Job
        @Volatile var abandoned = false
    }

    private val tells = GymTurnTelemetry(telemetry, catalog)
    private val turnScope = CoroutineScope(scope.coroutineContext + storage)
    private val driver = TurnDriver(transport, tells, turnScope, beat, recordEvery, elapsedMs)
    private val engine = training.engine
    private val started = AtomicBoolean(false)
    private val admitting = Mutex()
    private val runningTurn = MutableStateFlow<OpenTurn.Turn?>(null)
    private val told = ConcurrentHashMap.newKeySet<Id<CoachMessage>>()
    @Volatile private var running: LiveTurn? = null
        set(value) {
            field = value
            runningTurn.value = value?.turn
        }
    private val refused = MutableStateFlow<CoachTurnRefusal?>(null)
    private val faulted = MutableStateFlow<CoachTurnFault?>(null)
    private val takenBack = MutableStateFlow<WithdrawnTurn?>(null)

    val activity: StateFlow<TurnActivity?> get() = driver.activity
    // The one turn running on this phone, whichever chat it belongs to.
    val turn: StateFlow<OpenTurn.Turn?> = runningTurn.asStateFlow()
    // What the room draws on the running message. Its record takes the text every `recordEvery`, at each batch and at the end, since each commit syncs the whole text so far.
    val liveAnswer: StateFlow<LiveAnswer?> = driver.liveText.map { text -> if (text == null) null else running?.let { LiveAnswer(it.turn.coach, text) } }
        .stateIn(turnScope, SharingStarted.Eagerly, null)
    // How the last send was refused, said once at the conversation's end.
    val refusal: StateFlow<CoachTurnRefusal?> = refused.asStateFlow()
    // A fault of this phone's own, said in the band.
    val fault: StateFlow<CoachTurnFault?> = faulted.asStateFlow()
    // The last turn that never began.
    val withdrawn: StateFlow<WithdrawnTurn?> = takenBack.asStateFlow()

    // At engine start: every change of the seat from here on, a rebind under the same id among them, with the subscriptions in place when this returns, and the sweep.
    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch(storage, start = CoroutineStart.UNDISPATCHED) {
            engine.activeReplicaChanges().collect { change -> attempted(Unit) { seatChanged(change.previous) { it.pin.replica == change.previous } } }
        }
        scope.launch(storage, start = CoroutineStart.UNDISPATCHED) {
            engine.activeReplicaRebinds().collect { replica -> attempted(Unit) { seatChanged(replica) { it.pin.replica == replica && it.pin.anonymous } } }
        }
        scope.launch(storage, start = CoroutineStart.UNDISPATCHED) { engine.revisions().collect { accountSettled() } }
        sweep()
    }

    // At engine start, and when the account's transition ended or an account's replica went: what waited on them can be settled now.
    fun sweep() {
        scope.launch(storage) {
            admitting.withLock {
                interruptNamed()
                sweepPictures()
                accountSettled()
            }
        }
    }

    // §4.1, in order: the turn it opened, or null with the reason in `refusal` or `fault` and the draft kept. Nothing runs on the caller's thread. A question with `once` opens one turn however often it is asked, and answers that turn again. A question with `on` belongs to that replica, and opens on no other.
    suspend fun send(question: String, picture: ChosenPicture?, thread: Id<CoachThread>?, anonymous: Boolean, once: String? = null, on: String? = null): OpenTurn.Turn? = withContext(storage) {
        admitting.withLock { admit(question, picture, thread, anonymous, once, on) }
    }

    fun requestStop() = driver.requestStop()

    // The app stopped: a running turn's record takes its words now, off the main thread, since a death from here loses what it had not taken.
    fun appStopped() = driver.commitNow()

    // A new seat hears nothing of the last one's sends, and the same words said to it again are news. A deployment without Coach is no seat's, and stays said.
    fun forgetSeat() {
        faulted.value = null
        refused.value = refused.value.takeIf { it == CoachTurnRefusal.Absent }
    }

    // A send the room stopped on its way here ends in its one outcome as well.
    fun heldBack(fault: CoachTurnFault) = tells.heldBack(fault)

    // A conversation deleted from History; its pictures' files go after the commit. A conversation with a turn running stays.
    suspend fun deleteConversation(thread: Id<CoachThread>): Boolean = withContext(storage) {
        admitting.withLock {
            if (running?.turn?.thread == thread) return@withLock false
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
            if (anonymous) TurnSeat.Anon(installation.forAnonymousSend()) else TurnSeat.Bound(accountToken() ?: return said(CoachTurnFault.accountChanging))
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

    // A seat the phone could not take: no connection, or the installation the server refused by code. Anything else is this phone's own, which `AiInstallation` has reported.
    private fun seatRefusal(failure: Exception): CoachTurnRefusal? = when {
        failure is WindmillApiException.Refused -> CoachTurnRefusal.of(failure.refusal.code ?: "unavailable", failure.status)
        failure is WindmillApiException.Timeout || TelemetryPolicy.networkLoss(failure) -> CoachTurnRefusal.Offline
        else -> null
    }

    // §4.1 step 2, then the driver. Past the commit nothing may stop the turn from starting: a caller that went away leaves it running, and `running` tells the next send.
    private suspend fun opened(question: String, picture: ChosenPicture?, thread: Id<CoachThread>?, pin: ReplicaPin, seat: TurnSeat, once: String?): OpenTurn.Turn? {
        val abilities: Catalog
        val row: CoachPictureRow?
        try {
            abilities = catalog.value
            row = picture?.let(pictures::keep)
        } catch (failure: IOException) {
            tells.failure(TurnFailure.storage, null)
            return said(CoachTurnFault.pictureUnavailable)
        } catch (failure: Exception) {
            tells.failure(TurnFailure.storage, null)
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
                tells.failure(TurnFailure.storage, null)
                return@withContext said(CoachTurnFault.unsaved)
            } ?: return@withContext said(CoachTurnFault.unsaved)
            if (fresh) launched(LiveTurn(turn, pin, seat, question, picture, elapsedMs()), abilities) else takenBack.value = null
            turn
        }
    }

    // The driver's slot is taken before this returns, so a seat change that follows finds the turn to abandon.
    private fun launched(live: LiveTurn, abilities: Catalog) {
        running = live
        takenBack.value = null
        tells.started()
        val host = GymTurnHost(live.turn, live.question, live.pin, training, abilities, pictures, appBaseUrl, storage)
        live.work = scope.launch(storage, start = CoroutineStart.UNDISPATCHED) {
            try {
                val exit = driver.run(host.turnId, live.seat, host)
                live.abandoned = exit == TurnExit.abandoned
                settled(exit, live, host)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                tells.failure(TurnFailure.storage, null)
            } finally {
                running = null
            }
        }
        lease(live.work)
    }

    // How the run came back, as the room will say it. An abandon is the seat change's to settle.
    private suspend fun settled(exit: TurnExit, live: LiveTurn, host: GymTurnHost) {
        when (exit) {
            TurnExit.ended -> {
                val end = checkNotNull(host.ending)
                val code = end.code
                if (code != null) installationAnswered(code)
                val answer = if (end.state == TurnState.failed) code?.let { CoachTurnRefusal.of(it, resetsAtMs = end.budgetResetsAtMs, spent = end.spent) } else null
                refused.value = answer.takeUnless { it == CoachTurnRefusal.Unanswered }
                faulted.value = null
            }
            TurnExit.withdrawn -> {
                val refusal = checkNotNull(host.withdrawal)
                installationAnswered(refusal.code)
                refused.value = CoachTurnRefusal.of(refusal.code, refusal.status, refusal.budgetResetsAtMs, refusal.spent)
                faulted.value = null
                takenBack.value = WithdrawnTurn(live.question, live.picture, live.turn.thread.takeIf { host.threadStands })
            }
            TurnExit.stoppedOffline -> faulted.value = CoachTurnFault.stoppedOffline
            TurnExit.stopUnheard -> faulted.value = CoachTurnFault.stopUnheard
            TurnExit.abandoned -> Unit
        }
    }

    // What the server says of this installation stands across launches. `AiInstallation` reports a store that could not keep it.
    private suspend fun installationAnswered(code: String) {
        try {
            if (code == "device_bound" || code == "installation_bound") installation.markBound()
            if (code == "invalid_installation") installation.markInvalid()
        } catch (failure: Exception) {
            currentCoroutineContext().ensureActive()
        }
    }

    // §4.5 Writer, D-10: the seat changed under the turn, so its stream ended with it. A commit can outlive the cancellation, so the record is read again before anything is written, under the seat now active. A turn opened since, under the seat that replaced this one, is not this change's.
    private suspend fun seatChanged(previous: String?, ranUnder: (LiveTurn) -> Boolean) {
        val left = admitting.withLock { running?.takeIf(ranUnder) }
        if (left != null) {
            driver.abandon()
            left.work.join()
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

    private suspend fun interruptLeft(left: LiveTurn, previous: String?) {
        val message = onSeatInHand(null) { pin ->
            training.pinnedOn(pin) { runner ->
                val found = runner.read(CoachMessage.scope) { it.repository(CoachMessage).find(left.turn.coach, ViewMode.drawn) }
                if (found != null && found.replica == previous && training.mayWriteOn(pin)) interrupt(runner, found)
                found
            }
        }
        if (left.abandoned && told.add(left.turn.coach)) tells.interrupted(left.seat.kind, InterruptedCause.seat_changed, message, elapsedMs() - left.started)
    }

    // §4.5: a running Coach message the device row names, when nothing runs, ended with whatever ran it, and this tells of it unless this process already did. A row naming a message that ended lets go of it, and so does one naming a message gone from a replica that would know.
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
            if (ended != null && told.add(ended.id)) tells.interrupted(if (pin.anonymous) SeatKind.anon else SeatKind.bound, InterruptedCause.process_ended, ended, null)
        }
    }

    // Whether this ended a message still running. A record that refuses its own end is a defect of this phone's turn.
    private fun interrupt(runner: ActionRunner, message: CoachMessage): Boolean {
        if (message.state != MessageState.running) return false
        if (runner.run(EndTurn(message.id, MessageState.interrupted)) is Outcome.Refused) tells.failure(TurnFailure.refusal, null)
        return true
    }

    private fun messageId(named: Json): Id<CoachMessage>? = try {
        Id(RecordID(named), CoachMessage)
    } catch (_: JsonError) {
        null
    }

    // Rows no message claims go first, while the account allows a write. Then the files no row in any retained replica names, which takes no write and no permission.
    private suspend fun sweepPictures() {
        onSeatInHand(Unit) { pin ->
            if (engine.retainedDeviceKeys(gymProduct, pictureKeys).isNotEmpty() && training.mayWriteOn(pin)) {
                training.pinnedOn(pin) { it.run(ForgetUnclaimedPictures()) }
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
        tells.failure(TurnFailure.storage, null)
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
        private const val route = "/v1/gym/coach/turns"
        private val recordEvery = 5.seconds
        private val pictureKeys = CoachPictureRow.key("")

        // Composed for the application. Nothing here touches disk or the network, and `client` is one the caller already paid for: the catalog parses, the picture folder appears and the wire opens at the first send.
        fun onThisDevice(context: Context, training: EngineTraining, baseUrl: HttpUrl, client: OkHttpClient, installation: AiInstallation, accountToken: () -> String?,
            lease: TurnLease, telemetry: Telemetry, scope: CoroutineScope): CoachTurns {
            val application = context.applicationContext
            return CoachTurns(training, TurnHttp(baseUrl, route, SyncSchema.version.toInt(), client), installation, accountToken,
                PictureFiles { File(application.noBackupFilesDir, "coach-pictures") },
                lazy { Catalog(application.assets.open(catalogAsset).use { Json.parse(it.readBytes()) }) },
                telemetry, lease::hold, baseUrl.toString().trimEnd('/'), scope)
        }
    }
}
