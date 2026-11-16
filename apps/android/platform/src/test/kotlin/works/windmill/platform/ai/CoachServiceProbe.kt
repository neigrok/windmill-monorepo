package works.windmill.platform.ai

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrl
import works.windmill.agent.coach.*
import works.windmill.platform.agent.CoachBackgroundLease
import works.windmill.platform.agent.CoachRuntime
import works.windmill.sync.core.Json

object CoachServiceProbe {
    @JvmStatic fun main(args: Array<String>) = runBlocking {
        val config = Json.parse(Files.readAllBytes(Paths.get(checkNotNull(System.getenv("WM_COACH_PROBE_CONFIG")))))
        val out = Paths.get(checkNotNull(System.getenv("WM_COACH_PROBE_OUT")))
        val state = System.getenv("WM_COACH_PROBE_STATE")?.let { Paths.get(it) }
        val marks = mutableListOf<Json>()
        val abilities = mutableListOf<Json>()
        val requests = mutableListOf<Json>()
        val events = mutableListOf<Json>()
        val host = ProbeHost(config, state, marks, abilities)
        val telemetry = object : Telemetry {
            override fun turn(report: TurnReport) { events += Json.Obj(report.json.obj().toList() + ("kind" to Json.of("turn"))) }
            override fun ability(report: AbilityReport) { events += Json.Obj(report.json.obj().toList() + ("kind" to Json.of("ability"))) }
            override fun failure(operation: FailureOperation) { events += Json.objectOf("operation" to Json.of(operation.label)) }
        }
        val transport = AiHttp(config.member("origin").str().toHttpUrl(), {
            AiCredentials(config["session"]?.orNull()?.str(), config["installation"]?.orNull()?.str())
        }, allowLocalHttp = true, requestObserved = { method, path ->
            requests += Json.objectOf("method" to Json.of(method), "path" to Json.of(path))
        })
        transport.use {
            var index = 0
            val runtime = CoachRuntime(CoachBackgroundLease { AutoCloseable {} })
            val runner = TurnRunner(host, CoachAiClient(transport, telemetry), telemetry, object : Runtime {
                override fun now() = runtime.now()
                override fun newId() = config.member("runtime").member("callIds").arr()[index++].str()
                override suspend fun <T> withLease(turnId: String, ifAvailable: Boolean, body: suspend (Boolean) -> T) = runtime.withLease(turnId, ifAvailable, body)
            })
            host.afterText = { if (config.member("scenario").str() == "stop" || config["stopOnFirstText"] == Json.of(true)) runner.stop() }
            val end = runner.run(TurnInput(config.member("input")), Profile(config.member("profile")), config.member("scenario").str().startsWith("recover"))
            writePrivate(out, Json.objectOf("end" to (end?.json ?: Json.Null), "abilityCalls" to Json.Arr(abilities), "marks" to Json.Arr(marks), "requests" to Json.Arr(requests), "telemetry" to Json.Arr(events)))
        }
    }
    fun writePrivate(path: Path, value: Json) {
        val next = path.resolveSibling(path.fileName.toString() + ".next")
        Files.write(next, value.jcs.encodeToByteArray())
        Files.setPosixFilePermissions(next, PosixFilePermissions.fromString("rw-------"))
        Files.move(next, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}

class ProbeHost(private val config: Json, private val path: Path?, private val marks: MutableList<Json>, private val abilities: MutableList<Json>) : ToolHost {
    private class Lease : HostLease
    private val mutex = Mutex()
    private var lease: Lease? = null
    private var record: Json? = path?.takeIf { Files.exists(it) }?.let { Json.parse(Files.readAllBytes(it)) }
    var afterText: () -> Unit = {}
    private fun guard(candidate: HostLease) { if (candidate !== lease || record?.get("state")?.orNull() == null) throw HostUnavailable() }
    private fun save(value: Json) { path?.let { CoachServiceProbe.writePrivate(it, value) }; record = value }
    private fun replace(vararg values: Pair<String, Json>) = Json.Obj(record!!.obj().filterKeys { key -> values.none { it.first == key } }.toList() + values)
    suspend fun delete() = mutex.withLock { record = null }
    override suspend fun open(input: TurnInput): Opened = mutex.withLock {
        lease = Lease()
        val mark = Mark(input.turnId, null, 0).json
        save(Json.objectOf("mark" to mark, "text" to Json.of(""), "state" to Json.of("running"), "executions" to Json.array(), "values" to Json.array()))
        marks += mark
        Opened(lease!!, config["history"]?.str() ?: "", config["context"]?.arr()?.map(Json::str).orEmpty(), input.pictures)
    }
    override suspend fun recover(turnId: String, seat: Seat): Recovery? = mutex.withLock {
        val current = config["recovery"]?.orNull() ?: record ?: return@withLock null
        if (current["mark"]?.orNull() == null) return@withLock null
        lease = Lease()
        if (record == null) record = Json.objectOf("executions" to Json.array(), "values" to Json.array())
        save(replace("mark" to current.member("mark"), "text" to current.member("text"), "state" to (current["state"] ?: Json.of("running"))))
        Recovery(lease!!, record!!.member("state").str(), record!!.member("text").str(), Mark(record!!.member("mark")))
    }
    override suspend fun beginRound(lease: HostLease, text: String, mark: Mark) = mutex.withLock {
        guard(lease); save(replace("text" to Json.of(text), "mark" to mark.json)); marks += mark.json
    }
    override suspend fun text(lease: HostLease, text: String) { mutex.withLock { guard(lease); save(replace("text" to Json.of(text))) }; afterText() }
    override suspend fun check(lease: HostLease, rule: String, call: ToolCall): String? = mutex.withLock { guard(lease); config["checks"]?.get(call.id)?.get(rule)?.orNull()?.str() }
    override suspend fun execute(lease: HostLease, identity: CallIdentity, call: ToolCall): ToolOutcome = mutex.withLock {
        guard(lease)
        val key = Json.of("${identity.turnId}:${identity.callId}:${identity.toolCallId}")
        val executions = record!!.member("executions").arr()
        check(key !in executions) { "duplicate-execution" }
        save(replace("executions" to Json.Arr(executions + key), "values" to Json.Arr(record!!.member("values").arr() + call.input)))
        abilities += Json.objectOf("name" to Json.of(call.name), "input" to call.input)
        val outcome = config["executions"]?.get(call.name)
        if (outcome == null || outcome.member("ok").bool()) ToolOutcome.Ok(outcome?.get("content")?.str() ?: "saved") else ToolOutcome.Refused(outcome.member("code").str())
    }
    override suspend fun end(lease: HostLease, end: TurnEnd) = mutex.withLock { guard(lease); save(replace("text" to Json.of(end.text), "state" to Json.of(end.state.name), "mark" to Json.Null)); marks += Json.Null }
    override suspend fun withdraw(lease: HostLease) = mutex.withLock { guard(lease); save(replace("text" to Json.of(""), "state" to Json.Null, "mark" to Json.Null)); marks += Json.Null }
}
