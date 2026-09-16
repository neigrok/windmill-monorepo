package works.windmill.platform.telemetry

import io.sentry.Sentry
import java.io.ByteArrayInputStream
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import kotlinx.coroutines.Dispatchers
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
                mapOf("question" to "private question", "duration_ms" to "123"))
            telemetry.failure("http_request", WindmillApiException.Malformed)
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
            val request = withContext(Dispatchers.IO) { events.takeRequest(10, TimeUnit.SECONDS) }
            assertNotNull(request)
            assertEquals("/v1/events", request!!.path)
            assertNull(request.getHeader("Authorization"))
            val body = request.body.readUtf8()
            val batch = WindmillJson.decodeFromString<EventBatchIn>(body)
            assertEquals("android", batch.platform)
            assertEquals(listOf("client_error", "client_error", "client_error"), batch.events.map { it.name })
            assertTrue(body.contains("\"duration_ms\":123"))
            assertFalse(body.contains("private"))
            assertTrue(batch.events.all { it.id.isNotBlank() })
        } finally {
            Sentry.close()
            errors.shutdown()
            events.shutdown()
        }
    }
}
