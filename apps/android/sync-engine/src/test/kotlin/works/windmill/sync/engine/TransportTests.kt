package works.windmill.sync.engine

import java.io.File
import java.io.IOException
import java.net.ServerSocket
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import okhttp3.*
import okhttp3.internal.http2.ErrorCode
import okhttp3.internal.http2.StreamResetException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.*

class TransportTests {
    private fun json(text: String) = Json.parse(text)
    private val hello = """{"serverTime":100,"epoch":"ep-1","schema":4,"minSchema":4,"holdsRecords":{"gym":true},"as":"A"}"""
    private val push = """{"serverTime":100,"epoch":"ep-1","as":"A","lastN":0,"results":[]}"""
    private val pull = """{"serverTime":100,"epoch":"ep-1","as":"A","pages":[]}"""
    private val frame = """{"op":"gone","scope":"self/gym","as":"A"}"""
    private fun answer(reply: Reply<SyncResponse>) = (reply as Reply.Answer).value
    private fun connected(reply: Reply<LiveConnection>) = (reply as Reply.Answer).value
    private fun socketResponse(socket: CompletableDeferred<WebSocket>) = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) { socket.complete(webSocket) }
    })
    private class LiveSocket(private val failOnCancel: Boolean = true) : WebSocket, WebSocket.Factory {
        private lateinit var request: Request
        private lateinit var listener: WebSocketListener
        var sends = 0
        var cancels = 0
        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket {
            this.request = request; this.listener = listener
            listener.onOpen(this, Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("Switching Protocols").build())
            return this
        }
        override fun request() = request
        override fun queueSize() = 0L
        override fun send(text: String): Boolean { sends++; return true }
        override fun send(bytes: ByteString): Boolean = error("text frames only")
        override fun close(code: Int, reason: String?): Boolean = error("cancel expected")
        override fun cancel() { cancels++; if (failOnCancel) fail() }
        fun fail() { listener.onFailure(this, IOException("disconnected"), null) }
        fun message(text: String) { listener.onMessage(this, text) }
    }

    @Test fun helloPushAndPullUseCanonicalBodiesSchemaHeaderAndBearerAuth() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(hello)); server.enqueue(MockResponse().setBody(push)); server.enqueue(MockResponse().setBody(pull))
            HTTPTransport(server.url("/prefix/").toString(), 4).use { transport ->
                assertEquals(json(hello), answer(transport.hello(null)).body)
                val helloRequest = server.takeRequest(2, TimeUnit.SECONDS)!!
                assertEquals("GET", helloRequest.method); assertEquals("/prefix/v1/sync/hello", helloRequest.path)
                assertEquals("4", helloRequest.getHeader("Sync-Schema")); assertNull(helloRequest.getHeader("Authorization"))
                val body = Json.objectOf("z" to Json.of("é"), "a" to Json.of(1))
                assertEquals(200, answer(transport.push(body, "token")).status)
                val pushRequest = server.takeRequest(2, TimeUnit.SECONDS)!!
                assertEquals("POST", pushRequest.method); assertEquals("/prefix/v1/sync/push", pushRequest.path)
                assertEquals("Bearer token", pushRequest.getHeader("Authorization")); assertEquals("4", pushRequest.getHeader("Sync-Schema"))
                assertEquals(body.jcs, pushRequest.body.readUtf8()); assertEquals("application/json; charset=utf-8", pushRequest.getHeader("Content-Type"))
                assertEquals(200, answer(transport.pull(body, "other")).status)
                val pullRequest = server.takeRequest(2, TimeUnit.SECONDS)!!
                assertEquals("POST", pullRequest.method); assertEquals("/prefix/v1/sync/pull", pullRequest.path)
                assertEquals("Bearer other", pullRequest.getHeader("Authorization")); assertEquals(body.jcs, pullRequest.body.readUtf8())
            }
        }
    }

    @Test fun invalidJsonAndWrongSuccessShapesAreUnreachable() = runBlocking {
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4).use { transport ->
                for (body in listOf("not-json", "{}", """{"serverTime":100,"epoch":"ep-1","schema":"4","minSchema":4}""")) {
                    server.enqueue(MockResponse().setBody(body)); assertSame(Reply.Unreachable, transport.hello(null))
                }
                server.enqueue(MockResponse().setBody("""{"serverTime":100,"epoch":"ep-1","lastN":0,"results":[{"n":1,"s":"other"}]}"""))
                assertSame(Reply.Unreachable, transport.push(Json.objectOf(), "token"))
                server.enqueue(MockResponse().setBody("""{"serverTime":100,"epoch":"ep-1","pages":[{"scope":"self/gym","kind":"other"}]}"""))
                assertSame(Reply.Unreachable, transport.pull(Json.objectOf(), null))
            }
        }
    }

    @Test fun failureStatusesPreserveJsonAndPermitAnEmptyBody() = runBlocking {
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4).use { transport ->
                val failed = json("""{"serverTime":100,"epoch":"ep-1","code":"account-mismatch","as":"B"}""")
                server.enqueue(MockResponse().setResponseCode(409).setBody(failed.jcs))
                assertEquals(SyncResponse(409, failed), answer(transport.push(Json.objectOf(), "token")))
                server.enqueue(MockResponse().setResponseCode(401))
                assertEquals(SyncResponse(401, null), answer(transport.hello("token")))
                server.enqueue(MockResponse().setResponseCode(503).setBody("temporarily unavailable"))
                assertEquals(SyncResponse(503, null), answer(transport.pull(Json.objectOf(), null)))
            }
        }
    }

    @Test fun authenticatedRestoreConflictsValidateTheirEnvelopeBeforeDelivery() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(16)
        val request = json("""{"account":"A"}""")
        val valid = json("""{"serverTime":100,"epoch":"ep-2","as":"A","error":"gap"}""")
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                for ((index, malformed) in listOf(valid.with("epoch" to null), valid.with("epoch" to Json.of("")),
                    valid.with("epoch" to Json.of(2)), valid.with("serverTime" to null), valid.with("serverTime" to Json.of(-1)),
                    valid.with("serverTime" to Json.Num(0.5)), valid.with("error" to Json.of("unknown"))).withIndex()) {
                    server.enqueue(MockResponse().setResponseCode(409).setBody(malformed.jcs))
                    assertSame(Reply.Unreachable, transport.push(request, "token"))
                    assertEquals(EngineEvent(EngineOperation.push, EngineOutcome.failure, "malformed", repeated = index > 0), withTimeout(2_000) { events.receive() })
                }
                for (code in listOf("gap", "replica-forked", "replica-foreign")) {
                    val response = valid.with("error" to Json.of(code))
                    server.enqueue(MockResponse().setResponseCode(409).setBody(response.jcs))
                    assertEquals(SyncResponse(409, response), answer(transport.push(request, "token")))
                    assertEquals(EngineEvent(EngineOperation.push, EngineOutcome.refused, status = 409), withTimeout(2_000) { events.receive() })
                }
                val foreign = valid.with("as" to Json.of("B"), "epoch" to null)
                server.enqueue(MockResponse().setResponseCode(409).setBody(foreign.jcs))
                assertEquals(SyncResponse(409, foreign), answer(transport.push(request, "token")))
                assertEquals(EngineEvent(EngineOperation.push, EngineOutcome.refused, status = 409), withTimeout(2_000) { events.receive() })
            }
        }
        events.close()
        Unit
    }

    @Test fun updateAndAuthenticationRefusalsRemainMetricsWithoutFailureIssues() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(8)
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 5, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                for (status in listOf(401, 410, 426, 503)) {
                    server.enqueue(MockResponse().setResponseCode(status))
                    assertEquals(SyncResponse(status, null), answer(transport.hello("token")))
                    assertEquals(if (status == 503) EngineEvent(EngineOperation.hello, EngineOutcome.failure, "http", 503)
                        else EngineEvent(EngineOperation.hello, EngineOutcome.refused, status = status), withTimeout(2_000) { events.receive() })
                }
                server.enqueue(MockResponse().setResponseCode(426))
                assertEquals(Reply.Failed(SyncResponse(426)), transport.openLive("token"))
                assertEquals(EngineEvent(EngineOperation.live, EngineOutcome.refused, status = 426), withTimeout(2_000) { events.receive() })
            }
        }
        events.close()
        Unit
    }

    @Test fun redirectsAndCookieStateDoNotEscapeTheSyncOrigin() = runBlocking {
        MockWebServer().use { server ->
            var cookieReads = 0
            val client = OkHttpClient.Builder().cookieJar(object : CookieJar {
                override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) { error("cookies must be disabled") }
                override fun loadForRequest(url: HttpUrl): List<Cookie> { cookieReads++; return emptyList() }
            }).build()
            server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", server.url("/redirected")).addHeader("Set-Cookie", "token=secret"))
            HTTPTransport(server.url("/").toString(), 4, client = client).use { transport -> assertEquals(302, answer(transport.hello("token")).status) }
            assertEquals(1, server.requestCount); assertEquals(0, cookieReads)
        }
    }

    @Test fun stalledResponseUsesOneTotalDeadline() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(hello).setBodyDelay(5, TimeUnit.SECONDS))
            HTTPTransport(server.url("/").toString(), 4, requestTimeoutMs = 100).use { transport ->
                assertSame(Reply.Unreachable, withTimeout(2_000) { transport.hello(null) })
            }
        }
    }

    @Test fun callerCancellationCancelsTheUnderlyingHttpCall() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(8)
        val socket = LiveSocket()
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val failed = CompletableDeferred<Call>()
            val client = OkHttpClient.Builder().eventListener(object : EventListener() {
                override fun callFailed(call: Call, ioe: IOException) { failed.complete(call) }
            }).build()
            HTTPTransport(server.url("/").toString(), 4, client = client, requestTimeoutMs = 5_000,
                telemetry = EngineTelemetry { events.send(it) }, webSocketFactory = socket).use { transport ->
                val caller = async(start = CoroutineStart.UNDISPATCHED) { transport.hello(null) }
                assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)); caller.cancelAndJoin()
                assertTrue(withTimeout(2_000) { failed.await() }.isCanceled())
                connected(transport.openLive("token")).use {
                    socket.fail()
                    assertEquals(EngineEvent(EngineOperation.live, EngineOutcome.failure, "transport"), withTimeout(2_000) { events.receive() })
                    assertTrue(events.tryReceive().isFailure)
                }
            }
        }
        events.close()
        Unit
    }

    @Test fun closeCancelsPendingHttpAndRefusesFurtherRequests() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val transport = HTTPTransport(server.url("/").toString(), 4, requestTimeoutMs = 5_000)
            try {
                val pending = async(start = CoroutineStart.UNDISPATCHED) { transport.hello(null) }
                assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)); transport.close()
                assertSame(Reply.Unreachable, withTimeout(2_000) { pending.await() })
                assertSame(Reply.Unreachable, transport.hello(null)); assertSame(Reply.Unreachable, transport.openLive("token"))
                assertEquals(1, server.requestCount)
            } finally { transport.close() }
        }
    }

    @Test fun responseLimitAndSocketDisconnectFailWithoutPartialAnswers() = runBlocking {
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4, requestTimeoutMs = 2_000).use { transport ->
                server.enqueue(MockResponse().setBody("x".repeat(4 * 1024 * 1024 + 1)))
                assertSame(Reply.Unreachable, withTimeout(4_000) { transport.hello(null) })
                server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
                assertSame(Reply.Unreachable, withTimeout(4_000) { transport.hello(null) })
            }
        }
    }

    @Test fun liveHandshakeSendAndReceiveUseCanonicalJsonAndCloseTerminatesReceive() = runBlocking {
        MockWebServer().use { server ->
            val serverSocket = CompletableDeferred<WebSocket>(); val sent = CompletableDeferred<String>()
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { serverSocket.complete(webSocket) }
                override fun onMessage(webSocket: WebSocket, text: String) { sent.complete(text) }
            }))
            HTTPTransport(server.url("/").toString(), 4).use { transport ->
                connected(withTimeout(2_000) { transport.openLive("secret") }).use { connection ->
                    val request = server.takeRequest(2, TimeUnit.SECONDS)!!
                    assertEquals("/v1/sync/live?schema=4", request.path); assertEquals("Bearer secret", request.getHeader("Authorization"))
                    val outgoing = Json.objectOf("scopes" to Json.array(Json.of("self/gym")), "op" to Json.of("follow"))
                    connection.send(outgoing); assertEquals(outgoing.jcs, withTimeout(2_000) { sent.await() })
                    serverSocket.await().send(frame); assertEquals(json(frame), withTimeout(2_000) { connection.receive() })
                    serverSocket.await().close(1000, "done"); assertNull(withTimeout(2_000) { connection.receive() })
                }
            }
        }
    }

    @Test fun liveHandshakeFailuresPreserveAuthenticationAndUpgradeStatus() = runBlocking {
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4).use { transport ->
                for (status in listOf(401, 426)) {
                    server.enqueue(MockResponse().setResponseCode(status).setBody("""{"serverTime":100,"epoch":"ep-1"}"""))
                    val result = withTimeout(2_000) { transport.openLive("token") }
                    assertTrue(result is Reply.Failed)
                    assertEquals(status, (result as Reply.Failed).response.status)
                }
            }
        }
    }

    @Test fun stalledLiveHandshakeTimesOutAndCallerCancellationCancelsIt() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            HTTPTransport(server.url("/").toString(), 4, requestTimeoutMs = 100).use { transport ->
                assertSame(Reply.Unreachable, withTimeout(2_000) { transport.openLive("token") })
                assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            }
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            HTTPTransport(server.url("/").toString(), 4, requestTimeoutMs = 5_000).use { transport ->
                val caller = async(start = CoroutineStart.UNDISPATCHED) { transport.openLive("token") }
                assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)); caller.cancelAndJoin()
                assertTrue(caller.isCancelled)
            }
        }
    }

    @Test fun closeCancelsAPendingLiveHandshake() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val transport = HTTPTransport(server.url("/").toString(), 4, requestTimeoutMs = 5_000)
            try {
                val pending = async(start = CoroutineStart.UNDISPATCHED) { transport.openLive("token") }
                assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)); transport.close()
                assertSame(Reply.Unreachable, withTimeout(2_000) { pending.await() })
            } finally { transport.close() }
        }
    }

    @Test fun closeSurvivesTheLastLiveConnectionClosingDuringTraversal() = runBlocking {
        MockWebServer().use { server ->
            val serverSocket = CompletableDeferred<WebSocket>(); server.enqueue(socketResponse(serverSocket))
            HTTPTransport(server.url("/").toString(), 4).use { transport ->
                val connection = connected(withTimeout(2_000) { transport.openLive("token") })
                val waiting = async(start = CoroutineStart.UNDISPATCHED) { connection.receive() }
                val sockets = object : java.util.concurrent.ConcurrentHashMap<LiveConnection, Boolean>() {
                    override val size: Int get() = super.size.also { if (it == 1) connection.close() }
                }.keySet(true)
                sockets.add(connection)
                HTTPTransport::class.java.getDeclaredField("sockets").also { it.isAccessible = true }.set(transport, sockets)
                transport.close()
                assertNull(withTimeout(2_000) { waiting.await() })
                transport.close()
                assertSame(Reply.Unreachable, transport.openLive("token"))
                assertSame(Reply.Unreachable, transport.hello(null))
                assertEquals(1, server.requestCount)
            }
        }
    }

    @Test fun malformedUtf8AndOversizeFramesCloseTheLiveChannel() = runBlocking {
        for (payload in listOf(byteArrayOf(0xc3.toByte(), 0x28), "x".repeat(Constants.LIVE_FRAME_BYTES + 1).encodeToByteArray())) {
            MockWebServer().use { server ->
                val serverSocket = CompletableDeferred<WebSocket>(); server.enqueue(socketResponse(serverSocket))
                HTTPTransport(server.url("/").toString(), 4).use { transport ->
                    connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                        serverSocket.await().send(payload.toByteString())
                        assertTrue(runCatching { withTimeout(2_000) { connection.receive() } }.exceptionOrNull() is IOException)
                    }
                }
            }
        }
    }

    @Test fun liveReceiveQueueOverflowClosesInsteadOfLosingFrames() = runBlocking {
        MockWebServer().use { server ->
            val serverSocket = CompletableDeferred<WebSocket>(); server.enqueue(socketResponse(serverSocket))
            val failure = CompletableDeferred<Unit>()
            HTTPTransport(server.url("/").toString(), 4, telemetry = EngineTelemetry { if (it.operation == EngineOperation.live && it.outcome == EngineOutcome.failure) failure.complete(Unit) }).use { transport ->
                connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                    repeat(40) { serverSocket.await().send(frame) }
                    withTimeout(2_000) { failure.await() }
                    var received = 0
                    val ended = runCatching { withTimeout(2_000) { while (connection.receive() != null) received++ } }.exceptionOrNull()
                    assertTrue(ended is IOException); assertEquals(32, received)
                }
            }
        }
    }

    @Test fun liveAllowsOneReaderAndReaderCancellationLeavesItUsable() = runBlocking {
        MockWebServer().use { server ->
            val serverSocket = CompletableDeferred<WebSocket>(); server.enqueue(socketResponse(serverSocket))
            HTTPTransport(server.url("/").toString(), 4).use { transport ->
                connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                    val waiting = async(start = CoroutineStart.UNDISPATCHED) { connection.receive() }
                    assertTrue(runCatching { connection.receive() }.exceptionOrNull() is IllegalStateException)
                    waiting.cancelAndJoin(); serverSocket.await().send(frame)
                    assertEquals(json(frame), withTimeout(2_000) { connection.receive() })
                }
            }
        }
    }

    @Test fun liveDisconnectCloseAndOversizeSendHaveBoundedFailurePaths() = runTest {
        val disconnected = LiveSocket()
        HTTPTransport("https://sync.invalid/", 4, webSocketFactory = disconnected).use { transport ->
            connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                assertTrue(runCatching { connection.send(Json.of("x".repeat(Constants.LIVE_FRAME_BYTES))) }.exceptionOrNull() is IOException)
                assertEquals(0, disconnected.sends)
                disconnected.fail()
                connection.close()
                assertTrue(runCatching { withTimeout(2_000) { connection.receive() } }.exceptionOrNull() is IOException)
            }
        }
        for (closeTransport in listOf(false, true)) for (failOnCancel in listOf(true, false)) {
            val socket = LiveSocket(failOnCancel)
            HTTPTransport("https://sync.invalid/", 4, webSocketFactory = socket).use { transport ->
                val connection = connected(withTimeout(2_000) { transport.openLive("token") })
                val waiting = async(start = CoroutineStart.UNDISPATCHED) { connection.receive() }
                if (closeTransport) transport.close() else connection.close()
                assertEquals(1, socket.cancels)
                assertNull(withTimeout(2_000) { waiting.await() })
                assertTrue(runCatching { connection.send(Json.objectOf()) }.exceptionOrNull() is IOException)
                assertEquals(0, socket.sends)
                socket.fail()
                assertNull(withTimeout(2_000) { connection.receive() })
            }
        }
    }

    @Test fun intentionalLiveCloseIgnoresCancellationAndLateFramesButStillReportsDisconnects() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(8)
        val socket = LiveSocket(failOnCancel = true)
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4, webSocketFactory = socket,
                telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                val connection = connected(transport.openLive("token"))
                val receiving = async(start = CoroutineStart.UNDISPATCHED) { connection.receive() }
                connection.close()
                socket.fail()
                socket.message("not-json")
                assertNull(withTimeout(2_000) { receiving.await() })
                assertEquals(1, socket.cancels)
                // A real failure through the same telemetry queue fences all preceding close callbacks.
                server.enqueue(MockResponse().setResponseCode(503))
                assertEquals(503, answer(transport.hello(null)).status)
                assertEquals(EngineEvent(EngineOperation.hello, EngineOutcome.failure, "http", 503), withTimeout(2_000) { events.receive() })
                assertTrue(events.tryReceive().isFailure)
                val next = connected(transport.openLive("token"))
                socket.fail()
                assertTrue(runCatching { next.receive() }.exceptionOrNull() is IOException)
                assertEquals(EngineEvent(EngineOperation.live, EngineOutcome.failure, "transport"), withTimeout(2_000) { events.receive() })
                next.close()
            }
        }
        events.close()
        Unit
    }

    @Test fun liveSocketDisconnectFailsReceive() = runBlocking {
        MockWebServer().use { server ->
            val serverSocket = CompletableDeferred<WebSocket>(); server.enqueue(socketResponse(serverSocket))
            HTTPTransport(server.url("/").toString(), 4).use { transport ->
                connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                    withTimeout(2_000) { serverSocket.await() }
                    server.shutdown()
                    assertTrue(runCatching { withTimeout(2_000) { connection.receive() } }.exceptionOrNull() is IOException)
                }
            }
        }
    }

    @Test fun stalledLiveOutputRefusesAnUnboundedSendQueue() = runBlocking {
        MockWebServer().use { server ->
            val entered = CompletableDeferred<Unit>(); val release = CountDownLatch(1)
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    entered.complete(Unit); release.await(5, TimeUnit.SECONDS)
                }
            }))
            try {
                HTTPTransport(server.url("/").toString(), 4).use { transport ->
                    connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                        connection.send(Json.objectOf()); withTimeout(2_000) { entered.await() }
                        val payload = Json.of("x".repeat(Constants.LIVE_FRAME_BYTES - 4))
                        var refusal: Throwable? = null
                        for (index in 0 until 128) {
                            refusal = runCatching { connection.send(payload) }.exceptionOrNull()
                            if (refusal != null) break
                        }
                        assertTrue(refusal is IOException)
                    }
                }
            } finally { release.countDown() }
        }
    }

    @Test fun lostNetworkIsUnreachableOnEveryExchangeAndOneDroppedSocketReportsOnce() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(32)
        val unreachable = { operation: EngineOperation -> EngineEvent(operation, EngineOutcome.failure, "unreachable") }
        // Each drop gets its own server on one address, as OkHttp tries another after a failure; the hello after it fences the queue.
        suspend fun dropped(response: MockResponse, exchange: suspend (HTTPTransport) -> Reply<*>): List<EngineEvent> = MockWebServer().use { server ->
            HTTPTransport("http://127.0.0.1:${server.port}/", 4, requestTimeoutMs = 1_000, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                server.enqueue(response); assertSame(Reply.Unreachable, withTimeout(5_000) { exchange(transport) })
                server.enqueue(MockResponse().setResponseCode(503)); assertEquals(503, answer(transport.hello(null)).status)
                List(2) { withTimeout(5_000) { events.receive() } }
            }
        }
        val fence = EngineEvent(EngineOperation.hello, EngineOutcome.failure, "http", 503)
        assertEquals(listOf(unreachable(EngineOperation.push), fence),
            dropped(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)) { it.push(Json.objectOf(), "token") })
        assertEquals(listOf(unreachable(EngineOperation.hello), fence),
            dropped(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)) { it.hello(null) })
        assertEquals(listOf(unreachable(EngineOperation.pull), fence),
            dropped(MockResponse().setBody(pull + " ".repeat(200_000)).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)) { it.pull(Json.objectOf(), "token") })
        assertEquals(listOf(unreachable(EngineOperation.push), fence),
            dropped(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)) { it.push(Json.objectOf(), "token") })
        val refused = java.net.ServerSocket(0).use { it.localPort }
        HTTPTransport("http://127.0.0.1:$refused/", 4, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
            assertSame(Reply.Unreachable, transport.hello(null))
            assertSame(Reply.Unreachable, withTimeout(5_000) { transport.openLive("token") })
            assertSame(Reply.Unreachable, transport.pull(Json.objectOf(), null))
            assertEquals(listOf(unreachable(EngineOperation.hello), unreachable(EngineOperation.live), unreachable(EngineOperation.pull)),
                List(3) { withTimeout(5_000) { events.receive() } })
        }
        HTTPTransport("http://sync.invalid/", 4, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
            assertSame(Reply.Unreachable, transport.pull(Json.objectOf(), null))
            assertEquals(unreachable(EngineOperation.pull), withTimeout(5_000) { events.receive() })
        }
        MockWebServer().use { server ->
            val serverSocket = CompletableDeferred<WebSocket>(); server.enqueue(socketResponse(serverSocket))
            HTTPTransport(server.url("/").toString(), 4, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                    withTimeout(2_000) { serverSocket.await() }
                    server.shutdown()
                    assertTrue(runCatching { withTimeout(2_000) { connection.receive() } }.exceptionOrNull() is LiveEnded)
                    assertTrue(runCatching { connection.send(Json.objectOf()) }.exceptionOrNull() is LiveEnded)
                }
                assertSame(Reply.Unreachable, transport.hello(null))
                assertEquals(listOf(unreachable(EngineOperation.live), unreachable(EngineOperation.hello)), List(2) { withTimeout(5_000) { events.receive() } })
            }
        }
        assertTrue(events.tryReceive().isFailure)
    }

    @Test fun aFaultFilesOnceUntilItsOperationIsAnsweredAndLostNetworkOrARefusalEndsTheRun() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(32)
        val http = { operation: EngineOperation, status: Int -> EngineEvent(operation, EngineOutcome.failure, "http", status) }
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                for (response in listOf(MockResponse().setResponseCode(500), MockResponse().setResponseCode(500), MockResponse().setResponseCode(502),
                    MockResponse().setBody("not-json"), MockResponse().setBody("{}"), MockResponse().setResponseCode(413), MockResponse().setBody(pull),
                    MockResponse().setResponseCode(500))) {
                    server.enqueue(response); transport.pull(Json.objectOf(), "token")
                }
                for (response in listOf(MockResponse().setResponseCode(500), MockResponse().setResponseCode(413), MockResponse().setResponseCode(500),
                    MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST), MockResponse().setResponseCode(500))) {
                    server.enqueue(response); transport.push(Json.objectOf(), "token")
                }
                repeat(2) { server.enqueue(MockResponse().setBody("x".repeat(4 * 1024 * 1024 + 1))); assertSame(Reply.Unreachable, transport.hello(null)) }
                repeat(2) { server.enqueue(MockResponse().setResponseCode(503)); assertEquals(Reply.Failed(SyncResponse(503)), transport.openLive("token")) }
                server.enqueue(socketResponse(CompletableDeferred()))
                connected(transport.openLive("token")).close()
                server.enqueue(MockResponse().setResponseCode(503)); assertEquals(Reply.Failed(SyncResponse(503)), transport.openLive("token"))
                server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(frame) }
                }))
                connected(transport.openLive("token")).use { assertEquals(json(frame), withTimeout(2_000) { it.receive() }) }
                server.enqueue(MockResponse().setResponseCode(503)); assertEquals(Reply.Failed(SyncResponse(503)), transport.openLive("token"))
                assertEquals(listOf(
                    http(EngineOperation.pull, 500), http(EngineOperation.pull, 500).copy(repeated = true), http(EngineOperation.pull, 502),
                    EngineEvent(EngineOperation.pull, EngineOutcome.failure, "malformed"), EngineEvent(EngineOperation.pull, EngineOutcome.failure, "malformed", repeated = true),
                    http(EngineOperation.pull, 413), http(EngineOperation.pull, 500),
                    http(EngineOperation.push, 500), EngineEvent(EngineOperation.push, EngineOutcome.refused, status = 413), http(EngineOperation.push, 500),
                    EngineEvent(EngineOperation.push, EngineOutcome.failure, "unreachable"), http(EngineOperation.push, 500),
                    EngineEvent(EngineOperation.hello, EngineOutcome.failure, "limit"), EngineEvent(EngineOperation.hello, EngineOutcome.failure, "limit", repeated = true),
                    http(EngineOperation.live, 503), http(EngineOperation.live, 503).copy(repeated = true), http(EngineOperation.live, 503).copy(repeated = true),
                    http(EngineOperation.live, 503),
                ), List(18) { withTimeout(2_000) { events.receive() } })
                assertTrue(events.tryReceive().isFailure)
            }
        }
    }

    @Test fun aRefusedCertificateFilesAfterTheNetworkCutAHandshake() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(8)
        val store = File.createTempFile("untrusted", ".p12").apply { delete(); deleteOnExit() }
        val keytool = ProcessBuilder(File(System.getProperty("java.home"), "bin/keytool").path, "-genkeypair", "-alias", "sync", "-keyalg", "EC",
            "-dname", "CN=localhost", "-validity", "1", "-storetype", "PKCS12", "-keystore", store.path, "-storepass", "untrusted").redirectErrorStream(true).start()
        assertEquals(0, keytool.waitFor())
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
            init(KeyStore.getInstance("PKCS12").apply { store.inputStream().use { load(it, "untrusted".toCharArray()) } }, "untrusted".toCharArray())
        }
        val tls = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }
        ServerSocket(0).use { server ->
            Thread {
                runCatching { server.accept().use { cut -> cut.soTimeout = 300; runCatching { while (cut.getInputStream().read(ByteArray(4_096)) >= 0) Unit }; cut.shutdownOutput(); Thread.sleep(200) } }
                repeat(2) { runCatching { server.accept().use { raw ->
                    runCatching { (tls.socketFactory.createSocket(raw, null, raw.port, true) as SSLSocket).apply { useClientMode = false; startHandshake() } }
                } } }
            }.apply { isDaemon = true; start() }
            HTTPTransport("https://127.0.0.1:${server.localPort}/", 4, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                repeat(3) { assertSame(Reply.Unreachable, withTimeout(10_000) { transport.pull(Json.objectOf(), "token") }) }
                assertEquals(listOf(EngineEvent(EngineOperation.pull, EngineOutcome.failure, "unreachable"), EngineEvent(EngineOperation.pull, EngineOutcome.failure, "tls"),
                    EngineEvent(EngineOperation.pull, EngineOutcome.failure, "tls", repeated = true)), List(3) { withTimeout(2_000) { events.receive() } })
                assertTrue(events.tryReceive().isFailure)
            }
        }
    }

    @Test fun protocolFaultsFileAfterTheNetworkCutAReplyAndRefusedStreamsAreLostNetwork() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(8)
        suspend fun pulls(h2: Boolean, vararg responses: MockResponse): List<EngineEvent> = MockWebServer().use { server ->
            if (h2) server.protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE)
            val client = OkHttpClient.Builder().apply { if (h2) protocols(listOf(Protocol.H2_PRIOR_KNOWLEDGE)) }.build()
            HTTPTransport("http://127.0.0.1:${server.port}/", 4, telemetry = EngineTelemetry { events.send(it) }, client = client).use { transport ->
                for (response in responses) { server.enqueue(response); assertSame(Reply.Unreachable, withTimeout(5_000) { transport.pull(Json.objectOf(), "token") }) }
                List(responses.size) { withTimeout(2_000) { events.receive() } }.also { assertTrue(events.tryReceive().isFailure) }
            }
        }
        fun reset(code: ErrorCode) = MockResponse().setSocketPolicy(SocketPolicy.RESET_STREAM_AT_START).apply { http2ErrorCode = code.httpCode }
        val lost = EngineEvent(EngineOperation.pull, EngineOutcome.failure, "unreachable")
        val protocol = EngineEvent(EngineOperation.pull, EngineOutcome.failure, "protocol")
        assertEquals(listOf(lost, protocol, protocol.copy(repeated = true)), pulls(false,
            MockResponse().setBody(pull + " ".repeat(200_000)).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
            MockResponse().setStatus("garbage"), MockResponse().setStatus("garbage")))
        assertEquals(listOf(lost, protocol, protocol.copy(repeated = true)), pulls(true,
            MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST), reset(ErrorCode.INTERNAL_ERROR), reset(ErrorCode.INTERNAL_ERROR)))
        assertEquals(listOf(lost, lost), pulls(true, reset(ErrorCode.REFUSED_STREAM), reset(ErrorCode.REFUSED_STREAM)))
    }

    @Test fun aBadLiveFrameFilesOnceAcrossReconnectsUntilAValidFrameProvesTheSocketHealthy() = runBlocking {
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(8)
        fun sending(text: String) = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(text) }
        })
        MockWebServer().use { server ->
            HTTPTransport(server.url("/").toString(), 4, telemetry = EngineTelemetry { events.send(it) }).use { transport ->
                for (text in listOf("not json", "not json", "not json", frame, "not json")) {
                    server.enqueue(sending(text))
                    connected(withTimeout(2_000) { transport.openLive("token") }).use { connection ->
                        val received = runCatching { withTimeout(2_000) { connection.receive() } }
                        if (text == frame) assertEquals(json(frame), received.getOrThrow()) else assertTrue(received.exceptionOrNull() is LiveEnded)
                    }
                }
                val malformed = EngineEvent(EngineOperation.live, EngineOutcome.failure, "malformed")
                assertEquals(listOf(malformed, malformed.copy(repeated = true), malformed.copy(repeated = true), malformed),
                    List(4) { withTimeout(2_000) { events.receive() } })
                assertTrue(events.tryReceive().isFailure)
            }
        }
    }

    @Test fun failureKindsFollowTheTablePlatformAlsoRuns() {
        val rows = TransportTests::class.java.getResource("/failure-kinds.tsv")!!.readText().lines().filter { it.isNotBlank() && !it.startsWith("#") }
        val table = rows.map { row -> row.substringAfter('\t') to row.substringBefore('\t').takeUnless { it == "-" } }
        fun failure(chain: String): Throwable = chain.split(" <- ").map { link ->
            val type = Class.forName(link.substringBefore('('))
            val argument = link.substringAfter('(', "").removeSuffix(")")
            when {
                type == StreamResetException::class.java -> StreamResetException(ErrorCode.valueOf(argument))
                argument.isEmpty() -> type.getConstructor().newInstance() as Throwable
                else -> type.getConstructor(String::class.java).newInstance(argument) as Throwable
            }
        }.reduceRight { failure, cause -> failure.initCause(cause) }
        assertEquals(table, table.map { (chain, _) -> chain to failureKind(failure(chain)) })
        assertEquals(setOf("unreachable", "tls", "protocol", "malformed", "transport", null), table.map { it.second }.toSet())
    }
}
