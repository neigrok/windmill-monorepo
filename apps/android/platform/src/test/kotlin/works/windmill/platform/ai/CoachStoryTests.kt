package works.windmill.platform.ai

import java.io.File
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.agent.coach.*
import works.windmill.sync.core.Json

@RunWith(Parameterized::class)
class CoachStoryTests(private val file: File) {
    @Test fun completeSharedTrace() = runBlocking {
        val story = Json.parse(file.readText())
        val requests = mutableListOf<Json>()
        val hostCalls = mutableListOf<Json>()
        val refusals = mutableListOf<Json>()
        val marks = mutableListOf<Json>()
        val waits = mutableListOf<Json>()
        val events = mutableListOf<Json>()
        val controls = story.member("controls").arr().toMutableList()
        var now = story.member("runtime").member("nowMs").long()
        var generation = 0
        var exists = story.member("host")["recovery"]?.orNull() != null
        var recordState: String? = story.member("host")["recovery"]?.get("state")?.str()
        class Lease(val generation: Int) : HostLease
        var writer: Lease? = null
        var barrier: Job? = null
        lateinit var runner: TurnRunner
        fun control(at: String) {
            val index = controls.indexOfFirst { it.member("at").str() == at }
            if (index < 0) return
            when (controls.removeAt(index).member("action").str()) {
                "stop" -> runner.stop()
                "seat" -> barrier = launch(start = CoroutineStart.UNDISPATCHED) { runner.seatWillChange(); generation++ }
                "delete" -> exists = false
                "stale" -> recordState = "interrupted"
            }
        }
        fun guard(lease: HostLease) { if (!exists || writer !== lease || (lease as Lease).generation != generation) throw HostUnavailable() }
        val host = object : ToolHost {
            override fun refused(id: String, code: String) { refusals += Json.objectOf("id" to Json.of(id), "code" to Json.of(code)) }
            override suspend fun open(input: TurnInput): Opened {
                control("open:beforeCommit")
                writer = Lease(generation); exists = true; recordState = "running"
                hostCalls += Json.objectOf("op" to Json.of("open"), "input" to input.json)
                marks += Mark(input.turnId, null, 0).json
                val open = story.member("host").member("open")
                return Opened(writer!!, open.member("history").str(), open.member("context").arr().map(Json::str), open.member("pictures").arr().map(::Picture))
            }
            override suspend fun recover(turnId: String, seat: Seat): Recovery {
                writer = Lease(generation)
                hostCalls += Json.objectOf("op" to Json.of("recover"), "turnId" to Json.of(turnId))
                val data = story.member("host").member("recovery")
                return Recovery(writer!!, data.member("state").str(), data.member("text").str(), Mark(data.member("mark")))
            }
            override suspend fun beginRound(lease: HostLease, text: String, mark: Mark) {
                guard(lease); hostCalls += Json.objectOf("op" to Json.of("beginRound"), "text" to Json.of(text), "mark" to mark.json); marks += mark.json
            }
            override suspend fun text(lease: HostLease, text: String) { control("text:beforeCommit"); guard(lease); hostCalls += Json.objectOf("op" to Json.of("text"), "text" to Json.of(text)) }
            override suspend fun check(lease: HostLease, rule: String, call: ToolCall): String? {
                control("check:${call.id}:$rule"); guard(lease)
                hostCalls += Json.objectOf("op" to Json.of("check"), "rule" to Json.of(rule), "call" to call.json)
                return story.member("host").member("checks")[call.id]?.get(rule)?.orNull()?.str()
            }
            override suspend fun execute(lease: HostLease, identity: CallIdentity, call: ToolCall): ToolOutcome {
                control("execute:${call.id}:beforeCommit"); guard(lease)
                hostCalls += Json.objectOf("op" to Json.of("execute"), "callId" to Json.of(identity.callId), "call" to call.json)
                val value = story.member("host").member("executions")[call.id]
                return if (value == null) ToolOutcome.Ok(call.input.member("value").jcs)
                else if (value.member("ok").bool()) ToolOutcome.Ok(value.member("content").str()) else ToolOutcome.Refused(value.member("code").str())
            }
            override suspend fun end(lease: HostLease, end: TurnEnd) { guard(lease); recordState = end.state.name; hostCalls += Json.objectOf("op" to Json.of("end"), "end" to end.json); marks += Json.Null }
            override suspend fun withdraw(lease: HostLease) { guard(lease); exists = false; hostCalls += Json.objectOf("op" to Json.of("withdraw")); marks += Json.Null }
        }
        val telemetry = object : Telemetry {
            override fun failure(operation: FailureOperation) { events += Json.objectOf("kind" to Json.of("failure"), "operation" to Json.of(operation.label)) }
            override fun turn(report: TurnReport) { events += Json.Obj(report.json.obj().toList() + ("kind" to Json.of("turn"))) }
            override fun ability(report: AbilityReport) { events += Json.Obj(report.json.obj().toList() + ("kind" to Json.of("ability"))) }
        }
        var passIndex = 0; var exchangeIndex = 0; var repeat = 0; var pictureIndex = 0; var idIndex = 0
        val service = story.member("service")
        val transport = object : AiTransport {
            override suspend fun pass(body: Json): AiResponse {
                val passes = service.member("passes").arr()
                val value = passes[minOf(passIndex++, passes.lastIndex)]
                return if (value["pass"] != null) AiResponse(200, value) else AiResponse(value.member("status").long().toInt(), Json.objectOf("code" to value.member("code")))
            }
            override suspend fun request(request: AiRequest): AiResponse {
                requests += Json.objectOf("method" to Json.of(request.method), "path" to Json.of(request.path), "body" to (request.bytes?.let { Json.Arr(it.map { byte -> Json.of(byte.toInt() and 255) }) } ?: request.body?.let(Json::parse) ?: Json.Null))
                if (request.path.startsWith("/v1/pictures/")) return AiResponse(service.member("pictures").arr().getOrNull(pictureIndex++)?.long()?.toInt() ?: 204)
                val current = exchangeIndex
                val value = service.member("exchanges").arr().getOrNull(exchangeIndex) ?: error("unexpected-request")
                if (++repeat >= value.member("repeat").long()) { exchangeIndex++; repeat = 0 }
                if (value["refusal"]?.orNull() != null) return AiResponse(429, value.member("refusal"))
                return AiResponse(200, events = flow {
                    for (event in value.member("events").arr()) { control("event:$current:${event.member("id").long()}"); emit(event) }
                    if (value.member("broken").bool()) throw AiTransportFailure("lost")
                })
            }
        }
        val ai = CoachAiClient(transport, telemetry, now = { now }, wait = { ms, stop ->
            val index = waits.size; waits += Json.of(ms); control("wait:$index")
            if (stop.stopped) false else { now += ms; true }
        })
        runner = TurnRunner(host, ai, telemetry, object : Runtime {
            override fun now() = now
            override fun newId() = story.member("runtime").member("callIds").arr()[idIndex++].str()
            override suspend fun <T> withLease(turnId: String, ifAvailable: Boolean, body: suspend (Boolean) -> T) = body(story.member("runtime").member("lockAvailable").bool())
        })
        val end = runner.run(TurnInput(story.member("input")), Profile(story.member("profile")), recover = story.member("host")["recovery"]?.orNull() != null)
        barrier?.join()
        val actual = Json.objectOf("requests" to Json.Arr(requests), "hostCalls" to Json.Arr(hostCalls), "gateRefusals" to Json.Arr(refusals), "marks" to Json.Arr(marks), "waitsMs" to Json.Arr(waits), "telemetry" to Json.Arr(events), "end" to (end?.json ?: Json.Null))
        assertEquals(file.name, story.member("expected").jcs, actual.jcs)
        assertEquals(emptyList<Json>(), controls)
        if (end != null && exists) assertEquals(end.state.name, recordState)
    }
    companion object {
        @JvmStatic @Parameterized.Parameters(name = "{0}") fun stories(): List<Array<File>> = File(System.getProperty("windmill.contract"), "agent/turns").listFiles()!!.filter { it.extension == "json" }.sorted().map { arrayOf(it) }
    }
}
