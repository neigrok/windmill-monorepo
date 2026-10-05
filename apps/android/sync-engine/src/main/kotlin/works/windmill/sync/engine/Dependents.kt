package works.windmill.sync.engine

import works.windmill.sync.core.*

internal data class DependentPart(val removed: List<Delta>, val commandGone: Boolean, val whole: Boolean) {
    val any get() = removed.isNotEmpty() || commandGone
}
internal class Dependents(private val registry: Registry) {
    private val created = mutableSetOf<Pair<ScopeRef, RecordKey>>()
    private val governed = mutableSetOf<ScopeRef>()
    private val lives = mutableSetOf<Triple<ScopeRef, RecordKey, Life>>()
    fun absorb(scope: ScopeRef, deltas: List<Delta>, stamp: Stamp) {
        for (delta in deltas) {
            delta.lattice.life?.let { if (it.stamp >= stamp) lives.add(Triple(scope, delta.key, it)) }
            if (!delta.creates) continue
            created.add(scope to delta.key)
            if (registry.type(delta.key.type)?.json?.get("governs")?.str() == "tree") {
                val id = delta.key.id.string ?: throw IllegalStateException("governing-id")
                governed.add(ScopeRef.tree(id)); governed.add(ScopeRef.overlay(id))
            }
        }
    }
    private fun names(scope: ScopeRef, key: RecordKey) = registry.scopeOfType(key.type, scope)?.let { (it to key) in created } ?: false
    fun of(entry: Entry): DependentPart {
        val intent = entry.intent
        val removed = intent.deltas.filter { delta -> entry.scope in governed || (entry.scope to delta.key) in created ||
            delta.lattice.life?.let { Triple(entry.scope, delta.key, it) in lives } == true ||
            registry.type(delta.key.type)?.references(delta.key.id, delta.lattice.fields.mapValues { it.value.value })?.any { names(entry.scope, it) } == true }
        val command = intent.command
        val commandGone = command != null && (entry.scope in governed || registry.command(command.name)?.args?.values?.any { arg ->
            val ref = arg.ref
            ref != null && command.args[arg.name] is Json.Str && names(entry.scope, RecordKey(ref, RecordID(command.args.member(arg.name))))
        } == true || entry.predict.any { delta -> delta.lattice.life?.let { Triple(entry.scope, delta.key, it) in lives } == true })
        return DependentPart(removed, commandGone, removed.size == intent.deltas.size && (command == null || commandGone))
    }
    fun absorb(entry: Entry, part: DependentPart) = absorb(entry.scope, part.removed + if (part.commandGone) entry.predict else emptyList(), entry.stamp)
}
internal fun removeDependent(entry: Entry, part: DependentPart): Json {
    val intent = entry.intent
    val removed = part.removed.map { it.key }.toSet()
    entry.intent = intent.copy(deltas = intent.deltas.filter { it !in part.removed }, guards = intent.guards.filter { it.key !in removed },
        command = if (part.commandGone) null else intent.command)
    if (part.commandGone) entry.predict = emptyList()
    return Json.Obj(buildList {
        if (part.removed.isNotEmpty()) add("d" to Json.Arr(part.removed.map { it.json }))
        if (part.commandGone) intent.command?.let { add("cmd" to it.json) }
    })
}
internal fun Engine.silentFold(replica: ReplicaState, sources: List<Entry>): List<Pair<Entry, DependentPart>> {
    val dependencies = Dependents(registry)
    return buildList {
        for (entry in replica.entries()) {
            if (entry in sources) { dependencies.absorb(entry.scope, entry.deltas, entry.stamp); continue }
            val part = dependencies.of(entry)
            if (!part.any) continue
            check(entry.state in setOf("held", "ready")) { "numbered-held-dependent" }
            dependencies.absorb(entry, part)
            add(entry to part)
        }
    }
}
internal fun Engine.applySilentFold(replica: ReplicaState, folded: List<Pair<Entry, DependentPart>>) {
    for ((entry, part) in folded) {
        removeDependent(entry, part)
        if (entry.intent.deltas.isEmpty() && entry.intent.command == null) replica.move(entry, "silent-fold", ended)
    }
}
