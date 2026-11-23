package works.windmill.gym.coach.turn

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import works.windmill.agent.coach.AbilityReport
import works.windmill.agent.coach.CallIdentity
import works.windmill.agent.coach.HostLease
import works.windmill.agent.coach.HostUnavailable
import works.windmill.agent.coach.Mark
import works.windmill.agent.coach.Opened
import works.windmill.agent.coach.Picture as TurnPicture
import works.windmill.agent.coach.Recovery
import works.windmill.agent.coach.ToolCall
import works.windmill.agent.coach.ToolHost
import works.windmill.agent.coach.ToolOutcome
import works.windmill.agent.coach.TurnEnd
import works.windmill.agent.coach.TurnInput
import works.windmill.agent.coach.Seat as TurnSeat
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.JsonSchema
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.Seat
import works.windmill.gym.domain.coach.AbilityOutcome
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.AbilityRequest
import works.windmill.gym.domain.coach.BeginRound
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.ForgetRunningTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.coach.RecordShareCall
import works.windmill.gym.domain.coach.RecoverMark
import works.windmill.gym.domain.coach.RunAbility
import works.windmill.gym.domain.coach.StreamTurnText
import works.windmill.gym.domain.coach.WithdrawTurn
import works.windmill.gym.domain.coach.contextPictures
import works.windmill.gym.domain.coach.history
import works.windmill.gym.domain.coach.LogRead
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.TrainingLog
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.ReplicaPin
import works.windmill.gym.store.TrainingRefused
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.TelemetryPolicy
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.Sha256

// A call the turn makes of itself at its opening, before the model has asked for anything (gym Coach on the AI service §4.1).
const val contextCallPrefix = "context-"

// The answer so far on the running Coach message, ahead of what its record holds.
data class LiveAnswer(val message: Id<CoachMessage>, val text: String)

// One turn's records and the seat it runs on: the engine's lease. Every write checks the seat inside its commit, so a write that outlives a change of seat lands on no other replica.
class GymTurn(val turn: OpenTurn.Turn, val pin: ReplicaPin) : HostLease {
    val turnId: String = checkNotNull(turn.coach.record.string) { "a Coach message's id is a string" }
    val seat: Seat get() = if (pin.anonymous) Seat.anon else Seat.bound
    // The seat is changing: a write that waits on the account stops waiting, and the end goes through `writer`.
    @Volatile var released = false
    @Volatile var writer: EngineTraining? = null
    @Volatile var withdrawn = false
    // Whether the conversation stands once the turn is taken back; it goes with a turn that was all it held.
    @Volatile var threadStands = true
    @Volatile var textCommitted = ""
    @Volatile var committedAtMs = 0L
    // The commit that takes the words a pause left behind, once the pace comes round.
    @Volatile var trailing: Job? = null
}

// What gym does in a turn the engine runs (gym Coach on the AI service §4): it opens with the context reads, the history and the pictures; runs every call through the replica executor, or a share through the Share door; writes the text at its pace and the mark at each round; and ends, withdraws or recovers the turn, each in one local write on the turn's seat. Each step runs on the storage dispatcher, and cancellation never cuts a commit short.
class GymTurnHost(
    private val training: EngineTraining,
    private val catalog: Lazy<Catalog>,
    private val profile: Lazy<GymProfile>,
    private val pictures: PictureFiles,
    private val shares: () -> GymRest?,
    private val appBaseUrl: String,
    private val tells: GymTurnTelemetry,
    private val scope: CoroutineScope,
    private val storage: CoroutineDispatcher,
    private val elapsedMs: () -> Long,
    private val textEvery: Duration = 5.seconds,
    private val accountWait: Duration = 1.seconds,
) : ToolHost {
    // One turn runs at a time, so one waits for the engine at a time.
    @Volatile private var next: GymTurn? = null
    private val live = MutableStateFlow<LiveAnswer?>(null)

    // What the room draws on the running message, at every delta; the record takes it at the pace above, at each round and at the end.
    val answer: StateFlow<LiveAnswer?> = live.asStateFlow()

    // The turn the engine opens or recovers next under this id: written by the send that admitted it, or named by the mark a process death left.
    fun prepare(lease: GymTurn) {
        next = lease
    }

    override suspend fun open(input: TurnInput): Opened {
        val lease = taken(input.turnId) ?: throw HostUnavailable()
        live.value = LiveAnswer(lease.turn.coach, "")
        val workout = onReplica(lease) { runner -> runner.read(CoachMessage.scope) { TrainingLog(it).open?.id } }
        val reads = CoachTurnBounds.contextReads.map { it to contextInputs.getValue(it) } +
            listOfNotNull(workout?.let { "get_session" to Json.objectOf("sessionId" to it.json, "review" to Json.of(false)) })
        val context = mutableListOf<String>()
        var bytes = 0
        for ((name, input) in reads) {
            val answered = ability(lease, AbilityRequest(contextCallPrefix + name, name, input))
            tells.ability(AbilityReport(name, if (answered is AbilityOutcome.Result) "ok" else "refused", (answered as? AbilityOutcome.Refused)?.code?.code))
            if (answered is AbilityOutcome.Result && bytes + answered.jcs.size <= CoachTurnBounds.contextReadBytes) {
                bytes += answered.jcs.size
                context += profile.value.context(name, answered.jcs)
            }
        }
        val (messages, rows) = onReplica(lease) { runner ->
            runner.read(CoachMessage.scope) { read ->
                val messages = read.repository(CoachMessage).children(lease.turn.thread, "threadId", ViewMode.drawn)
                messages to messages.contextPictures(lease.turn.lifter).mapNotNull { CoachPictureRow.decode(it.id, read.device(CoachPictureRow.key(it.id))) }
            }
        }
        // The AI service names a picture it holds for the turn by an id of its own form; the picture's digest is one, whatever id its message gave it.
        val attached = withContext(storage) {
            rows.mapNotNull { row -> pictures.model(row.id)?.let { TurnPicture(Sha256.hex(row.id.encodeToByteArray()), PictureFiles.modelMediaType, it) } }
        }
        return Opened(lease, profile.value.history(messages.history(lease.turn.coach)), context, attached)
    }

    // Coach engine §5, the process ends: the turn the mark names, while its writer has not ended it, with the round the mark holds. A stale or malformed round row is cleared on the way.
    override suspend fun recover(turnId: String, seat: TurnSeat): Recovery? {
        val held = taken(turnId)
        val pin = withContext(storage) { training.pin() }
        val found = withContext(storage) {
            withContext(NonCancellable) {
                try {
                    training.pinnedOn(pin) { runner ->
                        val mark = when (val read = runner.run(RecoverMark())) {
                            is Outcome.Committed -> read.result
                            is Outcome.Unchanged -> read.result
                            is Outcome.Refused -> return@pinnedOn null
                        }
                        if (mark.turnId != turnId) return@pinnedOn null
                        val message = runner.read(CoachMessage.scope) { it.repository(CoachMessage).find(Id(RecordID(Json.of(turnId)), CoachMessage), ViewMode.drawn) }
                            ?: return@pinnedOn null
                        Triple(mark, message, runner.read(CoachMessage.scope) { it.replica })
                    }
                } catch (_: TrainingRefused) { null }
            }
        } ?: return null
        val (mark, message, replica) = found
        // The lease the recovery was prepared with, so a seat change releases it; a recovered turn is never withdrawn and opens nothing, so its lifter's message is never read, and the Coach message stands for it.
        val lease = (held ?: GymTurn(OpenTurn.Turn(message.threadId, message.id, message.id), pin)).also { it.textCommitted = message.text }
        val state = if (message.writersOwn(replica, mark)) MessageState.running.name else message.state.name
        if (state == MessageState.running.name) live.value = LiveAnswer(message.id, message.text)
        return Recovery(lease, state, message.text, Mark(turnId, mark.callId, mark.textBytesBeforeRound))
    }

    override suspend fun beginRound(lease: HostLease, text: String, mark: Mark) {
        val turn = lease as GymTurn
        commit(turn, text)
        onReplica(turn) { runner -> runner.run(BeginRound(turn.turn.coach, checkNotNull(mark.callId), mark.textBytesBeforeRound)).answered(runner, turn) }
    }

    // The room draws every delta; the record takes the words at the pace, and the words a pause leaves when the pace comes round.
    override suspend fun text(lease: HostLease, text: String) {
        val turn = lease as GymTurn
        live.value = LiveAnswer(turn.turn.coach, text)
        val wait = turn.committedAtMs + textEvery.inWholeMilliseconds - elapsedMs()
        if (wait <= 0) return commit(turn, text)
        if (turn.trailing?.isActive == true) return
        turn.trailing = scope.launch(storage) {
            delay(wait)
            try { commitNow(turn) }
            catch (_: HostUnavailable) { }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { tells.failure(TurnFault.storage) }
        }
    }

    // The app is leaving the screen, and a death from here loses what the last commit had not taken: the record takes the words so far now.
    suspend fun commitNow(lease: GymTurn) {
        val text = live.value?.takeIf { it.message == lease.turn.coach }?.text ?: return
        commit(lease, text)
    }

    override suspend fun check(lease: HostLease, rule: String, call: ToolCall): String? {
        val turn = lease as GymTurn
        val ability = catalog.value.ability(call.name) ?: return AbilityRefusal.notOffered.code
        return when (rule) {
            "seat" -> if (ability.admits(turn.seat)) null else AbilityRefusal.seatRequired.code
            "shape" -> if (JsonSchema(ability.input).fault(call.input) == null) null else AbilityRefusal.invalidInput.code
            else -> null
        }
    }

    override suspend fun execute(lease: HostLease, identity: CallIdentity, call: ToolCall): ToolOutcome {
        val turn = lease as GymTurn
        val request = AbilityRequest(call.id, call.name, call.input)
        val outcome = if (call.name in RunAbility.serverRun) share(turn, request) else ability(turn, request)
        return when (outcome) {
            is AbilityOutcome.Result -> ToolOutcome.Ok(outcome.jcs.decodeToString())
            is AbilityOutcome.Refused -> ToolOutcome.Refused(outcome.code.code)
        }
    }

    override suspend fun end(lease: HostLease, end: TurnEnd) {
        val turn = lease as GymTurn
        turn.trailing?.cancel()
        val ending = EndTurn(turn.turn.coach, MessageState.valueOf(end.state.name), end.text, end.truncated)
        try {
            closing(turn) { runner -> runner.run(ending).answered(runner, turn) }
        } finally {
            live.compareAndSet(live.value?.takeIf { it.message == turn.turn.coach }, null)
        }
    }

    override suspend fun withdraw(lease: HostLease) {
        val turn = lease as GymTurn
        turn.trailing?.cancel()
        turn.withdrawn = true
        try {
            closing(turn) { runner ->
                pictures.delete(runner.run(WithdrawTurn(turn.turn)).answered(runner, turn))
                turn.threadStands = runner.read(CoachMessage.scope) { it.repository(CoachThread).find(turn.turn.thread, ViewMode.drawn) != null }
            }
        } finally {
            live.compareAndSet(live.value?.takeIf { it.message == turn.turn.coach }, null)
        }
    }

    private fun taken(turnId: String): GymTurn? = next?.takeIf { it.turnId == turnId }.also { next = null }

    // The record takes the text so far, when it holds less.
    private suspend fun commit(turn: GymTurn, text: String) {
        turn.committedAtMs = elapsedMs()
        if (text == turn.textCommitted) return
        onReplica(turn) { runner -> runner.run(StreamTurnText(turn.turn.coach, text)).answered(runner, turn) }
        turn.textCommitted = text
    }

    private suspend fun ability(turn: GymTurn, request: AbilityRequest): AbilityOutcome = onReplica(turn) { runner ->
        runner.run(RunAbility(request, turn.turn.coach, turn.seat, catalog.value, appBaseUrl)).answered(runner, turn)
    }

    // §4.3: a share is the server's record, made through the door the Share sheet calls. The door answers one refusal for a workout it does not know and one with no share, and the model reads that one code; a door this phone could not reach is the same refusal, and a fault of the server's or this phone's is reported.
    private suspend fun share(turn: GymTurn, request: AbilityRequest): AbilityOutcome {
        val sessionId = request.input.member("sessionId").str()
        val door = shares()
        val outcome = if (door == null) AbilityOutcome.Refused(AbilityRefusal.refused) else try {
            if (request.name == "share_session") {
                val made = door.share(sessionId)
                val url = made.url?.takeIf { it.isNotEmpty() } ?: "${appBaseUrl.removeSuffix("/")}/#/gym/shared/${made.token}"
                AbilityOutcome.Result(Json.objectOf("url" to Json.of(url), "token" to Json.of(made.token), "expiresAt" to Json.of(made.expiresAtMs)).jcs.encodeToByteArray())
            } else {
                door.revokeShare(sessionId)
                AbilityOutcome.Result(Json.objectOf("revoked" to Json.of(true), "sessionId" to Json.of(sessionId)).jcs.encodeToByteArray())
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            val expected = failure is WindmillApiException.Refused && failure.status in 400..499 || failure is WindmillApiException.Timeout || TelemetryPolicy.networkLoss(failure)
            if (!expected) tells.failure(TurnFault.share)
            AbilityOutcome.Refused(AbilityRefusal.refused)
        }
        return onReplica(turn) { runner -> runner.run(RecordShareCall(request, turn.turn.coach, outcome)).answered(runner, turn) }
    }

    // The end and the withdraw write through the training the seat change hands over, when one does, and wait on nothing.
    private suspend fun <T> closing(turn: GymTurn, work: (ActionRunner) -> T): T {
        val writer = turn.writer ?: return onReplica(turn, work)
        return withContext(storage) {
            withContext(NonCancellable) {
                try { writer.pinnedOn(turn.pin, work) } catch (_: TrainingRefused) { throw HostUnavailable() }
            }
        }
    }

    // A refusal of the turn's own record is no outcome of any call: it ends the turn. Gone, a conversation deleted on another phone took it, which is nobody's fault, and the mark lets go of it; anything else this phone's turn did wrong, and is reported.
    private fun <T> Outcome<T, GymRefusal>.answered(runner: ActionRunner, turn: GymTurn): T = when (this) {
        is Outcome.Committed -> result
        is Outcome.Unchanged -> result
        is Outcome.Refused -> {
            if ((refusal as? GymRefusal.Gone)?.subject == turn.turn.coach.ref) runner.run(ForgetRunningTurn(turn.turn.coach))
            else tells.failure(TurnFault.refusal)
            throw HostUnavailable()
        }
    }

    // The turn's one door to its seat. While the account is in a transition, which a sign-out sheet holds open and its Cancel ends, or a sign-in waits on its decision, the turn waits rather than dies: the transition ends, or the seat changes and releases the lease. A race lost to either lands here as the commit's own refusal.
    private suspend fun <T> onReplica(turn: GymTurn, work: (ActionRunner) -> T): T {
        while (true) {
            if (turn.released) throw HostUnavailable()
            try {
                if (withContext(storage) { training.mayWriteOn(turn.pin) }) return withContext(storage) { withContext(NonCancellable) { training.pinnedOn(turn.pin, work) } }
            } catch (_: TrainingRefused) {
                // The race lost; the wait covers it.
            }
            delay(accountWait)
        }
    }

    private companion object {
        // Each context read as catalog/3 asks for it: the newest page, every routine.
        val contextInputs = mapOf(
            "list_sessions" to Json.objectOf("before" to Json.Null, "beforeId" to Json.Null, "limit" to Json.of(LogRead.defaultPage)),
            "list_notes" to Json.objectOf(), "list_exercises" to Json.objectOf(), "list_routines" to Json.objectOf("routineId" to Json.Null))
    }
}
