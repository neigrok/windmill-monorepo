package works.windmill.platform.telemetry

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

@OptIn(ExperimentalCoroutinesApi::class)
class EventQueueTest {
    @Test
    fun onboardingEventsRetainOnlyTheirFiniteSchemaAndReachTheQueueSender() = runTest {
        var disk: String? = null
        val sent = mutableListOf<EventBatchIn>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, bearer ->
            assertNull(bearer)
            sent += batch
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope, now = { 123L })
        val metadata = mapOf(
            "platform" to "android", "app_version" to "0.1", "build" to "123",
            "release" to "android-test", "environment" to "verification",
        )
        val valid = linkedMapOf(
            "onboarding_opened" to mapOf("state" to "first_launch"),
            "onboarding_page_viewed" to mapOf("state" to "replay", "screen" to "windmill"),
            "onboarding_action" to mapOf("state" to "first_launch", "screen" to "roadmap", "action" to "swipe"),
            "onboarding_exited" to mapOf("state" to "replay", "screen" to "gym", "outcome" to "completed"),
        )
        for ((name, properties) in valid) {
            queue.add(name, mapOf(
                "state" to "private_state", "screen" to "private_workout", "action" to "private_action",
                "outcome" to "private_outcome", "storage" to "private_storage", "operation" to "private_operation",
                "route" to "/private_workout", "question" to "private_question", "duration_ms" to "100",
            ) + properties + metadata)
        }
        runCurrent()
        assertEquals(1, sent.size)
        assertEquals(valid.keys.toList(), sent.single().events.map { it.name })
        assertEquals(valid.values.map { props -> (props + metadata).mapValues { JsonPrimitive(it.value) } },
            sent.single().events.map { it.props })
        assertTrue(sent.single().events.all { it.clientMs == 123L })
        assertFalse(WindmillJson.encodeToString(EventBatchIn.serializer(), sent.single()).contains("private"))
        assertTrue(disk!!.contains("\"events\":[]"))
    }

    @Test
    fun onboardingNamesAreExactAndAllPropertyEnumsAreFinite() = runTest {
        var disk: String? = null
        val failures = mutableListOf<String>()
        val sent = mutableListOf<EventBatchIn>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, _ ->
            sent += batch
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope)
        val originalDisk = disk
        for (name in listOf("onboarding_custom", "onboarding_opened_private", "ONBOARDING_OPENED", "onboarding_")) {
            queue.add(name, mapOf("state" to "first_launch"))
        }
        runCurrent()
        assertEquals(List(4) { "telemetry_event_name" }, failures)
        assertEquals(originalDisk, disk)
        assertTrue(sent.isEmpty())

        for (state in listOf("first_launch", "replay")) {
            queue.add("onboarding_opened", mapOf("state" to state))
            for (screen in listOf("windmill", "roadmap", "journal", "gym")) {
                queue.add("onboarding_page_viewed", mapOf("state" to state, "screen" to screen))
                for (action in listOf("next", "back", "swipe", "adjust")) {
                    queue.add("onboarding_action", mapOf("state" to state, "screen" to screen, "action" to action))
                }
                for (outcome in listOf("skipped", "completed", "back", "closed")) {
                    queue.add("onboarding_exited", mapOf("state" to state, "screen" to screen, "outcome" to outcome))
                }
            }
        }
        queue.add("onboarding_action", mapOf("state" to "private_state", "screen" to "private_screen", "action" to "private_action"))
        queue.add("onboarding_exited", mapOf("state" to "private_state", "screen" to "private_screen", "outcome" to "private_outcome"))
        runCurrent()
        val events = sent.flatMap { it.events }
        assertEquals(76, events.size)
        assertEquals(74, events.count { it.props.isNotEmpty() })
        assertEquals(listOf(emptyMap<String, JsonPrimitive>(), emptyMap()), events.takeLast(2).map { it.props })
        assertFalse(WindmillJson.encodeToString(EventBatchIn.serializer(), sent.last()).contains("private"))
    }

    @Test
    fun retriesTheSameEventIdAndKeepsOnlySafeProperties() = runTest {
        var disk: String? = null
        var online = false
        val attempts = mutableListOf<EventBatchIn>()
        val failures = mutableListOf<String>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, bearer ->
            assertNull(bearer)
            attempts += batch
            if (!online) throw EventDeliveryFailure(WindmillApiException.Offline, mapOf(
                "method" to "POST", "route" to "/v1/events", "duration_ms" to "10", "network_phase" to "dns",
            ))
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope, now = { 123L }, retryMs = 100)
        queue.add("app_started", mapOf("screen" to "coach", "question" to "private message", "status" to "200"))
        runCurrent()
        assertEquals(1, attempts.size)
        assertFalse(disk!!.contains("private"))
        online = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(attempts[0], attempts[1])
        assertEquals("android", attempts[0].platform)
        assertEquals(mapOf("screen" to JsonPrimitive("coach"), "status" to JsonPrimitive("200")), attempts[0].events.single().props)
        assertEquals(123L, attempts[0].events.single().clientMs)
        assertEquals(emptyList<String>(), failures)
        assertTrue(disk!!.contains("\"events\":[]"))
    }

    @Test
    fun persistedEventsWaitForTheirOwnerAndAnonymousEventsNeverTakeAnAccountBearer() = runTest {
        var disk: String? = null
        val sent = mutableListOf<Pair<EventBatchIn, String?>>()
        val queue = EventQueue("first", "first-secret", { disk }, { disk = it; true }, { batch, bearer ->
            sent += batch to bearer
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope, now = { 123L })
        queue.add("first_event", emptyMap())
        queue.identity(null, null)
        queue.add("anonymous_event", emptyMap())
        queue.identity("second", "second-secret")
        queue.add("second_event", emptyMap())
        assertFalse(disk!!.contains("secret"))
        runCurrent()
        assertEquals(listOf("anonymous_event", "second_event"), sent.map { it.first.events.single().name })
        assertEquals(listOf(null, "second-secret"), sent.map { it.second })
        assertTrue(disk!!.contains("first_event"))
        val restored = EventQueue("first", "first-renewed", { disk }, { disk = it; true }, { batch, bearer ->
            sent += batch to bearer
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope)
        runCurrent()
        assertEquals("first_event", sent.last().first.events.single().name)
        assertEquals("first-renewed", sent.last().second)
        assertEquals("android", WindmillJson.decodeFromString<EventBatchIn>(
            WindmillJson.encodeToString(EventBatchIn.serializer(), sent.last().first)).platform)
    }

    @Test
    fun failedPersistenceAndDeliveryAreReportedWithoutLosingMemoryQueue() = runTest {
        val failures = mutableListOf<String>()
        var online = false
        var writes = false
        val queue = EventQueue(null, null, { null }, { writes }, { batch, _ ->
            if (!online) throw IllegalStateException("failed intake")
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope, retryMs = 100)
        queue.add("app_started", emptyMap())
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertEquals(listOf("telemetry_persist", "telemetry_delivery"), failures)
        online = true
        writes = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(listOf("telemetry_persist", "telemetry_delivery"), failures)
    }

    @Test
    fun deliveryDiagnosticsReportOncePerFailureStreakAndResetAfterSuccess() = runTest {
        var online = false
        var attempts = 0
        val failure = WindmillApiException.Timeout(java.io.InterruptedIOException("private transport detail"))
        val diagnostics = mapOf(
            "method" to "POST", "route" to "/v1/events", "network_phase" to "response_body",
            "duration_ms" to "40", "operation" to "http_request", "failure_kind" to "timeout",
        )
        val reports = mutableListOf<Pair<String, Map<String, String>>>()
        val queue = EventQueue(null, null, { null }, { true }, { batch, _ ->
            attempts += 1
            if (!online) throw EventDeliveryFailure(failure, diagnostics)
            batch.events.size
        }, { operation, error, properties ->
            assertEquals(failure, error)
            reports += operation to properties
        }, backgroundScope, retryMs = 100)
        queue.add("app_started", emptyMap())
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertEquals(3, attempts)
        assertEquals(listOf("telemetry_delivery" to diagnostics), reports)

        online = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(4, attempts)
        online = false
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        assertEquals(5, attempts)
        assertEquals(List(2) { "telemetry_delivery" to diagnostics }, reports)
    }
}
