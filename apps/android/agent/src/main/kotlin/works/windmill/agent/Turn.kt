package works.windmill.agent

import kotlinx.coroutines.flow.Flow
import works.windmill.sync.core.Json

// One agent turn in product-neutral words, and the ports it runs on. § numbers cite the turn spec under docs/foundation/mobile.

enum class TurnState {
    running, interrupted, completed, declined, failed, stopped;

    val terminal: Boolean get() = this != running
}

enum class SeatKind { anon, bound }

// Every request of a turn carries the seat that opened it. A seat prints without its credential.
sealed interface TurnSeat {
    val kind: SeatKind

    data class Bound(val token: String) : TurnSeat {
        override val kind get() = SeatKind.bound
        override fun toString() = "TurnSeat.Bound"
    }

    data class Anon(val credential: String) : TurnSeat {
        override val kind get() = SeatKind.anon
        override fun toString() = "TurnSeat.Anon"
    }
}

data class ToolCall(val callId: String, val name: String, val input: Json)
data class TurnBatch(val batch: Int, val calls: List<ToolCall>)

sealed interface ToolOutcome {
    val callId: String
    val name: String

    data class Ok(override val callId: String, override val name: String, val result: Json) : ToolOutcome
    data class Refused(override val callId: String, override val name: String, val code: String) : ToolOutcome
}

data class TurnPicture(val id: String, val mediaType: String, val data: ByteArray)
data class TurnLine(val role: String, val text: String)
data class ContextRead(val name: String, val input: Json, val result: Json)

// §6.2's open body, and the outcome of every read the host ran to gather `context`: a read left out of `context` still counts.
data class TurnOpen(
    val turnId: String,
    val catalog: String,
    val question: String,
    val pictures: List<TurnPicture>,
    val history: List<TurnLine>,
    val context: List<ContextRead>,
    val contextOutcomes: List<ToolOutcome>,
)

// `budgetResetsAtMs` is the moment a shared pool refills, when a failed turn's closing frame names it.
data class TurnEnd(val state: TurnState, val text: String, val truncated: Boolean, val code: String?, val budgetResetsAtMs: Long?)

data class TurnActivity(val turnId: String, val stopping: Boolean, val reconnecting: Boolean)

// How `run` came back. `abandoned` was cancelled before it could say how the turn ended, and a write in flight can outlive that, so the caller re-reads the record before deciding it. The two stops ended the turn `stopped` on this phone alone, because the server never heard: `stoppedOffline` for want of a connection, `stopUnheard` for any other reason.
enum class TurnExit { ended, withdrawn, abandoned, stoppedOffline, stopUnheard }

// The record of the turn refused a write of its own (ended, full): a defect of this turn on this phone, and it ends the turn.
class TurnRecordRefused : Exception()

// The record of the turn is gone, removed elsewhere: nothing is broken, and it ends the turn all the same.
class TurnRecordGone : Exception()

// What a product does in a turn. One per turn, built after its opening transaction, so it already holds the turn's records and seat.
interface TurnHost {
    suspend fun open(): TurnOpen
    suspend fun execute(call: ToolCall): ToolOutcome
    suspend fun writeText(text: String)
    suspend fun end(end: TurnEnd)
    suspend fun withdraw(refusal: TurnRefusal)
}

// The four routes of §6.1. The flows and calls fail with TurnRefusal, TurnConnectionLost or TurnWireFault; anything else is a transport fault of its own.
interface TurnTransport {
    fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent>
    fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent>
    suspend fun answer(turnId: String, batch: Int, results: List<ToolOutcome>, seat: TurnSeat)
    suspend fun stop(turnId: String, seat: TurnSeat)
}

// A word telemetry may carry. No other string reaches it, so no question, answer, input, result or credential can.
@ConsistentCopyVisibility
data class TurnLabel private constructor(val value: String) {
    companion object {
        private const val other = "other"
        private val word = Regex("[a-z0-9_-]{1,64}")
        const val gone = "gone"
        private val causes = setOf(TurnFailure.transport.name, TurnFailure.decode.name, TurnFailure.storage.name, TurnFailure.refusal.name, gone, TurnRefusal.unreachable)

        // A catalog name or an ability's refusal code, which the product's catalog bounds and this module cannot list.
        fun of(name: String) = TurnLabel(if (word.matches(name)) name else other)

        // A turn's code: a §6.5 code the server sent, or this phone's own cause.
        fun code(code: String) = TurnLabel(if (code in TurnRefusal.codes || code in causes) code else other)
    }
}

// The counts a turn ends with.
data class TurnTally(val calls: Int, val refusals: Int, val answerBytes: Int)

// What failed, under one static name; `http` is a 5xx, and `status` says which.
enum class TurnFailure { transport, decode, storage, refusal, http }

// What a turn tells: labels, counts and durations. A lost connection and a cancellation are not failures.
interface TurnTelemetry {
    fun ability(name: TurnLabel, outcome: TurnLabel)
    fun ended(state: TurnState, seat: SeatKind, code: TurnLabel?, tally: TurnTally, durationMs: Long)
    fun withdrawn(status: Int, code: TurnLabel, durationMs: Long)
    fun failure(kind: TurnFailure, status: Int?)
}
