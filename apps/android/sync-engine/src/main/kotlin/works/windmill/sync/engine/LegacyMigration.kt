package works.windmill.sync.engine

import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.core.ScopeRef

fun <T> Engine.migrateLegacy(account: String?, scope: ScopeRef, activate: Boolean = false,
    body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T> = write(EngineOperation.storage) {
    val target = device.replicas.firstOrNull { replica ->
        if (account == null) replica.state == "anon" else replica.account == account
    } ?: freshReplica(identities.replicaID(), account).also { replica ->
        if (account != null && !activate) replica.meta = replica.meta.with("state" to works.windmill.sync.core.Json.of("dormant"))
        device.replicas.add(replica)
    }
    if (activate) {
        if (target.state == "dormant") target.meta = target.meta.with("state" to works.windmill.sync.core.Json.of("bound"))
        activate(device.active, target)
    }
    val reader = Reader(target, scope, now(target))
    val (gesture, value) = try { body(reader).also { reader.finish() } } finally { reader.end() }
    val outcome = gesture?.let {
        try { commitGesture(target, scope, it, now(target)) }
        catch (_: IllegalArgumentException) { throw CommitFailure.malformed("invalid-value") }
    }
    outcome to value
}
