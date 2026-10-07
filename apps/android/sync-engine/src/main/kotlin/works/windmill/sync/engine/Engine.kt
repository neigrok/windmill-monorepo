package works.windmill.sync.engine

import java.security.SecureRandom
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.flow.catch
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.Command
import works.windmill.sync.core.RecordID

interface EngineClock {
    fun now(): Long
    fun reading() = ClockReading(now(), System.nanoTime() / 1_000_000, ProcessClock.boot)
}
internal object ProcessClock { val boot = java.util.UUID.randomUUID().toString() }
class EngineCrash : RuntimeException("simulated-process-death")
interface IdentitySource {
    fun opaqueID(): String
    fun draw(bound: Int): Int
    fun replicaID() = "rp_" + buildString { repeat(32) { append("0123456789abcdef"[draw(16)]) } }
    fun actorID() = "r_" + buildString { repeat(12) { append("0123456789abcdef"[draw(16)]) } }
    fun forkGuard() = opaqueID()
}

class Engine internal constructor(val registry: Registry, internal val store: EngineStore,
    internal val clock: EngineClock, internal val identities: IdentitySource, var actor: String,
    internal val pushMaxBytes: Int = Constants.PUSH_MAX_BYTES, telemetry: EngineTelemetry = NoEngineTelemetry,
    internal val rewriteDeviceValue: DeviceValueRewrite = { _, _, value, _, _, _ -> value },
    internal val intentResultWrites: IntentResultDeviceWrites = { _, _, _, _, _ -> emptyList() },
    internal val pendingDeviceWork: PendingDeviceWork = { _, _ -> emptyList() }) : Replica, AutoCloseable {
    internal val lock = ReentrantLock(true)
    internal var device = DeviceState(store.metadata()).also { device -> device.replicas.forEach { replica -> replica.staging.replaceAll { _, stage -> stage.with("rows" to null) } } }
    internal val ended = mutableListOf<Json>()
    internal var closed = false
    private var writing = false
    private var crashCountdown: Int? = null
    internal val changedScopes = mutableSetOf<ScopeRef>()
    internal val changedRows = mutableSetOf<Pair<ScopeRef, RecordKey>>()
    internal var selectedScopes: Set<ScopeRef>? = null
    internal var openedScopes: Set<ScopeRef> = emptySet()
    internal val events = mutableListOf<Json>()
    internal val diagnostics = mutableListOf<Json>()
    internal val doubts = Doubts()
    internal var networkOnline = true
    internal var networkUpgradeRequired = false
    internal fun networkStatus(online: Boolean = networkOnline, upgradeRequired: Boolean = networkUpgradeRequired) = lock.withLock {
        networkOnline = online; networkUpgradeRequired = upgradeRequired
        version++; changes.tryEmit(Invalidation(version, emptySet(), operation = EngineOperation.sync,
            replica = device.current().id, account = device.current().account))
    }
    internal val observation by lazy { ObservationHub(this) }
    internal val writerSlices = WriterSlices()
    fun records(scope: ScopeRef, type: String, field: String? = null, id: RecordID? = null, mode: ViewMode = ViewMode.drawn) = observation.records(scope, type, field, id, mode)
    fun notices(product: String) = observation.notices(product)
    val offers get() = observation.undoOffers
    val status get() = observation.status
    fun events(): List<Json> = lock.withLock { events.toList() }
    fun diagnostics(): List<Json> = lock.withLock { diagnostics.toList() }
    fun activeReplica(): String = lock.withLock { ensureOpen(); device.current().id }
    internal fun diagnostic(event: Json) { diagnostics.add(event) }
    internal data class Invalidation(val version: Long, val records: Set<Pair<ScopeRef, RecordKey>>, val full: Boolean = false, val scopes: Set<ScopeRef> = emptySet(), val firstPullScopes: Set<ScopeRef> = emptySet(), val operation: EngineOperation = EngineOperation.commit,
        val replica: String? = null, val account: String? = null)
    internal val changes = MutableSharedFlow<Invalidation>(replay = 1, extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val telemetry = TelemetryQueue(telemetry)
    internal var version = 0L
    override fun physNow(): Long = lock.withLock { ensureOpen(); now(device.current()) }
    internal fun now(replica: ReplicaState) = clock.now() + replica.meta.member("serverOffsetMs").long()
    internal fun opaqueID() = identities.opaqueID()
    internal fun draw(bound: Int) = identities.draw(bound)
    internal fun report(operation: EngineOperation, outcome: EngineOutcome, code: String? = null) = telemetry.offer(operation, outcome, code)
    internal fun ensureOpen() { if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed") }
    internal fun <T> write(operation: EngineOperation = EngineOperation.commit, body: (ReplicaState) -> T): T = lock.withLock {
        ensureOpen()
        if (writing) throw CommitFailure.malformed("nested-commit")
        val before = device
        val endedBefore = ended.size
        val eventsBefore = events.size
        val diagnosticsBefore = diagnostics.size
        val actorBefore = actor
        val scopesBefore = selectedScopes
        val openedBefore = openedScopes
        changedRows.clear(); changedScopes.clear()
        device = device.copy()
        writing = true
        var durable = false
        try {
            val result = store.transaction { body(device.current()).also {
                val next = device.json()
                if (next != before.json()) store.metadata(next)
            } }
            durable = true
            crashCountdown?.let { left ->
                crashCountdown = if (left == 1) null else left - 1
                if (left == 1) throw EngineCrash()
            }
            val previous = before.replicas.flatMap { it.outbox }.associate { it.id to it.json }
            val current = device.replicas.flatMap { it.outbox }.associate { it.id to it.json }
            val modified = (previous.keys + current.keys).filter { previous[it] != current[it] }
                .flatMap { id -> listOfNotNull(previous[id], current[id]) }.map(::Entry)
            val activeChanged = before.active != device.active
            val oldCursors = before.replicas.firstOrNull { it.id == before.active }?.cursors.orEmpty()
            val newCursors = device.current().cursors
            val cursorScopes = (oldCursors.keys + newCursors.keys).filter { oldCursors[it] != newCursors[it] }.map(::ScopeRef).toSet()
            val changed = before.json() != device.json() || changedRows.isNotEmpty() || changedScopes.isNotEmpty() || scopesBefore != selectedScopes || openedBefore != openedScopes
            if (changed) {
                version++
                changes.tryEmit(Invalidation(version, modified.flatMap { entry -> entry.deltas.map { entry.scope to it.key } }.toSet() + changedRows,
                    activeChanged || operation == EngineOperation.lifecycle || operation == EngineOperation.subscription, scopes = changedScopes.toSet(), firstPullScopes = cursorScopes, operation = operation,
                    replica = device.current().id, account = device.current().account))
            }
            val outcome = (result as? Pair<*, *>)?.first as? CommitOutcome
            if (changed || outcome is CommitOutcome.Refused) telemetry.offer(operation,
                if (outcome is CommitOutcome.Refused) EngineOutcome.refused else EngineOutcome.success, (outcome as? CommitOutcome.Refused)?.code?.text)
            diagnostics.drop(diagnosticsBefore).forEach { report(EngineOperation.sync, EngineOutcome.failure, it["event"]?.str()) }
            for (trace in listOf(ended, events, diagnostics)) if (trace.size > 1_024) trace.subList(0, trace.size - 1_024).clear()
            result
        } catch (failure: Throwable) {
            // The transaction is durable. Reopening its snapshot must see it, even when the process dies before publication.
            if (failure is EngineCrash && durable) throw failure
            device = before
            actor = actorBefore
            selectedScopes = scopesBefore
            openedScopes = openedBefore
            while (events.size > eventsBefore) events.removeAt(events.lastIndex)
            while (diagnostics.size > diagnosticsBefore) diagnostics.removeAt(diagnostics.lastIndex)
            while (ended.size > endedBefore) ended.removeAt(ended.lastIndex)
            if (failure is StoreFailure) {
                telemetry.offer(EngineOperation.storage, EngineOutcome.failure, "store-failure")
                throw CommitFailure(CommitFailure.Kind.storeFailure, "transaction")
            }
            telemetry.offer(operation, EngineOutcome.failure, (failure as? CommitFailure)?.kind?.wire)
            throw failure
        } finally { writing = false }
    }
    override fun <T> commit(scope: ScopeRef, body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T> = write { replica ->
        if (replica.state !in setOf("anon", "bound")) throw CommitFailure(CommitFailure.Kind.notWritable, replica.state)
        val context = Reader(replica, scope, now(replica))
        val (gesture, value) = try { body(context).also { context.finish() } } finally { context.end() }
        val result = gesture?.let {
            try { commitGesture(replica, scope, it, context.now) }
            catch (_: IllegalArgumentException) { throw CommitFailure.malformed("invalid-value") }
        }
        result to value
    }
    override fun <T> read(scope: ScopeRef, body: (ScopeReader) -> T): T = lock.withLock {
        ensureOpen()
        val reader = Reader(device.current(), scope, now(device.current()))
        try { store.read { body(reader) } }
        catch (_: StoreFailure) { telemetry.offer(EngineOperation.read, EngineOutcome.failure, "store-failure"); throw CommitFailure(CommitFailure.Kind.storeFailure, "read") }
        finally { reader.end() }
    }
    // Refused source remains durable after its notice is dismissed, even without a drawn record.
    fun retainsRecord(scope: ScopeRef, key: RecordKey): Boolean = read(scope) { reader ->
        fun carries(content: Json): Boolean = content.items("d").any { it.recordKey == key } ||
            content.items("dependents").any(::carries)
        reader.drawn(key.type, key.id) != null || device.current().notices.any {
            ScopeRef(it.member("scope")) == scope && carries(it.member("content"))
        } || device.current().spent[scope.text]?.arr()?.any { it.recordKey == key } == true
    }
    override fun mintID(type: String): RecordID = lock.withLock {
        ensureOpen(); RecordID((registry.type(type)?.mint ?: throw CommitFailure.malformed("not-minted")).id(::draw))
    }
    override fun undo(gestureId: String): Boolean = write(EngineOperation.undo) { replica ->
        val entries = replica.entries().filter { it.gestureId == gestureId }
        if (entries.isEmpty() || entries.any { it.state != "held" }) return@write false
        val folded = silentFold(replica, entries)
        entries.forEach { replica.move(it, "undo", ended) }
        applySilentFold(replica, folded)
        true
    }
    override fun dismissNotice(id: String) { write(EngineOperation.dismiss) { replica ->
        val at = replica.notices.indexOfFirst { it.member("id").str() == id }
        if (at < 0) throw CommitFailure.malformed("unknown-notice")
        replica.notices[at] = replica.notices[at].with("dismissed" to Json.of(true))
    } }
    fun releaseHeld(all: Boolean = false): List<String> = write(EngineOperation.release) { replica ->
        val due = replica.entries().filter { it.state == "held" && (all || it.json.member("releaseAt").long() <= clock.now()) }
        due.forEach { replica.move(it, "release", ended) }; due.map { it.id }
    }
    fun release(localId: String): Boolean = write(EngineOperation.release) { replica ->
        val entry = replica.entries().firstOrNull { it.id == localId && it.state == "held" } ?: return@write false
        replica.move(entry, "release", ended); true
    }
    fun undoOffers(): List<UndoOffer> = lock.withLock {
        ensureOpen()
        device.current().entries().filter { it.state == "held" && it.json.member("releaseAt").long() > clock.now() }
            .distinctBy { it.gestureId }.map { UndoOffer(it.gestureId, it.scope, it.json.member("releaseAt").long()) }
    }
    fun observe(scope: ScopeRef, type: String, field: String? = null, id: RecordID? = null, mode: ViewMode = ViewMode.drawn): Flow<List<Record>> = flow {
        require((field == null) == (id == null))
        suspend fun snapshot(): Pair<Long, List<Record>> = withContext(Dispatchers.IO) { lock.withLock {
            ensureOpen(); version to Reader(device.current(), scope, now(device.current())).list(type, mode, field, id)
        } }
        val initial = snapshot()
        var delivered = initial.first
        val records = initial.second.associateBy { RecordKey(it.type, it.id) }.toMutableMap()
        emit(initial.second)
        changes.takeWhile { it.version != Long.MIN_VALUE }.collect { changed ->
            if (changed.version <= delivered) return@collect
            if (changed.full || changed.version != delivered + 1) {
                val next = snapshot(); records.clear(); records.putAll(next.second.associateBy { RecordKey(it.type, it.id) }); delivered = next.first
                emit(next.second); return@collect
            }
            delivered = changed.version
            val affected = changed.records.filter { it.first == scope && it.second.type == type }.map { it.second }
            if (affected.isEmpty()) return@collect
            withContext(Dispatchers.IO) { lock.withLock {
                ensureOpen()
                for (key in affected) {
                    val row = view(device.current(), scope, key, mode)
                    if (row == null || !row.isVisible || field != null && row.values[field] != id?.json) records.remove(key) else records[key] = row
                }
            } }
            emit(records.toSortedMap().values.toList())
        }
    }.catch { failure ->
        if (failure !is CommitFailure || failure.kind != CommitFailure.Kind.notWritable || lock.withLock { !closed }) throw failure
    }
    internal fun view(replica: ReplicaState, scope: ScopeRef, key: RecordKey, mode: ViewMode, gone: Set<Delta> = emptySet()): Record? {
        val row = store.row(replica.id, scope, key)
        var lattice = row?.lattice ?: Lattice()
        val texts = row?.texts?.mapValues { TextValueState(it.value.text, it.value.merged, false) }?.toMutableMap() ?: mutableMapOf()
        val serials = row?.serials?.toMutableMap() ?: mutableMapOf()
        var exists = row != null
        var pending = false; var held = false
        for (entry in replica.entries()) {
            if (entry.scope != scope) continue
            for (delta in entry.deltas) {
                if (delta.key != key || delta in gone) continue
                held = held || entry.state == "held"
                if (entry.state == "held" && mode == ViewMode.stored) continue
                exists = true; pending = true
                lattice = Join.record(registry.type(key.type), lattice, delta.lattice)
                for ((name, text) in delta.texts) texts[name] = TextValueState(text.text, false, true)
                serials.putAll(delta.serials)
            }
        }
        if (!exists) return null
        return Record(key.type, key.id, lattice.life, lattice.born, lattice.fields.mapValues { it.value.value },
            texts.mapValues { TextValue(it.value.text, it.value.merged, it.value.pending) }, serials, row?.rc, row?.ru,
            isVisible(registry.type(key.type), lattice, texts), pending, held)
    }
    internal fun latticeView(replica: ReplicaState, scope: ScopeRef, key: RecordKey, mode: ViewMode, gone: Set<Delta> = emptySet()): Lattice? {
        var lattice = store.row(replica.id, scope, key)?.lattice
        for (entry in replica.entries()) if (entry.scope == scope && (mode == ViewMode.drawn || entry.state != "held")) {
            for (delta in entry.deltas) if (delta.key == key && delta !in gone) lattice = Join.record(registry.type(key.type), lattice ?: Lattice(), delta.lattice)
        }
        return lattice
    }
    internal fun keys(replica: ReplicaState, scope: ScopeRef, type: String, field: String? = null, id: RecordID? = null): Set<RecordKey> {
        val rows = if (field != null && id != null) store.matching(replica.id, scope, type, field, id) else store.rows(replica.id, scope, type)
        return rows.map { it.key }.toSet() + replica.entries().filter { it.scope == scope }.flatMap { it.deltas }.filter { it.key.type == type }.map { it.key }
    }
    internal inner class Reader(private val replicaState: ReplicaState, private val scope: ScopeRef, override val now: Long) : CommitContext {
        private var open = true
        private var failure: Exception? = null
        private val minted = mutableSetOf<RecordID>()
        init { if (registry.scopeKind(scope) == null) throw CommitFailure.malformed("scope") }
        fun end() { open = false }
        fun finish() { failure?.let { throw it } }
        private fun <T> checked(body: () -> T): T = try {
            if (!open) throw CommitFailure.malformed("reader-ended")
            body()
        } catch (error: Exception) { if (failure == null) failure = error; throw error }
        private fun lives(type: String) { if (!registry.lives(type, scope)) throw CommitFailure.malformed("scope-type") }
        override val replica get() = replicaState.id
        override val actor get() = this@Engine.actor
        override val isAnonymous get() = replicaState.state == "anon"
        override fun drawn(type: String, id: RecordID) = checked { lives(type); view(replicaState, scope, RecordKey(type, id), ViewMode.drawn) }
        override fun stored(type: String, id: RecordID) = checked { lives(type); view(replicaState, scope, RecordKey(type, id), ViewMode.stored) }
        override fun drawn(type: String) = list(type, ViewMode.drawn)
        override fun stored(type: String) = list(type, ViewMode.stored)
        override fun drawn(type: String, field: String, id: RecordID) = list(type, ViewMode.drawn, field, id)
        override fun stored(type: String, field: String, id: RecordID) = list(type, ViewMode.stored, field, id)
        fun list(type: String, mode: ViewMode, field: String? = null, id: RecordID? = null): List<Record> = checked {
            lives(type)
            if (field != null && registry.type(type)?.fields?.get(field)?.ref == null) throw CommitFailure.malformed("reference-field")
            keys(replicaState, scope, type, field, id).sorted().mapNotNull { view(replicaState, scope, it, mode) }
                .filter { it.isVisible && (field == null || it.values[field] == id?.json) }
        }
        override fun confirmed(type: String, id: RecordID): Record? = checked {
            lives(type)
            val row = store.row(replica, scope, RecordKey(type, id)) ?: return@checked null
            Record(type, id, row.lattice.life, row.lattice.born, row.lattice.fields.mapValues { it.value.value },
                row.texts.mapValues { TextValue(it.value.text, it.value.merged, false) }, row.serials, row.rc, row.ru,
                isVisible(registry.type(type), row.lattice, row.texts.mapValues { TextValueState(it.value.text, it.value.merged, false) }), false, false)
        }
        override fun device(key: String): Json? = checked { registry.product(scope)?.let { replicaState.device[it]?.get(key) } }
        override fun devices(prefix: String): Map<String, Json> = checked { registry.product(scope)?.let { replicaState.device[it]?.obj()?.filterKeys { key -> key.startsWith(prefix) } }.orEmpty() }
        override fun firstPullComplete() = checked { scope !in (selectedScopes ?: (subscriptionsOf(replicaState) + openedScopes)) || replicaState.cursors[scope.text]?.flag("booted") == true }
        override fun serverSchema(): Long? = checked { if (isAnonymous) null else replicaState.meta["serverSchema"]?.long() }
        override fun checkpoint(): ScopeCheckpoint = checked {
            val state = replicaState.cursors[scope.text]
            val cursor = state?.get("cursor")?.orNull()?.str()?.let { WireCursor.decode(it) }
            val epoch = replicaState.meta.member("serverEpoch").orNull()?.str()
            val clean = cursor?.epoch == epoch && state != null && !state.flag("behind") && state["digestStop"] == null && !state.flag("mismatchReset") && scope.text !in replicaState.staging
            ScopeCheckpoint(epoch, if (clean && cursor?.mode == "live") cursor.seq - if (cursor.key == null) 0 else 1 else null)
        }
        override fun commands() = checked { replicaState.entries().filter { it.scope == scope && it.intent.command != null }
            .map { QueuedCommand(it.gestureId, it.intent.command!!, isAnonymous && it.state in setOf("held", "ready") && it.intent.n == null) } }
        override fun opaqueID() = checked { this@Engine.opaqueID() }
        override fun mintID(type: String): RecordID = checked {
            lives(type)
            val mint = registry.type(type)?.mint ?: throw CommitFailure.malformed("not-minted")
            var id: RecordID
            do { id = RecordID(mint.id(::draw)) } while (id in minted || view(replicaState, scope, RecordKey(type, id), ViewMode.drawn) != null || replicaState.spent[scope.text]?.arr()?.any { it.recordKey == RecordKey(type, id) } == true)
            minted.add(id)
            id
        }
    }
    fun snapshot(): Json = lock.withLock {
        ensureOpen()
        device.json().with("replicas" to Json.Arr(device.replicas.sortedBy { it.id }.map { replica ->
            val scopes = store.scopes(replica.id).sorted().mapNotNull { scope ->
                store.rows(replica.id, scope).takeIf { it.isNotEmpty() }?.let { scope.text to Json.Arr(it.map(Row::json)) }
            }
            replica.json().with("confirmed" to scopes.takeIf { it.isNotEmpty() }?.let { Json.Obj(it) }, "staging" to replica.staging.takeIf { it.isNotEmpty() }?.let { staged -> Json.Obj(staged.map { (scope, stage) -> scope to stage.with("rows" to Json.Arr(store.stagingRows(replica.id, ScopeRef(scope)).map(Row::json))) }) })
        }))
    }
    fun materialized(scope: ScopeRef, mode: ViewMode): Json = lock.withLock {
        ensureOpen()
        val replica = device.current()
        val allKeys = store.rows(replica.id, scope).map { it.key }.toSet() + replica.entries().filter { it.scope == scope }.flatMap { it.deltas }.map { it.key }
        val records = allKeys.sorted().mapNotNull { key ->
            val record = view(replica, scope, key, mode) ?: return@mapNotNull null
            val lattice = latticeView(replica, scope, key, mode) ?: Lattice()
            Json.Obj(buildList {
                add("t" to Json.of(key.type)); add("id" to key.id.json); addAll(lattice.json.obj().toList())
                if (record.texts.isNotEmpty()) add("x" to Json.Obj(record.texts.map { it.key to Json.of(it.value.text) }))
                if (record.serials.isNotEmpty()) add("v" to Json.Obj(record.serials.toList()))
            }) to record.isVisible
        }
        Json.objectOf("records" to Json.Arr(records.map { it.first }), "visible" to Json.Arr(records.filter { it.second }.map { it.first.recordKey.json }))
    }
    fun sweepReleased(limit: Int = 128): Boolean = write(EngineOperation.storage) { store.sweepReleased(limit) }
    fun ended(): List<Json> = lock.withLock { ended.toList() }
    fun failNextCommit() = lock.withLock { (store as? MemoryStore ?: error("memory-store-required")).failNextCommit = true }
    fun crashAfterTransactions(count: Int) = lock.withLock { require(count > 0); crashCountdown = count }
    fun rowsRead(): Int = lock.withLock { (store as? MemoryStore ?: error("memory-store-required")).rowsRead }
    override fun close() = lock.withLock { if (!closed) {
        closed = true; changes.tryEmit(Invalidation(Long.MIN_VALUE, emptySet())); telemetry.close(); observation.close(); store.close()
    } }
    companion object {
        fun memory(registry: Registry, snapshot: Json? = null, clock: EngineClock = object : EngineClock { override fun now() = System.currentTimeMillis() },
            identities: IdentitySource = object : IdentitySource {
                private val random = SecureRandom()
                override fun opaqueID() = buildString { repeat(32) { append("0123456789abcdef"[random.nextInt(16)]) } }
                override fun draw(bound: Int) = random.nextInt(bound)
            }, actor: String = "r_" + identities.opaqueID().take(12), pushMaxBytes: Int = Constants.PUSH_MAX_BYTES, telemetry: EngineTelemetry = NoEngineTelemetry,
            rewriteDeviceValue: DeviceValueRewrite = { _, _, value, _, _, _ -> value },
            intentResultWrites: IntentResultDeviceWrites = { _, _, _, _, _ -> emptyList() },
            pendingDeviceWork: PendingDeviceWork = { _, _ -> emptyList() }): Engine {
            val device = snapshot ?: Json.objectOf("active" to Json.of("rp_" + buildString { repeat(32) { append("0123456789abcdef"[identities.draw(16)]) } }), "replicas" to Json.array())
            val initial = if (snapshot != null) device else device.with("replicas" to Json.array(freshReplica(device.member("active").str()).json()))
            return Engine(registry, MemoryStore(registry, initial), clock, identities, actor, pushMaxBytes, telemetry, rewriteDeviceValue, intentResultWrites, pendingDeviceWork)
        }
    }
}
