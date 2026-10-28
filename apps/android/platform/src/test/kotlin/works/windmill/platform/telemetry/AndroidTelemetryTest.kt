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
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
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
    @Test fun deletionActionsKeepOnlyTheirBoundedLabelsAndPreserveNotificationAndTileEvents() {
        val valid = listOf(
            Triple("finish", "discard", "ok"), Triple("finish", "discard", "cancelled"),
            Triple("finish", "discard", "refused"), Triple("finish", "discard", "failed"),
            Triple("finish", "keep", "ok"), Triple("finish", "done", "ok"),
            Triple("session", "discard", "ok"), Triple("log", "discard", "ok"),
            Triple("log", "open_workout", "ok"), Triple("log", "open_bodyweight", "ok"), Triple("log", "open_record", "ok"),
            Triple("log", "share", "ok"), Triple("log", "share", "refused"), Triple("log", "share", "failed"),
            Triple("routines", "delete", "ok"), Triple("session", "delete", "refused"), Triple("notes", "delete", "failed"), Triple("note_editor", "delete", "ok"),
            Triple("note_editor", "delete", "refused"), Triple("note_editor", "delete", "failed"),
            Triple("note_editor", "save", "ok"), Triple("note_editor", "save", "refused"), Triple("note_editor", "save", "failed"),
            Triple("record", "edit", "ok"), Triple("record", "edit", "refused"), Triple("record", "edit", "failed"),
            Triple("workout", "remove", "ok"), Triple("workout", "remove", "refused"), Triple("workout", "reorder", "ok"),
            Triple("workout", "picker_open", "ok"), Triple("workout", "picker_cancel", "ok"),
            Triple("workout", "picker_add", "ok"), Triple("workout", "picker_add", "refused"),
            Triple("workout", "movement_switch", "ok"), Triple("workout", "open_workout", "ok"),
            Triple("workout", "fix", "ok"), Triple("workout", "fix", "refused"), Triple("workout", "fix", "failed"),
            Triple("session", "fix", "ok"), Triple("session", "fix", "refused"), Triple("session", "fix", "failed"),
            Triple("bodyweight", "delete", "held"), Triple("bodyweight", "delete", "closed"),
            Triple("bodyweight", "undo", "ok"), Triple("bodyweight", "undo", "closed"),
            Triple("bodyweight", "cancel", "rewritten"), Triple("bodyweight", "calendar_open", "ok"),
            Triple("bodyweight", "calendar_confirm", "ok"), Triple("bodyweight", "calendar_cancel", "ok"), Triple("notification", "log_set", "ok"),
            Triple("notification", "open", "refused"), Triple("tile", "open", "ok"), Triple("tile", "routines", "failed"),
        )
        for ((screen, action, outcome) in valid) {
            val labels = mapOf("screen" to screen, "action" to action, "outcome" to outcome, "platform" to "android")
            assertEquals(labels, TelemetryPolicy.eventProperties("gym_action", labels + mapOf(
                "date" to "2026-09-01", "weight" to "81.25", "name" to "private", "operation" to "private")))
        }
        for (screen in listOf("finish", "session", "log")) {
            val shown = mapOf("screen" to screen, "action" to "discard", "state" to "shown")
            assertEquals(shown, TelemetryPolicy.eventProperties("gym_action", shown + mapOf("request_id" to "private", "question" to "private")))
        }
        for (labels in listOf(
            mapOf("screen" to "private", "action" to "delete", "outcome" to "ok"),
            mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "acknowledged"),
            mapOf("screen" to "bodyweight", "action" to "undo", "outcome" to "private"),
            mapOf("screen" to "notes", "action" to "private", "outcome" to "ok"),
            mapOf("screen" to "record", "action" to "edit", "outcome" to "private"),
            mapOf("screen" to "record", "action" to "delete", "outcome" to "ok"),
        )) assertEquals(emptyMap<String, String>(), TelemetryPolicy.eventProperties("gym_action", labels))
    }

    @Test fun coachArchiveActionsAndDeletionDialogRejectContentAndUnboundedLabels() {
        val steps = listOf("fresh_entry", "history_open", "draft_restored", "reply_open", "read_sources", "copy", "jump_latest")
        val allowed = steps.map { mapOf("screen" to "coach", "action" to it, "outcome" to "ok") } +
            listOf(mapOf("screen" to "coach", "action" to "copy", "outcome" to "failed")) +
            listOf("ok", "refused", "failed", "cancelled").map { mapOf("screen" to "threads", "action" to "delete", "outcome" to it) } +
            listOf(mapOf("screen" to "threads", "action" to "delete", "state" to "shown"))
        val content = mapOf("chat_id" to "private", "question" to "private", "photo" to "private",
            "answerPreview" to "private", "operation" to "private", "status" to "private")
        allowed.forEach { properties ->
            assertEquals(properties, TelemetryPolicy.eventProperties("gym_action", properties + content))
        }
        for (properties in listOf(
            mapOf("screen" to "coach", "action" to "private", "outcome" to "ok"),
            mapOf("screen" to "coach", "action" to "history_open", "outcome" to "private"),
            mapOf("screen" to "threads", "action" to "delete", "state" to "private"),
            mapOf("screen" to "private", "action" to "delete", "state" to "shown"),
        )) assertEquals(emptyMap<String, String>(), TelemetryPolicy.eventProperties("gym_action", properties + content))
    }

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
            telemetry.failure("gym.proposal_receipt_shown", IllegalStateException("private message secret@example.com"),
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
            assertEquals(1, envelopes.count { it.contains("\"operation\":\"gym.proposal_receipt_shown\"") })
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

            telemetry.event("gym_proposal_receipt_shown", mapOf("outcome" to "applied", "proposal" to "private-proposal", "routine" to "private-routine"))
            runCurrent()
            val receiptRequest = withContext(Dispatchers.IO) { events.takeRequest(10, TimeUnit.SECONDS) }
            assertNotNull(receiptRequest)
            assertEquals("/v1/events", receiptRequest!!.path)
            val receiptBody = receiptRequest.body.readUtf8()
            val receiptBatch = WindmillJson.decodeFromString<EventBatchIn>(receiptBody)
            assertEquals(listOf("gym_proposal_receipt_shown"), receiptBatch.events.map { it.name })
            assertEquals("applied", (receiptBatch.events.single().props.getValue("outcome") as kotlinx.serialization.json.JsonPrimitive).content)
            assertFalse(receiptBody.contains("private"))
            assertFalse(receiptBody.contains("\"proposal\""))
            assertFalse(receiptBody.contains("\"routine\""))
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

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun failuresOfOneExceptionTypeAndStackGroupByTheirOperation() = runTest {
        val errors = MockWebServer()
        val events = MockWebServer()
        errors.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("{}")
        }
        events.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(202).setBody("{\"accepted\":1}")
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
            for (operation in listOf("sync_push", "sync_pull")) {
                telemetry.failure(operation, IllegalStateException("private detail"), mapOf("outcome" to "failure"))
            }
            runCurrent()
            Sentry.flush(10_000)
            val captured = withContext(Dispatchers.IO) {
                val found = mutableListOf<kotlinx.serialization.json.JsonObject>()
                while (found.size < 2) {
                    val request = errors.takeRequest(10, TimeUnit.SECONDS)
                    assertNotNull("Sentry SDK delivered an envelope", request)
                    val bytes = request!!.body.readByteArray()
                    val envelope = if (request.getHeader("Content-Encoding") == "gzip")
                        GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader().readText()
                    else bytes.toString(Charsets.UTF_8)
                    val lines = envelope.lines()
                    val item = lines.indexOfFirst { it.contains("\"type\":\"event\"") }
                    if (item >= 0) found += WindmillJson.parseToJsonElement(lines[item + 1]) as kotlinx.serialization.json.JsonObject
                }
                found
            }
            val fingerprints = captured.map { event ->
                (event["fingerprint"] as kotlinx.serialization.json.JsonArray).map { (it as kotlinx.serialization.json.JsonPrimitive).content }
            }
            assertEquals(setOf(listOf("{{ default }}", "sync_push"), listOf("{{ default }}", "sync_pull")), fingerprints.toSet())
            val exceptions = captured.map { event -> (event["exception"] as kotlinx.serialization.json.JsonObject)["values"].toString() }
            assertEquals(1, exceptions.distinct().size)
            assertFalse(captured.toString().contains("private"))
        } finally {
            Sentry.close()
            errors.shutdown()
            events.shutdown()
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun aSuppliedFailureKindAndStatusReachTheSentryTagsAndTheClientErrorEvent() = runTest {
        val errors = MockWebServer()
        val events = MockWebServer()
        val batches = java.util.concurrent.CopyOnWriteArrayList<EventBatchIn>()
        errors.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("{}")
        }
        events.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val batch = WindmillJson.decodeFromString<EventBatchIn>(request.body.readUtf8()).also(batches::add)
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
            telemetry.failure("sync_pull", IllegalStateException("private detail"),
                mapOf("operation" to "pull", "outcome" to "failure", "failure_kind" to "http", "status" to "502"))
            telemetry.failure("sync_storage", IllegalStateException("private detail"), mapOf("operation" to "storage", "outcome" to "failure"))
            runCurrent()
            Sentry.flush(10_000)
            val tags = withContext(Dispatchers.IO) {
                val found = mutableListOf<Map<String, String>>()
                while (found.size < 2) {
                    val request = errors.takeRequest(10, TimeUnit.SECONDS)
                    assertNotNull("Sentry SDK delivered an envelope", request)
                    val bytes = request!!.body.readByteArray()
                    val envelope = if (request.getHeader("Content-Encoding") == "gzip")
                        GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader().readText()
                    else bytes.toString(Charsets.UTF_8)
                    val lines = envelope.lines()
                    val item = lines.indexOfFirst { it.contains("\"type\":\"event\"") }
                    if (item < 0) continue
                    val event = WindmillJson.parseToJsonElement(lines[item + 1]) as kotlinx.serialization.json.JsonObject
                    found += (event["tags"] as kotlinx.serialization.json.JsonObject)
                        .mapValues { (_, value) -> (value as kotlinx.serialization.json.JsonPrimitive).content }
                        .filterKeys { it in setOf("operation", "outcome", "failure_kind", "status") }
                }
                found
            }
            assertEquals(setOf(
                mapOf("operation" to "sync_pull", "outcome" to "failure", "failure_kind" to "http", "status" to "502"),
                mapOf("operation" to "sync_storage", "outcome" to "failure", "failure_kind" to "IllegalStateException"),
            ), tags.toSet())
            withContext(Dispatchers.IO) { withTimeout(10_000) { while (batches.sumOf { it.events.size } < 2) delay(20) } }
            assertEquals(listOf(
                mapOf("operation" to "sync_pull", "outcome" to "failure", "failure_kind" to "http", "status" to "502"),
                mapOf("operation" to "sync_storage", "outcome" to "failure", "failure_kind" to "IllegalStateException"),
            ), batches.flatMap { it.events }.map { event ->
                assertEquals("client_error", event.name)
                event.props.mapValues { it.value.content }.filterKeys { it in setOf("operation", "outcome", "failure_kind", "status") }
            })
        } finally {
            Sentry.close()
            errors.shutdown()
            events.shutdown()
        }
    }
}
