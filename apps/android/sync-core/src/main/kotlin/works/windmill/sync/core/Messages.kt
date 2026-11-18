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

// §6.4 a register of a record in E-7's encoding: born, life, or a field or a text by its name.
data class Slot(val kind: Kind, val name: String? = null) {
    enum class Kind(val order: String) { born("0"), life("1"), field("2"), text("3") }
    init { require((kind == Kind.field || kind == Kind.text) == (name != null)) }
    // The lattice register a slot versions: `life`, or a field by its name. A born moves with its life, and a text has no register.
    val register: String? get() = when (kind) { Kind.life -> "life"; Kind.field -> name; Kind.born, Kind.text -> null }
    // E-7 lists a row's slots born, life, then fields and texts by name.
    val order: String get() = kind.order + (name ?: "")
    val json: Json get() = Json.objectOf("kind" to Json.of(kind.name)).with("name" to name?.let(Json::of))
    constructor(json: Json) : this(Kind.valueOf(json.member("kind").str()), json["name"]?.str())

    companion object {
        // The exact wire shape: born and life name nothing, a field or a text names its field.
        fun read(json: Json): Slot {
            val kind = Kind.entries.firstOrNull { it.name == json.member("kind").str() } ?: throw JsonError("slot")
            if (kind == Kind.born || kind == Kind.life) json.expectKeys(listOf("kind")) else json.expectKeys(listOf("kind", "name"))
            return Slot(kind, json["name"]?.str())
        }
    }
}

// The version a slot holds: a register's stamp, or a text's revision.
sealed interface SlotVersion {
    val json: Json
    data class Stamped(val stamp: Stamp) : SlotVersion {
        override val json: Json get() = Json.objectOf("kind" to Json.of("stamp"), "stamp" to stamp.json)
    }
    data class Revision(val revision: Long) : SlotVersion {
        override val json: Json get() = Json.objectOf("kind" to Json.of("text"), "revision" to Json.of(revision))
    }
    companion object {
        operator fun invoke(json: Json): SlotVersion = if (json.member("kind").str() == "text") Revision(json.member("revision").long()) else Stamped(Stamp(json.member("stamp").str()))
        // The exact wire shape of a slot's version: a text's positive revision, any other slot's set stamp.
        fun read(slot: Slot, json: Json): SlotVersion {
            if (slot.kind == Slot.Kind.text) {
                json.expectKeys(listOf("kind", "revision")); if (json.member("kind") != Json.of("text")) throw JsonError("slot-version")
                return Revision(json.member("revision").long(1))
            }
            json.expectKeys(listOf("kind", "stamp")); if (json.member("kind") != Json.of("stamp")) throw JsonError("slot-version")
            return Stamped(Stamp(json.member("stamp").str()).also { if (it == Stamp.UNSET) throw JsonError("slot-version") })
        }
    }
}

// §6.4 scoped effect receipts: the versions one opted admission committed, scope by scope, and never a value.
data class EffectSlot(val slot: Slot, val version: SlotVersion) {
    constructor(json: Json) : this(Slot(json.member("slot")), SlotVersion(json.member("version")))
    val kind: Slot.Kind get() = slot.kind
    val name: String? get() = slot.name
    val stamp: Stamp? get() = (version as? SlotVersion.Stamped)?.stamp
    val json: Json get() = Json.objectOf("slot" to slot.json, "version" to version.json)

    companion object {
        // The exact wire shape of `{slot, version}`.
        fun read(json: Json): EffectSlot {
            json.expectKeys(listOf("slot", "version"))
            val slot = Slot.read(json.member("slot"))
            return EffectSlot(slot, SlotVersion.read(slot, json.member("version")))
        }
    }
}

data class EffectRow(val key: RecordKey, val beforeRowSeq: Long?, val rowSeq: Long, val slots: List<EffectSlot>) {
    constructor(json: Json) : this(RecordKey(json.member("t").str(), RecordID(json.member("id"))), json.member("beforeRowSeq").orNull()?.long(),
        json.member("rowSeq").long(), json.member("slots").arr().map(::EffectSlot))
    val json: Json get() = Json.objectOf("t" to Json.of(key.type), "id" to key.id.json, "beforeRowSeq" to (beforeRowSeq?.let(Json::of) ?: Json.Null),
        "rowSeq" to Json.of(rowSeq), "slots" to Json.Arr(slots.map(EffectSlot::json)))
    fun slot(slot: Slot): EffectSlot? = slots.firstOrNull { it.slot == slot }

    companion object {
        // A committed row's receipt: born, life, then changed fields and texts by name; a created row lists its whole footprint.
        fun committed(before: Row?, after: Row): EffectRow = EffectRow(after.key, before?.seq, after.seq, buildList {
            after.lattice.born?.takeIf { it != before?.lattice?.born }?.let { add(EffectSlot(Slot(Slot.Kind.born), SlotVersion.Stamped(it))) }
            after.lattice.life?.takeIf { it != before?.lattice?.life }?.let { add(EffectSlot(Slot(Slot.Kind.life), SlotVersion.Stamped(it.stamp))) }
            for ((name, register) in after.lattice.fields.toSortedMap(::compareBytes)) if (register != before?.lattice?.fields?.get(name))
                add(EffectSlot(Slot(Slot.Kind.field, name), SlotVersion.Stamped(register.stamp)))
            for ((name, text) in after.texts.toSortedMap(::compareBytes)) if (text != before?.texts?.get(name))
                add(EffectSlot(Slot(Slot.Kind.text, name), SlotVersion.Revision(text.rev)))
        })
    }
}

// A stored row's version of a slot, or null while the register is unset.
fun Row.version(slot: Slot): SlotVersion? = when (slot.kind) {
    Slot.Kind.born -> lattice.born?.let(SlotVersion::Stamped)
    Slot.Kind.life -> lattice.life?.let { SlotVersion.Stamped(it.stamp) }
    Slot.Kind.field -> lattice.fields[slot.name]?.let { SlotVersion.Stamped(it.stamp) }
    Slot.Kind.text -> texts[slot.name]?.let { SlotVersion.Revision(it.rev) }
}

// A stored row's complete versioned footprint, in E-7's slot order.
val Row.footprint: List<EffectSlot> get() = (listOf(Slot(Slot.Kind.born), Slot(Slot.Kind.life)) + lattice.fields.keys.map { Slot(Slot.Kind.field, it) } +
    texts.keys.map { Slot(Slot.Kind.text, it) }).mapNotNull { slot -> version(slot)?.let { EffectSlot(slot, it) } }.sortedWith { a, b -> compareBytes(a.slot.order, b.slot.order) }

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
            check(effects.firstOrNull()?.let { it.beforeSeq != null && it.seq == resultSeq } == true)
            effects
        } catch (_: IllegalArgumentException) { throw JsonError("scoped-receipt") }
          catch (_: IllegalStateException) { throw JsonError("scoped-receipt") }

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
                check(row.slots.zipWithNext().all { (a, b) -> compareBytes(a.slot.order, b.slot.order) < 0 })
                for (slot in row.slots) when (slot.kind) {
                    Slot.Kind.born -> check(type.hasBorn)
                    Slot.Kind.life -> check(type.life)
                    Slot.Kind.field -> check(type.fields[slot.name]?.isLattice == true)
                    Slot.Kind.text -> check(type.fields[slot.name]?.kind == "text" && (slot.version as SlotVersion.Revision).revision <= row.rowSeq)
                }
                if (row.beforeRowSeq == null) check((!type.hasBorn || row.slot(Slot(Slot.Kind.born)) != null) && (!type.life || row.slot(Slot(Slot.Kind.life)) != null))
            }
            return receipt
        }

        // The exact wire shape of a row and its slots, which the lenient constructors then read.
        private fun checkRow(json: Json) {
            json.expectKeys(listOf("t", "id", "beforeRowSeq", "rowSeq", "slots"))
            json.member("t").str(); json.member("beforeRowSeq").orNull()?.long(0); json.member("rowSeq").long(0)
            json.member("slots").arr().forEach { EffectSlot.read(it) }
        }
    }
}
