package works.windmill.app

import java.io.IOException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.telemetry.EventBatchOut
import works.windmill.platform.telemetry.EventQueue
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.*
import works.windmill.sync.engine.*
import works.windmill.sync.schema.SyncSchema

class EngineIdleTests {
    private class Clock : EngineClock {
        @Volatile var elapsed = 0L
        override fun now() = 1_800_000_000_000L + elapsed
        override fun reading() = ClockReading(now(), elapsed, "idle-test")
    }

    @Test fun anHourIdleOnlineUsesOnlyTheLiveSocketAndCreatesNoProductEvents() = runBlocking { idle(online = true) }
    @Test fun anHourIdleOfflineFillsNoTelemetryShelfAndMakesNoNetworkRequests() = runBlocking { idle(online = false) }

    private suspend fun idle(online: Boolean) {
        val clock = Clock()
        val requests = ConcurrentLinkedQueue<String>()
        val openings = AtomicInteger()
        val socket = AtomicReference<WebSocket?>()
        val subscribed = CompletableDeferred<Unit>()
        val source = AtomicReference<String?>()
        val issues = ConcurrentLinkedQueue<String>()
        val reported = ConcurrentLinkedQueue<EngineEvent>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            if (!online) throw IOException("offline")
            chain.proceed(chain.request())
        }.build()
        try { MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests.add("${request.method} ${request.path}")
                    val base = Json.objectOf("serverTime" to Json.of(clock.now()), "epoch" to Json.of("idle-epoch"), "as" to Json.of("A"))
                    return when (request.path?.substringBefore('?')) {
                        "/v1/sync/live" -> MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                            override fun onOpen(opened: WebSocket, response: Response) { socket.set(opened); openings.incrementAndGet() }
                            override fun onMessage(socket: WebSocket, text: String) {
                                when (Json.parse(text).member("op").str()) {
                                    "sub" -> subscribed.complete(Unit)
                                    "ping" -> socket.send("""{"op":"pong"}""")
                                }
                            }
                        })
                        "/v1/sync/pull" -> {
                            val asked = Json.parse(request.body.readUtf8()).member("scopes").arr()
                            val pages = asked.map { scope -> Json.objectOf("scope" to scope.member("scope"), "kind" to Json.of("rows"),
                                "rows" to Json.array(), "more" to Json.of(false), "seq" to Json.of(0),
                                "cursor" to Json.of(WireCursor("idle-epoch", "live", 0).text), "digest" to Json.of(ScopeDigest.ZERO.hex)) }
                            MockResponse().setBody(Json.Obj(base.obj().toList() + ("pages" to Json.Arr(pages))).jcs)
                        }
                        "/v1/events" -> {
                            val size = Json.parse(request.body.readUtf8()).member("events").arr().size
                            MockResponse().setResponseCode(202).setBody("""{"accepted":$size}""")
                        }
                        else -> MockResponse().setResponseCode(500)
                    }
                }
            }
            val api = WindmillApi(server.url("/"), { "token:A" }, client)
            val queue = EventQueue("A", "token:A", { source.get() }, { source.set(it); true },
                send = { batch, _ -> api.send<EventBatchOut>("POST", "/v1/events", batch).accepted },
                failure = { operation, _, _ -> issues.add(operation) }, scope = scope, now = clock::now)
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) = queue.add(name, properties)
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { issues.add(operation) }
            }
            val product = engineTelemetry(telemetry)
            val bridge = EngineTelemetry { event -> reported.add(event); product.record(event) }
            val initial = Engine.memory(SyncSchema.registry, clock = clock).use { engine ->
                assertTrue(engine.signIn("A", mapOf("gym" to false)).member("complete").bool())
                engine.snapshot()
            }
            Engine.memory(SyncSchema.registry, initial, clock = clock, telemetry = bridge).use { engine ->
                val tokens = object : SessionTokens {
                    override fun token(account: String) = "token:A"
                    override fun save(account: String, token: String) {}
                    override fun delete(account: String) {}
                    override fun accounts() = setOf("A")
                }
                HTTPTransport(server.url("/").toString(), SyncSchema.version.toInt(), bridge).use { transport ->
                    SyncRuntime(engine, transport, tokens, "test", sleeper = object : EngineSleeper {
                        override suspend fun sleep(ms: Long) = awaitCancellation()
                    }, products = listOf("gym")).use { runtime ->
                        runtime.connectivity(online); runtime.enter()
                        if (online) {
                            withTimeout(2_000) { subscribed.await() }
                            withTimeout(2_000) {
                                while (!engine.read(ScopeRef.product("gym")) { it.firstPullComplete() }) { runtime.pullerStep(); delay(5) }
                            }
                            runtime.pullerStep()
                        }
                        // Drain startup callbacks; the measured hour contains no person-authored work.
                        delay(100)
                        requests.clear(); reported.clear(); issues.clear()
                        repeat(3_600) {
                            clock.elapsed += 1_000
                            runtime.senderStep(); runtime.pullerStep(); engine.sweepReleased(); engine.releaseHeld()
                            if (it % 60 == 0) yield()
                        }
                        delay(100)
                        val shelf = source.get()?.let(Json::parse)
                        val queued = shelf?.member("shelves")?.arr().orEmpty().sumOf { it.member("events").arr().size }
                        val delivered = requests.toList()
                        assertEquals("idle HTTP traffic: ${delivered.groupingBy { it }.eachCount()}; queued=$queued; issues=$issues", emptyList<String>(), delivered)
                        assertEquals("idle telemetry fills nothing", 0, queued)
                        assertEquals("no idle failure or overflow issues", emptyList<String>(), issues.toList())
                        assertFalse("no-op engine successes never enter the telemetry worker", reported.any { it.outcome == EngineOutcome.success })
                        assertEquals(if (online) 1 else 0, openings.get())
                        if (online) {
                            assertTrue(socket.get()!!.close(1011, "test disconnect"))
                            withTimeout(2_000) {
                                while (openings.get() < 2 || requests.none { it == "POST /v1/sync/pull" }) delay(5)
                            }
                        }
                    }
                }
            }
        } } finally {
            scope.cancel()
            client.dispatcher.executorService.shutdownNow()
            client.connectionPool.evictAll()
        }
    }
}
