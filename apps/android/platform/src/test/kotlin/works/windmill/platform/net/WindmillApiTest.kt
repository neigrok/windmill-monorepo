package works.windmill.platform.net

import kotlinx.serialization.SerializationException
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.ResponseBody
import okhttp3.OkHttpClient
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.serialization.Serializable
import okio.buffer
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit
import works.windmill.platform.telemetry.Telemetry
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Response
import java.util.concurrent.ConcurrentHashMap
import works.windmill.platform.i18n.Words
import org.robolectric.annotation.Config
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.junit.runner.RunWith

@Serializable
private data class Wire(val value: String)

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WindmillApiTest {
    private val server = MockWebServer()

    @Test fun retryAfterIsResolvedAtReceiptWithoutLosingTypedRefusalsForMalformedJsonTiming() = runTest {
        for ((header, date) in listOf("120" to null, "Thu, 29 Oct 2026 09:00:00 GMT" to 1_793_264_400_000L,
            "-1" to null, "18446744073709551616" to null, "not a deadline" to null)) {
            server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", header)
                .setBody("""{"code":"ask-daily-limit","retryAtMs":"invalid"}"""))
            val before = System.currentTimeMillis()
            val failure = try { api().get<Wire>("/v1/fixture"); error("expected refusal") }
                catch (failure: WindmillApiException.Refused) { failure }
            val after = System.currentTimeMillis()
            assertEquals(429, failure.status)
            assertEquals("ask-daily-limit", failure.refusal.code)
            if (header == "120") assertTrue(failure.retryAfterAtMs!! in (before + 120_000)..(after + 120_000))
            else assertEquals(date, failure.retryAfterAtMs)
        }
    }

    @Test fun configuredHeadersCoverJsonStreamAndBytesWithoutChangingTheOriginalApi() = runTest {
        val original = api { "fixture-bearer" }
        val configured = original.withHeaders(mapOf("Fixture-Schema" to "fixture-version"))
        server.enqueue(MockResponse().setBody("{\"value\":\"fixture\"}"))
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody("fixture"))
        server.enqueue(MockResponse().setBody("fixture"))
        server.enqueue(MockResponse().setBody("{\"value\":\"fixture\"}"))
        assertEquals(Wire("fixture"), configured.get<Wire>("/v1/fixture"))
        assertEquals("fixture", configured.consume("POST", "/v1/fixture", accept = "text/event-stream") { it.body!!.string() })
        assertEquals("fixture", configured.consume("GET", "/v1/fixture", accept = "image/png") { it.body!!.string() })
        original.get<Wire>("/v1/fixture")
        repeat(3) {
            val request = server.takeRequest()
            assertEquals("fixture-version", request.getHeader("Fixture-Schema"))
            assertEquals("Bearer fixture-bearer", request.getHeader("Authorization"))
        }
        assertNull(server.takeRequest().getHeader("Fixture-Schema"))
    }

    @Test fun onlyTheSyncUpgradeRefusalAsksForAnUpdate() {
        assertEquals("Update Windmill to keep syncing. Your work is saved on this phone.",
            WindmillApiException.Refused(426, Refusal(code = "client-update-required")).words.spelled())
        assertEquals("That link has expired.",
            WindmillApiException.Refused(410, Refusal(message = "That link has expired.", code = "expired")).words.spelled())
    }

    @Before
    fun start() {
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun api(credential: () -> String? = { null }) = WindmillApi(server.url("/"), credential)

    @Test
    fun rawConsumptionClosesTheResponseAndCancellationStopsAnIncompleteBody() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val closed = CompletableDeferred<Unit>()
        val reports = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { reports += name }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { reports += operation }
        }
        server.enqueue(MockResponse().setBody("first\nlast\n").throttleBody(6, 2, TimeUnit.SECONDS))
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val response = chain.proceed(chain.request())
            val original = requireNotNull(response.body)
            val source = object : okio.ForwardingSource(original.source()) {
                override fun close() { try { super.close() } finally { closed.complete(Unit) } }
            }.buffer()
            response.newBuilder().body(object : ResponseBody() {
                override fun contentType() = original.contentType()
                override fun contentLength() = original.contentLength()
                override fun source() = source
            }).build()
        }.build()
        val request = async {
            WindmillApi(server.url("/"), { "private" }, client, telemetry).consume("GET", "/v1/raw", accept = "text/plain") { response ->
                assertEquals("first", response.body!!.source().readUtf8Line())
                entered.complete(Unit)
                response.body!!.source().readUtf8Line()
            }
        }
        entered.await()
        request.cancel()
        request.join()
        withTimeout(2_000) { closed.await() }
        assertTrue(request.isCancelled)
        assertEquals(emptyList<String>(), reports)
        assertEquals("Bearer private", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun malformedAndServerFailuresAreReportedOnceWithoutResponseContent() = runTest {
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val events = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                failures += operation to properties
            }
        }
        val api = WindmillApi(server.url("/"), { "private-bearer" }, telemetry = telemetry)
        server.enqueue(MockResponse().setResponseCode(503).setBody("private response"))
        server.enqueue(MockResponse().setBody("private malformed body"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        for (attempt in 1..3) runCatching {
            api.send<Wire>("POST", "/v1/example?token=private-token", operation = "example_action")
        }
        assertEquals(listOf(
            "example_action" to mapOf("method" to "POST", "route" to "/v1/example", "failure_kind" to "http", "operation" to "example_action", "status" to "503", "network_phase" to "response_body"),
            "example_action" to mapOf("method" to "POST", "route" to "/v1/example", "failure_kind" to "malformed", "operation" to "example_action", "network_phase" to "decode"),
        ), failures.map { (operation, properties) -> operation to properties.minus("duration_ms") })
        assertTrue(failures.all { it.second.getValue("duration_ms").toLong() >= 0 })
        assertEquals(listOf("api_request_failed", "api_request_failed", "api_request_failed"), events)
    }

    @Test
    fun aReadTimeoutIsVisibleAndDistinctFromOffline() = runTest {
        val failures = mutableListOf<Throwable>()
        val properties = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, values: Map<String, String>) {
                failures += error
                properties += values
            }
        }
        server.enqueue(MockResponse().setBody("{\"value\":\"late\"}").setHeadersDelay(250, TimeUnit.MILLISECONDS))
        server.enqueue(MockResponse().setBody("{\"value\":\"late\"}").setBodyDelay(250, TimeUnit.MILLISECONDS))
        val client = OkHttpClient.Builder().readTimeout(40, TimeUnit.MILLISECONDS).build()
        val api = WindmillApi(server.url("/"), { null }, client, telemetry)
        val errors = (1..2).map { runCatching { api.get<Wire>("/v1/example") }.exceptionOrNull() }
        assertTrue(errors.all { it is WindmillApiException.Timeout })
        assertEquals(errors, failures)
        assertEquals(listOf("response_headers", "response_body"), properties.map { it.getValue("network_phase") })
        assertTrue(properties.all { it.getValue("duration_ms").toLong() >= 25 })
        assertEquals(List(2) {
            mapOf("method" to "GET", "route" to "/v1/example", "failure_kind" to "timeout", "operation" to "http_request")
        }, properties.map { it.minus(setOf("duration_ms", "network_phase")) })
    }

    @Test
    fun aDroppedResponseRemainsTransportAndEmitsAnEventWithoutAnIssue() = runTest {
        val failures = mutableListOf<Throwable>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += error }
        }
        server.enqueue(MockResponse().setBody("""{"value":"interrupted"}""")
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        val api = WindmillApi(server.url("/"), { null }, telemetry = telemetry)
        val failure = runCatching { api.get<Wire>("/v1/example") }.exceptionOrNull()
        assertTrue(failure is WindmillApiException.Transport)
        assertEquals("That connection was interrupted. Try again.", (failure as WindmillApiException.Transport).words.spelled())
        assertEquals(emptyList<Throwable>(), failures)
        assertEquals(listOf("api_request_failed" to mapOf("method" to "GET", "route" to "/v1/example",
            "failure_kind" to "transport", "operation" to "http_request", "network_phase" to "response_body")),
            events.map { it.first to it.second.minus("duration_ms") })
        assertTrue(events.single().second.getValue("duration_ms").toLong() >= 0)
    }

    @Test
    fun concurrentRequestsKeepTheirPhasesAndPreserveTheCallersListener() = runTest {
        val properties = ConcurrentHashMap<String, Map<String, String>>()
        val calls = ConcurrentHashMap.newKeySet<Call>()
        val responses = ConcurrentHashMap.newKeySet<Call>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path == "/v1/headers") MockResponse().setBody("{}").setHeadersDelay(300, TimeUnit.MILLISECONDS)
                else MockResponse().setBody("{}").setBodyDelay(300, TimeUnit.MILLISECONDS)
        }
        val client = OkHttpClient.Builder().readTimeout(75, TimeUnit.MILLISECONDS)
            .eventListenerFactory { object : EventListener() {
                override fun callStart(call: Call) { calls += call }
                override fun responseHeadersEnd(call: Call, response: Response) { responses += call }
            } }.build()
        val telemetry = object : Telemetry {
            override fun event(name: String, values: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, values: Map<String, String>) {
                properties[operation] = values
            }
        }
        val api = WindmillApi(server.url("/"), { null }, client, telemetry)
        listOf("headers", "body").map { phase -> async {
            assertTrue(runCatching { api.get<Wire>("/v1/$phase", operation = phase) }.exceptionOrNull() is WindmillApiException.Timeout)
        } }.awaitAll()
        assertEquals(mapOf("headers" to "response_headers", "body" to "response_body"), properties.mapValues { it.value.getValue("network_phase") })
        assertEquals(2, calls.size)
        assertEquals(1, responses.size)
        assertTrue(calls.containsAll(responses))
    }

    @Test
    fun durationIncludesConsumptionAndDecodeWhileCoachKeepsItsTimeout() = runTest {
        val failures = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += properties }
        }
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            assertEquals(660_000, chain.readTimeoutMillis())
            assertEquals(TimeUnit.SECONDS.toNanos(660), chain.call().timeout().timeoutNanos())
            chain.proceed(chain.request())
        }.build()
        server.enqueue(MockResponse().setBody("private response"))
        val error = runCatching {
            WindmillApi(server.url("/"), { null }, client, telemetry).consume<Unit>(
                "POST", "/v1/gym/ask?private=token", timeoutSeconds = 660, operation = "gym_ask",
            ) { response ->
                response.body!!.string()
                Thread.sleep(80)
                throw SerializationException("private response could not decode")
            }
        }.exceptionOrNull()
        assertEquals(WindmillApiException.Malformed, error)
        assertTrue(failures.single().getValue("duration_ms").toLong() >= 70)
        assertEquals(mapOf("method" to "POST", "route" to "/v1/gym", "failure_kind" to "malformed", "operation" to "gym_ask", "network_phase" to "decode"), failures.single().minus("duration_ms"))
    }

    @Test
    fun theBearerHeaderComesFromTheCredential() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"a"}"""))
        api { "s3cret" }.get<Wire>("/v1/echo")
        val request = server.takeRequest()
        assertEquals("Bearer s3cret", request.getHeader("Authorization"))
        assertEquals("application/json", request.getHeader("Accept"))
    }

    @Test
    fun noCredentialMeansNoBearerHeader() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"a"}"""))
        api().get<Wire>("/v1/echo")
        assertNull(server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun aJsonBodyRoundTrips() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"pong"}"""))
        val reply = api().send<Wire>("POST", "/v1/echo", Wire("ping"))
        assertEquals(Wire("pong"), reply)
        val request = server.takeRequest()
        assertEquals("""{"value":"ping"}""", request.body.readUtf8())
        assertEquals("application/json; charset=utf-8", request.getHeader("Content-Type"))
    }

    @Test
    fun aRefusalCarriesTheServersWords() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(429)
                .setBody("""{"error":"slow down","detail":"try later","code":"rate_limited"}""")
        )
        try {
            api().get<Wire>("/v1/echo")
            fail("expected a refusal")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(429, refused.status)
            assertEquals(Refusal("slow down", "try later", "rate_limited"), refused.refusal)
            assertEquals("slow down", refused.words.spelled())
            assertFalse(refused.isUnauthorized)
        }
    }

    @Test
    fun aFourOhOneIsUnauthorized() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"sign in to continue"}"""))
        try {
            api().get<Wire>("/v1/echo")
            fail("expected a refusal")
        } catch (refused: WindmillApiException.Refused) {
            assertTrue(refused.isUnauthorized)
            assertEquals("sign in to continue", refused.words.spelled())
        }
    }

    @Test
    fun aRefusalWithAnUnreadableBodyStillRefuses() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("<html>oops</html>"))
        try {
            api().get<Wire>("/v1/echo")
            fail("expected a refusal")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(500, refused.status)
            assertEquals(Refusal(null, null, null), refused.refusal)
            assertEquals("That didn’t go through", refused.words.spelled())
        }
    }

    @Test
    fun aBlankRefusalMessageUsesTheExistingFallback() {
        assertEquals("That didn’t go through", WindmillApiException.Refused(410, Refusal("  ", "\n")).words.spelled())
    }

    @Test
    fun aDeadHostIsOffline() = runTest {
        val dead = MockWebServer()
        dead.start()
        val base = dead.url("/")
        dead.shutdown()
        try {
            WindmillApi(base, { null }).get<Wire>("/v1/anything")
            fail("expected offline")
        } catch (offline: WindmillApiException.Offline) {
            assertEquals("Can’t reach windmill.works", offline.words.spelled())
        }
    }

    @Test
    fun anUndecodableSuccessIsMalformed() = runTest {
        server.enqueue(MockResponse().setBody("not json at all"))
        try {
            api().get<Wire>("/v1/echo")
            fail("expected malformed")
        } catch (broken: WindmillApiException.Malformed) {
            assertEquals("That didn’t go through", broken.words.spelled())
        }
    }

    @Test
    fun aTwoOhFourHasNoBodyToParse() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        api().send<Unit>("DELETE", "/v1/things/th_x")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals(0, request.bodySize)
    }

    @Test
    fun aBodilessPostStillGoesOut() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        api().send<Unit>("POST", "/v1/auth/logout")
        assertEquals("POST", server.takeRequest().method)
    }

    @Test
    fun capturingLiftsTheSessionCookie() = runTest {
        server.enqueue(
            MockResponse().setBody("""{"value":"in"}""")
                .addHeader("Set-Cookie", "wm_session=abc123; Path=/; HttpOnly; SameSite=Lax")
                .addHeader("Set-Cookie", "crumb=other; Path=/")
        )
        val answer = api().sendCapturingSession<Wire>("POST", "/v1/auth/verify", Wire("tok"))
        assertEquals(Wire("in"), answer.reply)
        assertEquals("abc123", answer.session)
    }

    @Test
    fun capturingAMissingOrEmptySessionIsMalformedAndReported() = runTest {
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                assertEquals(WindmillApiException.Malformed, error)
                failures += operation to properties
            }
        }
        val api = WindmillApi(server.url("/"), { null }, telemetry = telemetry)
        for (cookie in listOf(null, "wm_session=; Path=/")) {
            val response = MockResponse().setBody("""{"value":"in"}""")
            if (cookie != null) response.addHeader("Set-Cookie", cookie)
            server.enqueue(response)
            assertEquals(WindmillApiException.Malformed,
                runCatching { api.sendCapturingSession<Wire>("POST", "/v1/auth/verify", Wire("tok")) }.exceptionOrNull())
        }
        val expected = mapOf("method" to "POST", "route" to "/v1/auth", "failure_kind" to "malformed",
            "operation" to "auth_request", "network_phase" to "decode")
        assertEquals(List(2) { "auth_request" to expected }, failures.map { it.first to it.second.minus("duration_ms") })
        assertEquals(List(2) { "api_request_failed" to expected }, events.map { it.first to it.second.minus("duration_ms") })
        assertTrue(failures.all { it.second.getValue("duration_ms").toLong() >= 0 })
    }

    @Test
    fun theQuerySurvivesTheResolve() = runTest {
        server.enqueue(MockResponse().setBody("""{"value":"x"}"""))
        api().get<Wire>("/v1/things?filter=th_abc%20d&limit=2")
        assertEquals("/v1/things?filter=th_abc%20d&limit=2", server.takeRequest().path)
    }

    @Test
    fun blankConfigurationMeansProduction() {
        assertEquals("https://windmill.works/", WindmillApi.resolvedBaseUrl("").toString())
        assertEquals("https://windmill.works/", WindmillApi.resolvedBaseUrl("   ").toString())
        assertEquals("http://10.0.2.2:8088/", WindmillApi.resolvedBaseUrl("http://10.0.2.2:8088").toString())
        for (configured in listOf("not a url", "ftp://x")) {
            val failure = assertThrows(IllegalArgumentException::class.java) { WindmillApi.resolvedBaseUrl(configured) }
            assertEquals("windmill.apiBase is not an http(s) URL", failure.message)
        }
    }
}

// The words as English spells them.
private fun Words.spelled(): String = text(RuntimeEnvironment.getApplication())
