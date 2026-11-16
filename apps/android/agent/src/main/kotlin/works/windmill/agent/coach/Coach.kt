package works.windmill.agent.coach

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import works.windmill.sync.core.Json

class Profile(val json: Json) {
    val name = json.member("name").str()
    val version = json.member("version").long(1)
    val system = json.member("system").arr().map(Json::str)
    val firstContent = json.member("firstContent")
    val refusals = json.member("refusals").obj().mapValues { it.value.str() }
    val tools = json.member("tools").arr().map(::Tool)
    val groups = json.member("groups").arr().map(::Group)
    val model = json.member("model").str()
    val effort = json.member("effort").str()
    val output = json.member("output")
    val label = json.member("label").str()
    val modelCalls = json.member("limits").member("modelCalls").long(1)
    val abilityCalls = json.member("limits").member("abilityCalls").long(0)
    val writes = json.member("limits").member("writes").long(0)

    init {
        require(Regex("[a-z][a-z0-9.-]{0,63}").matches(name))
        require(model in setOf("large", "medium", "small"))
        require(effort in setOf("low", "medium", "high", "xhigh", "max"))
        output.expectKeys(listOf("maxTokens", "minTokens"))
        val maxTokens = output.member("maxTokens").long(1)
        output.member("minTokens").orNull()?.let { require(it.long(1) <= maxTokens) }
        listOf("historyPrefix", "contextPrefix", "questionPrefix", "emptyQuestion").forEach { firstContent.member(it).str() }
        require(refusals.keys.all { Regex("[a-z][a-z0-9-]{0,63}").matches(it) })
        require(refusals.keys.containsAll(listOf("not-offered", "seat-required", "invalid-input", "coach-turn-volume", "stopped")))
        require(tools.map { it.name }.distinct().size == tools.size)
        require(groups.map { it.name }.distinct().size == groups.size)
        groups.forEach { group -> require(group.tools.all { name -> tools.any { it.name == name } } && group.code in refusals) }
    }

    class Tool(json: Json) {
        val name = json.member("name").str()
        val description = json.member("description").str()
        val input = json.member("input")
        val countsAsWrite = json.member("countsAsWrite").bool()
        init { require(Regex("[A-Za-z0-9_-]{1,64}").matches(name) && input.member("type").str() == "object") }
        val wire get() = Json.objectOf("name" to Json.of(name), "description" to Json.of(description), "input" to input)
    }
    class Group(json: Json) {
        val name = json.member("name").str()
        val tools = json.member("tools").arr().map(Json::str)
        val maxSuccesses = json.member("maxSuccesses").long(0)
        val code = json.member("code").str()
    }
}

enum class SeatKind { anon, bound }
data class Seat(val kind: SeatKind, val key: String) {
    constructor(json: Json) : this(SeatKind.valueOf(json.member("kind").str()), json.member("key").str())
    val json get() = Json.objectOf("kind" to Json.of(kind.name), "key" to Json.of(key))
    override fun toString() = "Seat(${kind.name})"
}
class Picture(val pictureId: String, val mediaType: String, bytes: ByteArray) {
    init { require(Regex("[A-Za-z0-9_-]{22,64}").matches(pictureId)); require(mediaType in setOf("image/jpeg", "image/png")) }
    private val data = bytes.copyOf()
    val bytes get() = data.copyOf()
    constructor(json: Json) : this(json.member("pictureId").str(), json.member("mediaType").str(),
        json.member("bytes").arr().map { it.long(0).also { n -> require(n <= 255) }.toByte() }.toByteArray())
    val json get() = Json.objectOf("pictureId" to Json.of(pictureId), "mediaType" to Json.of(mediaType), "bytes" to Json.Arr(data.map { Json.of(it.toInt() and 255) }))
}
data class TurnInput(val turnId: String, val seat: Seat, val question: String, val pictures: List<Picture>) {
    constructor(json: Json) : this(json.member("turnId").str(), Seat(json.member("seat")), json.member("question").str(), json.member("pictures").arr().map(::Picture))
    val json get() = Json.objectOf("turnId" to Json.of(turnId), "seat" to seat.json, "question" to Json.of(question), "pictures" to Json.Arr(pictures.map { it.json }))
}
data class Mark(val turnId: String, val callId: String?, val textBytesBeforeRound: Int) {
    init { require(textBytesBeforeRound >= 0) }
    constructor(json: Json) : this(json.member("turnId").str(), json.member("callId").orNull()?.str(), json.member("textBytesBeforeRound").long(0).also { require(it <= Int.MAX_VALUE) }.toInt())
    val json get() = Json.objectOf("turnId" to Json.of(turnId), "callId" to (callId?.let(Json::of) ?: Json.Null), "textBytesBeforeRound" to Json.of(textBytesBeforeRound))
}
enum class EndState { completed, declined, failed, stopped, interrupted }
data class TurnEnd(val state: EndState, val text: String, val truncated: Boolean = false, val code: String? = null) {
    val json get() = Json.objectOf("state" to Json.of(state.name), "text" to Json.of(text), "truncated" to Json.of(truncated), "code" to (code?.let(Json::of) ?: Json.Null))
}
data class ToolCall(val id: String, val name: String, val input: Json) {
    constructor(json: Json) : this(json.member("id").str(), json.member("name").str(), json.member("input"))
    val json get() = Json.objectOf("id" to Json.of(id), "name" to Json.of(name), "input" to input)
}
data class CallIdentity(val turnId: String, val callId: String, val toolCallId: String)
sealed interface ToolOutcome {
    data class Ok(val content: String) : ToolOutcome
    data class Refused(val code: String) : ToolOutcome
}

// Every host operation checks its opaque lease and record existence inside the commit boundary.
interface HostLease
class HostUnavailable : Exception()
data class Opened(val lease: HostLease, val history: String, val context: List<String>, val pictures: List<Picture>)
data class Recovery(val lease: HostLease, val state: String, val text: String, val mark: Mark)
interface ToolHost {
    suspend fun open(input: TurnInput): Opened
    suspend fun recover(turnId: String, seat: Seat): Recovery?
    suspend fun beginRound(lease: HostLease, text: String, mark: Mark)
    suspend fun text(lease: HostLease, text: String)
    suspend fun check(lease: HostLease, rule: String, call: ToolCall): String?
    suspend fun execute(lease: HostLease, identity: CallIdentity, call: ToolCall): ToolOutcome
    suspend fun end(lease: HostLease, end: TurnEnd)
    suspend fun withdraw(lease: HostLease)
    fun refused(id: String, code: String) {}
}

enum class Admission { none, possible, admitted }
data class AiFailure(val source: String, val code: String?, val admission: Admission, val allowance: Json? = null)
sealed interface AiAnswer {
    data class Failure(val failure: AiFailure) : AiAnswer
    data class Terminal(val event: String, val data: Json) : AiAnswer
}
interface AiClient {
    fun clearPass()
    suspend fun text(callId: String, request: Json, pictures: List<Picture>, label: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer
    suspend fun result(callId: String, use: String, version: Long, stop: StopSignal, onText: suspend (String) -> Unit): AiAnswer
}

// Stop wakes retry waits. It never cancels an admitted provider call or the host's pending commit.
class StopSignal {
    private val signal = CompletableDeferred<Unit>()
    val stopped get() = signal.isCompleted
    fun stop() { signal.complete(Unit) }
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    suspend fun wait(milliseconds: Long): Boolean {
        if (stopped) return false
        return select { signal.onAwait { false }; onTimeout(milliseconds) { true } }
    }
}
interface Runtime {
    fun now(): Long
    fun newId(): String
    suspend fun <T> withLease(turnId: String, ifAvailable: Boolean, body: suspend (Boolean) -> T): T
}

data class TurnReport(val state: EndState, val seat: SeatKind, val code: String?, val rounds: Int, val abilityCalls: Int, val refusals: Int, val answerBytes: Int, val durationMs: Long) {
    val json get() = Json.objectOf("state" to Json.of(state.name), "seat" to Json.of(seat.name), "code" to (code?.let(Json::of) ?: Json.Null), "rounds" to Json.of(rounds), "abilityCalls" to Json.of(abilityCalls), "refusals" to Json.of(refusals), "answerBytes" to Json.of(answerBytes), "durationMs" to Json.of(durationMs))
}
data class AbilityReport(val name: String, val outcome: String, val code: String?) {
    val json get() = Json.objectOf("name" to Json.of(name), "outcome" to Json.of(outcome), "code" to (code?.let(Json::of) ?: Json.Null))
}
enum class FailureOperation(val label: String) { aiCall("ai-call"), aiPass("ai-pass"), host("agent-host") }
interface Telemetry {
    fun turn(report: TurnReport)
    fun ability(report: AbilityReport)
    fun failure(operation: FailureOperation)
}

fun isStaleTurn(state: String, serverUpdatedAt: Long?, syncLive: Boolean, serverNow: Long?): Boolean =
    state == "running" && syncLive && serverNow != null && serverUpdatedAt != null && serverNow >= serverUpdatedAt && serverNow - serverUpdatedAt >= 1_800_000

fun accessState(failure: AiFailure): String = when (failure.code) {
    "subject_exhausted" -> "allowance"
    "free_day_exhausted", "free_month_exhausted" -> "capacity"
    "concurrency_exhausted", "rate_limited", "busy", "paused" -> "busy"
    "unauthenticated", "invalid_installation", "device_bound" -> "sign-in"
    "client-update-required" -> "update"
    "anonymous_ai_unavailable" -> "off"
    null -> if (failure.source == "transport") "offline" else "did-not-answer"
    else -> "did-not-answer"
}
