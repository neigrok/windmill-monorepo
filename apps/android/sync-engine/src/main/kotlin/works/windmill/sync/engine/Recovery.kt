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
    val old = current.arr()[1]
    val creates = named.name == "life" && current.arr()[0] == Json.of("alive") && delta["born"] == old
    val moved = Json.array(current.arr()[0], stamp.json)
    delta = if (named.name == "life") delta.with("life" to moved, "born" to if (creates) stamp.json else delta["born"])
        else delta.with("f" to delta.member("f").with(named.name to moved))
    slot.delta = delta
    val queued = queuedOnly || slot.entry.predictions != null
    for (later in replica.laterUnacked(slot.entry).filter { !queued || it.queued() }) {
        if (named.name == "life") {
            for (other in later.slots()) {
                var following = other.delta
                if (other.scope != slot.scope || following.recordKey != delta.recordKey) continue
                if (creates && following["born"] == old) following = following.with("born" to stamp.json)
                following["life"]?.arr()?.let { life ->
                    if (life[1] == old) following = following.with("life" to Json.array(life[0], stamp.json))
                }
                other.delta = following
            }
        } else {
            if (later.scope != slot.scope) continue
            val intent = later.json.member("intent")
            val guards = intent.items("guard")
            if (guards.isEmpty()) continue
            later.json = later.json.with("intent" to intent.with("guard" to Json.Arr(guards.map { guard ->
                if (guard.recordKey == delta.recordKey && guard.member("field").str() == named.name && guard["stamp"] == old)
                    guard.with("stamp" to stamp.json) else guard
            })))
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

private fun Registry.rewriteKey(key: RecordKey, map: WriteMapEntry): RecordKey {
    val from = map.from ?: return key
    if (key == RecordKey(map.key.type, from)) return map.key
    val definition = type(key.type)?.json?.get("key") ?: return key
    if (definition["ref"]?.str() == map.key.type && key.id == from) return RecordKey(key.type, map.key.id)
    val parts = definition["tuple"]?.arr() ?: return key
    val ids = key.id.parts ?: return key
    val joined = map.key.id.string ?: return key
    return RecordKey(key.type, RecordID(ids.mapIndexed { i, id -> if (parts[i].member("ref").str() == map.key.type && RecordID(id) == from) joined else id }))
}

private fun Registry.rewriteDelta(delta: Json, map: WriteMapEntry): Json {
    val key = rewriteKey(delta.recordKey, map)
    val definition = type(key.type)
    val fields = delta.fields("f").map { (name, register) ->
        name to if (definition?.fields?.get(name)?.ref == map.key.type && register.arr()[0] == map.from?.json)
            Json.array(map.key.id.json, register.arr()[1]) else register
    }
    return delta.with("id" to key.id.json, "f" to fields.takeIf { it.isNotEmpty() }?.let { Json.Obj(it) })
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

// A write map's identity in an entry. A type of global ids is rewritten everywhere, and a governing record's moves the scopes it governs;
// any other type only in `scope`, where the mapped record lives. `predictionOnly` rewrites an opted command's own projections.
private fun Registry.rewriteEntry(entry: Entry, map: WriteMapEntry, replay: Boolean = false, scope: ScopeRef = entry.scope, predictionOnly: Boolean = false) {
    val global = type(map.key.type)?.json?.get("idSpace") == Json.of("global")
    val origin = global || entry.scope == scope
    var intent = entry.json.member("intent")
    val command = intent["cmd"]
    val targets = entry.json["writeTargets"]
    if (!predictionOnly && origin && replay && command != null && targets != null) {
        var args = command.member("args")
        val definitions = this.command(command.member("name").str())?.args.orEmpty()
        val rebound = targets.arr().map { target ->
            if (target["t"] != Json.of(map.key.type) || target["id"] != map.from?.json) target else {
                val references = definitions.filter { (name, arg) -> arg.ref == map.key.type && args[name] == target["from"] }.keys
                for (name in references) args = args.with(name to map.key.id.json)
                if (references.isEmpty()) target else target.with("from" to map.key.id.json)
            }
        }
        entry.json = entry.json.with("writeTargets" to Json.Arr(rebound), "intent" to intent.with("cmd" to command.with("args" to args)))
    }
    for (slot in entry.slots().filter { (!predictionOnly || it.prediction) && (global || it.scope == scope) }) slot.delta = rewriteDelta(slot.delta, map)
    intent = entry.json.member("intent")
    if (!predictionOnly && origin) {
        val guards = intent.items("guard")
        if (guards.isNotEmpty()) intent = intent.with("guard" to Json.Arr(guards.map { it.with("id" to rewriteKey(it.recordKey, map).id.json) }))
        intent["cmd"]?.let { value ->
            var args = value.member("args")
            for ((name, arg) in this.command(value.member("name").str())?.args.orEmpty())
                if (arg.ref == map.key.type && args[name] == map.from?.json) args = args.with(name to map.key.id.json)
            intent = intent.with("cmd" to value.with("args" to args))
        }
        entry.json = entry.json.with("intent" to intent)
        entry.json["writeTargets"]?.let { values ->
            entry.json = entry.json.with("writeTargets" to Json.Arr(values.arr().map { target ->
                if (target["t"] != Json.of(map.key.type)) target else target.with(
                    "from" to if (target["from"] == map.from?.json) map.key.id.json else target["from"],
                    "id" to if (target["id"] == map.from?.json) map.key.id.json else target["id"])
            }))
        }
        val bases = entry.json.fields("baseTexts")
        if (bases.isNotEmpty()) {
            val rewritten = linkedMapOf<String, Json>()
            for ((text, value) in bases) {
                val parts = Json.parse(text).arr()
                val key = rewriteKey(RecordKey(parts[0].str(), RecordID(parts[1])), map)
                rewritten.putIfAbsent(Json.array(Json.of(key.type), key.id.json, parts[2]).jcs, value)
            }
            entry.json = entry.json.with("baseTexts" to Json.Obj(rewritten.toList()))
        }
    }
    entry.acceptedEffects = entry.acceptedEffects.map { effect ->
        if (!global && effect.scope != scope) effect else effect.copy(rows = effect.rows.map { it.copy(key = rewriteKey(it.key, map)) })
    }
    if (global && type(map.key.type)?.json?.get("governs") == Json.of("tree")) {
        if (!predictionOnly) {
            val moved = remappedScope(entry.scope, listOf(map))
            entry.json = entry.json.with("scope" to moved.json, "intent" to entry.json.member("intent").with("scope" to moved.json))
        }
        entry.predictions = entry.predictions?.map { it.copy(scope = remappedScope(it.scope, listOf(map))) }
        entry.acceptedEffects = entry.acceptedEffects.map { it.copy(scope = remappedScope(it.scope, listOf(map))) }
        entry.mergePredictions()
    }
}

internal fun Engine.recoverWriteTargets(command: Entry) {
    val intent = command.intent.command ?: return
    if (command.json["writeTargets"] != null) return
    val definition = registry.command(intent.name) ?: return
    val targets = mutableListOf<Json>()
    for ((type, predictions) in command.predict.groupBy { it.key.type }) {
        val references = definition.args.values.filter { it.ref == type && intent.args[it.name] != null }
        if (references.size == 1 && predictions.size == 1) {
            val prediction = predictions.single()
            targets.add(Json.objectOf("t" to Json.of(type), "from" to intent.args.member(references.single().name),
                "id" to prediction.key.id.json).with("born" to prediction.lattice.born?.json))
        }
    }
    command.json = command.json.with("writeTargets" to Json.Arr(targets))
}

private fun Engine.rewriteDeviceValues(replica: ReplicaState, command: Entry, type: String, from: RecordID, to: RecordID) {
    val product = registry.product(command.scope) ?: return
    val rows = replica.device[product] ?: return
    replica.device[product] = Json.Obj(rows.obj().map { (key, value) -> key to rewriteDeviceValue(product, key, value, type, from, to) })
}

// §7.7 write map: an ok result's map applies in the result's transaction. An opted command's restamps come from its receipt instead.
internal fun Engine.applyWriteMap(replica: ReplicaState, command: Entry, write: List<Json>) {
    if (command.predictions != null) { applyScopedWriteMap(replica, command, write); return }
    val maps = write.map(::WriteMapEntry)
    val retained = command.json["writeTargets"] != null
    val targets = command.json.items("writeTargets").toMutableList()
    for (map in maps) {
        val source = (map.from ?: map.key.id).json
        val at = targets.indexOfFirst { it["t"] == Json.of(map.key.type) && it["from"] == source }
        val prior = targets.getOrNull(at)
        if (prior != null) {
            val previous = RecordID(prior.member("id"))
            val replay = map.copy(from = previous)
            for (entry in replica.entries().filter { it.order > command.order && it.queued() }) registry.rewriteEntry(entry, replay, replay = true, scope = command.scope)
            if (previous != map.key.id) {
                for (slot in command.slots().filter { it.prediction }) slot.delta = registry.rewriteDelta(slot.delta, replay)
                rewriteDeviceValues(replica, command, map.key.type, previous, map.key.id)
            }
            val born = prior["born"]
            val nextBorn = map.born?.json
            if (born != null && nextBorn != null) {
                for (entry in replica.laterUnacked(command)) for (slot in entry.slots()) {
                    var delta = slot.delta
                    if (slot.scope != command.scope || delta.recordKey != map.key) continue
                    if (delta["born"] == born) delta = delta.with("born" to nextBorn)
                    delta["life"]?.arr()?.let { life ->
                        if (life[1] == born) delta = delta.with("life" to Json.array(life[0], nextBorn))
                    }
                    slot.delta = delta
                }
            }
        } else if (retained && map.born != null) {
            val predicted = command.predict.filter { it.key.type == map.key.type }
            for (entry in replica.entries().filter { it.order > command.order && it.queued() }) {
                if (entry !in replica.outbox) continue
                val unmapped = entry.intent.deltas.any { delta -> delta.key.type == map.key.type && delta.removes &&
                    delta.key.id.json != source && delta.key.id != map.key.id &&
                    (predicted.isEmpty() || predicted.any { it.key == delta.key }) }
                if (unmapped) refuse(replica, entry, "target-merged", "target-merged")
            }
        }
        val from = map.from
        if (prior == null && from != null) {
            for (entry in replica.entries().filter { it.queued() }) {
                if (entry !in replica.outbox) continue
                val deletes = entry.intent.deltas.any { it.key == RecordKey(map.key.type, from) && it.removes }
                if (deletes) { refuse(replica, entry, "target-merged", "target-merged"); continue }
                registry.rewriteEntry(entry, map, scope = command.scope)
            }
            for (slot in command.slots().filter { it.prediction }) slot.delta = registry.rewriteDelta(slot.delta, map)
            rewriteDeviceValues(replica, command, map.key.type, from, map.key.id)
        }
        for (slot in command.slots().filter { it.prediction && it.delta.recordKey == map.key }) {
            for ((name, stamp) in map.fields) moveRegister(replica, NamedRegister(slot, name), stamp)
            map.born?.let { moveRegister(replica, NamedRegister(slot, "life"), it) }
        }
        val target = Json.objectOf("t" to Json.of(map.key.type), "from" to source, "id" to map.key.id.json)
            .with("born" to (map.born?.json ?: prior?.get("born")))
        if (at < 0) targets.add(target) else targets[at] = target
    }
    command.json = command.json.with("writeTargets" to Json.Arr(targets))
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

// An opted command's write map moves identities only: global ones first, wherever they are held. Its versions arrive with its receipt.
private fun Engine.applyScopedWriteMap(replica: ReplicaState, command: Entry, write: List<Json>) {
    val retained = command.json["writeTargets"] != null
    val targets = command.json.items("writeTargets").toMutableList()
    for (map in write.map(::WriteMapEntry)) {
        val source = (map.from ?: map.key.id).json
        val at = targets.indexOfFirst { it["t"] == Json.of(map.key.type) && it["from"] == source }
        val previous = targets.getOrNull(at)
        val from = previous?.member("id")?.let(::RecordID) ?: RecordID(source)
        val mapping = map.copy(from = from)
        for (entry in replica.entries().filter { it.order > command.order && it.queued() }) {
            if (entry !in replica.outbox) continue
            val deletes = entry.scope == command.scope && entry.intent.deltas.any { delta -> delta.key.type == map.key.type && delta.removes &&
                (previous == null && map.from != null && delta.key.id == from || retained && previous == null && map.born != null && delta.key.id.json != source && delta.key.id != map.key.id) }
            if (deletes) { refuse(replica, entry, "target-merged", "target-merged"); continue }
            if (from != map.key.id) registry.rewriteEntry(entry, mapping, replay = previous != null, scope = command.scope)
        }
        if (from != map.key.id) {
            registry.rewriteEntry(command, mapping, scope = command.scope, predictionOnly = true)
            rewriteDeviceValues(replica, command, map.key.type, from, map.key.id)
        }
        val oldBorn = previous?.get("born"); val newBorn = map.born?.json
        if (oldBorn != null && newBorn != null && oldBorn != newBorn) {
            for (entry in replica.entries().filter { it.order > command.order && it.queued() }) for (slot in entry.slots()) {
                if (slot.scope != command.scope || slot.delta.recordKey != map.key) continue
                var delta = slot.delta
                if (delta["born"] == oldBorn) delta = delta.with("born" to newBorn)
                delta["life"]?.arr()?.let { if (it[1] == oldBorn) delta = delta.with("life" to Json.array(it[0], newBorn)) }
                slot.delta = delta
            }
        }
        val target = Json.objectOf("t" to Json.of(map.key.type), "from" to source, "id" to map.key.id.json).with("born" to (newBorn ?: oldBorn))
        if (at < 0) targets.add(target) else targets[at] = target
    }
    command.json = command.json.with("writeTargets" to Json.Arr(targets))
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
        val predicted = command.slots().filter { it.prediction && it.scope == effect.scope && it.delta.recordKey == row.key }
        for (slot in row.slots) {
            val stamp = slot.stamp ?: continue
            val prior = previous.firstOrNull { it.scope == effect.scope }?.row(row.key)?.slot(slot.kind, slot.name)?.stamp
            if (prior != null && prior != stamp) for (entry in later) {
                for (other in entry.slots().filter { it.scope == effect.scope && it.delta.recordKey == row.key }) {
                    var delta = other.delta
                    if (slot.kind == EffectSlot.Kind.born && delta["born"] == prior.json) delta = delta.with("born" to stamp.json)
                    if (slot.kind == EffectSlot.Kind.born || slot.kind == EffectSlot.Kind.life) delta["life"]?.arr()?.let {
                        if (it[1] == prior.json) delta = delta.with("life" to Json.array(it[0], stamp.json))
                    }
                    other.delta = delta
                }
                if (slot.kind == EffectSlot.Kind.field && entry.scope == effect.scope) entry.intent = entry.intent.copy(guards = entry.intent.guards.map {
                    if (it.key == row.key && it.field == slot.name && it.stamp == prior) it.copy(stamp = stamp) else it
                })
            }
            for (delta in predicted) {
                val old = delta.delta["born"]
                if (slot.kind == EffectSlot.Kind.born && old != null) {
                    var updated = delta.delta.with("born" to stamp.json)
                    updated["life"]?.arr()?.let { if (it[0] == Json.of("alive") && it[1] == old) updated = updated.with("life" to Json.array(it[0], stamp.json)) }
                    delta.delta = updated
                    for (entry in later) for (other in entry.slots().filter { it.scope == effect.scope && it.delta.recordKey == row.key }) {
                        var following = other.delta
                        if (following["born"] == old) following = following.with("born" to stamp.json)
                        following["life"]?.arr()?.let { if (it[1] == old) following = following.with("life" to Json.array(it[0], stamp.json)) }
                        other.delta = following
                    }
                }
                slot.register?.let { moveRegister(replica, NamedRegister(delta, it), stamp, queuedOnly = true) }
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
