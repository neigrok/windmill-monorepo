package works.windmill.platform.telemetry

import io.sentry.Sentry
import java.io.ByteArrayInputStream
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AndroidTelemetryTest {
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun realSdkAndFirstPartyTransportDeliverRedactedRepeatedFailures() = runTest {
        val errors = MockWebServer()
        val events = MockWebServer()
        errors.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("{}")
        }
        events.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val batch = WindmillJson.decodeFromString<EventBatchIn>(request.body.clone().readUtf8())
                return MockResponse().setResponseCode(202).setBody("{\"accepted\":${batch.events.size}}")
            }
        }
        errors.start()
        events.start()
        try {
            val context = RuntimeEnvironment.getApplication()
            context.getSharedPreferences("works.windmill.telemetry", 0).edit().clear().commit()
            AndroidTelemetry.startSentry(context, "http://public@localhost:${errors.port}/1",
                "android-test", "verification", "123")
            val telemetry = AndroidTelemetry(context, events.url("/"), "android-test", "verification",
                "test", "123", null, { null }, backgroundScope)
            telemetry.failure("telemetry_smoke", IllegalStateException("private message secret@example.com"),
                mapOf("question" to "private question", "duration_ms" to "123", "network_phase" to "response_body"))
            telemetry.failure("http_request", WindmillApiException.Malformed,
                mapOf("network_phase" to "private-host.example"))
            telemetry.failure("http_request", WindmillApiException.Malformed)
            runCurrent()
            Sentry.flush(10_000)
            val envelopes = withContext(Dispatchers.IO) {
                val captured = mutableListOf<String>()
                while (captured.size < 3) {
                    val request = errors.takeRequest(10, TimeUnit.SECONDS)
                    assertNotNull("Sentry SDK delivered an envelope", request)
                    val bytes = request!!.body.readByteArray()
                    val envelope = if (request.getHeader("Content-Encoding") == "gzip")
                        GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader().readText()
                    else bytes.toString(Charsets.UTF_8)
                    if (envelope.contains("\"type\":\"event\"")) captured += envelope
                }
                captured
            }
            for (envelope in envelopes) {
                assertFalse(envelope.contains("private"))
                assertFalse(envelope.contains("secret@example.com"))
                assertTrue(envelope.contains("\"environment\":\"verification\""))
                assertTrue(envelope.contains("\"release\":\"android-test\""))
                assertTrue(envelope.contains("\"stacktrace\""))
            }
            assertEquals(3, envelopes.size)
            assertEquals(1, envelopes.count { it.contains("\"network_phase\":\"response_body\"") })
            val request = withContext(Dispatchers.IO) { events.takeRequest(10, TimeUnit.SECONDS) }
            assertNotNull(request)
            assertEquals("/v1/events", request!!.path)
            assertNull(request.getHeader("Authorization"))
            val body = request.body.readUtf8()
            val batch = WindmillJson.decodeFromString<EventBatchIn>(body)
            assertEquals("android", batch.platform)
            assertEquals(listOf("client_error", "client_error", "client_error"), batch.events.map { it.name })
            assertTrue(body.contains("\"duration_ms\":123"))
            assertTrue(body.contains("\"network_phase\":\"response_body\""))
            assertFalse(body.contains("private"))
            assertTrue(batch.events.all { it.id.isNotBlank() })
        } finally {
            Sentry.close()
            errors.shutdown()
            events.shutdown()
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun analyticsBatchesReuseOneConnectionWithoutReusingAccountCredentials() = runTest {
        val events = MockWebServer()
        events.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse()
                .setResponseCode(202).setBody("{\"accepted\":1}")
        }
        events.start()
        try {
            val context = RuntimeEnvironment.getApplication()
            context.getSharedPreferences("works.windmill.telemetry", 0).edit().clear().commit()
            var credential: String? = "first-secret"
            val telemetry = AndroidTelemetry(context, events.url("/"), "android-test", "verification",
                "test", "123", "first", { credential }, backgroundScope)
            val requests = mutableListOf<RecordedRequest>()
            for ((user, secret) in listOf("first" to "first-secret", null to null, "second" to "second-secret")) {
                credential = secret
                telemetry.identity(user)
                telemetry.event("app_foregrounded")
                runCurrent()
                val request = withContext(Dispatchers.IO) { events.takeRequest(10, TimeUnit.SECONDS) }
                assertNotNull("A separate event batch arrives for each account", request)
                requests += request!!
            }
            assertEquals(listOf(0, 1, 2), requests.map { it.sequenceNumber })
            assertEquals(listOf("Bearer first-secret", null, "Bearer second-secret"), requests.map { it.getHeader("Authorization") })
            assertEquals(List(3) { "/v1/events" }, requests.map { it.path })
            val batches = requests.map { WindmillJson.decodeFromString<EventBatchIn>(it.body.readUtf8()) }
            assertEquals(List(3) { listOf("app_foregrounded") }, batches.map { it.events.map { event -> event.name } })
            assertEquals(3, batches.map { it.sessionKey }.distinct().size)
            assertFalse(context.getSharedPreferences("works.windmill.telemetry", 0).getString("queue", "")!!.contains("secret"))
        } finally {
            events.shutdown()
        }
    }

    @Test
    fun deliveryFailuresReachSentryWithTransportDiagnosticsWithoutAnotherAnalyticsEvent() = runTest {
        val errors = MockWebServer()
        val events = MockWebServer()
        val deliveryScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        errors.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("{}")
        }
        events.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse()
                .setResponseCode(503).setBody("private response private@example.com")
        }
        errors.start()
        events.start()
        try {
            val context = RuntimeEnvironment.getApplication()
            context.getSharedPreferences("works.windmill.telemetry", 0).edit().clear().commit()
            AndroidTelemetry.startSentry(context, "http://public@localhost:${errors.port}/1",
                "android-test", "verification", "123")
            val telemetry = AndroidTelemetry(context, events.url("/"), "android-test", "verification",
                "test", "123", "first", { "private-secret" }, deliveryScope)
            telemetry.event("app_started")
            val eventJson = withContext(Dispatchers.IO) {
                var event: kotlinx.serialization.json.JsonObject? = null
                while (event == null) {
                    val request = errors.takeRequest(10, TimeUnit.SECONDS)
                    assertNotNull("Delivery failure reaches Sentry", request)
                    val bytes = request!!.body.readByteArray()
                    val envelope = if (request.getHeader("Content-Encoding") == "gzip")
                        GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader().readText()
                    else bytes.toString(Charsets.UTF_8)
                    val lines = envelope.lines()
                    val item = lines.indexOfFirst { it.contains("\"type\":\"event\"") }
                    if (item >= 0) event = WindmillJson.parseToJsonElement(lines[item + 1]) as kotlinx.serialization.json.JsonObject
                }
                requireNotNull(event)
            }
            val tags = (eventJson["tags"] as kotlinx.serialization.json.JsonObject)
                .mapValues { (_, value) -> (value as kotlinx.serialization.json.JsonPrimitive).content }
            assertEquals("telemetry_delivery", tags["operation"])
            assertEquals("POST", tags["method"])
            assertEquals("/v1/events", tags["route"])
            assertEquals("response_body", tags["network_phase"])
            assertEquals("http", tags["failure_kind"])
            assertEquals("503", tags["status"])
            assertTrue(tags.getValue("duration_ms").toLong() >= 0)
            assertFalse(eventJson.toString().contains("private"))
            val request = withContext(Dispatchers.IO) { events.takeRequest(10, TimeUnit.SECONDS) }
            assertNotNull(request)
            val batch = WindmillJson.decodeFromString<EventBatchIn>(request!!.body.readUtf8())
            assertEquals(listOf("app_started"), batch.events.map { it.name })
            val stored = context.getSharedPreferences("works.windmill.telemetry", 0).getString("queue", "")!!
            assertFalse(stored.contains("api_request_failed"))
            assertFalse(stored.contains("client_error"))
            assertEquals(1, events.requestCount)
        } finally {
            deliveryScope.cancel()
            Sentry.close()
            errors.shutdown()
            events.shutdown()
        }
    }
}
