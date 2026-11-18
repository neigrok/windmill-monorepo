package works.windmill.sync.core

data class RefusalCode(val text: String) {
    val json: Json get() = Json.of(text)
    override fun toString(): String = text
    companion object {
        val notFound = RefusalCode("not-found")
        val scopeDead = RefusalCode("scope-dead")
        val forbidden = RefusalCode("forbidden")
        val invalid = RefusalCode("invalid")
        val tooLarge = RefusalCode("too-large")
        val clockSkew = RefusalCode("clock-skew")
        val idTaken = RefusalCode("id-taken")
        val idSpent = RefusalCode("id-spent")
        val unknownRecord = RefusalCode("unknown-record")
        val recordDead = RefusalCode("record-dead")
        val parentDead = RefusalCode("parent-dead")
        val stale = RefusalCode("stale")
        val cap = RefusalCode("cap")
        val baseUnknown = RefusalCode("base-unknown")
        val requestConflict = RefusalCode("request-conflict")
        val requestRunning = RefusalCode("request-running")
        val internalError = RefusalCode("internal")
        val targetMerged = RefusalCode("target-merged")
        val engine: List<RefusalCode> = listOf(notFound, scopeDead, forbidden, invalid, tooLarge, clockSkew, idTaken,
            idSpent, unknownRecord, recordDead, parentDead, stale, cap, baseUnknown, requestConflict, requestRunning, internalError, targetMerged)
    }
}

data class WriteMapEntry(val key: RecordKey, val from: RecordID? = null, val born: Stamp? = null, val fields: Map<String, Stamp> = emptyMap()) {
    constructor(json: Json) : this(RecordKey(json.member("t").str(), RecordID(json.member("id"))), json["from"]?.let(::RecordID),
        json["born"]?.str()?.let(::Stamp), readMap(json["f"]) { Stamp(it.str()) })
    val stamps: List<Stamp> get() = listOfNotNull(born) + fields.values
}

data class PushResult(val n: Long, val verdict: Verdict, val detail: Json? = null) {
    sealed interface Verdict {
        data class Ok(val seq: Long, val write: List<WriteMapEntry>? = null) : Verdict
        data class Refused(val code: RefusalCode) : Verdict
    }
    constructor(json: Json) : this(json.member("n").long(), when (json.member("s").str()) {
        "ok" -> Verdict.Ok(json.member("seq").long(), json["write"]?.arr()?.map(::WriteMapEntry))
        "refused" -> Verdict.Refused(RefusalCode(json.member("code").str()))
        else -> throw JsonError("push-result")
    }, json["detail"])
}

// §6.4 scoped effect receipts: the versions one opted admission committed, scope by scope, and never a value.
data class EffectSlot(val kind: Kind, val name: String?, val version: Version) {
    enum class Kind(val order: String) { born("0"), life("1"), field("2"), text("3") }
    sealed interface Version {
        val json: Json
        data class Stamped(val stamp: Stamp) : Version {
            override val json: Json get() = Json.objectOf("kind" to Json.of("stamp"), "stamp" to stamp.json)
        }
        data class Revision(val revision: Long) : Version {
            override val json: Json get() = Json.objectOf("kind" to Json.of("text"), "revision" to Json.of(revision))
        }
    }
    constructor(json: Json) : this(Kind.valueOf(json.member("slot").member("kind").str()), json.member("slot")["name"]?.str(),
        json.member("version").let { version -> if (version.member("kind").str() == "text") Version.Revision(version.member("revision").long())
            else Version.Stamped(Stamp(version.member("stamp").str())) })
    // The lattice register a slot versions: `life`, or a field by its name. A born moves with its life, and a text has no register.
    val register: String? get() = when (kind) { Kind.life -> "life"; Kind.field -> name; Kind.born, Kind.text -> null }
    val stamp: Stamp? get() = (version as? Version.Stamped)?.stamp
    val order: String get() = kind.order + (name ?: "")
    val json: Json get() = Json.objectOf("slot" to Json.objectOf("kind" to Json.of(kind.name)).with("name" to name?.let(Json::of)), "version" to version.json)
}

data class EffectRow(val key: RecordKey, val beforeRowSeq: Long?, val rowSeq: Long, val slots: List<EffectSlot>) {
    constructor(json: Json) : this(RecordKey(json.member("t").str(), RecordID(json.member("id"))), json.member("beforeRowSeq").orNull()?.long(),
        json.member("rowSeq").long(), json.member("slots").arr().map(::EffectSlot))
    val json: Json get() = Json.objectOf("t" to Json.of(key.type), "id" to key.id.json, "beforeRowSeq" to (beforeRowSeq?.let(Json::of) ?: Json.Null),
        "rowSeq" to Json.of(rowSeq), "slots" to Json.Arr(slots.map(EffectSlot::json)))
    fun slot(kind: EffectSlot.Kind, name: String?): EffectSlot? = slots.firstOrNull { it.kind == kind && it.name == name }

    companion object {
        // A committed row's receipt: born, life, then changed fields and texts by name; a created row lists its whole footprint.
        fun committed(before: Row?, after: Row): EffectRow = EffectRow(after.key, before?.seq, after.seq, buildList {
            after.lattice.born?.takeIf { it != before?.lattice?.born }?.let { add(EffectSlot(EffectSlot.Kind.born, null, EffectSlot.Version.Stamped(it))) }
            after.lattice.life?.takeIf { it != before?.lattice?.life }?.let { add(EffectSlot(EffectSlot.Kind.life, null, EffectSlot.Version.Stamped(it.stamp))) }
            for ((name, register) in after.lattice.fields.toSortedMap(::compareBytes)) if (register != before?.lattice?.fields?.get(name))
                add(EffectSlot(EffectSlot.Kind.field, name, EffectSlot.Version.Stamped(register.stamp)))
            for ((name, text) in after.texts.toSortedMap(::compareBytes)) if (text != before?.texts?.get(name))
                add(EffectSlot(EffectSlot.Kind.text, name, EffectSlot.Version.Revision(text.rev)))
        })
    }
}

data class EffectReceipt(val scope: ScopeRef, val beforeSeq: Long?, val seq: Long?, val rows: List<EffectRow>) {
    constructor(json: Json) : this(ScopeRef(json.member("scope")), json.member("beforeSeq").orNull()?.long(), json.member("seq").orNull()?.long(),
        json.member("rows").arr().map(::EffectRow))
    val json: Json get() = Json.objectOf("scope" to scope.json, "beforeSeq" to (beforeSeq?.let(Json::of) ?: Json.Null),
        "seq" to (seq?.let(Json::of) ?: Json.Null), "rows" to Json.Arr(rows.map(EffectRow::json)))
    fun row(key: RecordKey): EffectRow? = rows.firstOrNull { it.key == key }

    companion object {
        // Origin first, then every other scope by its UTF-8 bytes.
        fun ordered(origin: ScopeRef, scopes: Collection<ScopeRef>): List<ScopeRef> = listOf(origin) + scopes.distinct().filter { it != origin }.sorted()

        // The complete opted result inside the widest push envelope it can travel in: what SCOPED_RESPONSE_MAX_BYTES bounds.
        fun responseBytes(result: Json, epoch: String, account: String): Int {
            val widest = Json.of(Json.MAX_SAFE_INTEGER)
            return Json.objectOf("serverTime" to widest, "epoch" to Json.of(epoch), "as" to Json.of(account), "lastN" to widest,
                "results" to Json.array(result.with("n" to widest)), "retry" to Json.objectOf("n" to widest, "retryAfterMs" to widest)).jcs.encodeToByteArray().size
        }

        // An opted ok result's receipts, checked whole before anything applies: the origin first at the result's seq, every `required` scope
        // present, and each row and slot one the registry admits in its scope. Answers or throws JsonError, naming nothing it read.
        fun read(registry: Registry, origin: ScopeRef, required: Collection<ScopeRef>, resultSeq: Long, detail: Json?): List<EffectReceipt> = try {
            checkNotNull(detail).expectKeys(listOf("windmillKit"), listOf("command"))
            val kit = detail.member("windmillKit")
            kit.expectKeys(listOf("v", "effects"))
            check(kit.member("v") == Json.of(1) && !kit.holdsNul && kit.jcs.encodeToByteArray().size <= Constants.RECEIPT_MAX_BYTES)
            val effects = kit.member("effects").arr().map { effect(registry, it) }
            val scopes = effects.map { it.scope }
            check(scopes.toSet().size == scopes.size && scopes == ordered(origin, scopes) && scopes.containsAll(required))
            check(effects.first().beforeSeq != null && effects.first().seq == resultSeq)
            effects
        } catch (_: IllegalArgumentException) { throw JsonError("scoped-receipt") }
          catch (_: IllegalStateException) { throw JsonError("scoped-receipt") }
          catch (_: NoSuchElementException) { throw JsonError("scoped-receipt") }

        private fun effect(registry: Registry, json: Json): EffectReceipt {
            json.expectKeys(listOf("scope", "beforeSeq", "seq", "rows"))
            json.member("scope").str(); json.member("beforeSeq").orNull()?.long(0); json.member("seq").orNull()?.long(0)
            json.member("rows").arr().forEach(::checkRow)
            val receipt = EffectReceipt(json)
            val kind = checkNotNull(registry.scopeKind(receipt.scope))
            receipt.scope.tree?.let { tree -> check(registry.governingType?.let { registry.isId(Json.of(tree), it) } == true) }
            check(receipt.seq != null || receipt.beforeSeq == null && receipt.rows.isEmpty())
            check(receipt.beforeSeq == null || receipt.seq!! >= receipt.beforeSeq)
            check(receipt.rows.zipWithNext().all { (a, b) -> a.key < b.key })
            for (row in receipt.rows) {
                val type = checkNotNull(registry.type(row.key.type))
                check(type.scope == kind && registry.isId(row.key.id.json, type))
                check(row.rowSeq > 0 && row.rowSeq == receipt.seq && receipt.beforeSeq != receipt.seq)
                check(row.beforeRowSeq == null || receipt.beforeSeq != null && row.beforeRowSeq < row.rowSeq && row.beforeRowSeq <= receipt.beforeSeq)
                check(row.slots.zipWithNext().all { (a, b) -> compareBytes(a.order, b.order) < 0 })
                for (slot in row.slots) when (slot.kind) {
                    EffectSlot.Kind.born -> check(type.hasBorn)
                    EffectSlot.Kind.life -> check(type.life)
                    EffectSlot.Kind.field -> check(type.fields[slot.name]?.isLattice == true)
                    EffectSlot.Kind.text -> check(type.fields[slot.name]?.kind == "text" && (slot.version as EffectSlot.Version.Revision).revision <= row.rowSeq)
                }
                if (row.beforeRowSeq == null) check((!type.hasBorn || row.slot(EffectSlot.Kind.born, null) != null) && (!type.life || row.slot(EffectSlot.Kind.life, null) != null))
            }
            return receipt
        }

        // The exact wire shape of a row and its slots, which the lenient constructors then read.
        private fun checkRow(json: Json) {
            json.expectKeys(listOf("t", "id", "beforeRowSeq", "rowSeq", "slots"))
            json.member("t").str(); json.member("beforeRowSeq").orNull()?.long(0); json.member("rowSeq").long(0)
            for (item in json.member("slots").arr()) {
                item.expectKeys(listOf("slot", "version"))
                val slot = item.member("slot"); val version = item.member("version")
                val kind = EffectSlot.Kind.entries.single { it.name == slot.member("kind").str() }
                if (kind == EffectSlot.Kind.born || kind == EffectSlot.Kind.life) slot.expectKeys(listOf("kind")) else { slot.expectKeys(listOf("kind", "name")); slot.member("name").str() }
                if (kind == EffectSlot.Kind.text) {
                    version.expectKeys(listOf("kind", "revision")); check(version.member("kind") == Json.of("text")); version.member("revision").long(1)
                } else {
                    version.expectKeys(listOf("kind", "stamp")); check(version.member("kind") == Json.of("stamp") && Stamp(version.member("stamp").str()) != Stamp.UNSET)
                }
            }
        }
    }
}
