package works.windmill.sync.engine

import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.Change
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Delta
import works.windmill.sync.core.Lattice
import works.windmill.sync.core.RecordKey
import works.windmill.sync.api.Record
import kotlin.concurrent.withLock

fun Engine.pendingGesture(context: CommitContext, scope: ScopeRef, gestureId: String): Boolean = lock.withLock {
    ensureOpen()
    device.replicas.single { it.id == context.replica }.entries().any { it.scope == scope && it.gestureId == gestureId }
}

fun Engine.refusedDeltas(context: CommitContext, scope: ScopeRef, code: String): List<Pair<String, Delta>> = lock.withLock {
    ensureOpen()
    device.replicas.single { it.id == context.replica }.notices.filter { it["scope"] == scope.json && it["code"] == works.windmill.sync.core.Json.of(code) }
        .flatMap { notice -> notice.member("content").items("d").map { notice.member("id").str() to Delta(it) } }
}

fun Engine.confirmedRecords(context: CommitContext, scope: ScopeRef, type: String): List<Record> = lock.withLock {
    ensureOpen()
    store.rows(context.replica, scope).filter { it.key.type == type }.mapNotNull { context.confirmed(type, it.key.id) }
}

fun Engine.unsubmittedGestures(context: CommitContext, scope: ScopeRef, records: Set<RecordKey>): List<String> = lock.withLock {
    ensureOpen()
    val replica = device.replicas.single { it.id == context.replica }
    if (replica.state != "anon") throw CommitFailure.malformed("supersede-bound")
    replica.entries().groupBy { it.gestureId }.filterValues { entries -> entries.any { entry -> entry.scope == scope && entry.deltas.any { it.key in records } } }
        .map { (gesture, entries) ->
            if (entries.any { it.scope != scope || it.state !in setOf("ready", "held") || it.intent.n != null ||
                    it.deltas.isEmpty() || it.deltas.any { delta -> delta.key !in records &&
                        !(delta.lattice.life == null && delta.lattice.born != null && delta.lattice.fields.isEmpty() && delta.texts.isEmpty()) } }) throw CommitFailure.malformed("supersede-mixed")
            gesture
        }
}

fun Engine.reconcileConfirmedCommand(context: CommitContext, scope: ScopeRef, gestureId: String, command: String, record: RecordKey): Boolean = lock.withLock {
    ensureOpen()
    val replica = device.replicas.single { it.id == context.replica }
    val known = context.confirmed(record.type, record.id)?.takeIf { it.isVisible && it.born != null } ?: return@withLock false
    val entries = replica.entries().filter { it.gestureId == gestureId }
    if (entries.isEmpty()) return@withLock true
    if (entries.any { it.scope != scope || it.state !in setOf("ready", "held") || it.intent.n != null || it.intent.command?.name != command ||
            it.intent.deltas.any { delta -> delta.lattice.life != null || delta.lattice.born == null || delta.lattice.fields.isNotEmpty() || delta.texts.isNotEmpty() } ||
            it.predict.any { delta -> delta.key != RecordKey(known.type, known.id) } }) return@withLock false
    entries.forEach { replica.move(it, "silent-fold", ended) }
    true
}

private fun Engine.commitPrerequisiteGesture(replica: ReplicaState, scope: ScopeRef, gesture: Gesture, at: Long): CommitOutcome {
    val outcome = commitGesture(replica, scope, gesture, at)
    if (outcome !is CommitOutcome.Committed || gesture.command == null) return outcome
    // Born-only updates require an alive parent at admission without changing its registers.
    val prerequisites = gesture.changes.filter { it.operation is Change.Operation.Update && it.values.isEmpty() && it.texts.isEmpty() }
        .map { change ->
            val key = RecordKey(change.type, requireNotNull(change.id))
            val row = view(replica, scope, key, ViewMode.drawn)
            require(row?.life?.isAlive == true && row.born != null)
            Delta(key, Lattice(born = row.born))
        }.distinctBy { it.key }
    if (prerequisites.isNotEmpty()) {
        val entry = replica.outbox.single { it.id in outcome.receipt.localIds }
        val intent = entry.intent
        val added = prerequisites.filter { prerequisite -> intent.deltas.none { it.key == prerequisite.key } }
        if (added.isNotEmpty()) {
            entry.intent = intent.copy(deltas = intent.deltas + added)
            if (widestBytes(replica, entry.intent) > pushMaxBytes) throw CommitFailure.malformed("too-large")
        }
    }
    return outcome
}

fun <T> Engine.commitWithPrerequisites(scope: ScopeRef, body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T> = write { replica ->
    if (replica.state !in setOf("anon", "bound")) throw CommitFailure(CommitFailure.Kind.notWritable, replica.state)
    val reader = Reader(replica, scope, now(replica))
    val (gesture, value) = try { body(reader).also { reader.finish() } } finally { reader.end() }
    val outcome = gesture?.let {
        try { commitPrerequisiteGesture(replica, scope, it, reader.now) }
        catch (_: IllegalArgumentException) { throw CommitFailure.malformed("invalid-value") }
    }
    outcome to value
}
