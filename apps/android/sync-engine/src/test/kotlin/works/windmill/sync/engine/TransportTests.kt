package works.windmill.sync.engine

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import okhttp3.*
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
                for (malformed in listOf(valid.with("epoch" to null), valid.with("epoch" to Json.of("")),
                    valid.with("epoch" to Json.of(2)), valid.with("serverTime" to null), valid.with("serverTime" to Json.of(-1)),
                    valid.with("serverTime" to Json.Num(0.5)), valid.with("error" to Json.of("unknown")))) {
                    server.enqueue(MockResponse().setResponseCode(409).setBody(malformed.jcs))
                    assertSame(Reply.Unreachable, transport.push(request, "token"))
                    assertEquals(EngineEvent(EngineOperation.push, EngineOutcome.failure), withTimeout(2_000) { events.receive() })
                }
                for (code in listOf("gap", "replica-forked", "replica-foreign")) {
                    val response = valid.with("error" to Json.of(code))
                    server.enqueue(MockResponse().setResponseCode(409).setBody(response.jcs))
                    assertEquals(SyncResponse(409, response), answer(transport.push(request, "token")))
                    assertEquals(EngineEvent(EngineOperation.push, EngineOutcome.refused), withTimeout(2_000) { events.receive() })
                }
                val foreign = valid.with("as" to Json.of("B"), "epoch" to null)
                server.enqueue(MockResponse().setResponseCode(409).setBody(foreign.jcs))
                assertEquals(SyncResponse(409, foreign), answer(transport.push(request, "token")))
                assertEquals(EngineEvent(EngineOperation.push, EngineOutcome.refused), withTimeout(2_000) { events.receive() })
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
                    assertEquals(EngineEvent(EngineOperation.hello, if (status == 503) EngineOutcome.failure else EngineOutcome.refused),
                        withTimeout(2_000) { events.receive() })
                }
                server.enqueue(MockResponse().setResponseCode(426))
                assertEquals(Reply.Failed(SyncResponse(426)), transport.openLive("token"))
                assertEquals(EngineEvent(EngineOperation.live, EngineOutcome.refused), withTimeout(2_000) { events.receive() })
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
                    assertEquals(EngineEvent(EngineOperation.live, EngineOutcome.failure), withTimeout(2_000) { events.receive() })
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
                assertEquals(EngineEvent(EngineOperation.hello, EngineOutcome.failure), withTimeout(2_000) { events.receive() })
                assertTrue(events.tryReceive().isFailure)
                val next = connected(transport.openLive("token"))
                socket.fail()
                assertTrue(runCatching { next.receive() }.exceptionOrNull() is IOException)
                assertEquals(EngineEvent(EngineOperation.live, EngineOutcome.failure), withTimeout(2_000) { events.receive() })
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
}
