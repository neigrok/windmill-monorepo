package works.windmill.platform.agent

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import works.windmill.agent.ContextRead
import works.windmill.agent.SeatKind
import works.windmill.agent.ToolOutcome
import works.windmill.agent.ToolCall
import works.windmill.agent.TurnBatch
import works.windmill.agent.TurnConnectionLost
import works.windmill.agent.TurnDriver
import works.windmill.agent.TurnEnd
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnExit
import works.windmill.agent.TurnFailure
import works.windmill.agent.TurnHost
import works.windmill.agent.TurnLabel
import works.windmill.agent.TurnLine
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnPicture
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnSse
import works.windmill.agent.TurnState
import works.windmill.agent.TurnTally
import works.windmill.agent.TurnTelemetry
import works.windmill.agent.TurnWireFault
import works.windmill.sync.core.Json

class TurnHttpTest {
    private val server = MockWebServer()
    private val bound = TurnSeat.Bound("session-token")
    private val anon = TurnSeat.Anon("installation-credential")
    private val open = TurnOpen("tn_1", "catalog/2", "Hi", listOf(TurnPicture("p1", "image/jpeg", byteArrayOf(1, 2, 3))), listOf(TurnLine("lifter", "Before")),
        listOf(ContextRead("list_things", Json.objectOf(), Json.objectOf("things" to Json.Arr(emptyList())))), emptyList())

    private val shared = OkHttpClient()

    @Before fun start() = server.start()
    @After fun stop() {
        shared.dispatcher.cancelAll()
        runCatching { server.shutdown() }
    }

    private fun http(client: OkHttpClient = shared) = TurnHttp(server.url("/"), "/v1/agent/turns", 13, client)
    private fun settled(): String {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (shared.dispatcher.runningCallsCount() != 0 && System.nanoTime() < deadline) Thread.sleep(20)
        shared.connectionPool.evictAll()
        return "running=${shared.dispatcher.runningCallsCount()} connections=${shared.connectionPool.connectionCount()}"
    }
    private fun frames(count: Int) = (1..count).joinToString("") { "event: text\ndata: {\"delta\":\"$it\"}\n\n" }
    private fun quietTelemetry(lines: MutableList<String> = mutableListOf()) = object : TurnTelemetry {
        override fun ability(name: TurnLabel, outcome: TurnLabel) { lines += "ability" }
        override fun ended(state: TurnState, seat: SeatKind, code: TurnLabel?, tally: TurnTally, durationMs: Long) { lines += "ended $state ${code?.value}" }
        override fun withdrawn(status: Int, code: TurnLabel, durationMs: Long) { lines += "withdrawn" }
        override fun failure(kind: TurnFailure, status: Int?) { lines += "failure $kind $status" }
    }
    private fun echo(ends: MutableList<TurnEnd> = mutableListOf()) = object : TurnHost {
        override suspend fun open() = this@TurnHttpTest.open
        override suspend fun execute(call: ToolCall): ToolOutcome = ToolOutcome.Ok(call.callId, call.name, call.input)
        override suspend fun writeText(text: String) {}
        override suspend fun end(end: TurnEnd) { ends += end }
        override suspend fun withdraw(refusal: TurnRefusal) {}
    }
    private fun sse(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream; charset=utf-8").setBody(body)
    private fun json(status: Int, body: String) = MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
    private fun request(): RecordedRequest = server.takeRequest(60, TimeUnit.SECONDS)!!
    private fun RecordedRequest.seen() = listOf(method, path, headers["Sync-Schema"], headers["Authorization"], headers["X-Windmill-Installation"], headers["Accept"], headers["Content-Type"], headers["Cookie"], body.readUtf8())
    // Every wait here is for a condition: the bounds only say when a test that will never pass gives up, so they leave room for the slowest machine.
    private fun <T> within(work: suspend () -> T): T = runBlocking { withTimeout(60.seconds) { work() } }
    private fun thrown(work: suspend () -> Unit): Exception = within {
        var failure: Exception? = null
        try { work() } catch (caught: Exception) { failure = caught }
        failure ?: error("expected a failure")
    }
    private fun failure(flow: Flow<TurnEvent>): Exception = thrown { flow.toList() }

    @Test fun theOpenPostsItsCanonicalBodyAndStreamsToItsClosingFrame() {
        server.enqueue(sse(": heartbeat\n\nevent: text\ndata: {\"delta\":\"Hi\"}\n\nevent: calls\ndata: {\"batch\":1,\"calls\":[{\"callId\":\"a\",\"name\":\"list_things\",\"input\":{}}]}\n\nevent: done\ndata: {\"state\":\"completed\",\"truncated\":true}\n\nevent: text\ndata: {\"delta\":\"after the end\"}\n\n"))
        assertEquals(listOf(TurnEvent.Text("Hi"), TurnEvent.Calls(TurnBatch(1, listOf(ToolCall("a", "list_things", Json.objectOf())))), TurnEvent.Done(TurnState.completed, true)),
            within { http().open(open, bound).toList() })
        assertEquals(listOf("POST", "/v1/agent/turns", "13", "Bearer session-token", null, "text/event-stream", "application/json", null,
            """{"catalog":"catalog/2","context":[{"input":{},"name":"list_things","result":{"things":[]}}],"history":[{"role":"lifter","text":"Before"}],"pictures":[{"data":"AQID","id":"p1","mediaType":"image/jpeg"}],"question":"Hi","turnId":"tn_1"}"""),
            request().seen())
    }

    @Test fun theResumeReadsTheTurnsStreamUnderAnAnonSeatPastATerminalSnapshotToItsClosingFrame() {
        server.enqueue(sse("event: snapshot\ndata: {\"text\":\"So far\",\"state\":\"failed\"}\n\nevent: error\ndata: {\"code\":\"free_month_exhausted\",\"budgetResetsAtMs\":1793491200000}\n\nevent: text\ndata: {\"delta\":\"after the end\"}\n\n"))
        assertEquals(listOf(TurnEvent.Snapshot("So far", TurnState.failed, null), TurnEvent.Error("free_month_exhausted", 1_793_491_200_000)), within { http().resume("tn_1", anon).toList() })
        assertEquals(listOf("GET", "/v1/agent/turns/tn_1", "13", null, "installation-credential", "text/event-stream", null, null, ""), request().seen())
    }

    @Test fun theResultsPostOneBatchAndAReplayAnsweringNoContentIsAnAnswer() {
        val results = listOf(ToolOutcome.Ok("a", "one", Json.objectOf("n" to Json.of(1))), ToolOutcome.Refused("b", "two", "record-dead"))
        val body = """{"batch":2,"results":[{"callId":"a","ok":true,"result":{"n":1}},{"callId":"b","code":"record-dead","ok":false}]}"""
        server.enqueue(json(200, """{"batch":2}"""))
        server.enqueue(MockResponse().setResponseCode(204))
        within { http().answer("tn_1", 2, results, bound) }
        within { http().answer("tn_1", 2, results, anon) }
        assertEquals(listOf("POST", "/v1/agent/turns/tn_1/results", "13", "Bearer session-token", null, null, "application/json", null, body), request().seen())
        assertEquals(listOf("POST", "/v1/agent/turns/tn_1/results", "13", null, "installation-credential", null, "application/json", null, body), request().seen())
    }

    @Test fun refusedResultsNameTheirCode() {
        server.enqueue(json(409, """{"error":"Out of order","code":"coach-turn-order"}"""))
        assertEquals(TurnRefusal(409, "coach-turn-order", null), thrown { http().answer("tn_1", 1, emptyList(), bound) })
    }

    @Test fun theStopPostsAnEmptyObject() {
        server.enqueue(json(202, """{"state":"stopped"}"""))
        within { http().stop("tn_1", anon) }
        assertEquals(listOf("POST", "/v1/agent/turns/tn_1/stop", "13", null, "installation-credential", null, "application/json", null, "{}"), request().seen())
    }

    @Test fun aStopAnswerIsNotRead() {
        server.enqueue(json(202, "<html>"))
        within { http().stop("tn_1", bound) }
        server.enqueue(MockResponse().setResponseCode(202))
        within { http().stop("tn_1", bound) }
    }

    @Test fun aRefusedStopNamesItsCode() {
        server.enqueue(json(404, """{"error":"Gone","code":"coach-turn-unknown"}"""))
        assertEquals(TurnRefusal(404, TurnRefusal.turnUnknown, null), thrown { http().stop("tn_1", bound) })
    }

    @Test fun aRefusalBeforeTheStreamNamesItsCodeAndReset() {
        server.enqueue(json(429, """{"error":"Paused","code":"free_month_exhausted","allowance":{"budgetResetsAtMs":1793491200000}}"""))
        assertEquals(TurnRefusal(429, "free_month_exhausted", 1_793_491_200_000), failure(http().open(open, anon)))
        server.enqueue(json(426, """{"error":"Update","code":"client-update-required"}"""))
        assertEquals(TurnRefusal(426, "client-update-required", null), failure(http().resume("tn_1", bound)))
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))
        assertEquals(TurnRefusal(502, TurnRefusal.vendorError, null), failure(http().open(open, bound)))
    }

    @Test fun aRefusalBodyPastTheBoundIsReadNoFurther() {
        server.enqueue(MockResponse().setResponseCode(500).setBody("x".repeat(TurnSse.maxLineBytes + 1024)))
        assertEquals(TurnRefusal(500, TurnRefusal.vendorError, null), failure(http().open(open, bound)))
    }

    @Test fun aTwoHundredThatIsNoEventStreamIsAFault() {
        server.enqueue(json(200, """{"answer":"Hi"}"""))
        assertEquals(TurnWireFault.notAStream, (failure(http().open(open, bound)) as TurnWireFault).kind)
        server.enqueue(MockResponse().setResponseCode(204))
        assertEquals(TurnWireFault.notAStream, (failure(http().resume("tn_1", bound)) as TurnWireFault).kind)
    }

    @Test fun aStreamThatEndsWithoutAClosingFrameIsALostConnection() {
        server.enqueue(sse("event: text\ndata: {\"delta\":\"Hi\"}\n\n"))
        val seen = mutableListOf<TurnEvent>()
        assertTrue(thrown { http().open(open, bound).collect { seen += it } } is TurnConnectionLost)
        assertEquals(listOf<TurnEvent>(TurnEvent.Text("Hi")), seen)
    }

    @Test fun aDroppedConnectionIsALostConnection() {
        server.enqueue(sse("event: text\ndata: {\"delta\":\"Hi\"}\n\n").setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        assertTrue(failure(http().open(open, bound)) is TurnConnectionLost)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        assertTrue(thrown { http().answer("tn_1", 1, emptyList(), bound) } is TurnConnectionLost)
    }

    @Test fun nobodyListeningIsALostConnection() {
        val closed = MockWebServer().apply { start() }
        val base = closed.url("/")
        closed.shutdown()
        val http = TurnHttp(base, "/v1/agent/turns", 13, OkHttpClient())
        assertTrue(failure(http.open(open, bound)) is TurnConnectionLost)
        assertTrue(thrown { http.stop("tn_1", bound) } is TurnConnectionLost)
    }

    @Test fun silencePastTheIdleTimeoutIsALostConnection() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val http = TurnHttp(server.url("/"), "/v1/agent/turns", 13, shared, idleTimeout = 200.milliseconds)
        assertTrue(failure(http.open(open, bound)) is TurnConnectionLost)
    }

    @Test fun theIdleTimeoutIsIdleNotTotal() {
        val beat = ": heartbeat\n\n"
        server.enqueue(sse(beat.repeat(7) + "event: done\ndata: {\"state\":\"completed\"}\n\n").throttleBody(beat.length.toLong(), 1, TimeUnit.SECONDS))
        val http = TurnHttp(server.url("/"), "/v1/agent/turns", 13, shared, idleTimeout = 5.seconds)
        assertEquals(listOf(TurnEvent.Done(TurnState.completed, false)), within { http.resume("tn_1", bound).toList() })
    }

    @Test fun aStreamThatKeepsTalkingEndsAtTheTotalTimeoutAsALostConnection() {
        val beat = ": heartbeat\n\n"
        server.enqueue(sse(beat.repeat(1000)).throttleBody(beat.length.toLong(), 50, TimeUnit.MILLISECONDS))
        val http = TurnHttp(server.url("/"), "/v1/agent/turns", 13, shared, idleTimeout = 200.milliseconds, totalTimeout = 500.milliseconds)
        assertTrue(failure(http.resume("tn_1", bound)) is TurnConnectionLost)
    }

    @Test fun aStreamOutlivesACallTimeoutTheClientCarries() {
        val body = "event: text\ndata: {\"delta\":\"Hi\"}\n\nevent: done\ndata: {\"state\":\"completed\"}\n\n"
        server.enqueue(sse(body).throttleBody(16, 60, TimeUnit.MILLISECONDS))
        val hurried = OkHttpClient.Builder().callTimeout(100, TimeUnit.MILLISECONDS).build()
        assertEquals(listOf(TurnEvent.Text("Hi"), TurnEvent.Done(TurnState.completed, false)), within { http(hurried).open(open, bound).toList() })
    }

    @Test fun aLineTooLongIsAFault() {
        server.enqueue(sse("data: ${"x".repeat(TurnSse.maxLineBytes)}\n\n"))
        assertEquals(TurnWireFault.lineTooLong, (failure(http().open(open, bound)) as TurnWireFault).kind)
    }

    @Test fun anUnreadableFrameIsAFault() {
        server.enqueue(sse("event: gift\ndata: {}\n\n"))
        assertEquals(TurnWireFault.unknownEvent, (failure(http().open(open, bound)) as TurnWireFault).kind)
    }

    @Test fun aRedirectIsARefusalAndNoCredentialReachesAnotherHost() {
        val elsewhere = MockWebServer().apply { start() }
        try {
            for (seat in listOf(bound, anon)) {
                server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", elsewhere.url("/stolen").toString()))
                assertEquals(TurnRefusal(302, TurnRefusal.vendorError, null), failure(http().open(open, seat)))
                request()
                server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", elsewhere.url("/stolen").toString()))
                assertEquals(TurnRefusal(307, TurnRefusal.vendorError, null), thrown { http().answer("tn_1", 1, emptyList(), seat) })
                request()
            }
            assertEquals(0, elsewhere.requestCount)
        } finally {
            elsewhere.shutdown()
        }
    }

    @Test fun aRedirectingClientIsPinnedAllTheSame() {
        val elsewhere = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(301).setHeader("Location", elsewhere.url("/stolen").toString()))
            val following = OkHttpClient.Builder().followRedirects(true).followSslRedirects(true).build()
            assertEquals(301, (failure(http(following).resume("tn_1", anon)) as TurnRefusal).status)
            assertEquals(0, elsewhere.requestCount)
        } finally {
            elsewhere.shutdown()
        }
    }

    @Test fun anAddressThatLeavesTheRouteIsNeverRequested() {
        val http = http()
        for (turnId in listOf("../../v1/account", "..%2f..%2fv1", "%2e%2e/%2e%2e/v1/account", "..\\..\\v1")) {
            assertEquals(turnId, TurnWireFault.badAddress, (failure(http.resume(turnId, bound)) as TurnWireFault).kind)
            assertEquals(turnId, TurnWireFault.badAddress, (thrown { http.stop(turnId, bound) } as TurnWireFault).kind)
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun aRouteOnAnotherHostIsNeverRequested() {
        val http = TurnHttp(server.url("/"), "//elsewhere.invalid/v1/agent/turns", 13, OkHttpClient())
        assertEquals(TurnWireFault.badAddress, (failure(http.open(open, bound)) as TurnWireFault).kind)
        assertEquals(0, server.requestCount)
    }

    @Test fun noCookieGoesOrIsKept() {
        val saved = mutableListOf<Cookie>()
        val jar = object : CookieJar {
            override fun loadForRequest(url: HttpUrl) = listOf(Cookie.Builder().name("wm_session").value("from-the-jar").hostOnlyDomain(url.host).build())
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) { saved += cookies }
        }
        val http = http(OkHttpClient.Builder().cookieJar(jar).build())
        server.enqueue(sse("event: done\ndata: {\"state\":\"completed\"}\n\n").setHeader("Set-Cookie", "wm_session=from-the-server"))
        within { http.resume("tn_1", bound).toList() }
        server.enqueue(json(202, """{"state":"stopped"}""").setHeader("Set-Cookie", "wm_session=from-the-server"))
        within { http.stop("tn_1", bound) }
        assertEquals(listOf(null, null), listOf(request().headers["Cookie"], request().headers["Cookie"]))
        assertEquals(emptyList<Cookie>(), saved)
    }

    @Test fun everyPathReturnsItsConnection() {
        val paths = listOf<suspend () -> Unit>(
            { server.enqueue(MockResponse().setResponseCode(429).setBody("""{"code":"subject_exhausted"}""")); runCatching { http().open(open, bound).toList() } },
            { server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<html>")); runCatching { http().open(open, bound).toList() } },
            { server.enqueue(MockResponse().setBody("x")); runCatching { http().resume("tn_1", bound).toList() } },
            { server.enqueue(MockResponse().setResponseCode(500).setBody("x".repeat(3_000_000))); runCatching { http().open(open, bound).toList() } },
            { server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"coach-turn-order"}""")); runCatching { http().answer("tn_1", 1, emptyList(), bound) } },
            { server.enqueue(MockResponse().setResponseCode(202).setBody("<html>")); http().stop("tn_1", bound) },
            { server.enqueue(sse("event: done\ndata: {\"state\":\"completed\"}\n\nevent: text\ndata: {\"delta\":\"x\"}\n\n: more\n\n")); http().open(open, bound).toList() },
            { server.enqueue(sse("event: text\ndata: {\"delta\":\"x\"}\n\n")); runCatching { http().open(open, bound).toList() } },
            { server.enqueue(sse("event: gift\ndata: {}\n\n: more\n\n")); runCatching { http().open(open, bound).toList() } },
        )
        for ((index, path) in paths.withIndex()) {
            within { path() }
            assertEquals("path $index", "running=0 connections=0", settled())
        }
    }

    @Test fun chunkedCrlfSplitAndMultiByteFramesArrive() {
        val body = "event: text\r\ndata: {\"delta\":\"Жим 100 кг 💪\"}\r\n\r\n: heartbeat\r\n\r\nevent: done\r\ndata: {\"state\":\"completed\"}\r\n\r\n"
        for (size in listOf(1, 2, 3, 5, 7)) {
            server.enqueue(MockResponse().setHeader("Content-Type", "TEXT/Event-Stream;Charset=UTF-8").setChunkedBody(body, size))
            assertEquals(listOf(TurnEvent.Text("Жим 100 кг 💪"), TurnEvent.Done(TurnState.completed, false)), within { http().open(open, bound).toList() })
        }
    }

    @Test fun aCallCancelledFromOutsideIsNoCoroutineCancellation() {
        server.enqueue(sse("event: text\ndata: {\"delta\":\"x\"}\n\n: more\n\n").throttleBody(40, 20, TimeUnit.SECONDS))
        val failure = thrown { http().resume("tn_1", bound).collect { shared.dispatcher.cancelAll() } }
        assertTrue("$failure", failure !is CancellationException)
    }

    @Test fun cancellingASlowCollectorFreesTheReaderThread() {
        val many = frames(2000)
        server.enqueue(sse(many + ": more\n\n").throttleBody(many.length.toLong(), 30, TimeUnit.SECONDS))
        within {
            coroutineScope {
                val collecting = CompletableDeferred<Unit>()
                val job = launch(Dispatchers.Default) {
                    http().open(open, bound).collect {
                        collecting.complete(Unit)
                        awaitCancellation()
                    }
                }
                collecting.await()
                job.cancelAndJoin()
            }
        }
        assertEquals("running=0 connections=0", settled())
    }

    @Test fun aCollectorThatThrowsLeavesNoThreadBehind() {
        server.enqueue(sse(frames(500) + ": more\n\n").throttleBody(40_000, 60, TimeUnit.SECONDS))
        runCatching { within { http().open(open, bound).collect { delay(700); throw IllegalStateException("from the collector") } } }
        assertEquals("running=0 connections=0", settled())
    }

    @Test fun cancellingAPostCancelsItsCall() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        within {
            coroutineScope {
                val job = launch(Dispatchers.Default) { http().answer("tn_1", 1, emptyList(), bound) }
                withContext(Dispatchers.IO) { request() }
                job.cancelAndJoin()
            }
        }
        assertEquals("running=0 connections=0", settled())
    }

    // The driver on the real transport: a post hangs while the next round's text piles up behind it, and the seat changes. Five such turns, then the next request.
    @Test fun abandoningWhileFramesPileUpLeavesNoThreadBehind() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = "event: calls\ndata: {\"batch\":1,\"calls\":[{\"callId\":\"a\",\"name\":\"list_things\",\"input\":{}}]}\n\n"
        val posted = Channel<Unit>(Channel.UNLIMITED)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path.orEmpty().endsWith("/results") -> MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE).also { posted.trySend(Unit) }
                request.path.orEmpty().endsWith("/stop") -> MockResponse().setResponseCode(202).setBody("""{"state":"running"}""")
                else -> sse(calls + frames(200) + ": more\n\n").throttleBody(40_000, 60, TimeUnit.SECONDS)
            }
        }
        repeat(5) {
            val driver = TurnDriver(http(), quietTelemetry(), scope, elapsedMs = { 0L })
            within {
                coroutineScope {
                    val run = async(Dispatchers.Default) { driver.run("tn_1", bound, echo()) }
                    driver.activity.first { it != null }
                    posted.receive()
                    driver.abandon()
                    assertEquals(TurnExit.abandoned, run.await())
                }
            }
        }
        val running = settled()
        within { http().stop("tn_next", bound) }
        scope.cancel()
        assertTrue(running, running.startsWith("running=0 "))
    }

    // The whole driver on the real transport: a post retried on the backoff while the stream delivers far past any buffer a reader would wait on.
    @Test fun thePostRetriesWhileTheStreamRunsOn() {
        val calls = "event: calls\ndata: {\"batch\":1,\"calls\":[{\"callId\":\"a\",\"name\":\"list_things\",\"input\":{}}]}\n\n"
        val text = (1..500).joinToString("") { "event: text\ndata: {\"delta\":\"x\"}\n\n" }
        server.enqueue(sse(calls + text + "event: done\ndata: {\"state\":\"completed\"}\n\n"))
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"batch":1}"""))
        val ends = mutableListOf<TurnEnd>()
        val lines = Collections.synchronizedList(mutableListOf<String>())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val driver = TurnDriver(http(), quietTelemetry(lines), scope, beat = 200.milliseconds, elapsedMs = { 0L })
        assertEquals(TurnExit.ended, within { driver.run("tn_1", bound, echo(ends)) })
        scope.cancel()
        assertEquals(listOf(TurnEnd(TurnState.completed, "x".repeat(500), false, null, null)), ends)
        assertEquals(listOf("ability", "ended completed null"), lines.toList())
    }

    @Test fun leavingAStreamEarlyCancelsItsCall() {
        val cancelled = CountDownLatch(1)
        val client = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun canceled(call: Call) = cancelled.countDown()
        }).build()
        val frame = "event: text\ndata: {\"delta\":\"Hi\"}\n\n"
        server.enqueue(sse(frame + ": a heartbeat still on its way\n\n").throttleBody(frame.length.toLong(), 2, TimeUnit.SECONDS))
        assertEquals(TurnEvent.Text("Hi"), within { http(client).resume("tn_1", bound).first() })
        assertTrue(cancelled.await(60, TimeUnit.SECONDS))
    }
}
