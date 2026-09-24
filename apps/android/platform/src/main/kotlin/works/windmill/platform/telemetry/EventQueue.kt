package works.windmill.platform.telemetry

import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import works.windmill.platform.net.WindmillJson

@Serializable
data class EventIn(val id: String, val name: String, val clientMs: Long, val props: Map<String, JsonPrimitive>)

@Serializable
data class EventBatchIn(val sessionKey: String, val events: List<EventIn>, val platform: String)

@Serializable
data class EventBatchOut(val accepted: Int)

@Serializable
private data class EventShelf(val sessionKey: String, val userId: String?, val events: List<EventIn>)

@Serializable
private data class EventStore(val shelves: List<EventShelf>)

internal class EventDeliveryFailure(val error: Throwable, val properties: Map<String, String>) : Exception(error)

class EventQueue(
    userId: String?,
    credential: String?,
    read: () -> String?,
    private val write: (String) -> Boolean,
    private val send: suspend (EventBatchIn, String?) -> Int,
    private val failure: (String, Throwable, Map<String, String>) -> Unit,
    scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val retryMs: Long = 30_000,
) {
    private val lock = Any()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var currentUser = userId
    private var secret = credential
    private var overflowReported = false
    private var storageReported = false
    private var store = try {
        read()?.let { WindmillJson.decodeFromString<EventStore>(it) } ?: EventStore(emptyList())
    } catch (error: Exception) {
        failure("telemetry_restore", error, emptyMap())
        EventStore(emptyList())
    }

    init {
        identity(userId, credential)
        scope.launch {
            var deliveryReported = false
            for (signal in wake) {
                while (true) {
                    val next = synchronized(lock) {
                        store.shelves.firstOrNull { it.events.isNotEmpty() && (it.userId == null || it.userId == currentUser) }
                            ?.let { EventBatchIn(it.sessionKey, it.events.take(50), "android") to if (it.userId == null) null else secret }
                    } ?: break
                    val (batch, bearer) = next
                    try {
                        val accepted = send(batch, bearer)
                        if (accepted != batch.events.size) {
                            failure("telemetry_rejected", IllegalStateException("Event intake rejected entries"), emptyMap())
                        }
                        synchronized(lock) {
                            store = store.copy(shelves = store.shelves.map {
                                if (it.sessionKey != batch.sessionKey) it else it.copy(events = it.events.drop(batch.events.size))
                            })
                            overflowReported = false
                            persist()
                        }
                        deliveryReported = false
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        val delivery = error as? EventDeliveryFailure
                        val cause = delivery?.error ?: error
                        if (!deliveryReported && TelemetryPolicy.report(cause)) {
                            failure("telemetry_delivery", cause, delivery?.properties.orEmpty())
                            deliveryReported = true
                        }
                        delay(retryMs)
                    }
                }
            }
        }
    }

    fun identity(userId: String?, credential: String?) = synchronized(lock) {
        currentUser = userId
        secret = credential
        val retained = store.shelves.filter { it.userId == userId || it.events.isNotEmpty() }
        store = EventStore(if (retained.any { it.userId == userId }) retained
            else retained + EventShelf(UUID.randomUUID().toString(), userId, emptyList()))
        persist()
        wake.trySend(Unit)
        Unit
    }

    fun add(name: String, properties: Map<String, String>) = synchronized(lock) {
        if (!Regex("[a-z0-9_]{1,64}").matches(name)) {
            failure("telemetry_event_name", IllegalArgumentException("Invalid event name"), emptyMap())
            return@synchronized
        }
        if (store.shelves.sumOf { it.events.size } >= 500) {
            if (!overflowReported) failure("telemetry_overflow", IllegalStateException("Event queue reached capacity"), emptyMap())
            overflowReported = true
            return@synchronized
        }
        val props = TelemetryPolicy.properties(properties).mapValues { (key, value) ->
            if (key == "duration_ms") JsonPrimitive(value.toLongOrNull()?.coerceAtLeast(0) ?: 0) else JsonPrimitive(value)
        }
        val event = EventIn(UUID.randomUUID().toString(), name, now(), props)
        store = store.copy(shelves = store.shelves.map {
            if (it.userId != currentUser) it else it.copy(events = it.events + event)
        })
        persist()
        wake.trySend(Unit)
        Unit
    }

    private fun persist() {
        try {
            check(write(WindmillJson.encodeToString(EventStore.serializer(), store)))
            storageReported = false
        } catch (error: Exception) {
            if (!storageReported) failure("telemetry_persist", error, emptyMap())
            storageReported = true
        }
    }
}
