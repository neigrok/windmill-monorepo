package works.windmill.sync.modelserver

import works.windmill.sync.core.*

class Admission(val registry: Registry, val rules: ServerRules, val limits: ServerLimits = ServerLimits()) {
    fun admit(intent: Json, origin: IntentOrigin, now: Long, state: ServerState): Pair<ServerState, Admitted> = try {
        val checked = IntentShape.check(intent, origin.isReplica, registry, now)
        val scope = ScopeKey.resolve(checked.scope, origin.account) ?: throw Refusal("invalid")
        val run = Run(origin, now, scope, state.copy(), checked)
        val result = run.admit()
        run.state to Admitted(result, run.events)
    } catch (refusal: Refusal) { state to Admitted(refused(refusal.code, refusal.detail)) }
      catch (fault: AdmissionFault) { throw fault }
      catch (error: Exception) { throw AdmissionFault(error) }

    private data class Place(val scope: ScopeKey, val key: RecordKey)
    private data class Placed(val place: Place, val delta: PlannedDelta, val source: String)
    private class Touched(val locked: IdState) {
        var row: Row? = null; var fields: Map<String, Register> = emptyMap()
        val ops = mutableSetOf<String>(); val createdBy = mutableListOf<String>()
        val superseded = mutableMapOf<String, TextState>(); val archives = mutableMapOf<String, Json>()
        val changed get() = row?.content != locked.row?.content
        val diesHere get() = locked.isAlive && row?.isAlive == false
    }
    private inner class Run(val origin: IntentOrigin, val now: Long, val scope: ScopeKey, val state: ServerState, val intent: CheckedIntent) {
        val locks = mutableMapOf<Place, IdState>(); val touched = linkedMapOf<Place, Touched>()
        val created = mutableSetOf<ScopeKey>(); val events = mutableListOf<LiveEvent>(); val deaths = mutableListOf<LiveEvent>()
        fun context(): RuleContext = RuleContext(registry, scope, origin, intent.deltas, intent.guards, now, state, rules,
            touched.filterKeys { it.scope == scope }.mapNotNull { (place, record) -> record.row?.let { place.key to it } }.toMap())
        fun admit(): Json {
            when (state.access(scope, origin.account, registry)) {
                "not-found" -> throw Refusal("not-found"); "gone" -> throw Refusal("scope-dead"); "readable" -> throw Refusal("forbidden")
                "absent" -> state.scopes[scope.text] = ScopeRecord(origin.account, governedBy = scope.tree?.let { "tree:$it" })
            }
            intent.command?.definition?.let { if (it.serverInternal && origin.isReplica || origin.kind !in it.origins) throw Refusal("forbidden") }
            if (intent.deltas.any { origin.kind !in registry.type(it.key.type)!!.json.member("origins").arr().map(Json::str) }) throw Refusal("forbidden")
            val client = lockIdentities(intent.deltas, scope, "intent")
            if (intent.command?.let { rules.replays(it, context()) } != true) checkGuards(client)
            val outcome = intent.command?.let { rules.run(it, context()) }
            outcome?.let { state.product = it.product }
            val command = lockIdentities(outcome?.deltas.orEmpty(), scope, "command") + outcome?.created.orEmpty().toSortedMap().flatMap { (created, deltas) -> lockIdentities(deltas, created, "command") }
            val stamp = join(client + command, client)
            val checking = context(); val appended = rules.check(changes(), checking); state.product = checking.product
            join(lockIdentities(appended, scope, "check"), client)
            checkParents(); assignSerials(); checkCaps(); apply(scope); lifecycle()
            for (written in touched.keys.map { it.scope }.toSet().minus(scope).sorted()) {
                if (written !in created) throw AdmissionFault()
                apply(written)
            }
            events.addAll(deaths)
            return Json.objectOf("s" to Json.of("ok"), "seq" to Json.of(state.scopes.getValue(scope.text).seq)).with(
                "write" to outcome?.let { Json.Arr(it.write.map { claim -> claim.json(stamp, touched[Place(scope, claim.key)]?.row?.lattice?.born) }) }, "detail" to outcome?.detail)
        }
        private fun lock(place: Place): IdState = locks.getOrPut(place) { state.idState(place.key, place.scope, registry).let { if (it.state == "none" && rules.elsewhere(place.key, state.product)) IdState("foreign") else it } }
        private fun lockIdentities(deltas: List<PlannedDelta>, scope: ScopeKey, source: String): List<Placed> = deltas.mapNotNull { delta ->
            val type = registry.type(delta.key.type) ?: throw AdmissionFault(); val place = Place(scope, delta.key); val locked = lock(place)
            val row = if (source == "check") touched[place]?.row else null
            val present = row?.let { IdState(if (it.isAlive) "alive" else "dead", it) } ?: locked
            when (val verdict = IdentityRules.verdict(delta.op, present, delta.born, type.json["revivable"]?.bool() == true)) {
                "ok" -> null
                "apply" -> {
                    if (source == "intent" && origin.isReplica) for ((name, reg) in delta.fields) {
                        val stored = locked.row?.lattice?.fields?.get(name)
                        if (type.fields[name]?.kind in listOf("const", "time") && stored != null && reg.stamp != stored.stamp && reg.value != stored.value) throw Refusal("invalid")
                    }
                    Placed(place, delta, source)
                }
                else -> throw Refusal(verdict)
            }
        }
        private fun checkGuards(deltas: List<Placed>) {
            for (guard in intent.guards) {
                val stored = lock(Place(scope, guard.key)).row?.lattice?.fields?.get(guard.field)
                val written = deltas.firstOrNull { it.delta.key == guard.key }?.delta?.fields?.get(guard.field)?.stamp
                if (stored?.stamp != guard.stamp && !(stored != null && written == stored.stamp)) throw Refusal("stale", Json.objectOf("t" to Json.of(guard.key.type), "id" to guard.key.id.json, "field" to Json.of(guard.field), "current" to (stored?.stamp?.json ?: Json.Null)))
            }
        }
        private fun join(deltas: List<Placed>, observing: List<Placed>): Stamp? {
            val server = deltas.filter { it.delta.serverRegisters.isNotEmpty() }
            for (placed in server) for (name in placed.delta.serverRegisters) {
                val stored = lock(placed.place).row
                stored?.stamp(name)?.let(state.clock::observe)
                observing.filter { it.place == placed.place }.mapNotNull { it.delta.given(name) }.forEach(state.clock::observe)
            }
            val stamp = if (server.isEmpty()) null else state.clock.tick(now, "srv")
            for (placed in deltas) {
                val delta = placed.delta.minted(stamp); val record = touched.getOrPut(placed.place) { Touched(lock(placed.place)) }
                val type = registry.type(delta.key.type)!!
                var row = record.row ?: record.locked.row ?: Row(delta.key, seq = 0)
                row = row.copy(lattice = Join.record(type, row.lattice, delta.lattice), serials = row.serials + placed.delta.serials)
                record.fields = row.lattice.fields
                val texts = row.texts.toMutableMap()
                for ((name, write) in delta.texts.toSortedMap()) {
                    val head = texts[name] ?: TextState("", 0, false)
                    val merged = TextMerge.merge(head, write.base, write.text, limits.mergeWorkCells) { rev -> state.revisions[placed.place.scope.text]?.firstOrNull { it.recordKey == row.key && it.member("field").str() == name && it.member("rev").long() == rev }?.member("text")?.str() }
                    boundText(merged.text, type.fields.getValue(name))
                    if (merged.text != head.text || merged.merged != head.merged) {
                        texts[name]?.let { record.superseded.putIfAbsent(name, it) }
                        texts[name] = TextState(merged.text, nextSeq(placed.place.scope), merged.merged)
                    }
                }
                for ((name, replacement) in placed.delta.replacements) {
                    val field = type.fields[name]; if (field?.kind != "text") throw Refusal("invalid")
                    boundText(replacement.text, field)
                    texts[name]?.let { if (!replacement.archiveNonempty || it.text.isNotEmpty()) { record.superseded[name] = it; record.archives[name] = replacement.archive } }
                    texts[name] = TextState(replacement.text, nextSeq(placed.place.scope), false)
                }
                row = row.copy(texts = texts)
                if (row.lattice.life?.isAlive == false && type.json["revivable"]?.bool() != true) row = row.copy(lattice = Lattice(row.lattice.life, row.lattice.born), texts = emptyMap(), serials = emptyMap())
                record.row = row; record.ops.add(placed.delta.op)
                if (placed.delta.op == "create") record.createdBy.add(placed.source)
            }
            for ((place, record) in touched) if (record.changed && stored(record.row!!, place).json.jcs.encodeToByteArray().size > limits.maxRecordBytes) throw Refusal("too-large")
            return stamp
        }
        private fun boundText(text: String, field: FieldDef) { field.bounds?.let { if (it.unit.length(text).toLong() > (it.max ?: Long.MAX_VALUE)) throw Refusal("too-large") } }
        private fun nextSeq(scope: ScopeKey) = (state.scopes[scope.text]?.seq ?: 0) + 1
        private fun stored(row: Row, place: Place) = row.copy(seq = nextSeq(place.scope), rc = state.rows[place.scope.text]?.get(place.key)?.let(::Row)?.rc ?: now, ru = now)
        private fun changes() = touched.map { (place, record) -> RecordChange(place.scope, place.key, record.locked, record.row!!, record.createdBy.toList()) }
        private fun checkParents() {
            for ((place, record) in touched) {
                if (record.ops.none { it in listOf("create", "update") }) continue
                val parent = registry.type(place.key.type)?.fields?.values?.firstOrNull { it.parent } ?: continue
                val target = parent.ref ?: continue; val id = record.fields[parent.name]?.value as? Json.Str ?: continue
                val parentScope = registry.scopeOfType(target, place.scope.ref)?.let { ScopeKey.resolve(it, state.scopes.getValue(scope.text).owner) } ?: throw Refusal("parent-dead")
                val parentPlace = Place(parentScope, RecordKey(target, RecordID(id)))
                if (!(touched[parentPlace]?.row?.isAlive ?: lock(parentPlace).isAlive)) throw Refusal("parent-dead")
            }
        }
        private fun assignSerials() {
            val numbered = mutableMapOf<ScopeKey, MutableList<Row>>()
            for ((place, record) in touched) {
                var row = record.row!!
                if (!row.isAlive || record.locked.row != null) continue
                for (field in registry.type(place.key.type)!!.fields.values) {
                    if (field.kind != "serial" || field.name in row.serials) continue
                    val next = field.json["serialNext"]?.arr()?.map(Json::str).orEmpty()
                    val peers = state.rows[place.scope.text].orEmpty().values.map(::Row) + numbered[place.scope].orEmpty()
                    val highest = peers.filter { peer -> peer.key.type == place.key.type && peer.key != place.key && peer.isAlive && next.all { peer.lattice.fields[it]?.value == row.lattice.fields[it]?.value } }.mapNotNull { it.serials[field.name]?.long() }.maxOrNull() ?: 0
                    row = row.copy(serials = row.serials + (field.name to Json.of(highest + 1)))
                }
                record.row = row; numbered.getOrPut(place.scope) { mutableListOf() }.add(row)
            }
        }
        private fun net(type: String, scope: ScopeKey) = touched.filterKeys { it.scope == scope && it.key.type == type }.values.sumOf { (if (it.row!!.isAlive) 1L else 0L) - (if (it.locked.isAlive) 1L else 0L) }
        private fun checkCaps() {
            for (written in touched.keys.map { it.scope }.toSet()) for (type in registry.types) {
                val cap = type.cap ?: continue; val before = state.scopes[written.text]?.counters?.get(type.name) ?: 0; val after = before + net(type.name, written)
                if (after > cap && after > before) throw Refusal("cap", Json.objectOf("type" to Json.of(type.name), "cap" to Json.of(cap)))
            }
        }
        private fun apply(written: ScopeKey) {
            val changed = touched.filter { it.key.scope == written && it.value.changed }
            if (changed.isEmpty()) return
            val record = state.scopes.getValue(written.text)
            val rows = changed.map { (place, touched) -> stored(touched.row!!, place) }; record.seq = nextSeq(written)
            for (type in registry.types.filter { it.cap != null }) {
                val net = net(type.name, written)
                if (net != 0L || type.name in record.counters) record.counters[type.name] = (record.counters[type.name] ?: 0) + net
            }
            val superseded = changed.flatMap { (place, touched) -> touched.superseded.map { (field, head) ->
                (touched.archives[field] ?: Json.objectOf()).with("t" to Json.of(place.key.type), "id" to place.key.id.json, "field" to Json.of(field), "rev" to Json.of(head.rev), "text" to Json.of(head.text))
            } }
            if (superseded.isNotEmpty()) state.revisions[written.text] = rules.pruneRevisions(state.revisions[written.text].orEmpty() + superseded, superseded, now, written, state).sortedWith(ServerState.revisionOrder).toMutableList()
            for (row in rows) {
                record.digest = record.digest.replacing(state.rows[written.text]?.get(row.key), row.json)
                if (row.isAlive || registry.type(row.key.type)!!.json["deadRows"]?.str() != "spent") {
                    state.rows.getOrPut(written.text) { mutableMapOf() }[row.key] = row.json; state.spent[written.text]?.remove(row.key)
                } else {
                    state.rows[written.text]?.remove(row.key)
                    state.spent.getOrPut(written.text) { mutableMapOf() }[row.key] = Json.objectOf("t" to Json.of(row.key.type), "id" to row.key.id.json, "lifeStamp" to row.lattice.life!!.stamp.json, "seq" to Json.of(row.seq)).with("born" to row.lattice.born?.json)
                }
            }
            events.add(LiveEvent.change(written, state.epoch, record.seq, record.digest, rows, limits.liveInlineBytes))
        }
        private fun lifecycle() {
            for ((place, record) in touched) {
                if (!record.changed || registry.type(place.key.type)?.json?.get("governs")?.str() != "tree") continue
                val tree = ScopeKey("tree:${place.key.id}")
                if (record.locked.state == "none" && record.row!!.isAlive && tree.text !in state.scopes) {
                    state.scopes[tree.text] = ScopeRecord(state.scopes.getValue(scope.text).owner, governedBy = governor(place.scope, place.key)); created.add(tree)
                }
                if (record.diesHere) for (key in state.scopes.keys.map(::ScopeKey).filter { it == tree || it.kind == "overlay" && it.tree == tree.tree }.sorted()) {
                    val dead = state.scopes.getValue(key.text)
                    if (dead.state == "alive") { dead.state = "dead"; dead.deadAt = now; deaths.add(LiveEvent(key, dead = true)) }
                }
            }
        }
    }
}
private fun Row.stamp(name: String) = when (name) { "life" -> lattice.life?.stamp; "born" -> lattice.born; else -> lattice.fields[name]?.stamp }
