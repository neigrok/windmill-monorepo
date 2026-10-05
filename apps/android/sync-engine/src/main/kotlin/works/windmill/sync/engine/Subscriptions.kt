package works.windmill.sync.engine

import kotlin.concurrent.withLock
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.*

internal fun Engine.subscriptionsOf(replica: ReplicaState, products: List<String> = listOf("gym")): Set<ScopeRef> {
    if (replica.state != "bound") return emptySet()
    val scopes = products.filter { it in registry.products }.map { ScopeRef.product(it) }.toMutableSet()
    val governing = registry.governingType
    if (governing != null) {
        val scope = registry.scopeOfType(governing.name, ScopeRef.product(products.firstOrNull() ?: "gym"))
        if (scope in scopes) {
            val ids = keys(replica, scope!!, governing.name).filter { key ->
                listOf(ViewMode.drawn, ViewMode.stored).any { view(replica, scope, key, it)?.life?.isAlive == true }
            }.mapNotNull { it.id.string }.sorted()
            ids.forEach { scopes.add(ScopeRef.tree(it)); scopes.add(ScopeRef.overlay(it)) }
        }
    }
    return scopes.filter { it.text !in replica.known }.toSet()
}
fun Engine.subscriptions(products: List<String> = listOf("gym")): Set<ScopeRef> = lock.withLock { ensureOpen(); subscriptionsOf(device.current(), products) + openedScopes.filter { it.text !in device.current().known } }
fun Engine.subscribe(scope: ScopeRef): String? = write(EngineOperation.subscription) { replica ->
    openedScopes = openedScopes + scope
    selectedScopes = selectedScopes?.plus(scope)
    if (replica.known[scope.text] == Json.of("gone")) "gone" else { replica.known.remove(scope.text); null }
}
fun Engine.unsubscribe(scope: ScopeRef) { write(EngineOperation.subscription) { replica ->
    openedScopes = openedScopes - scope
    selectedScopes = selectedScopes?.minus(scope)
    forgetScope(replica, scope); doubts.left(scope)
} }
internal fun Engine.forgetScope(replica: ReplicaState, scope: ScopeRef) {
    changedScopes.add(scope)
    store.forgetScope(replica.id, scope)
    replica.spent.remove(scope.text); replica.cursors.remove(scope.text); replica.staging.remove(scope.text)
    replica.entries().filter { it.scope == scope && it.state == "acked" }.forEach { replica.move(it, "resolve", ended) }
}
fun Engine.reconcile(scopes: Set<ScopeRef>) { write(EngineOperation.subscription) { replica ->
    selectedScopes = scopes.toSet()
    replica.cursors.keys.map(::ScopeRef).filter { it !in scopes }.forEach { forgetScope(replica, it); doubts.left(it) }
    replica.entries().filter { it.state == "acked" && it.scope !in scopes }.forEach { replica.move(it, "resolve", ended) }
} }

class Doubts {
    private data class State(var k: Int = 0, var doubt: Boolean = false, var due: Long? = null, var following: Boolean = false, var followedSince: Long? = null)
    private val scopes = mutableMapOf<ScopeRef, State>()
    private fun of(scope: ScopeRef) = scopes.getOrPut(scope, ::State)
    fun followed(scope: ScopeRef, now: Long) { of(scope).apply { following = true; if (!doubt && followedSince == null) followedSince = now } }
    private fun endStretch(state: State, now: Long) { if (state.followedSince?.let { now - it >= 30_000 } == true) state.k = 0; state.followedSince = null }
    fun unfollowed(scope: ScopeRef, now: Long) { of(scope).apply { endStretch(this, now); following = false } }
    private fun schedule(state: State, now: Long, draw: (Int) -> Int) { state.due = now + draw(minOf(30_000L, 1_000L shl minOf(state.k, 5)).toInt()); state.k++ }
    fun end(scope: ScopeRef, now: Long, draw: (Int) -> Int) { of(scope).apply { endStretch(this, now); if (!doubt) { doubt = true; schedule(this, now, draw) } } }
    fun due(now: Long): List<ScopeRef> = scopes.filter { (_, state) -> state.doubt && state.due?.let { it <= now } == true }.keys.sortedBy { it.text }
    fun pulling(scope: ScopeRef) { of(scope).due = null }
    fun repulled(scope: ScopeRef, now: Long, draw: (Int) -> Int) { of(scope).apply { if (doubt && due == null) schedule(this, now, draw) } }
    fun rows(scope: ScopeRef, now: Long) { of(scope).apply { if (doubt && following) followedSince = now; doubt = false; due = null } }
    fun mayFollow(scope: ScopeRef) = !of(scope).doubt
    fun left(scope: ScopeRef) { scopes.remove(scope) }
    fun clear() { scopes.clear() }
}
