package works.windmill.platform.ai

import java.io.ByteArrayOutputStream
import kotlinx.coroutines.flow.Flow
import works.windmill.sync.core.Json

class AiTransportFailure(val code: String) : Exception(code)
data class AiRequest(val method: String, val path: String, val pass: String, val body: String? = null, val bytes: ByteArray? = null, val mediaType: String? = null, val timeoutMs: Long = 30_000) {
    override fun toString() = "AiRequest($method)"
}
class AiResponse(val status: Int, val body: Json? = null, val events: Flow<Json>? = null, private val release: () -> Unit = {}) : AutoCloseable {
    override fun close() = release()
}
interface AiTransport {
    suspend fun pass(body: Json): AiResponse
    suspend fun request(request: AiRequest): AiResponse
}

object AiWire {
    private val amount = Regex("(0|[1-9][0-9]*)(\\.[0-9]{1,9})?")
    private val models = setOf("large", "medium", "small")
    private val refusalStatus = mapOf(
        "invalid_request" to 400, "provider_rejected" to 400, "pass_missing" to 401, "pass_signature" to 401,
        "pass_audience" to 401, "pass_malformed" to 401, "pass_expired" to 401, "funding_required" to 403,
        "device_bound" to 403, "call_unknown" to 404, "conflict" to 409, "result_gone" to 410, "picture_gone" to 410,
        "too_large" to 413, "subject_exhausted" to 429, "free_month_exhausted" to 429, "free_day_exhausted" to 429,
        "background_exhausted" to 429, "concurrency_exhausted" to 429, "rate_limited" to 429, "busy" to 503,
        "paused" to 503, "accounting_unavailable" to 503, "provider_unavailable" to 503,
    )
    private val passStatus = mapOf(
        "invalid_request" to 400, "unauthenticated" to 401, "invalid_installation" to 401, "device_bound" to 409,
        "client-update-required" to 426, "anonymous_ai_unavailable" to 503, "rate_limited" to 429,
        "unavailable" to 503, "untrusted-origin" to 403, "unsupported-media-type" to 415,
    )
    fun refusal(response: AiResponse): Json? = try {
        val value = requireNotNull(response.body)
        value.expectKeys(listOf("code", "allowance"))
        require(refusalStatus[value.member("code").str()] == response.status)
        value.member("allowance").orNull()?.let(::allowance)
        value
    } catch (_: Exception) { null }

    fun passRefusal(response: AiResponse): String? = try {
        val value = requireNotNull(response.body)
        value.expectKeys(listOf("code", "error"))
        value.member("error").str()
        value.member("code").str().takeIf { passStatus[it] == response.status }
    } catch (_: Exception) { null }

    fun allowance(value: Json) {
        value.expectKeys(listOf("tier", "period", "limit", "used", "reserved", "remaining", "resetsAt", "budgetResetsAt", "code", "capabilities"))
        require(value.member("tier").str() in setOf("anonymous", "free", "one"))
        require(value.member("period").str() in setOf("lifetime", "calendar_month_utc", "billing_period"))
        listOf("limit", "used", "reserved", "remaining").forEach { require(amount.matches(value.member(it).str())) }
        listOf("resetsAt", "budgetResetsAt").forEach { value.member(it).orNull()?.long(0) }
        require(value.member("code").str() in setOf("ok", "device_bound", "subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted"))
        val capabilities = value.member("capabilities")
        capabilities.expectKeys(listOf("text", "transcription")); capabilities.member("transcription").bool()
        capabilities.member("text").expectKeys(listOf("large", "medium", "small"))
        require(capabilities.member("text").obj().values.all { it.str() in models })
    }
    fun event(value: Json) {
        value.expectKeys(listOf("id", "event", "data"))
        value.member("id").long(1)
        val data = value.member("data")
        when (value.member("event").str()) {
            "started" -> {
                data.expectKeys(listOf("callId", "served", "maxTokens"))
                require(Regex("[A-Za-z0-9_-]{22,64}").matches(data.member("callId").str()))
                require(data.member("served").str() in models); data.member("maxTokens").long(1)
            }
            "text" -> { data.expectKeys(listOf("delta")); data.member("delta").str() }
            "toolCall" -> call(data)
            "ended", "failed" -> {
                val failed = value.member("event").str() == "failed"
                data.expectKeys(if (failed) listOf("code", "charged", "allowance") else listOf("stop", "message", "charged", "allowance"))
                data.member("charged").orNull()?.let { require(amount.matches(it.str())) }
                data.member("allowance").orNull()?.let(::allowance)
                if (failed) {
                    require(data.member("code").str() in setOf("provider_rejected", "provider_unavailable", "provider_failed", "accounting_unavailable"))
                } else {
                    require(data.member("stop").str() in setOf("completed", "tool_calls", "truncated", "declined"))
                    val message = data.member("message")
                    message.expectKeys(listOf("role", "parts", "carry"))
                    require(message.member("role").str() == "assistant"); message.member("carry").str()
                    message.member("parts").arr().forEach { part ->
                        if (part["text"] != null) { part.expectKeys(listOf("text")); part.member("text").str() }
                        else { part.expectKeys(listOf("toolCall")); call(part.member("toolCall")) }
                    }
                }
            }
            else -> throw AiTransportFailure("invalid-answer")
        }
    }
    private fun call(value: Json) {
        value.expectKeys(listOf("id", "name", "input"))
        require(value.member("id").str().isNotEmpty())
        require(Regex("[A-Za-z0-9_-]{1,64}").matches(value.member("name").str()))
        value.member("input").obj()
    }
}

// Frames are bounded before UTF-8 decoding, including an unterminated line.
class AiSse {
    private val frame = ByteArrayOutputStream()
    private val line = ByteArrayOutputStream()
    fun consume(bytes: ByteArray, count: Int = bytes.size): Sequence<Json> = sequence {
        for (index in 0 until count) {
            val byte = bytes[index].toInt() and 255
            if (frame.size() + line.size() >= 1_048_576) throw AiTransportFailure("invalid-answer")
            if (byte != 10) { line.write(byte); continue }
            var data = line.toByteArray(); line.reset()
            if (data.lastOrNull() == 13.toByte()) data = data.copyOf(data.size - 1)
            if (data.isNotEmpty()) { frame.write(data); frame.write(10); continue }
            if (frame.size() == 0) continue
            val text = try { frame.toByteArray().decodeToString(throwOnInvalidSequence = true) } catch (_: Exception) { throw AiTransportFailure("invalid-answer") }
            frame.reset()
            var id: String? = null
            var event: String? = null
            val values = mutableListOf<String>()
            for (field in text.split('\n')) {
                if (field.isEmpty() || field.startsWith(':')) continue
                val colon = field.indexOf(':')
                val name = if (colon < 0) field else field.take(colon)
                val value = if (colon < 0) "" else field.substring(colon + 1).removePrefix(" ")
                when (name) { "data" -> values += value; "id" -> id = value; "event" -> event = value }
            }
            if (values.isEmpty()) continue
            if (id == null || !Regex("[1-9][0-9]*").matches(id)) throw AiTransportFailure("invalid-answer")
            try {
                val parsed = Json.objectOf("id" to Json.of(id.toLong()), "event" to Json.of(event ?: ""), "data" to Json.parse(values.joinToString("\n")))
                AiWire.event(parsed); yield(parsed)
            } catch (failure: AiTransportFailure) { throw failure }
            catch (_: Exception) { throw AiTransportFailure("invalid-answer") }
        }
    }
    fun finish() {
        val tail = frame.toByteArray() + line.toByteArray()
        try { tail.decodeToString(throwOnInvalidSequence = true) } catch (_: Exception) { throw AiTransportFailure("invalid-answer") }
        if (tail.isNotEmpty()) throw AiTransportFailure("lost")
    }
}
