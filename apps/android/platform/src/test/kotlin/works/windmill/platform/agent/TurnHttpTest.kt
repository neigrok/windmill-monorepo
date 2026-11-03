package works.windmill.platform.agent

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
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
import works.windmill.agent.ToolOutcome
import works.windmill.agent.ToolCall
import works.windmill.agent.TurnBatch
import works.windmill.agent.TurnConnectionLost
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnLine
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnPicture
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnSse
import works.windmill.agent.TurnState
import works.windmill.agent.TurnWireFault
import works.windmill.sync.core.Json

class TurnHttpTest {
    private val server = MockWebServer()
    private val bound = TurnSeat.Bound("session-token")
    private val anon = TurnSeat.Anon("installation-credential")
    private val open = TurnOpen("tn_1", "catalog/2", "Hi", listOf(TurnPicture("p1", "image/jpeg", byteArrayOf(1, 2, 3))), listOf(TurnLine("lifter", "Before")),
        listOf(ContextRead("list_things", Json.objectOf(), Json.objectOf("things" to Json.Arr(emptyList())))), emptyList())

    @Before fun start() = server.start()
    @After fun stop() = server.shutdown()

    private fun http(client: OkHttpClient = OkHttpClient()) = TurnHttp(server.url("/"), "/v1/agent/turns", 13, client)
    private fun sse(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream; charset=utf-8").setBody(body)
    private fun json(status: Int, body: String) = MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
    private fun request(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS)!!
    private fun RecordedRequest.seen() = listOf(method, path, headers["Sync-Schema"], headers["Authorization"], headers["X-Windmill-Installation"], headers["Accept"], headers["Content-Type"], headers["Cookie"], body.readUtf8())
    private fun <T> within(work: suspend () -> T): T = runBlocking { withTimeout(20.seconds) { work() } }
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

    @Test fun theResumeReadsTheTurnsStreamUnderAnAnonSeat() {
        server.enqueue(sse("event: snapshot\ndata: {\"text\":\"So far\",\"state\":\"completed\"}\n\n"))
        assertEquals(listOf(TurnEvent.Snapshot("So far", TurnState.completed, null)), within { http().resume("tn_1", anon).toList() })
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

    @Test fun theStopPostsAnEmptyObjectAndReadsTheState() {
        server.enqueue(json(202, """{"state":"stopped"}"""))
        assertEquals(TurnState.stopped, within { http().stop("tn_1", anon) })
        assertEquals(listOf("POST", "/v1/agent/turns/tn_1/stop", "13", null, "installation-credential", null, "application/json", null, "{}"), request().seen())
    }

    @Test fun aStopAnswerThatCannotBeReadIsAFault() {
        server.enqueue(json(202, "<html>"))
        assertEquals(TurnWireFault.unreadable, (thrown { http().stop("tn_1", bound) } as TurnWireFault).kind)
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
        val http = TurnHttp(server.url("/"), "/v1/agent/turns", 13, OkHttpClient(), idleTimeout = 200.milliseconds)
        assertTrue(failure(http.open(open, bound)) is TurnConnectionLost)
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

    @Test fun leavingAStreamEarlyCancelsItsCall() {
        val cancelled = CountDownLatch(1)
        val client = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun canceled(call: Call) = cancelled.countDown()
        }).build()
        val frame = "event: text\ndata: {\"delta\":\"Hi\"}\n\n"
        server.enqueue(sse(frame + ": a heartbeat still on its way\n\n").throttleBody(frame.length.toLong(), 2, TimeUnit.SECONDS))
        assertEquals(TurnEvent.Text("Hi"), within { http(client).resume("tn_1", bound).first() })
        assertTrue(cancelled.await(5, TimeUnit.SECONDS))
    }
}
