package works.windmill.gym.coach.turn

import java.io.File
import java.util.Collections
import javax.crypto.KeyGenerator
import kotlin.coroutines.ContinuationInterceptor
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.TestScope
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.inOrder
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.agent.CoachBackgroundLease
import works.windmill.platform.agent.CoachRuntime
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationApi
import works.windmill.platform.ai.AiInstallationResponse
import works.windmill.platform.ai.AiAllowance
import works.windmill.platform.ai.AiRequest
import works.windmill.platform.ai.AiResponse
import works.windmill.platform.ai.AiTransportFailure
import works.windmill.platform.ai.AiTransport
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

// The AI service and the pass door as one exchange scripts it, in frames of the turn: `text` deltas, `calls` the model makes, which end the round, `done` with the state the round ends in, and `error` with a code the round is refused or fails with. `{"await":"results"}` marks where the next round picks up, after the calls ran; `{"await":"stop"}` holds the round open until Stop is asked or the test releases it, `{"await":"resume"}` drops the stream there and holds the call asked again the same way, and a `done` that says `stopped` then ends the round asking for tools, which the engine discards. A script that runs out ends its round completed.
internal class ScriptedTurns(private val events: List<Json>) : AiTransport {
    // A round 1 as the engine sent it: the question the model reads last, and the request whole.
    class Opened(val question: String, val request: Json) {
        private val parts get() = request.member("messages").arr()[0].member("parts").arr()
        val texts: List<String> get() = parts.mapNotNull { it["text"]?.str() }
        // The pictures the first content names, by the id the AI service holds each under.
        val pictures: List<String> get() = parts.mapNotNull { it["image"]?.member("picture")?.str() }
    }
    // A refusal the pass door, or the text door in place of a turn's first round, answers.
    data class Refusal(val status: Int, val code: String, val allowance: Json? = null, val atPassDoor: Boolean = false) {
        companion object {
            // The code as the door that answers it says it, with the status it says it under.
            fun of(code: String, allowance: Json? = null): Refusal = passRefusals[code]?.let { Refusal(it, code, atPassDoor = true) }
                ?: Refusal(checkNotNull(refusals[code]) { "no door answers $code" }, code, allowance)
        }
    }

    val opened: MutableList<Opened> = Collections.synchronizedList(mutableListOf())
    val rounds: MutableList<Json> = Collections.synchronizedList(mutableListOf())
    val uploads: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val uploaded: MutableMap<String, ByteArray> = Collections.synchronizedMap(mutableMapOf())
    val reads: MutableList<String> = Collections.synchronizedList(mutableListOf())
    var passes = 0
    var refuseOpen: Refusal? = null
    // Whether a call read again, as a new process recovers it, finds its answer in the script; otherwise the service holds none.
    var holdsAnswers = false
    // Nothing reaches the pass door or the service: the device has no connection.
    var unreachable = false
    var stopAsked: StateFlow<Boolean> = MutableStateFlow(false)
    var beforeRound: suspend () -> Unit = {}
    var beforePass: suspend () -> Unit = {}
    private val released = MutableStateFlow(false)
    private var position = 0
    private var eventId = 0L
    @Volatile private var resuming = false

    // The same script again, for a second turn of one conversation.
    fun rewind() {
        position = 0
        released.value = false
    }

    // A round held on `{"await":"stop"}` goes on.
    fun release() { released.value = true }

    // What each round answered the calls of the one before it, in order.
    val results: List<Json> get() = rounds.flatMap { round -> round.member("messages").arr().lastOrNull()?.takeIf { it["role"]?.str() == "tool" }?.member("results")?.arr().orEmpty() }

    // What the pass door answers in place of a pass, when a test says.
    var passAnswer: AiResponse? = null

    override suspend fun pass(body: Json): AiResponse {
        beforePass()
        passAnswer?.let { passes += 1; return it }
        if (unreachable) throw AiTransportFailure("offline")
        passes += 1
        refuseOpen?.takeIf { it.atPassDoor }?.let { return AiResponse(it.status, Json.objectOf("error" to Json.of(it.code), "code" to Json.of(it.code))) }
        return AiResponse(200, Json.objectOf("pass" to Json.of("wm-pass.scripted"), "expiresIn" to Json.of(600_000)))
    }

    override suspend fun request(request: AiRequest): AiResponse {
        val path = request.path.substringBefore('?')
        if (request.method == "PUT" && path.startsWith("/v1/pictures/")) {
            uploads += path.removePrefix("/v1/pictures/")
            uploaded[path.removePrefix("/v1/pictures/")] = checkNotNull(request.bytes)
            return AiResponse(204)
        }
        // A call read again, as a new process recovers its last round: what the script still holds is that round's answer, when it holds answers, and a script spent holds none.
        if (request.method == "GET") {
            reads += path
            val callId = path.removePrefix("/v1/calls/").removeSuffix("/result")
            if (resuming) {
                resuming = false
                return AiResponse(200, events = flow {
                    combine(stopAsked, released) { stop, go -> stop || go }.first { it }
                    round(callId, again = true)
                })
            }
            if (!holdsAnswers || position >= events.size) return refusal(410, "result_gone")
            eventId = 0
            return AiResponse(200, events = flow { round(callId) })
        }
        if (unreachable) throw AiTransportFailure("lost")
        val body = Json.parse(checkNotNull(request.body))
        rounds += body
        val messages = body.member("messages").arr()
        if (messages.size == 1) opened += Opened(messages[0].member("parts").arr().last().member("text").str(), body)
        beforeRound()
        // A pass already in hand from an earlier turn meets the pass door's refusal at its next refresh, which an expired pass asks for.
        if (messages.size == 1) refuseOpen?.let { return if (it.atPassDoor) refusal(401, "pass_expired") else refusal(it.status, it.code, it.allowance) }
        while (position < events.size && events[position]["event"]?.str() == "snapshot") position++
        val first = events.getOrNull(position)
        if (first?.get("event")?.str() == "error" && first.member("data").member("code").str() in refusals) {
            position++
            val code = first.member("data").member("code").str()
            return refusal(refusals.getValue(code), code, first.member("data")["allowance"]?.orNull())
        }
        val callId = path.removePrefix("/v1/calls/").removeSuffix("/text")
        eventId = 0
        return AiResponse(200, events = flow { round(callId) })
    }

    // A round's events from where the script stands; `again` carries on a round whose stream broke, after the events already sent.
    private suspend fun FlowCollector<Json>.round(callId: String, again: Boolean = false) {
        suspend fun send(event: String, data: Json) = emit(Json.objectOf("id" to Json.of(++eventId), "event" to Json.of(event), "data" to data))
        val text = StringBuilder()
        val calls = mutableListOf<Json>()
        suspend fun end(stop: String) {
            val parts = listOfNotNull(text.takeIf { it.isNotEmpty() }?.let { Json.objectOf("text" to Json.of(it.toString())) }) + calls.map { Json.objectOf("toolCall" to it) }
            send("ended", Json.objectOf("stop" to Json.of(stop), "message" to Json.objectOf("role" to Json.of("assistant"), "parts" to Json.Arr(parts), "carry" to Json.of("carry")),
                "charged" to Json.of("0.01"), "allowance" to Json.Null))
        }
        if (!again) send("started", Json.objectOf("callId" to Json.of(callId), "served" to Json.of("large"), "maxTokens" to Json.of(2_000)))
        while (position < events.size) {
            val frame = events[position++]
            when (frame["await"]?.str()) {
                "stop" -> { combine(stopAsked, released) { stop, go -> stop || go }.first { it }; continue }
                "results" -> return end("tool_calls")
                "resume" -> { resuming = true; throw AiTransportFailure("lost") }
                null -> Unit
                else -> continue
            }
            val data = frame.member("data")
            when (frame.member("event").str()) {
                "text" -> { text.append(data.member("delta").str()); send("text", Json.objectOf("delta" to data.member("delta"))) }
                "calls" -> for (call in data.member("calls").arr()) {
                    val toolCall = Json.objectOf("id" to call.member("callId"), "name" to call.member("name"), "input" to call.member("input"))
                    calls += toolCall
                    send("toolCall", toolCall)
                }
                "done" -> return end(when (data.member("state").str()) {
                    "stopped" -> "tool_calls"
                    "declined" -> "declined"
                    else -> if (data["truncated"] == Json.of(true)) "truncated" else "completed"
                })
                "error" -> return send("failed", Json.objectOf("code" to Json.of("provider_failed"), "charged" to Json.Null, "allowance" to Json.Null))
            }
        }
        end("completed")
    }

    private fun refusal(status: Int, code: String, allowance: Json? = null) =
        AiResponse(status, Json.objectOf("code" to Json.of(code), "allowance" to (allowance ?: Json.Null)))

    private companion object {
        val passRefusals = mapOf("unauthenticated" to 401, "invalid_installation" to 401, "device_bound" to 409, "client-update-required" to 426,
            "anonymous_ai_unavailable" to 503, "not_found" to 404)
        val refusals = mapOf("subject_exhausted" to 429, "free_month_exhausted" to 429, "free_day_exhausted" to 429, "concurrency_exhausted" to 429,
            "rate_limited" to 429, "busy" to 503, "paused" to 503, "provider_unavailable" to 503, "device_bound" to 403, "funding_required" to 403)
    }
}

// The id the AI service holds a picture under for a turn: its digest.
internal fun heldAs(pictureId: String): String = works.windmill.sync.core.Sha256.hex(pictureId.encodeToByteArray())

// An allowance as the AI service states it beside a refusal.
internal fun scriptedAllowance(code: String, remaining: String = "0", reserved: String = "0", resetsAt: Long? = null, budgetResetsAt: Long? = null): Json = Json.parse("""{"tier":"anonymous",
    "period":"lifetime","limit":"0.5","used":"0.5","reserved":"$reserved","remaining":"$remaining","resetsAt":${resetsAt ?: "null"},"budgetResetsAt":${budgetResetsAt ?: "null"},
    "code":"$code","capabilities":{"text":{"large":"medium","medium":"medium","small":"small"},"transcription":false}}""")

// An installation that keeps its credential in memory, on a scripted issuer.
internal object TurnPhoneInstallation {
    fun onMemory(server: AiInstallationApi = ScriptedInstallation()): AiInstallation {
        val kept = mutableMapOf<String, String?>()
        return AiInstallation(object : KeptValues {
            override fun read(key: String) = kept[key]
            override fun write(values: Map<String, String?>) { kept.putAll(values) }
        }, KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().let { key -> SecretVault { key } }, server)
    }
}

// Every event and failure a phone told, for a test to read whole.
internal class TellingRecorder : Telemetry {
    val events: MutableList<Pair<String, Map<String, String>>> = Collections.synchronizedList(mutableListOf())
    val failures: MutableList<Map<String, String>> = Collections.synchronizedList(mutableListOf())
    var onEvent: (String, Map<String, String>) -> Unit = { _, _ -> }

    override fun event(name: String, properties: Map<String, String>) {
        events += name to properties
        onEvent(name, properties)
    }

    // The throwable each failure carried, in order with `failures`.
    val errors: MutableList<Throwable> = Collections.synchronizedList(mutableListOf())

    override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
        failures += properties + ("operation" to operation)
        errors += error
    }

    fun named(name: String) = events.filter { it.first == name }.map { it.second }
}

internal class ScriptedInstallation : AiInstallationApi {
    val credential = "a".repeat(43)
    var reads = 0
    var refuseCurrent: WindmillApiException? = null
    var issueFailure: WindmillApiException? = null

    private val allowance = AiAllowance("subject", "USD", "lifetime", "free", true, used = "0", reserved = "0", remaining = "1")

    override suspend fun issue(): AiInstallationResponse {
        issueFailure?.let { throw it }
        return AiInstallationResponse(false, allowance, credential)
    }

    override suspend fun current(credential: String): AiInstallationResponse {
        reads += 1
        refuseCurrent?.let { throw it }
        return AiInstallationResponse(false, allowance)
    }

    override suspend fun bind(credential: String, token: String) = AiInstallationResponse(true, allowance)
}

// One phone for a turn: the real engine, the store composed as the application composes it, `CoachTurns` on them, and a scripted AI service. A snapshot reopens a phone as a new process finds it. Virtual time, one dispatcher: the test advances it.
internal class TurnPhone(
    test: TestScope,
    directory: File,
    val server: ScriptedTurns = ScriptedTurns(emptyList()),
    snapshot: Json? = null,
    private val writable: () -> Boolean = { true },
    private val lease: (Job) -> Unit = {},
    private val accountToken: () -> String? = { "account-token" },
    shares: () -> GymRest? = { null },
    textEvery: Duration = 5.seconds,
) : AutoCloseable {
    val telling = TellingRecorder()
    val scope = CoroutineScope(SupervisorJob() + test.coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)
    val room = EngineRoomFixture(directory, scope, snapshot = snapshot, writeAuthority = writable)
    val engine get() = room.engine
    val installationServer = ScriptedInstallation()
    val pictureFolder = File(directory, "pictures")
    val pictures = PictureFiles { pictureFolder }
    val installation = TurnPhoneInstallation.onMemory(installationServer)
    val turns = CoachTurns(room.training, server, installation, accountToken, pictures, lazy { catalog() }, lazy { words() }, telling, lease,
        "https://windmill.works", shares, scope, test.coroutineContext[ContinuationInterceptor] as CoroutineDispatcher,
        runtime = CoachRuntime(CoachBackgroundLease { AutoCloseable {} }) { test.testScheduler.currentTime }, textEvery = textEvery,
        elapsedMs = { test.testScheduler.currentTime }).also { server.stopAsked = it.stopping }

    suspend fun signIn(account: String = "account-1") {
        room.select(account)
        room.sync(EngineRoomFixture.server())
    }

    fun seedRoutines() {
        for ((position, routine) in listOf("rt_00000001" to "Push A", "rt_00000002" to "Pull A").withIndex()) {
            engine.commit(ScopeRef(Gym.scope), Gesture(listOf(Change.create(Gym.Types.routine, NewID.Given(RecordID(routine.first)), mapOf(
                "name" to Json.of(routine.second), "position" to Json.of(position), "entries" to Json.parse("""[{"exerciseId":"bench-press"}]"""))))))
        }
    }

    fun messages(): List<CoachMessage> = room.engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachMessage, read.drawn(CoachMessage.type))
    }.inOrder

    fun threads(): List<CoachThread> = room.engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachThread, read.drawn(CoachThread.type))
    }

    fun message(id: Id<CoachMessage>): CoachMessage? = messages().firstOrNull { it.id == id }

    fun device(key: String): Json? = engine.read(ScopeRef(Gym.scope)) { it.device(key) }

    override fun close() {
        scope.cancel()
        room.close()
    }

    companion object {
        private val contract get() = File(System.getProperty("windmill.contract"))
        fun catalog() = Catalog(Json.parse(contract.resolve("gym/catalog-3.json").readBytes()))
        fun words() = CoachWords(contract.resolve("gym/coach/prompt.md").readText(), Json.parse(contract.resolve("gym/coach/first-content.json").readBytes()),
            Json.parse(contract.resolve("gym/coach/refusals.json").readBytes()))
    }
}
