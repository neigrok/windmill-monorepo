package works.windmill.sync.engine

import java.io.File
import java.nio.file.Files
import java.util.UUID
import java.util.Collections
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.modelserver.Credential
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.ProbeServerRules
import works.windmill.sync.modelserver.ServerState

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class RoadmapScaleBenchmarks {
    data class WriterSample(val phase: String, val timing: WriterTiming)

    @Test fun deviceCopies() = runBlocking {
        val fixtures = System.getenv("SYNC_ROADMAP_SCALE_FIXTURES")
        assumeTrue("opt-in scale fixture directory", fixtures != null)
        val directory = File(fixtures!!)
        val manifest = Json.parse(File(directory, "manifest.json").readBytes())
        val scenarios = manifest.member("scenarios").obj()
        val selected = System.getenv("SYNC_ROADMAP_SCALE_SCENARIO")
        require(selected == null || selected in scenarios) { "unknown scale scenario" }
        val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
        val scope = ScopeRef(manifest.member("tree"))
        val clock = object : EngineClock {
            override fun now() = System.currentTimeMillis()
            override fun reading() = ClockReading(now(), System.nanoTime() / 1_000_000, "scale")
        }
        val identities = object : IdentitySource {
            override fun opaqueID() = UUID.randomUUID().toString()
            override fun draw(bound: Int) = java.util.concurrent.ThreadLocalRandom.current().nextInt(bound)
        }
        for ((scenario, expected) in scenarios) {
            if (selected != null && selected != scenario) continue
            val server = ModelServer(registry, ProbeServerRules(), ServerState(Json.parse(File(directory, "$scenario.json").readBytes())))
            val transport = object : SyncTransport {
                override suspend fun hello(token: String?): Reply<SyncResponse> {
                    val answer = server.hello(Credential.Account("A"), clock.now())
                    return Reply.Answer(SyncResponse(answer.status, answer.body))
                }
                override suspend fun pull(request: Json, token: String?): Reply<SyncResponse> {
                    val answer = server.pull(request, Credential.Account("A"), clock.now())
                    return Reply.Answer(SyncResponse(answer.status, answer.body))
                }
                override suspend fun push(request: Json, token: String): Reply<SyncResponse> = error("benchmark never drains pending gestures")
                override suspend fun openLive(token: String): Reply<LiveConnection> = error("benchmark steps pull explicitly")
            }
            val tokens = object : SessionTokens {
                val values = mutableMapOf<String, String>()
                override fun token(account: String) = values[account]
                override fun save(account: String, token: String) { values[account] = token }
                override fun delete(account: String) { values.remove(account) }
                override fun accounts() = values.keys.toSet()
            }
            val folder = Files.createTempDirectory("windmill-scale-").toFile()
            val initial = Json.objectOf("active" to Json.of("replica"), "replicas" to Json.array(freshReplica("replica").json()))
            val result = mutableMapOf<String, Json>(
                "scenario" to Json.of(scenario), "sourceHead" to Json.of(System.getenv("SYNC_BENCH_SOURCE_HEAD") ?: "unspecified"),
                "storage" to Json.of("AndroidSqlite WAL FULL; Robolectric NATIVE SDK 35"),
                "transport" to Json.of("in-process model server; explicit engine pull rounds"),
                "java" to Json.of(System.getProperty("java.runtime.version") ?: "unknown"), "os" to Json.of(System.getProperty("os.name") ?: "unknown"),
                "openCache" to Json.of("same-process reopen; OS pages may be warm"),
            )
            val phase = AtomicReference("initialOpen")
            val writerSamples = Collections.synchronizedList(mutableListOf<WriterSample>())
            val observer = WriterObserver { timing ->
                val current = phase.get()
                if (current != "fixtureSeed") writerSamples.add(WriterSample(current, timing))
            }
            fun open() = AndroidSqlite.open(File(folder, "scale.sqlite"), registry, initial, clock, identities, "r_aaaaaaaaaaaa", writerObserver = observer)
            fun runtime(engine: Engine) = SyncRuntime(engine, transport, tokens, "scale", products = listOf("probe"), activityAllowed = { false })
            var engine = open()
            var runtime = runtime(engine)
            try {
                phase.set("initialStart")
                engine.start()
                if (scenario == "pending") {
                    phase.set("fixtureSeed")
                    val entries = Json.parse(File(directory, "pending-entries.json").readBytes()).arr().map(::Entry)
                    engine.write { it.outbox.addAll(entries) }
                } else {
                    phase.set("initialSignIn")
                    assertTrue(runtime.signIn("A", "scale").isComplete)
                    phase.set("firstPull")
                    val began = System.nanoTime()
                    pull(engine, server, clock, expected.member("followedScopes").long().toInt())
                    result["firstPullMs"] = Json.of((System.nanoTime() - began) / 1_000_000.0)
                }
                runtime.close(); engine.close()
                phase.set("open")
                val opened = System.nanoTime()
                engine = open()
                result["openMs"] = Json.of((System.nanoTime() - opened) / 1_000_000.0)
                phase.set("read")
                val read = System.nanoTime()
                val count = engine.read(scope) { it.drawn("tag").size + it.drawn("link").size }
                result["readMs"] = Json.of((System.nanoTime() - read) / 1_000_000.0)
                assertEquals(expected.member("deviceRecords").long().toInt(), count)
                result["records"] = Json.of(count)
                runtime = runtime(engine)
                phase.set("gesture")
                val edited = System.nanoTime()
                val outcome = engine.commit(scope, Gesture(listOf(Change.update("tag", RecordID("step0"), mapOf("label" to Json.of("Edited"))))))
                assertTrue(outcome is CommitOutcome.Committed)
                result["gestureMs"] = Json.of((System.nanoTime() - edited) / 1_000_000.0)
                assertEquals(Json.of("Edited"), engine.read(scope) { it.drawn("tag", RecordID("step0"))!!.values["label"] })
                phase.set("signIn")
                val signed = System.nanoTime()
                assertTrue(runtime.signIn("A", "scale").isComplete)
                result["signInMs"] = Json.of((System.nanoTime() - signed) / 1_000_000.0)
                result["signInCoverage"] = Json.of(if (scenario == "pending") "hello and anonymous adoption" else "returning account API completion; hello runs asynchronously")
                if (scenario == "pending") {
                    val queued = engine.device.current().outbox.size
                    phase.set("firstPull")
                    val began = System.nanoTime()
                    pull(engine, server, clock, 1, listOf(ScopeRef.product("probe")))
                    result["firstPullMs"] = Json.of((System.nanoTime() - began) / 1_000_000.0)
                    assertEquals(queued, engine.device.current().outbox.size)
                    assertFalse(engine.device.current().cursors[scope.text]?.flag("booted") == true)
                    result["firstPullCoverage"] = Json.of("empty account product after adoption; queued new tree remains local")
                } else result["firstPullCoverage"] = Json.of("all owned product, tree and overlay scopes")
                assertEquals(count, engine.read(scope) { it.drawn("tag").size + it.drawn("link").size })
                assertEquals(expected.member("pendingEntries").long().toInt() + 1, engine.device.current().outbox.size)
                result["pendingEntries"] = Json.of(engine.device.current().outbox.size)
                val samples = synchronized(writerSamples) { writerSamples.toList() }
                assertEquals(1, samples.count { it.phase == "gesture" && it.timing.operation == EngineOperation.commit && it.timing.outcome == WriterTiming.Outcome.success })
                assertTrue(samples.any { it.phase == "firstPull" && it.timing.operation != EngineOperation.commit })
                val summaries = samples.groupBy { listOf(it.phase, it.timing.operation.name, it.timing.outcome.name) }
                    .entries.sortedBy { it.key.joinToString("/") }.map { (labels, values) ->
                        val summary = mutableMapOf("phase" to Json.of(labels[0]), "operation" to Json.of(labels[1]),
                            "kind" to Json.of(if (labels[1] == "commit") "commit" else "non-commit"),
                            "outcome" to Json.of(labels[2]), "count" to Json.of(values.size))
                        for ((name, numbers) in listOf("heldMs" to values.map { it.timing.heldMs }.sorted(),
                            "queueMs" to values.map { it.timing.queueMs }.sorted())) {
                            fun quantile(q: Double) = numbers[(kotlin.math.ceil(numbers.size * q).toInt() - 1).coerceAtLeast(0)]
                            summary[name] = Json.objectOf("max" to Json.of(numbers.last()), "p50" to Json.of(quantile(0.5)),
                                "p95" to Json.of(quantile(0.95)), "p99" to Json.of(quantile(0.99)))
                        }
                        Json.Obj(summary.toList())
                    }
                result["writer"] = Json.objectOf("coverage" to Json.of("engine writer lock; excludes fixture loading; queue and hold timed separately"),
                    "summaries" to Json.Arr(summaries), "samples" to Json.Arr(samples.map {
                        Json.objectOf("phase" to Json.of(it.phase), "operation" to Json.of(it.timing.operation.name),
                            "outcome" to Json.of(it.timing.outcome.name), "heldMs" to Json.of(it.timing.heldMs), "queueMs" to Json.of(it.timing.queueMs))
                    }))
                val report = Json.Obj(result.toList()).jcs
                println(report)
                System.getenv("SYNC_BENCH_REPORT")?.let { File(it).appendText(report + "\n") }
            } finally { runtime.close(); engine.close(); folder.deleteRecursively() }
        }
    }

    private fun pull(engine: Engine, server: ModelServer, clock: EngineClock, expected: Int, only: List<ScopeRef>? = null) {
        repeat(2_000) {
            val scopes = only ?: engine.subscriptions(listOf("probe")).sorted()
            engine.reconcile(scopes.toSet())
            val pending = scopes.filter { engine.device.current().cursors[it.text]?.flag("booted") != true }
            if (scopes.size == expected && pending.isEmpty()) return
            for (batch in pending.chunked(Constants.PULL_MAX_SCOPES)) {
                val request = engine.pullRequest(batch) ?: error("no pull for unfinished scopes")
                val send = clock.reading()
                val reply = server.pull(request, Credential.Account("A"), clock.now())
                assertEquals(200, reply.status)
                engine.onPullResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(send, clock.reading()), appVersion = "scale")
                while (engine.sweepReleased()) { }
            }
        }
        error("first pull did not finish")
    }
}
