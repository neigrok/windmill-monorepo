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
    fun retriesTheSameEventIdAndKeepsOnlySafeProperties() = runTest {
        var disk: String? = null
        var online = false
        val attempts = mutableListOf<EventBatchIn>()
        val failures = mutableListOf<String>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, bearer ->
            assertNull(bearer)
            attempts += batch
            if (!online) throw WindmillApiException.Offline
            batch.events.size
        }, { operation, _ -> failures += operation }, backgroundScope, now = { 123L }, retryMs = 100)
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
        }, { _, error -> throw AssertionError(error) }, backgroundScope, now = { 123L })
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
        }, { _, error -> throw AssertionError(error) }, backgroundScope)
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
        }, { operation, _ -> failures += operation }, backgroundScope, retryMs = 100)
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
}
