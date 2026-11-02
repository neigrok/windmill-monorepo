package works.windmill.app

import android.app.Application
import io.sentry.Sentry
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import works.windmill.platform.telemetry.AndroidTelemetry
import works.windmill.platform.telemetry.SentryErrors

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ReleaseMappingTests {
    private val expectedUuid = UUID.nameUUIDFromBytes(
        "windmill-android:${BuildConfig.WM_SOURCE_REVISION}:${BuildConfig.VERSION_CODE}:${BuildConfig.VERSION_NAME}"
            .toByteArray(Charsets.UTF_8)
    ).toString()

    @Test
    fun releaseAssetsCarryTheBuildIdentity() {
        val contents = RuntimeEnvironment.getApplication().assets.open("sentry-debug-meta.properties")
            .bufferedReader().use { it.readText() }
        assertEquals("io.sentry.ProguardUuids=$expectedUuid\n", contents)
    }

    @Test
    fun manuallyStartedSentryAttachesTheReleaseMappingToEvents() {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("{}")
        }
        server.start()
        try {
            AndroidTelemetry.startSentry(RuntimeEnvironment.getApplication(),
                "http://public@localhost:${server.port}/1", "android-test", "verification", "123")
            SentryErrors.failure("sync_storage", IllegalStateException("private detail"))
            Sentry.flush(10_000)
            repeat(10) {
                val request = server.takeRequest(10, TimeUnit.SECONDS)
                assertNotNull("Sentry delivered an envelope", request)
                val bytes = request!!.body.readByteArray()
                val envelope = if (request.getHeader("Content-Encoding") == "gzip")
                    GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader().use { it.readText() }
                else bytes.toString(Charsets.UTF_8)
                val lines = envelope.lines()
                val item = lines.indexOfFirst { it.contains("\"type\":\"event\"") }
                if (item < 0) return@repeat
                assertFalse(envelope.contains("private detail"))
                val images = JSONObject(lines[item + 1]).getJSONObject("debug_meta").getJSONArray("images")
                val proguard = (0 until images.length()).map { images.getJSONObject(it) }
                    .filter { it.optString("type") == "proguard" }
                assertEquals(1, proguard.size)
                assertEquals(setOf("type", "uuid"), proguard.single().keys().asSequence().toSet())
                assertEquals("proguard", proguard.single().getString("type"))
                assertEquals(expectedUuid, proguard.single().getString("uuid"))
                return
            }
            fail("Sentry delivered no event")
        } finally {
            Sentry.close()
            server.shutdown()
        }
    }
}
