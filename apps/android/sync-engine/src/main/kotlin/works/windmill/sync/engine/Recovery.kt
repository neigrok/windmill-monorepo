package works.windmill.sync.engine

import works.windmill.sync.core.*

private fun Entry.queued() = state == "held" || state == "ready"
private fun ReplicaState.laterUnacked(entry: Entry) = entries().filter { it.order > entry.order && (it.queued() || it.state == "sent") }

// One delta of an entry where it is held: in the intent, the legacy prediction, or an opted command's projection `group`.
private data class DeltaSlot(val entry: Entry, val prediction: Boolean, val index: Int, val group: Int? = null) {
    val scope: ScopeRef get() = group?.let { entry.predictions!![it].scope } ?: entry.scope
    var delta: Json
        get() = if (group != null) entry.predictions!![group].deltas[index].json else if (prediction) entry.json.items("predict")[index] else entry.json.member("intent").items("d")[index]
        set(value) {
            if (group != null) {
                entry.predictions = entry.predictions!!.mapIndexed { at, projection ->
                    if (at != group) projection else projection.copy(deltas = projection.deltas.toMutableList().apply { this[index] = Delta(value) })
                }
            } else if (prediction) {
                val values = entry.json.items("predict").toMutableList().apply { this[index] = value }
                entry.json = entry.json.with("predict" to Json.Arr(values))
            } else {
                val intent = entry.json.member("intent")
                val values = intent.items("d").toMutableList().apply { this[index] = value }
                entry.json = entry.json.with("intent" to intent.with("d" to Json.Arr(values)))
            }
        }
}

private fun Entry.slots(predictions: Boolean = true): List<DeltaSlot> =
    json.member("intent").items("d").indices.map { DeltaSlot(this, false, it) } + if (!predictions) emptyList() else
        this.predictions?.flatMapIndexed { group, projection -> projection.deltas.indices.map { DeltaSlot(this, true, it, group) } }
            ?: json.items("predict").indices.map { DeltaSlot(this, true, it) }

private data class NamedRegister(val slot: DeltaSlot, val name: String)

private fun ownRegisters(entry: Entry): List<NamedRegister> = entry.slots(false).flatMap { slot ->
    val delta = slot.delta
    buildList {
        if (delta["life"]?.arr()?.get(1)?.str()?.let(::Stamp)?.let { it >= entry.stamp } == true) add(NamedRegister(slot, "life"))
        for ((name, register) in delta.fields("f")) if (Stamp(register.arr()[1].str()) >= entry.stamp) add(NamedRegister(slot, name))
    }
}

// Borns, carried lives and guards follow their source in later unacked entries of the same scope, sent ones included. An opted command's
// registers, and every move a receipt makes, reach queued entries only: a sent entry is the server's to answer.
private fun moveRegister(replica: ReplicaState, named: NamedRegister, stamp: Stamp, queuedOnly: Boolean = false) {
    val slot = named.slot
    var delta = slot.delta
    val current = if (named.name == "life") delta["life"] else delta["f"]?.get(named.name)
    if (current == null || current.arr()[1] == stamp.json) return
    val old = Stamp(current.arr()[1].str())
    val creates = named.name == "life" && current.arr()[0] == Json.of("alive") && delta["born"] == old.json
    val moved = Json.array(current.arr()[0], stamp.json)
    delta = if (named.name == "life") delta.with("life" to moved, "born" to if (creates) stamp.json else delta["born"])
        else delta.with("f" to delta.member("f").with(named.name to moved))
    slot.delta = delta
    followRegister(replica, slot.entry, slot.scope, delta.recordKey, named.name, old, stamp, creates, queuedOnly || slot.entry.predictions != null)
}

// What follows a record's register from `old` to `stamp` in the entries after `source`, in `scope`: the borns of a record it creates and
// the lives that carry it, or the guards on a field.
private fun followRegister(replica: ReplicaState, source: Entry, scope: ScopeRef, key: RecordKey, register: String, old: Stamp, stamp: Stamp,
    createsRecord: Boolean = false, queuedOnly: Boolean = false) {
    for (later in replica.laterUnacked(source).filter { !queuedOnly || it.queued() }) {
        if (register == "life") for (other in later.slots().filter { it.scope == scope && it.delta.recordKey == key }) {
            var following = other.delta
            if (createsRecord && following["born"] == old.json) following = following.with("born" to stamp.json)
            following["life"]?.arr()?.let { life -> if (life[1] == old.json) following = following.with("life" to Json.array(life[0], stamp.json)) }
            if (following != other.delta) other.delta = following
        } else if (later.scope == scope) {
            val intent = later.json.member("intent")
            val guards = intent.items("guard")
            val followed = guards.map { if (it.recordKey == key && it.member("field").str() == register && it["stamp"] == old.json) it.with("stamp" to stamp.json) else it }
            if (followed != guards) later.json = later.json.with("intent" to intent.with("guard" to Json.Arr(followed)))
        }
    }
}

private data class WrittenLife(val scope: ScopeRef, val key: RecordKey, val stamp: Stamp)
private data class Carried(val slot: DeltaSlot, val born: Boolean)

// The borns and carried lives of queued entries above admittedHigh that no unacked entry wrote, by a delta or a prediction in that scope.
private fun unsourced(replica: ReplicaState): List<Carried> {
    val admitted = Stamp(replica.meta.member("admittedHigh").str())
    val written = mutableSetOf<WrittenLife>()
    for (entry in replica.entries().filter { it.queued() || it.state == "sent" }) {
        for (named in ownRegisters(entry).filter { it.name == "life" }) {
            val delta = named.slot.delta
            written.add(WrittenLife(entry.scope, delta.recordKey, Stamp(delta.member("life").arr()[1].str())))
        }
        for ((scope, deltas) in entry.predicted) for (delta in deltas) delta.lattice.life?.let { written.add(WrittenLife(scope, delta.key, it.stamp)) }
    }
    return buildList {
        for (entry in replica.entries().filter { it.queued() }) for (slot in entry.slots(false)) {
            val delta = slot.delta
            val life = delta["life"]?.let(::Life)
            val born = delta["born"]?.str()?.let(::Stamp)
            val creates = life?.isAlive == true && life.stamp == born
            if (born != null && !creates && born > admitted && WrittenLife(entry.scope, delta.recordKey, born) !in written) add(Carried(slot, true))
            if (life != null && life.stamp < entry.stamp && life.stamp > admitted && WrittenLife(entry.scope, delta.recordKey, life.stamp) !in written) add(Carried(slot, false))
        }
    }
}

private fun Engine.recoverSkew(replica: ReplicaState, refused: Entry, lastN: Long) {
    val physical = now(replica)
    val admitted = Stamp(replica.meta.member("admittedHigh").str())
    val clock = Hlc.pairMaximum(Hlc(maxOf(physical, 0), 0), Hlc(admitted.ms, admitted.counter))
    val floor = clock.reading(actor)
    replica.meta = replica.meta.with("hlc" to clock.json)
    for (entry in replica.entries()) if (entry !== refused && entry.state == "sent" && entry.json.member("n").long() > lastN)
        replica.move(entry, "skew-return", ended)
    replica.meta = replica.meta.with("nextN" to Json.of(lastN + 1))
    replica.move(refused, "recover", ended)
    val plan = replica.entries().filter { it.queued() }.map { it to ownRegisters(it) }
    val lowered = unsourced(replica)
    var high = admitted
    for ((entry, own) in plan) {
        val stamp = clock.tick(physical, actor)
        own.forEach { moveRegister(replica, it, stamp) }
        entry.json = entry.json.with("stamp" to stamp.json)
        high = maxOf(high, stamp)
    }
    for (carried in lowered) {
        val delta = carried.slot.delta
        carried.slot.delta = if (carried.born) delta.with("born" to minOf(Stamp(delta.member("born").str()), floor).json)
            else delta.with("life" to Life(delta.member("life").arr()[0].str(), minOf(Stamp(delta.member("life").arr()[1].str()), floor)).json)
    }
    replica.meta = replica.meta.with("hlc" to Hlc(high.ms, high.counter).json, "hlcHigh" to high.json)
}

private fun recoverBase(replica: ReplicaState, refused: Entry, ended: MutableList<Json>) {
    for (slot in refused.slots(false)) {
        val delta = slot.delta
        val texts = delta.fields("x")
        if (texts.isEmpty()) continue
        slot.delta = delta.with("x" to Json.Obj(texts.map { (name, write) ->
            val key = Json.array(delta.member("t"), delta.member("id"), Json.of(name)).jcs
            val from = refused.json.member("baseTexts")[key] ?: throw TransitionError()
            name to write.with("base" to Json.objectOf("text" to from))
        }))
    }
    replica.move(refused, "recover", ended)
}

// An entry's content as its notice keeps it: a snapshot no later recovery changes, an opted command's projections whole.
private fun contentOf(entry: Entry): Json = Json.Obj(buildList {
    val intent = entry.json.member("intent")
    if (intent.items("d").isNotEmpty()) add("d" to intent.member("d"))
    intent["cmd"]?.let { add("cmd" to it) }
    entry.predictions?.let { add("predictions" to Json.Arr(it.map(Projection::json))) }
})

// §7.7 step 3: a refused source's dependents fold into `origin`'s notice. Once a scoped command is on either side, each folded part names
// the scope it came from, so the notice keeps every scope's content.
private fun Engine.foldDependents(replica: ReplicaState, source: Entry, origin: String): List<Json> {
    val dependents = Dependents(registry)
    dependents.absorb(source)
    return buildList {
        for (entry in replica.entries().filter { it.order > source.order }) {
            val part = dependents.of(entry)
            if (!part.any) continue
            val scoped = source.predictions != null || entry.predictions != null
            fun placed(content: Json) = if (scoped) content.with("scope" to entry.scope.json) else content
            if (entry.state == "sent") {
                add(placed(contentOf(entry))); entry.json = entry.json.with("orphanOf" to Json.of(origin)); continue
            }
            if (!entry.queued()) continue
            dependents.absorb(entry, part)
            val original = entry.intent
            add(placed(removeDependent(entry, part)))
            if (part.commandGone || entry.intent.deltas.isEmpty() && entry.intent.command == null)
                applyIntentResultDeviceWrites(replica, original, entry.gestureId,
                    PushResult(original.n ?: 0, PushResult.Verdict.Refused(RefusalCode.parentDead)),
                    replica.meta["serverEpoch"]?.orNull()?.str() ?: "")
            if (entry.intent.deltas.isEmpty() && entry.intent.command == null) {
                entry.json = entry.json.with("orphanOf" to Json.of(origin))
                replica.move(entry, "fold", ended, origin)
            }
        }
    }
}

internal fun Engine.refuse(replica: ReplicaState, entry: Entry, event: String, code: String, detail: Json? = null) {
    applyIntentResultDeviceWrites(replica, entry.intent, entry.gestureId,
        PushResult(entry.intent.n ?: 0, PushResult.Verdict.Refused(RefusalCode(code))),
        replica.meta["serverEpoch"]?.orNull()?.str() ?: "")
    val orphan = entry.json["orphanOf"]?.str()
    replica.move(entry, event, ended, orphan)
    val folded = foldDependents(replica, entry, orphan ?: entry.id)
    if (orphan != null) {
        if (folded.isEmpty()) return
        val index = replica.notices.indexOfFirst { it.member("id").str() == "notice:$orphan" }
        if (index < 0) throw TransitionError()
        val notice = replica.notices[index]
        val content = notice.member("content")
        replica.notices[index] = notice.with("content" to content.with("dependents" to Json.Arr(content.items("dependents") + folded)), "dismissed" to null)
        return
    }
    var content = contentOf(entry)
    if (folded.isNotEmpty()) content = content.with("dependents" to Json.Arr(folded))
    replica.notices.add(Json.objectOf("id" to Json.of("notice:${entry.id}"), "scope" to entry.scope.json, "code" to Json.of(code),
        "content" to content, "at" to Json.of(now(replica) - replica.meta.member("serverOffsetMs").long())).with("detail" to detail))
}

internal fun Engine.onRefused(replica: ReplicaState, entry: Entry, result: Json, response: Json) {
    val code = result.member("code").str()
    if (entry.json["orphanOf"] != null) { refuse(replica, entry, "refuse", code, result["detail"]); return }
    when (code) {
        "clock-skew" -> recoverSkew(replica, entry, response.member("lastN").long())
        "base-unknown" -> recoverBase(replica, entry, ended)
        else -> refuse(replica, entry, "refuse", code, result["detail"])
    }
}

// A tree or overlay scope under the identity a write map gave its governing record: a fresh mapping of that record, or one that
// rebases `targets`, a replay's earlier mapping of it.
internal fun Registry.remappedScope(scope: ScopeRef, write: List<WriteMapEntry>, targets: List<Json> = emptyList()): ScopeRef {
    val governing = governingType ?: return scope
    val tree = scope.tree ?: return scope
    val mapping = write.firstOrNull { item -> item.key.type == governing.name && (item.from == RecordID(tree) ||
        targets.any { it["t"] == Json.of(item.key.type) && it["from"] == (item.from ?: item.key.id).json && it["id"] == Json.of(tree) }) } ?: return scope
    val id = mapping.key.id.string ?: return scope
    return if (scope.kind is ScopeRef.Kind.Tree) ScopeRef.tree(id) else ScopeRef.overlay(id)
}

// §7.7 write map and E-8: one entry renamed by one logical map, atomically. Every delta, guard, receipt row and argument is
// renamed by its compiled leaves, global mappings first and then scoped ones in the scopes the governor mappings leave; then
// its ScopeRefs follow the governors. `replayed` re-address a retained command (step 0): an argument naming its own source
// moves to the record that source now resolves to, even a proposed creation. `predictionOnly` renames an opted command's
// own projections.
private fun Registry.rewriteEntry(entry: Entry, map: RecordMap, predictionOnly: Boolean = false, replayed: List<Mapping> = emptyList()) {
    val scope = entry.scope
    val moves = mutableMapOf<RecordKey, RecordID>()
    if (!predictionOnly) for (mapping in replayed) {
        if (!isGlobal(mapping.type) && map.scope(mapping.scope!!) != map.scope(scope)) continue
        for (target in entry.json.items("writeTargets")) if (target["t"] == Json.of(mapping.type) && target["id"] == mapping.from.json)
            moves[RecordKey(mapping.type, RecordID(target.member("from")))] = mapping.id
    }
    val command = entry.json.member("intent")["cmd"]
    val named = if (predictionOnly || command == null) emptyList()
        else references.ofCommand(scope, command) + references.ofCommand(scope, command, Leaf.Role.creation)
    val before = entry.intent.deltas.map { it.key }
    for (slot in entry.slots().filter { !predictionOnly || it.prediction }) slot.delta = references.remapRecord(slot.scope, slot.delta, map)
    entry.acceptedEffects = entry.acceptedEffects.map { effect -> effect.copy(rows = effect.rows.map { EffectRow(references.remapRecord(effect.scope, it.json, map)) }) }
    if (!predictionOnly) {
        var intent = entry.json.member("intent")
        intent = intent.with("guard" to intent["guard"]?.let { guards -> Json.Arr(guards.arr().map { references.remapRecord(scope, it, map) }) },
            "cmd" to command?.let { references.remapCommand(scope, it, map, moves) })
        entry.json = entry.json.with("intent" to intent)
        fun renamed(type: String, id: Json): Json = RecordKey(type, RecordID(id)).let { key ->
            (if (isGlobal(type)) map.globalTarget(key) else map.scopedTarget(map.scope(scope), key))?.json ?: id
        }
        entry.json["writeTargets"]?.let { targets -> entry.json = entry.json.with("writeTargets" to Json.Arr(targets.arr().map { target ->
            val type = target.member("t").str(); val from = target.member("from")
            val moved = moves[RecordKey(type, RecordID(from))]
            val argued = moved != null && named.any { it.key == RecordKey(type, RecordID(from)) }
            target.with("from" to if (argued) moved!!.json else renamed(type, from), "id" to renamed(type, target.member("id")))
        })) }
        val keys = before.zip(entry.intent.deltas.map { it.key }).toMap()
        entry.json.fields("baseTexts").takeIf { it.isNotEmpty() }?.let { bases -> entry.json = entry.json.with("baseTexts" to Json.Obj(bases.map { (text, value) ->
            val parts = Json.parse(text).arr()
            val key = keys[RecordKey(parts[0].str(), RecordID(parts[1]))] ?: RecordKey(parts[0].str(), RecordID(parts[1]))
            Json.array(Json.of(key.type), key.id.json, parts[2]).jcs to value
        }.distinctBy { it.first })) }
    }
    if (!map.movesScopes) return
    if (!predictionOnly) {
        val moved = map.scope(scope)
        entry.json = entry.json.with("scope" to moved.json, "intent" to entry.json.member("intent").with("scope" to moved.json))
    }
    entry.predictions = entry.predictions?.map { it.copy(scope = map.scope(it.scope)) }
    entry.acceptedEffects = entry.acceptedEffects.map { it.copy(scope = map.scope(it.scope)) }
    entry.mergePredictions()
}

// A retained command's targets, rebuilt after an epoch change: each predicted record its one proposed creation of that type
// names, or else its one argument of that type.
internal fun Engine.recoverWriteTargets(command: Entry) {
    val intent = command.json.member("intent")["cmd"] ?: return
    if (command.json["writeTargets"] != null) return
    val proposed = registry.references.ofCommand(command.scope, intent, Leaf.Role.creation)
    val named = registry.references.ofCommand(command.scope, intent)
    val targets = command.predict.groupBy { it.key.type }.mapNotNull { (type, predictions) ->
        val sources = proposed.filter { it.key.type == type }.ifEmpty { named.filter { it.key.type == type } }
        val prediction = predictions.singleOrNull()?.takeIf { sources.size == 1 } ?: return@mapNotNull null
        Json.objectOf("t" to Json.of(type), "from" to sources.single().key.id.json, "id" to prediction.key.id.json).with("born" to prediction.lattice.born?.json)
    }
    command.json = command.json.with("writeTargets" to Json.Arr(targets))
}

private fun Engine.rewriteDeviceValues(replica: ReplicaState, command: Entry, mappings: List<Mapping>) {
    val product = registry.product(command.scope) ?: return
    for (mapping in mappings.filter { it.from != it.id }) {
        val rows = replica.device[product] ?: return
        replica.device[product] = Json.Obj(rows.obj().map { (key, value) -> key to rewriteDeviceValue(product, key, value, mapping.type, mapping.from, mapping.id) })
    }
}

// One write map item and the retained target of its source, if a replay already mapped it.
private data class WriteItem(val map: WriteMapEntry, val source: Json, val at: Int, val previous: Json?) {
    val previousId: RecordID? get() = previous?.member("id")?.let(::RecordID)
}
private fun writeItems(command: Entry, write: List<Json>): List<WriteItem> {
    val targets = command.json.items("writeTargets")
    return write.map(::WriteMapEntry).map { map ->
        val source = (map.from ?: map.key.id).json
        val at = targets.indexOfFirst { it["t"] == Json.of(map.key.type) && it["from"] == source }
        WriteItem(map, source, at, targets.getOrNull(at))
    }
}
private fun Entry.retarget(items: List<WriteItem>) {
    val targets = json.items("writeTargets").toMutableList()
    for (item in items) {
        val target = Json.objectOf("t" to Json.of(item.map.key.type), "from" to item.source, "id" to item.map.key.id.json)
            .with("born" to (item.map.born?.json ?: item.previous?.get("born")))
        if (item.at < 0) targets.add(target) else targets[item.at] = target
    }
    json = json.with("writeTargets" to Json.Arr(targets))
}

// §7.7 write map: an ok result's map applies in the result's transaction. Its target-merged refusals are read first, from the
// queue as it stood; then the map renames every queued entry at once; then each mapped record's born, predicted registers and
// retained target follow. An opted command's restamps come from its receipt instead.
internal fun Engine.applyWriteMap(replica: ReplicaState, command: Entry, write: List<Json>) {
    if (command.predictions != null) { applyScopedWriteMap(replica, command, write); return }
    val retained = command.json["writeTargets"] != null
    val items = writeItems(command, write)
    for (item in items) {
        if (item.previous != null || !retained || item.map.born == null) continue
        val predicted = command.predict.filter { it.key.type == item.map.key.type }
        for (entry in replica.laterUnacked(command).filter { it.queued() }) {
            if (entry !in replica.outbox) continue
            val unmapped = entry.intent.deltas.any { delta -> delta.key.type == item.map.key.type && delta.removes &&
                delta.key.id.json != item.source && delta.key.id != item.map.key.id && (predicted.isEmpty() || predicted.any { it.key == delta.key }) }
            if (unmapped) refuse(replica, entry, "target-merged", "target-merged")
        }
    }
    for (item in items) {
        val from = item.map.from ?: continue
        if (item.previous != null) continue
        for (entry in replica.entries().filter { it.queued() }) {
            if (entry !in replica.outbox) continue
            if (entry.intent.deltas.any { it.key == RecordKey(item.map.key.type, from) && it.removes }) refuse(replica, entry, "target-merged", "target-merged")
        }
    }
    val joins = items.filter { it.previous == null && it.map.from != null }.map { Mapping(it.map.key.type, it.map.from!!, it.map.key.id, command.scope) }
    val replayed = items.filter { it.previous != null }.map { Mapping(it.map.key.type, it.previousId!!, it.map.key.id, command.scope) }
    val later = replica.laterUnacked(command).toSet()
    for (entry in replica.entries().filter { it.queued() }) {
        val mappings = if (entry in later) joins + replayed else joins
        if (mappings.isNotEmpty()) registry.rewriteEntry(entry, RecordMap(registry, mappings), replayed = if (entry in later) replayed else emptyList())
    }
    val own = joins + replayed.filter { it.from != it.id }
    val ownMap = RecordMap(registry, own)
    for (slot in command.slots().filter { it.prediction }) slot.delta = registry.references.remapRecord(command.scope, slot.delta, ownMap)
    rewriteDeviceValues(replica, command, own)
    for (item in items) {
        val born = item.previous?.get("born"); val nextBorn = item.map.born?.json
        if (born != null && nextBorn != null && born != nextBorn) for (entry in replica.laterUnacked(command)) for (slot in entry.slots()) {
            var delta = slot.delta
            if (slot.scope != command.scope || delta.recordKey != item.map.key) continue
            if (delta["born"] == born) delta = delta.with("born" to nextBorn)
            delta["life"]?.arr()?.let { life -> if (life[1] == born) delta = delta.with("life" to Json.array(life[0], nextBorn)) }
            slot.delta = delta
        }
        for (slot in command.slots().filter { it.prediction && it.delta.recordKey == item.map.key }) {
            for ((name, stamp) in item.map.fields) moveRegister(replica, NamedRegister(slot, name), stamp)
            item.map.born?.let { moveRegister(replica, NamedRegister(slot, "life"), it) }
        }
    }
    command.retarget(items)
    val maps = items.map { it.map }
    val mapped = maps.flatMap { it.stamps }
    observe(replica, mapped)
    raiseAdmittedHigh(replica, mapped)
    val physical = now(replica)
    val clock = Hlc(replica.meta.member("hlc"))
    for (entry in replica.entries().filter { it.queued() }) {
        val named = entry.slots().filter { it.scope == command.scope }.flatMap { slot -> maps.filter { it.key == slot.delta.recordKey }.flatMap { map ->
            map.fields.keys.filter { it in slot.delta.fields("f") }.map { NamedRegister(slot, it) } +
                if (map.born != null && slot.delta["life"] != null) listOf(NamedRegister(slot, "life")) else emptyList()
        } }
        if (named.isEmpty()) continue
        val stamp = clock.tick(physical, actor)
        named.forEach { moveRegister(replica, it, stamp) }
        replica.meta = replica.meta.with("hlcHigh" to maxOf(Stamp(replica.meta.member("hlcHigh").str()), stamp).json)
    }
    replica.meta = replica.meta.with("hlc" to clock.json)
}

// An opted command's write map moves identities only, through the same renaming. Its versions arrive with its receipt.
private fun Engine.applyScopedWriteMap(replica: ReplicaState, command: Entry, write: List<Json>) {
    val retained = command.json["writeTargets"] != null
    val items = writeItems(command, write)
    for (item in items) {
        val from = item.previousId ?: RecordID(item.source)
        for (entry in replica.laterUnacked(command).filter { it.queued() }) {
            if (entry !in replica.outbox) continue
            val deletes = entry.scope == command.scope && entry.intent.deltas.any { delta -> delta.key.type == item.map.key.type && delta.removes &&
                (item.previous == null && item.map.from != null && delta.key.id == from ||
                    retained && item.previous == null && item.map.born != null && delta.key.id.json != item.source && delta.key.id != item.map.key.id) }
            if (deletes) refuse(replica, entry, "target-merged", "target-merged")
        }
    }
    val moved = items.mapNotNull { item -> Mapping(item.map.key.type, item.previousId ?: RecordID(item.source), item.map.key.id, command.scope).takeIf { it.from != it.id }?.let { item to it } }
    val mappings = moved.map { it.second }
    if (mappings.isNotEmpty()) {
        val map = RecordMap(registry, mappings)
        val replayed = moved.filter { it.first.previous != null }.map { it.second }
        for (entry in replica.laterUnacked(command).filter { it.queued() }) registry.rewriteEntry(entry, map, replayed = replayed)
        registry.rewriteEntry(command, map, predictionOnly = true)
        rewriteDeviceValues(replica, command, mappings)
    }
    for (item in items) {
        val oldBorn = item.previous?.get("born"); val newBorn = item.map.born?.json
        if (oldBorn == null || newBorn == null || oldBorn == newBorn) continue
        for (entry in replica.laterUnacked(command).filter { it.queued() }) for (slot in entry.slots()) {
            if (slot.scope != command.scope || slot.delta.recordKey != item.map.key) continue
            var delta = slot.delta
            if (delta["born"] == oldBorn) delta = delta.with("born" to newBorn)
            delta["life"]?.arr()?.let { if (it[1] == oldBorn) delta = delta.with("life" to Json.array(it[0], newBorn)) }
            slot.delta = delta
        }
    }
    command.retarget(items)
}

// The ACK transaction's receipt-application point, before any projection settles or the entry resolves: the receipt is kept, each scope's
// projection takes its accepted seq (a receipt-only scope its own empty marker, an uncreated one covered now), and the accepted versions apply.
internal fun Engine.applyReceipt(replica: ReplicaState, command: Entry, effects: List<EffectReceipt>, write: List<Json>) {
    val previous = command.acceptedEffects
    command.acceptedEffects = effects
    val projections = command.predictions!!.toMutableList()
    for (effect in effects) {
        val at = projections.indexOfFirst { it.scope == effect.scope }
        val projection = projections.getOrNull(at) ?: Projection(effect.scope, emptyList())
        val accepted = if (effect.seq == null) projection.copy(covered = true) else projection.copy(resultSeq = effect.seq)
        if (at < 0) projections.add(accepted) else projections[at] = accepted
    }
    command.predictions = projections
    command.mergePredictions()
    val written = write.map(::WriteMapEntry)
    val accepted = effects.map { effect ->
        if (effect.scope != command.scope) return@map effect
        val rows = effect.rows.toMutableList()
        for (map in written) {
            val at = rows.indexOfFirst { it.key == map.key }
            val row = rows.getOrNull(at) ?: EffectRow(map.key, null, 0, emptyList())
            val versions = buildList {
                map.born?.let { add(EffectSlot(EffectSlot.Kind.born, null, EffectSlot.Version.Stamped(it))); add(EffectSlot(EffectSlot.Kind.life, null, EffectSlot.Version.Stamped(it))) }
                for ((name, stamp) in map.fields) add(EffectSlot(EffectSlot.Kind.field, name, EffectSlot.Version.Stamped(stamp)))
            }
            val next = row.copy(slots = row.slots + versions.filter { row.slot(it.kind, it.name) == null })
            if (at < 0) rows.add(next) else rows[at] = next
        }
        effect.copy(rows = rows)
    }
    applyAcceptedVersions(replica, command, accepted, previous)
}

// Accepted versions replace what the command predicted and what later queued work carried from it, scope by scope. A replay whose versions
// differ from the ones a previous receipt gave rebases later work from those; later work that wrote an accepted register again takes a new stamp.
private fun Engine.applyAcceptedVersions(replica: ReplicaState, command: Entry, effects: List<EffectReceipt>, previous: List<EffectReceipt>) {
    val stamps = effects.flatMap { effect -> effect.rows.flatMap { row -> row.slots.mapNotNull { it.stamp } } }
    observe(replica, stamps); raiseAdmittedHigh(replica, stamps)
    val later = replica.entries().filter { it.order > command.order && it.queued() }
    val own = later.associateWith { entry -> entry.slots().flatMap { slot ->
        val row = effects.firstOrNull { it.scope == slot.scope }?.row(slot.delta.recordKey)
        row?.slots.orEmpty().mapNotNull { it.register }.filter { register ->
            val value = if (register == "life") slot.delta["life"] else slot.delta["f"]?.get(register)
            value != null && Stamp(value.arr()[1].str()) >= entry.stamp
        }.map { NamedRegister(slot, it) }
    } }
    for (effect in effects) for (row in effect.rows) {
        val ordinary = if (effect.scope == command.scope) command.intent.deltas.filter { it.key == row.key } else emptyList()
        val predicted = command.slots().filter { it.prediction && it.scope == effect.scope && it.delta.recordKey == row.key }
        val prior = previous.firstOrNull { it.scope == effect.scope }?.row(row.key)
        for (slot in row.slots) {
            val stamp = slot.stamp ?: continue
            val register = if (slot.kind == EffectSlot.Kind.field) slot.name!! else "life"
            fun follow(old: Stamp?) {
                if (old != null && old != stamp) followRegister(replica, command, effect.scope, row.key, register, old, stamp, slot.kind == EffectSlot.Kind.born, queuedOnly = true)
            }
            follow(prior?.slot(slot.kind, slot.name)?.stamp)
            for (delta in ordinary) follow(when (slot.kind) {
                EffectSlot.Kind.born -> delta.lattice.born
                EffectSlot.Kind.life -> delta.lattice.life?.stamp
                else -> delta.lattice.fields[register]?.stamp
            })
            for (delta in predicted) {
                if (slot.kind != EffectSlot.Kind.born) { moveRegister(replica, NamedRegister(delta, register), stamp, queuedOnly = true); continue }
                val old = delta.delta["born"]?.str()?.let(::Stamp) ?: continue
                var updated = delta.delta.with("born" to stamp.json)
                updated["life"]?.arr()?.let { if (it[0] == Json.of("alive") && it[1] == old.json) updated = updated.with("life" to Json.array(it[0], stamp.json)) }
                delta.delta = updated
                follow(old)
            }
        }
    }
    val clock = Hlc(replica.meta.member("hlc")); val physical = now(replica)
    for (entry in later) {
        val named = own.getValue(entry)
        if (named.isEmpty()) continue
        val stamp = clock.tick(physical, actor)
        named.forEach { moveRegister(replica, it, stamp, queuedOnly = true) }
        replica.meta = replica.meta.with("hlcHigh" to maxOf(Stamp(replica.meta.member("hlcHigh").str()), stamp).json)
    }
    replica.meta = replica.meta.with("hlc" to clock.json)
}
