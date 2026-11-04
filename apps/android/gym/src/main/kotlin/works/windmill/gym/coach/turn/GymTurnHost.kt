package works.windmill.gym.coach.turn

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import works.windmill.agent.ContextRead
import works.windmill.agent.SeatKind
import works.windmill.agent.ToolCall
import works.windmill.agent.ToolOutcome
import works.windmill.agent.TurnEnd
import works.windmill.agent.TurnHost
import works.windmill.agent.TurnLine
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnPicture
import works.windmill.agent.TurnRecordGone
import works.windmill.agent.TurnRecordRefused
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.Seat
import works.windmill.gym.domain.coach.AbilityExecutor
import works.windmill.gym.domain.coach.AbilityOutcome
import works.windmill.gym.domain.coach.AbilityRequest
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.ForgetRunningTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.coach.StreamTurnText
import works.windmill.gym.domain.coach.WithdrawTurn
import works.windmill.gym.domain.coach.contextPictures
import works.windmill.gym.domain.coach.history
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.TrainingLog
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.TrainingRefused
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json

// What gym does in one turn, under the seat the turn opened with (Coach §4.1 steps 3-5, §4.3, §4.4, D-10). It holds the turn's records and seat, and every step is one transaction on the storage dispatcher that cancellation never cuts short: a commit in flight lands, and whoever abandoned the turn reads the record again.
class GymTurnHost(
    private val turn: OpenTurn.Turn,
    private val seat: TurnSeat,
    private val question: String,
    private val replica: String,
    private val training: EngineTraining,
    private val catalog: Catalog,
    private val pictures: PictureFiles,
    private val appBaseUrl: String,
    private val storage: CoroutineDispatcher,
    private val accountWait: Duration = 1.seconds,
) : TurnHost {
    val turnId: String = checkNotNull(turn.coach.record.string) { "a Coach message's id is a string" }

    private val anonymous = seat.kind == SeatKind.anon

    // How the turn closed, for the one who runs it to read after the driver returns.
    @Volatile var withdrawal: TurnRefusal? = null
        private set
    @Volatile var ending: TurnEnd? = null
        private set
    // Whether the conversation stands once the turn is taken back; it goes with a turn that was all it held.
    @Volatile var threadStands = true
        private set

    override suspend fun open(): TurnOpen {
        val workout = onReplica { runner -> runner.read(CoachMessage.scope) { TrainingLog(it).open?.id } }
        val reads = CoachTurnBounds.contextReads.map { it to Json.objectOf() } + listOfNotNull(workout?.let { "get_session" to Json.objectOf("sessionId" to it.json) })
        val context = mutableListOf<ContextRead>()
        val outcomes = mutableListOf<ToolOutcome>()
        var bytes = 0
        for ((name, input) in reads) {
            val call = ToolCall("context-$name", name, input)
            val answered = ability(call)
            outcomes += tool(call, answered)
            if (answered is AbilityOutcome.Result && bytes + answered.jcs.size <= CoachTurnBounds.contextReadBytes) {
                bytes += answered.jcs.size
                context += ContextRead(name, input, Json.parse(answered.jcs))
            }
        }
        val (messages, rows) = onReplica { runner ->
            runner.read(CoachMessage.scope) { read ->
                val messages = read.repository(CoachMessage).children(turn.thread, "threadId", ViewMode.drawn)
                messages to messages.contextPictures(turn.lifter).mapNotNull { CoachPictureRow.decode(it.id, read.device(CoachPictureRow.key(it.id))) }
            }
        }
        val attached = withContext(storage) { rows.mapNotNull { row -> pictures.model(row.id)?.let { TurnPicture(row.id, PictureFiles.modelMediaType, it) } } }
        return TurnOpen(turnId, catalog.version, question, attached, messages.history(turn.coach).map { TurnLine(it.role.name, it.text) }, context, outcomes)
    }

    override suspend fun execute(call: ToolCall): ToolOutcome = tool(call, ability(call))

    override suspend fun writeText(text: String) {
        onReplica { runner -> runner.run(StreamTurnText(turn.coach, text)).answered() }
    }

    override suspend fun end(end: TurnEnd) {
        ending = end
        onReplica { runner -> closing(runner) { runner.run(EndTurn(turn.coach, MessageState.valueOf(end.state.name), end.text, end.truncated)).answered() } }
    }

    override suspend fun withdraw(refusal: TurnRefusal) {
        withdrawal = refusal
        onReplica { runner ->
            closing(runner) { pictures.delete(runner.run(WithdrawTurn(turn)).answered()) }
            threadStands = runner.read(CoachMessage.scope) { it.repository(CoachThread).find(turn.thread, ViewMode.drawn) != null }
        }
    }

    // A record gone by the turn's last write leaves nothing to close but the device row that named it.
    private fun closing(runner: ActionRunner, close: () -> Unit) {
        try {
            close()
        } catch (gone: TurnRecordGone) {
            runner.run(ForgetRunningTurn(turn.coach))
        }
    }

    private suspend fun ability(call: ToolCall): AbilityOutcome = onReplica { runner ->
        AbilityExecutor(runner, catalog, appBaseUrl).run(AbilityRequest(call.callId, call.name, call.input), turn.coach, if (anonymous) Seat.anon else Seat.bound).answered()
    }

    private fun tool(call: ToolCall, outcome: AbilityOutcome): ToolOutcome = when (outcome) {
        is AbilityOutcome.Result -> ToolOutcome.Ok(call.callId, call.name, Json.parse(outcome.jcs))
        is AbilityOutcome.Refused -> ToolOutcome.Refused(call.callId, call.name, outcome.code.code)
    }

    // A refusal of the turn's own record is no outcome of any call: it ends the turn. Gone, a conversation deleted on another phone took it, and that is nobody's fault; anything else (ended, full) the driver reports.
    private fun <T> Outcome<T, GymRefusal>.answered(): T = when (this) {
        is Outcome.Committed -> result
        is Outcome.Unchanged -> result
        is Outcome.Refused -> throw (refusal as? GymRefusal.Gone)?.takeIf { it.subject == turn.coach.ref }?.let { TurnRecordGone() } ?: TurnRecordRefused()
    }

    // The turn's one door to its seat. While the account is in a transition, which a sign-out sheet holds open and its Cancel ends, or a sign-in waits on its decision, the turn waits rather than dies: the transition ends, or the seat changes and the abandon this wait yields to arrives. A race lost to either lands here as the commit's own refusal.
    private suspend fun <T> onReplica(work: (ActionRunner) -> T): T {
        while (true) {
            try {
                if (withContext(storage) { training.mayWriteOn(replica, anonymous) }) return withContext(storage) { withContext(NonCancellable) { training.pinnedOn(replica, anonymous, work) } }
            } catch (_: TrainingRefused) {
                // The race lost; the wait covers it.
            }
            delay(accountWait)
        }
    }
}
