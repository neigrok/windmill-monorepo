package works.windmill.agent

import java.io.ByteArrayOutputStream
import java.util.Base64
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError

// The turn wire of §6 without a socket: the frames, the text/event-stream they arrive in, the refusals and the two bodies a phone posts.

// §6.3, the frames of a turn stream, heartbeats aside.
sealed interface TurnEvent {
    data class Snapshot(val text: String, val state: TurnState, val batch: TurnBatch?) : TurnEvent
    data class Text(val delta: String) : TurnEvent
    data class Calls(val batch: TurnBatch) : TurnEvent
    data class Done(val state: TurnState, val truncated: Boolean) : TurnEvent
    data class Error(val code: String, val budgetResetsAtMs: Long?, val spent: Boolean = false) : TurnEvent

    // The frame after which the server closes this stream. A terminal snapshot is not one: the closing frame that names how the turn ended follows it.
    val closing: Boolean get() = this is Done || this is Error

    companion object {
        fun of(event: String, data: Json): TurnEvent = readable {
            when (event) {
                "snapshot" -> Snapshot(data.member("text").str(), state(data), data["calls"]?.orNull()?.let(::batch))
                "text" -> Text(data.member("delta").str())
                "calls" -> Calls(batch(data))
                "done" -> Done(terminalState(data), (data["truncated"] as? Json.Bool)?.value ?: false)
                "error" -> Error(data.member("code").str(), moment(data["budgetResetsAtMs"]), spent(data["allowance"]))
                else -> throw TurnWireFault(TurnWireFault.unknownEvent)
            }
        }

        private fun state(data: Json): TurnState {
            val name = data.member("state").str()
            return TurnState.entries.firstOrNull { it.name == name } ?: throw TurnWireFault(TurnWireFault.unknownState)
        }

        private fun terminalState(data: Json): TurnState = state(data).also { if (!it.terminal) throw TurnWireFault(TurnWireFault.unknownState) }

        private fun batch(data: Json) = TurnBatch(data.member("batch").long(min = 1).toInt(), data.member("calls").arr().map { call ->
            ToolCall(call.member("callId").str(), call.member("name").str(), call.member("input"))
        })
    }
}

// A refusal the server answered a turn request with, by §6.5 code: the moment a shared free pool refills when its body says, and whether its allowance read says the balance is gone.
data class TurnRefusal(val status: Int, val code: String, val budgetResetsAtMs: Long?, val spent: Boolean = false) : Exception(code) {
    // A cap the server refills, which is expected however it is answered.
    val capped: Boolean get() = code == rateLimited || code in allowanceCodes && code !in installationCodes

    // A failure of the server's own, which files a report: a 5xx it did not mean. A cap and `busy`, a process at capacity, are refusals it meant.
    val serverFault: Boolean get() = status >= 500 && !capped && code != busy

    companion object {
        const val turnOrder = "coach-turn-order"
        const val turnUnknown = "coach-turn-unknown"
        const val streamReplaced = "coach-stream-replaced"
        const val rateLimited = "coach-rate-limited"
        const val vendorError = "coach-vendor-error"
        const val busy = "coach-busy"
        const val unreachable = "unreachable"
        private val installationCodes = setOf("device_bound", "invalid_installation")
        val allowanceCodes = setOf("subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted",
            "funding_required", "debt_outstanding") + installationCodes
        val codes = allowanceCodes + setOf("coach-bad-request", "coach-update-required", "coach-turn-conflict", turnUnknown, turnOrder,
            "coach-turn-volume", rateLimited, "coach-replica-syncing", busy, vendorError, streamReplaced)

        // No server said this: no attempt to open the turn reached one this phone could read, so it names no status, and the turn never began.
        val unreached: TurnRefusal get() = TurnRefusal(0, unreachable, null)

        fun of(status: Int, body: ByteArray): TurnRefusal {
            val json = try { Json.parse(body) } catch (unreadable: JsonError) { null }
            val code = (json?.get("code") as? Json.Str)?.value.orEmpty()
            val allowance = json?.get("allowance")
            return TurnRefusal(status, code.ifEmpty { vendorError }, moment(allowance?.get("budgetResetsAtMs")), spent(allowance))
        }
    }
}

// No connection, or a stream that dropped before its terminal frame. It reconnects, and it is never an Issue.
class TurnConnectionLost(cause: Throwable?) : Exception(cause)

// A frame or an answer that cannot be read, or a stream another stream of this turn took over.
class TurnWireFault(val kind: String) : Exception(kind) {
    companion object {
        const val unknownEvent = "unknown-event"
        const val unknownState = "unknown-state"
        const val unreadable = "unreadable"
        const val notAStream = "not-a-stream"
        const val lineTooLong = "line-too-long"
        const val badAddress = "bad-address"
        const val replaced = "stream-replaced"
    }
}

// Bytes of a text/event-stream, in pieces of any size, to frames: `event:` and `data:` lines gather one frame, a blank line ends it, CRLF ends a line as LF does, and every other line, a `:` heartbeat among them, is passed over. A line, or the data of one frame, past the bound is a fault.
class TurnSse {
    private val line = ByteArrayOutputStream()
    private var event = ""
    private var data = mutableListOf<String>()
    private var dataBytes = 0

    fun consume(bytes: ByteArray, count: Int = bytes.size): List<TurnEvent> {
        val frames = mutableListOf<TurnEvent>()
        for (index in 0 until count) {
            if (bytes[index] != LF) {
                line.write(bytes[index].toInt())
                if (line.size() > maxLineBytes) throw TurnWireFault(TurnWireFault.lineTooLong)
                continue
            }
            finishLine()?.let(frames::add)
        }
        return frames
    }

    private fun finishLine(): TurnEvent? {
        val raw = line.toByteArray().let { if (it.lastOrNull() == CR) it.copyOf(it.size - 1) else it }
        line.reset()
        if (raw.isEmpty()) return finishFrame()
        val text = strict(raw)
        if (text.startsWith("event:")) event = text.removePrefix("event:").trim()
        if (text.startsWith("data:")) {
            dataBytes += raw.size
            if (dataBytes > maxLineBytes) throw TurnWireFault(TurnWireFault.lineTooLong)
            data.add(text.removePrefix("data:").removePrefix(" "))
        }
        return null
    }

    private fun finishFrame(): TurnEvent? {
        val name = event
        val gathered = data
        event = ""; data = mutableListOf(); dataBytes = 0
        if (gathered.isEmpty()) return null
        return readable { TurnEvent.of(name, Json.parse(gathered.joinToString("\n"))) }
    }

    private fun strict(raw: ByteArray): String = try {
        raw.decodeToString(throwOnInvalidSequence = true)
    } catch (invalid: CharacterCodingException) {
        throw TurnWireFault(TurnWireFault.unreadable)
    }

    companion object {
        const val maxLineBytes = 1_048_576
        private const val LF: Byte = 10
        private const val CR: Byte = 13
    }
}

// §6.2, the open body.
val TurnOpen.json: Json get() = Json.objectOf(
    "catalog" to Json.of(catalog),
    "turnId" to Json.of(turnId),
    "question" to Json.of(question),
    "pictures" to Json.Arr(pictures.map { Json.objectOf("id" to Json.of(it.id), "mediaType" to Json.of(it.mediaType), "data" to Json.of(Base64.getEncoder().encodeToString(it.data))) }),
    "history" to Json.Arr(history.map { Json.objectOf("role" to Json.of(it.role), "text" to Json.of(it.text)) }),
    "context" to Json.Arr(context.map { Json.objectOf("name" to Json.of(it.name), "input" to it.input, "result" to it.result) }),
)

// §6.4, the body that answers one batch.
fun turnAnswer(batch: Int, results: List<ToolOutcome>): Json = Json.objectOf(
    "batch" to Json.of(batch),
    "results" to Json.Arr(results.map { outcome ->
        when (outcome) {
            is ToolOutcome.Ok -> Json.objectOf("callId" to Json.of(outcome.callId), "ok" to Json.of(true), "result" to outcome.result)
            is ToolOutcome.Refused -> Json.objectOf("callId" to Json.of(outcome.callId), "ok" to Json.of(false), "code" to Json.of(outcome.code))
        }
    }),
)

private inline fun <T> readable(read: () -> T): T = try {
    read()
} catch (unreadable: JsonError) {
    throw TurnWireFault(TurnWireFault.unreadable)
}

// §7.1: the allowance read says the balance is gone when nothing remains and no unresolved call holds any of it. A read that is absent or cannot be read says nothing of the balance.
private fun spent(allowance: Json?): Boolean {
    fun usd(name: String) = (allowance?.get(name) as? Json.Str)?.value?.toBigDecimalOrNull()
    return usd("remaining")?.signum() == 0 && usd("reserved")?.signum() == 0
}

// A moment the server names is a courtesy: one that cannot be read is no moment, and the refusal stands.
private fun moment(value: Json?): Long? = try {
    (value as? Json.Num)?.long()
} catch (unreadable: JsonError) {
    null
}
