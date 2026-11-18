package works.windmill.sync.core

data class ScopedDeltas(val scope: ScopeRef, val deltas: List<Delta>) {
    constructor(json: Json) : this(ScopeRef(json.member("scope")), json.member("d").arr().map(::Delta))
    val json: Json get() = Json.objectOf("scope" to scope.json, "d" to Json.Arr(deltas.map(Delta::json)))
}

data class Projection(val scope: ScopeRef, val deltas: List<Delta>, val resultSeq: Long? = null, val covered: Boolean = false) {
    constructor(json: Json) : this(ScopeRef(json.member("scope")), json.member("d").arr().map(::Delta), json["resultSeq"]?.long(), json["covered"]?.bool() ?: false)
    val json: Json get() = Json.Obj(buildList {
        add("scope" to scope.json); add("d" to Json.Arr(deltas.map(Delta::json)))
        resultSeq?.let { add("resultSeq" to Json.of(it)) }; if (covered) add("covered" to Json.of(true))
    })
}

object EffectReceipts {
    fun holdsNul(value: Json): Boolean = when (value) {
        is Json.Str -> '\u0000' in value.value
        is Json.Obj -> value.members.any { (key, item) -> '\u0000' in key || holdsNul(item) }
        is Json.Arr -> value.values.any(::holdsNul)
        else -> false
    }

    fun orderedScopes(origin: ScopeRef, scopes: Collection<ScopeRef>): List<ScopeRef> = listOf(origin) + scopes.distinct().filter { it != origin }.sorted()

    fun row(before: Row?, after: Row): Json {
        val slots = mutableListOf<Json>()
        fun stamp(kind: String, value: Stamp, name: String? = null) {
            val slot = Json.Obj(buildList { add("kind" to Json.of(kind)); name?.let { add("name" to Json.of(it)) } })
            slots.add(Json.objectOf("slot" to slot, "version" to Json.objectOf("kind" to Json.of("stamp"), "stamp" to value.json)))
        }
        after.lattice.born?.takeIf { it != before?.lattice?.born }?.let { stamp("born", it) }
        after.lattice.life?.takeIf { it != before?.lattice?.life }?.let { stamp("life", it.stamp) }
        for ((name, value) in after.lattice.fields.toSortedMap(::compareBytes)) if (value != before?.lattice?.fields?.get(name)) stamp("field", value.stamp, name)
        for ((name, value) in after.texts.toSortedMap(::compareBytes)) if (value != before?.texts?.get(name)) slots.add(Json.objectOf(
            "slot" to Json.objectOf("kind" to Json.of("text"), "name" to Json.of(name)),
            "version" to Json.objectOf("kind" to Json.of("text"), "revision" to Json.of(value.rev))))
        return Json.objectOf("t" to Json.of(after.key.type), "id" to after.key.id.json,
            "beforeRowSeq" to (before?.seq?.let(Json::of) ?: Json.Null), "rowSeq" to Json.of(after.seq), "slots" to Json.Arr(slots))
    }

    fun validate(registry: Registry, origin: ScopeRef, expected: Collection<ScopeRef>, resultSeq: Long, detail: Json?): List<Json> {
        try {
            require(detail != null)
            detail.expectKeys(listOf("windmillKit"), listOf("command"))
            val kit = detail.member("windmillKit")
            kit.expectKeys(listOf("v", "effects"))
            require(kit.member("v").long() == 1L && !holdsNul(kit) && kit.jcs.encodeToByteArray().size <= Constants.RECEIPT_MAX_BYTES)
            val effects = kit.member("effects").arr()
            val scopes = mutableListOf<ScopeRef>()
            fun sequence(value: Json): Long? = if (value === Json.Null) null else value.long().also { require(it >= 0) }
            for (effect in effects) {
                effect.expectKeys(listOf("scope", "beforeSeq", "seq", "rows"))
                val scope = ScopeRef(effect.member("scope"))
                val kind = registry.scopeKind(scope)
                require(kind != null && scope !in scopes)
                scope.tree?.let { id -> require(registry.governingType?.let { registry.isId(Json.of(id), it) } == true) }
                scopes.add(scope)
                val before = sequence(effect.member("beforeSeq")); val seq = sequence(effect.member("seq"))
                require(before == null || (seq != null && seq >= before))
                val rows = effect.member("rows").arr()
                require(seq != null || rows.isEmpty())
                var prior: RecordKey? = null
                for (row in rows) {
                    row.expectKeys(listOf("t", "id", "beforeRowSeq", "rowSeq", "slots"))
                    val key = RecordKey(row.member("t").str(), RecordID(row.member("id")))
                    val type = registry.type(key.type) ?: throw JsonError("receipt-type")
                    require(type.scope == kind && registry.isId(key.id.json, type) && (prior == null || prior < key))
                    prior = key
                    val rowSeq = sequence(row.member("rowSeq")); val oldSeq = sequence(row.member("beforeRowSeq"))
                    require(rowSeq != null && rowSeq > 0 && rowSeq == seq && before != seq)
                    require(oldSeq == null || (before != null && oldSeq < rowSeq && oldSeq <= before))
                    val slots = row.member("slots").arr()
                    var previous = ""
                    for (item in slots) {
                        item.expectKeys(listOf("slot", "version"))
                        val slot = item.member("slot"); val version = item.member("version"); val slotKind = slot.member("kind").str()
                        val order = when (slotKind) {
                            "born", "life" -> {
                                slot.expectKeys(listOf("kind")); require(if (slotKind == "born") type.hasBorn else type.life)
                                if (slotKind == "born") "0" else "1"
                            }
                            else -> {
                                slot.expectKeys(listOf("kind", "name"))
                                val name = slot.member("name").str(); val field = type.fields[name]
                                require(if (slotKind == "field") field?.isLattice == true else slotKind == "text" && field?.kind == "text")
                                (if (slotKind == "field") "2" else "3") + name
                            }
                        }
                        require(compareBytes(previous, order) < 0); previous = order
                        if (slotKind == "text") {
                            version.expectKeys(listOf("kind", "revision"))
                            val revision = sequence(version.member("revision"))
                            require(version.member("kind").str() == "text" && revision != null && revision > 0 && revision <= rowSeq)
                        } else {
                            version.expectKeys(listOf("kind", "stamp"))
                            require(version.member("kind").str() == "stamp" && Stamp(version.member("stamp").str()) != Stamp.UNSET)
                        }
                    }
                    if (oldSeq == null) {
                        require(!type.hasBorn || slots.any { it.member("slot").member("kind").str() == "born" })
                        require(!type.life || slots.any { it.member("slot").member("kind").str() == "life" })
                    }
                }
            }
            require(scopes == orderedScopes(origin, scopes) && scopes.containsAll(expected))
            require(effects.first().member("beforeSeq") !== Json.Null && effects.first().member("seq").long() == resultSeq)
            return effects
        } catch (_: Exception) { throw JsonError("invalid-scoped-receipt") }
    }
}
