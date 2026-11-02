package works.windmill.platform.telemetry

import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.first
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
private data class EventShelf(val sessionKey: String, val userId: String?, val events: List<EventIn>) {
    fun drainable(currentUser: String?): Boolean = userId == null || userId == currentUser
}

@Serializable
private data class EventStore(val shelves: List<EventShelf>) {
    fun prune(currentUser: String?): EventStore = EventStore(shelves.filter {
        it.drainable(currentUser) || it.events.isNotEmpty()
    })

    fun identify(userId: String?, sessionKey: String): EventStore {
        val retained = prune(userId).shelves
        if (retained.any { it.userId == userId }) return EventStore(retained)
        return EventStore(retained + EventShelf(sessionKey, userId, emptyList()))
    }

    fun append(owner: String?, events: List<EventIn>, sessionKey: String): EventStore {
        if (shelves.none { it.userId == owner }) return EventStore(shelves + EventShelf(sessionKey, owner, events))
        return EventStore(shelves.map { if (it.userId == owner) it.copy(events = it.events + events) else it })
    }

    fun add(event: EventIn, owner: String?, currentUser: String?, sessionKey: String): EventStore {
        var retained = shelves
        while (retained.sumOf { it.events.size } >= 500) {
            val oldest = retained.indices.filter {
                !retained[it].drainable(currentUser) && retained[it].events.isNotEmpty()
            }.minWithOrNull(compareBy<Int> { retained[it].events.first().clientMs }.thenBy { it }) ?: return this
            retained = EventStore(retained.mapIndexed { index, shelf ->
                if (index == oldest) shelf.copy(events = shelf.events.drop(1)) else shelf
            }).prune(currentUser).shelves
        }
        return EventStore(retained).append(owner, listOf(event), sessionKey)
    }

    fun retire(userId: String, carrying: Set<String>, currentUser: String?, sessionKey: String): EventStore {
        val carried = shelves.filter { it.userId == userId }.flatMap { it.events }.filter { it.name in carrying }
        val retained = EventStore(shelves.map {
            if (it.userId == userId) it.copy(events = emptyList()) else it
        }).prune(currentUser)
        if (carried.isEmpty()) return retained
        return retained.append(null, carried, sessionKey)
    }

    fun acknowledge(ids: Set<String>, currentUser: String?): EventStore = EventStore(shelves.map {
        it.copy(events = it.events.filterNot { event -> event.id in ids })
    }).prune(currentUser)
}

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
    private val schemas: EventSchemas = EventSchemas.platform,
) {
    private sealed interface Command {
        data class Add(val event: EventIn, val signedOut: Boolean) : Command
        data class Identity(val userId: String?, val credential: String?) : Command
        data class Retire(val userId: String, val carrying: Set<String>) : Command
        data class Acknowledge(val ids: Set<String>, val applied: CompletableDeferred<Unit>) : Command
    }

    private data class Snapshot(val store: EventStore, val userId: String?, val credential: String?) {
        fun next(): Pair<EventBatchIn, String?>? = store.shelves.firstOrNull {
            it.events.isNotEmpty() && it.drainable(userId)
        }?.let { EventBatchIn(it.sessionKey, it.events.take(50), "android") to if (it.userId == null) null else credential }
    }

    private val commands = Channel<Command>(Channel.UNLIMITED)
    private val snapshots = MutableStateFlow<Snapshot?>(null)

    init {
        scope.launch {
            try {
                var store = try {
                    read()?.let { WindmillJson.decodeFromString<EventStore>(it) } ?: EventStore(emptyList())
                } catch (error: Exception) {
                    coroutineContext.ensureActive()
                    failure("telemetry_restore", error, emptyMap())
                    EventStore(emptyList())
                }
                var currentUser = userId
                var secret = credential
                var overflowReported = false
                var storageReported = false
                var previous = store
                store = store.identify(userId, UUID.randomUUID().toString())
                var command = commands.tryReceive().getOrNull()
                while (true) {
                    val acknowledgements = mutableListOf<CompletableDeferred<Unit>>()
                    while (command != null) {
                        val change: Command = command
                        when (change) {
                            is Command.Add -> {
                                val updated = store.add(change.event, if (change.signedOut) null else currentUser,
                                    currentUser, UUID.randomUUID().toString())
                                if (updated === store) {
                                    if (!overflowReported) failure("telemetry_overflow", IllegalStateException("Event queue reached capacity"), emptyMap())
                                    overflowReported = true
                                }
                                store = updated
                            }
                            is Command.Identity -> {
                                currentUser = change.userId
                                secret = change.credential
                                store = store.identify(currentUser, UUID.randomUUID().toString())
                            }
                            is Command.Retire -> store = store.retire(change.userId, change.carrying, currentUser, UUID.randomUUID().toString())
                            is Command.Acknowledge -> {
                                store = store.acknowledge(change.ids, currentUser)
                                overflowReported = false
                                acknowledgements += change.applied
                            }
                        }
                        command = commands.tryReceive().getOrNull()
                    }
                    snapshots.value = Snapshot(store, currentUser, secret)
                    if (store != previous) {
                        try {
                            check(write(WindmillJson.encodeToString(EventStore.serializer(), store)))
                            storageReported = false
                        } catch (error: Exception) {
                            coroutineContext.ensureActive()
                            if (!storageReported) failure("telemetry_persist", error, emptyMap())
                            storageReported = true
                        }
                    }
                    acknowledgements.forEach { it.complete(Unit) }
                    previous = store
                    command = commands.receive()
                }
            } finally {
                commands.cancel()
            }
        }
        scope.launch {
            var deliveryReported = false
            while (true) {
                val (batch, bearer) = snapshots.mapNotNull { it?.next() }.first()
                try {
                    val accepted = send(batch, bearer)
                    if (accepted != batch.events.size) {
                        failure("telemetry_rejected", IllegalStateException("Event intake rejected entries"), emptyMap())
                    }
                    val applied = CompletableDeferred<Unit>()
                    commands.send(Command.Acknowledge(batch.events.map { it.id }.toSet(), applied))
                    applied.await()
                    deliveryReported = false
                } catch (error: Exception) {
                    coroutineContext.ensureActive()
                    val delivery = error as? EventDeliveryFailure
                    val cause = delivery?.error ?: error
                    if (!deliveryReported && TelemetryPolicy.report(cause) && !TelemetryPolicy.networkLoss(cause)) {
                        failure("telemetry_delivery", cause, delivery?.properties.orEmpty())
                        deliveryReported = true
                    }
                    delay(retryMs)
                }
            }
        }
    }

    fun identity(userId: String?, credential: String?) {
        commands.trySend(Command.Identity(userId, credential))
    }

    fun retire(userId: String, carrying: Set<String>) {
        commands.trySend(Command.Retire(userId, carrying.toSet()))
    }

    fun add(name: String, properties: Map<String, String>, signedOut: Boolean = false) {
        if (!schemas.accepts(name)) {
            failure("telemetry_event_name", IllegalArgumentException("Invalid event name"), emptyMap())
            return
        }
        val props = schemas.properties(name, properties).mapValues { (key, value) ->
            if (key == "duration_ms") JsonPrimitive(value.toLongOrNull()?.coerceAtLeast(0) ?: 0) else JsonPrimitive(value)
        }
        commands.trySend(Command.Add(EventIn(UUID.randomUUID().toString(), name, now(), props), signedOut))
    }
}
