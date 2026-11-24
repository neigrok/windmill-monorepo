package works.windmill.sync.core

// K-3 Undo of an act: the closed recipe union a plan opts in with, the fixed arguments of an engine `restore` command and of a
// product `inverse` command, and the one evaluation of restore operations the server admits. Slots and versions use E-7's
// encoding (§6.4). Values never leave the device but in a restore's own arguments; every `read` here is strict and throws an
// IllegalArgumentException naming nothing it read.

// A record of a scope.
data class RecordAddress(val scope: ScopeRef, val key: RecordKey) {
    constructor(json: Json) : this(ScopeRef(json.member("scope")), RecordKey(json.member("t").str(), RecordID(json.member("id"))))
    val json: Json get() = Json.objectOf("scope" to scope.json, "t" to Json.of(key.type), "id" to key.id.json)

    // The record's type, living in its scope, and its id is one the type admits.
    fun check(registry: Registry): TypeDef {
        val type = registry.type(key.type)
        require(type != null && type.scope == registry.scopeKind(scope) && registry.isId(key.id.json, type))
        scope.tree?.let { tree -> require(registry.governingType?.let { registry.isId(Json.of(tree), it) } == true) }
        return type
    }

    companion object {
        fun read(json: Json): RecordAddress { json.expectKeys(listOf("scope", "t", "id")); return RecordAddress(json) }
    }
}

// A register of a record: the unit an Undo writes back.
data class RecordSlot(val record: RecordAddress, val slot: Slot) {
    constructor(json: Json) : this(RecordAddress(json), Slot(json.member("slot")))
    val scope: ScopeRef get() = record.scope
    val key: RecordKey get() = record.key
    val json: Json get() = record.json.with("slot" to slot.json)

    companion object {
        fun read(json: Json): RecordSlot {
            json.expectKeys(listOf("scope", "t", "id", "slot"))
            return RecordSlot(RecordAddress(json), Slot.read(json.member("slot")))
        }
    }
}

val TypeDef.revivable: Boolean get() = json["revivable"]?.bool() == true
val TypeDef.governs: Boolean get() = json["governs"] != null
val TypeDef.wholePut: Boolean get() = json["wholePut"]?.bool() == true

// A slot a generic restore writes back (§6.4): a client lww register, a client text, or the life of a record a write can bring
// back, keyed with life or revivable. Never born, a server register or a const.
fun TypeDef.restores(slot: Slot): Boolean = when (slot.kind) {
    Slot.Kind.born -> false
    Slot.Kind.life -> life && (identity == "keyed" || revivable)
    Slot.Kind.field -> fields[slot.name]?.let { it.kind == "lww" && it.writer == "client" } == true
    Slot.Kind.text -> fields[slot.name]?.let { it.kind == "text" && it.writer == "client" } == true
}

// A keyed record's life brought back alive: its death kept no field (G1), so its restore carries the record's values.
fun TypeDef.revivesKeyed(slot: Slot, before: Json): Boolean = identity == "keyed" && slot.kind == Slot.Kind.life && before == Json.of("alive")

// A record an Undo deletes again or a Redo creates again: it has life, governs no tree and is not saved whole.
val TypeDef.recreatable: Boolean get() = life && !governs && !wholePut

// Whether `value` is a logical value of a slot of `type`: a life alive or dead, a text within its bound, a field on its domain.
fun Registry.admitsLogical(type: TypeDef, slot: Slot, value: Json): Boolean = when (slot.kind) {
    Slot.Kind.born -> false
    Slot.Kind.life -> value == Json.of("alive") || value == Json.of("dead")
    Slot.Kind.text -> value is Json.Str && type.fields[slot.name]?.bounds?.let { it.unit.length(value.value) <= (it.max ?: Long.MAX_VALUE) } != false
    Slot.Kind.field -> admits(value, type.fields.getValue(slot.name!!))
}

// A record's complete versioned footprint as a receipt or an operation names it: born, life, fields and texts of its type, in slot order.
fun readFootprint(type: TypeDef, json: Json): List<EffectSlot> {
    val footprint = json.arr().map(EffectSlot::read)
    require(footprint.isNotEmpty() && footprint.zipWithNext().all { (a, b) -> compareBytes(a.slot.order, b.slot.order) < 0 })
    for (item in footprint) require(when (item.kind) {
        Slot.Kind.born -> type.hasBorn
        Slot.Kind.life -> type.life
        Slot.Kind.field -> type.fields[item.name]?.isLattice == true
        Slot.Kind.text -> type.fields[item.name]?.kind == "text"
    })
    return footprint
}

private fun Json.positive(): Long = long(1)
private fun Json.epoch(): String = str().also { require(it.isNotEmpty()) }

// The closed recipe union a plan opts an act's segment into Undo with (§7.3 Undo of an act).
sealed interface UndoRecipe {
    val json: Json

    // Generic restores of registers of the segment's scope, each to its first local preimage; `defaultValue` stands for an unset slot.
    data class Fields(val restoreCommand: String, val targets: List<FieldTarget>) : UndoRecipe {
        override val json: Json get() = Json.objectOf("kind" to Json.of("fields"), "restoreCommand" to Json.of(restoreCommand), "targets" to Json.Arr(targets.map(FieldTarget::json)))
    }
    // A target and the product's value equivalent to unset; null stands for no default, Json.Null for the value null.
    data class FieldTarget(val target: RecordSlot, val defaultValue: Json? = null) {
        val json: Json get() = Json.objectOf("target" to target.json).with("defaultValue" to defaultValue)
    }
    // A record the act creates, deleted again while its own receipts prove it unchanged.
    data class CreatedRecord(val restoreCommand: String, val record: RecordAddress) : UndoRecipe {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createdRecord"), "restoreCommand" to Json.of(restoreCommand), "record" to record.json)
    }
    // A product inverse command, run over the evidence the engine builds from the act's receipts.
    data class Product(val command: String, val input: Json, val evidence: EvidenceSelection) : UndoRecipe {
        override val json: Json get() = Json.objectOf("kind" to Json.of("command"), "command" to Json.of(command), "input" to input, "evidence" to evidence.json)
    }

    // The recipe against its segment's scope (§7.3): a generic recipe names the scope kind's restore command and registers of that
    // scope it restores; a product recipe names an inverse command of the scope kind, its evidence any scope.
    fun check(registry: Registry, scope: ScopeRef) {
        val kind = registry.scopeKind(scope)
        fun restore(name: String) = registry.command(name)?.takeIf { it.engine == "restore" && it.scope == kind } ?: throw IllegalArgumentException("undo-restore-command")
        when (this) {
            is Fields -> {
                val command = restore(restoreCommand)
                require(targets.isNotEmpty())
                for ((target, defaultValue) in targets) {
                    require(target.scope == scope)
                    val type = target.record.check(registry)
                    require(type.name in command.predicts && type.restores(target.slot))
                    require(defaultValue == null || registry.admitsLogical(type, target.slot, defaultValue))
                }
            }
            is CreatedRecord -> {
                val command = restore(restoreCommand)
                require(record.scope == scope)
                val type = record.check(registry)
                require(type.name in command.predicts && type.recreatable)
            }
            is Product -> {
                require(registry.command(command)?.let { it.inverse && it.scope == kind } == true)
                evidence.ownedFields.forEach { it.record.check(registry) }
                evidence.unchangedCreatedRecords.forEach { require(it.check(registry).life) }
                require(evidence.unchangedCreatedScopes.all { it.tree != null && registry.governingType?.let { type -> registry.isId(Json.of(it.tree!!), type) } == true })
            }
        }
    }

    companion object {
        operator fun invoke(json: Json): UndoRecipe = read(json)
        fun read(json: Json): UndoRecipe = when (json.member("kind").str()) {
            "fields" -> {
                json.expectKeys(listOf("kind", "restoreCommand", "targets"))
                Fields(json.member("restoreCommand").str(), json.member("targets").arr().map { item ->
                    item.expectKeys(listOf("target"), listOf("defaultValue"))
                    FieldTarget(RecordSlot.read(item.member("target")), item["defaultValue"])
                })
            }
            "createdRecord" -> {
                json.expectKeys(listOf("kind", "restoreCommand", "record"))
                CreatedRecord(json.member("restoreCommand").str(), RecordAddress.read(json.member("record")))
            }
            "command" -> {
                json.expectKeys(listOf("kind", "command", "input", "evidence"))
                Product(json.member("command").str(), json.member("input"), EvidenceSelection.read(json.member("evidence")))
            }
            else -> throw JsonError("undo-recipe")
        }
    }
}

// The evidence a product inverse recipe selects: the owned fields, created records and created scopes its command needs proven.
data class EvidenceSelection(val ownedFields: List<RecordSlot>, val unchangedCreatedRecords: List<RecordAddress>, val unchangedCreatedScopes: List<ScopeRef>) {
    val json: Json get() = Json.objectOf("ownedFields" to Json.Arr(ownedFields.map(RecordSlot::json)),
        "unchangedCreatedRecords" to Json.Arr(unchangedCreatedRecords.map(RecordAddress::json)), "unchangedCreatedScopes" to Json.Arr(unchangedCreatedScopes.map(ScopeRef::json)))

    companion object {
        fun read(json: Json): EvidenceSelection {
            json.expectKeys(listOf("ownedFields", "unchangedCreatedRecords", "unchangedCreatedScopes"))
            return EvidenceSelection(json.member("ownedFields").arr().map(RecordSlot::read), json.member("unchangedCreatedRecords").arr().map(RecordAddress::read),
                json.member("unchangedCreatedScopes").arr().map(::ScopeRef))
        }
    }
}

// A record a Redo creates again, or a keyed record a restore brings back alive: its client fields and texts.
data class CreationValues(val fields: Map<String, Json> = emptyMap(), val texts: Map<String, String> = emptyMap()) {
    constructor(json: Json) : this(json["f"]?.obj().orEmpty(), json["x"]?.obj().orEmpty().mapValues { it.value.str() })
    val json: Json get() = Json.objectOf().with("f" to fields.takeIf { it.isNotEmpty() }?.let { Json.Obj(it.toList()) },
        "x" to texts.takeIf { it.isNotEmpty() }?.let { Json.Obj(it.map { (name, text) -> name to Json.of(text) }) })
    val isEmpty: Boolean get() = fields.isEmpty() && texts.isEmpty()

    // `delta` with these values written under the server stamp, each text onto an empty head.
    fun writtenInto(delta: Json): Json {
        var written = delta
        for ((name, value) in fields) written = written.with("f" to (written["f"] ?: Json.objectOf()).with(name to Json.array(value, Json.Null)))
        for ((name, text) in texts) written = written.with("x" to (written["x"] ?: Json.objectOf()).with(name to
            Json.objectOf("text" to Json.of(text), "base" to Json.objectOf("rev" to Json.of(0)))))
        return written
    }

    companion object {
        // What a keyed record's revival brings back from the record its life's preimage read (`{born?, f?, x?}`): its client fields and texts.
        fun revival(type: TypeDef, record: Json): CreationValues = CreationValues(
            record["f"]?.obj().orEmpty().filterKeys { type.fields[it]?.let { field -> field.writer == "client" && field.kind in listOf("lww", "fww", "const", "time") } == true }
                .mapValues { it.value.arr()[0] },
            record["x"]?.obj().orEmpty().filterKeys { type.fields[it]?.let { field -> field.writer == "client" && field.kind == "text" } == true }.mapValues { it.value.str() })

        // Client lww, fww, const or time fields and client texts of `type`, each on its domain.
        fun read(registry: Registry, type: TypeDef, json: Json): CreationValues {
            json.expectKeys(emptyList(), listOf("f", "x"))
            val values = CreationValues(json)
            for ((name, value) in values.fields) require(type.fields[name]?.let { it.writer == "client" && it.kind in listOf("lww", "fww", "const", "time") && registry.admits(value, it) } == true)
            for ((name, text) in values.texts) require(type.fields[name]?.kind == "text" && registry.admitsLogical(type, Slot(Slot.Kind.text, name), Json.of(text)) &&
                type.fields.getValue(name).writer == "client")
            return values
        }
    }
}

// One operation's outcome in a restore's or an inverse command's detail: applied, or skipped by its code.
data class InverseOutcome(val index: Int, val skipped: String? = null) {
    constructor(json: Json) : this(json.member("index").long(0).toInt(), json["code"]?.str())
    val applied: Boolean get() = skipped == null
    val json: Json get() = Json.objectOf("index" to Json.of(index), "s" to Json.of(if (applied) "applied" else "skipped")).with("code" to skipped?.let(Json::of))

    companion object {
        fun detail(outcomes: List<InverseOutcome>): Json = Json.objectOf("inverse" to Json.objectOf("outcomes" to Json.Arr(outcomes.map(InverseOutcome::json))))

        // The outcomes a result's command detail reports, one an operation in order; anything else throws JsonError.
        fun read(detail: Json?, count: Int): List<InverseOutcome> = try {
            val outcomes = checkNotNull(detail).member("inverse").member("outcomes").arr()
            check(outcomes.size == count)
            outcomes.mapIndexed { index, outcome ->
                if (outcome["s"] == Json.of("applied")) outcome.expectKeys(listOf("index", "s"))
                else { outcome.expectKeys(listOf("index", "s", "code")); check(outcome.member("s") == Json.of("skipped")); outcome.member("code").str() }
                InverseOutcome(outcome).also { check(it.index == index) }
            }
        } catch (_: IllegalArgumentException) { throw JsonError("inverse-outcomes") }
          catch (_: IllegalStateException) { throw JsonError("inverse-outcomes") }
    }
}

// What a field operation expects to find: the version the act owns, or the slot unset in the record of birth `born`.
sealed interface Expectation {
    val json: Json
    data class Version(val version: SlotVersion) : Expectation { override val json: Json get() = version.json }
    data class Absent(val born: Stamp?) : Expectation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("absent"), "born" to (born?.json ?: Json.Null))
    }
}

// One operation of a restore command (§6.4): it holds or skips by its own condition, in order.
sealed interface RestoreOperation {
    val key: RecordKey
    val json: Json

    // `values`: on a keyed record's life brought back alive, the record's values, which its death did not keep (G1).
    data class Field(override val key: RecordKey, val slot: Slot, val expected: Expectation, val before: Json, val values: CreationValues? = null) : RestoreOperation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("field"), "t" to Json.of(key.type), "id" to key.id.json, "slot" to slot.json,
            "expected" to expected.json, "before" to before).with("values" to values?.json)
    }
    data class CreatedRecord(override val key: RecordKey, val rowSeq: Long, val footprint: List<EffectSlot>) : RestoreOperation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createdRecord"), "t" to Json.of(key.type), "id" to key.id.json,
            "rowSeq" to Json.of(rowSeq), "footprint" to Json.Arr(footprint.map(EffectSlot::json)))
    }
    data class CreateRecord(override val key: RecordKey, val values: CreationValues) : RestoreOperation {
        override val json: Json get() = Json.objectOf("kind" to Json.of("createRecord"), "t" to Json.of(key.type), "id" to key.id.json, "values" to values.json)
    }
}

// The outcome of one restore command: a server delta a record, its registers to be stamped at admission, and an outcome an operation.
data class RestoreEvaluation(val deltas: List<Json>, val outcomes: List<InverseOutcome>)

// §6.4 the fixed arguments of an engine restore command: the epoch they were bound in and the operations.
data class RestoreArguments(val expectedEpoch: String, val operations: List<RestoreOperation>) {
    val json: Json get() = Json.objectOf("expectedEpoch" to Json.of(expectedEpoch), "operations" to Json.Arr(operations.map(RestoreOperation::json)))

    // Each operation against the scope's stored rows, in order: it holds or skips by its own condition, and what holds becomes one
    // server delta a record. `stored` reads a row as stored and `spent` whether a spent id holds a key.
    fun evaluate(registry: Registry, stored: (RecordKey) -> Row?, spent: (RecordKey) -> Boolean, epoch: String): RestoreEvaluation {
        class Restored(val key: RecordKey, val row: Row?) {
            var delta: Json? = null
            // The record's restoring delta, carrying its born and, for a keyed type or a dead record, its stored life.
            fun delta(type: TypeDef): Json = delta ?: Json.objectOf("t" to Json.of(key.type), "id" to key.id.json).with(
                "born" to row!!.lattice.born?.json?.takeIf { type.hasBorn },
                "life" to row.lattice.life?.takeIf { type.life && (type.identity == "keyed" || !it.isAlive) }?.let { Json.array(Json.of(it.state), it.stamp.json) })
        }
        val records = linkedMapOf<RecordKey, Restored>()
        val outcomes = operations.mapIndexed { index, op ->
            if (expectedEpoch != epoch) return@mapIndexed InverseOutcome(index, "epoch-changed")
            val type = registry.type(op.key.type)!!
            val record = records.getOrPut(op.key) { Restored(op.key, stored(op.key)) }
            val row = record.row
            when (op) {
                is RestoreOperation.Field -> {
                    val holds = when (val expected = op.expected) {
                        is Expectation.Absent -> row != null && (!type.hasBorn || row.lattice.born == expected.born) && row.version(op.slot) == null
                        is Expectation.Version -> row?.version(op.slot) == expected.version
                    }
                    if (!holds) return@mapIndexed InverseOutcome(index, "version-changed")
                    if (op.slot.kind != Slot.Kind.life && type.life && row!!.lattice.life?.isAlive != true && !type.revivable && type.identity != "keyed")
                        return@mapIndexed InverseOutcome(index, "record-dead")
                    val delta = record.delta(type)
                    record.delta = when (op.slot.kind) {
                        Slot.Kind.life -> (op.values ?: CreationValues()).writtenInto(delta.with("life" to Json.array(op.before, Json.Null)))
                        Slot.Kind.field -> delta.with("f" to (delta["f"] ?: Json.objectOf()).with(op.slot.name!! to Json.array(op.before, Json.Null)))
                        else -> delta.with("x" to (delta["x"] ?: Json.objectOf()).with(op.slot.name!! to Json.objectOf("text" to op.before,
                            "replace" to Json.of(true), "archiveNonempty" to Json.of(false), "archive" to Json.objectOf())))
                    }
                }
                is RestoreOperation.CreatedRecord -> {
                    if (row?.lattice?.life?.isAlive != true || row.seq != op.rowSeq || row.footprint != op.footprint) return@mapIndexed InverseOutcome(index, "record-changed")
                    record.delta = record.delta(type).with("life" to Json.array(Json.of("dead"), Json.Null))
                }
                is RestoreOperation.CreateRecord -> {
                    if (row != null || record.delta != null || spent(op.key)) return@mapIndexed InverseOutcome(index, "record-present")
                    record.delta = op.values.writtenInto(Json.objectOf("t" to Json.of(op.key.type), "id" to op.key.id.json,
                        "life" to Json.array(Json.of("alive"), Json.Null)).with("born" to Json.Null.takeIf { type.hasBorn }))
                }
            }
            InverseOutcome(index)
        }
        return RestoreEvaluation(records.values.mapNotNull { it.delta }, outcomes)
    }

    companion object {
        // A restore's arguments as §6.4 fixes them: every operation names a type `command` restores, one slot at most once.
        fun read(registry: Registry, command: CommandDef, json: Json): RestoreArguments {
            json.expectKeys(listOf("expectedEpoch", "operations"))
            val written = mutableSetOf<Pair<RecordKey, Slot>>()
            val operations = json.member("operations").arr().map { op ->
                val key = RecordKey(op.member("t").str(), RecordID(op.member("id")))
                val type = registry.type(key.type)
                require(type != null && type.name in command.predicts && registry.isId(key.id.json, type))
                when (op.member("kind").str()) {
                    "field" -> {
                        op.expectKeys(listOf("kind", "t", "id", "slot", "expected", "before"), listOf("values"))
                        val slot = Slot.read(op.member("slot"))
                        require(type.restores(slot) && registry.admitsLogical(type, slot, op.member("before")) && written.add(key to slot))
                        require(op["values"] == null || type.revivesKeyed(slot, op.member("before")))
                        val expected = op.member("expected")
                        RestoreOperation.Field(key, slot, if (expected["kind"] == Json.of("absent")) {
                            expected.expectKeys(listOf("kind", "born"))
                            require(slot.kind != Slot.Kind.life)
                            Expectation.Absent(if (type.hasBorn) Stamp(expected.member("born").str()).also { require(it != Stamp.UNSET) } else null.also { require(expected.member("born") === Json.Null) })
                        } else Expectation.Version(SlotVersion.read(slot, expected)), op.member("before"),
                            op["values"]?.let { CreationValues.read(registry, type, it) })
                    }
                    "createdRecord" -> {
                        op.expectKeys(listOf("kind", "t", "id", "rowSeq", "footprint"))
                        require(type.recreatable)
                        RestoreOperation.CreatedRecord(key, op.member("rowSeq").positive(), readFootprint(type, op.member("footprint")))
                    }
                    "createRecord" -> {
                        op.expectKeys(listOf("kind", "t", "id", "values"))
                        require(type.recreatable)
                        RestoreOperation.CreateRecord(key, CreationValues.read(registry, type, op.member("values")))
                    }
                    else -> throw JsonError("restore-operation")
                }
            }
            require(operations.isNotEmpty())
            return RestoreArguments(json.member("expectedEpoch").epoch(), operations)
        }
    }
}

// §6.4 the engine-built evidence of a product inverse command: the epoch, the latest versions the act owns, and the receipts that
// prove its created records and scopes unchanged since.
data class Evidence(val expectedEpoch: String, val ownedFields: List<OwnedField>, val unchangedCreatedRecords: List<CreatedRecordProof>,
    val unchangedCreatedScopes: List<CreatedScopeProof>) {
    data class OwnedField(val target: RecordSlot, val version: SlotVersion) {
        val json: Json get() = Json.objectOf("target" to target.json, "version" to version.json)
    }
    data class CreatedRecordProof(val record: RecordAddress, val rowSeq: Long, val footprint: List<EffectSlot>) {
        val json: Json get() = Json.objectOf("record" to record.json, "rowSeq" to Json.of(rowSeq), "footprint" to Json.Arr(footprint.map(EffectSlot::json)))
    }
    data class CreatedScopeProof(val scope: ScopeRef, val seq: Long) {
        val json: Json get() = Json.objectOf("scope" to scope.json, "seq" to Json.of(seq))
    }
    val json: Json get() = Json.objectOf("expectedEpoch" to Json.of(expectedEpoch), "ownedFields" to Json.Arr(ownedFields.map(OwnedField::json)),
        "unchangedCreatedRecords" to Json.Arr(unchangedCreatedRecords.map(CreatedRecordProof::json)),
        "unchangedCreatedScopes" to Json.Arr(unchangedCreatedScopes.map(CreatedScopeProof::json)))

    // The first condition the evidence breaks against the scopes as stored, or null: another epoch, an owned field another write
    // moved, a created record or a created scope changed since.
    fun skip(row: (RecordAddress) -> Row?, seq: (ScopeRef) -> Long?, epoch: String): String? {
        if (expectedEpoch != epoch) return "epoch-changed"
        if (ownedFields.any { (target, version) -> row(target.record)?.version(target.slot) != version }) return "version-changed"
        if (unchangedCreatedRecords.any { proof -> row(proof.record).let { it?.lattice?.life?.isAlive != true || it.seq != proof.rowSeq || it.footprint != proof.footprint } })
            return "record-changed"
        if (unchangedCreatedScopes.any { seq(it.scope) != it.seq }) return "scope-changed"
        return null
    }

    companion object {
        fun read(registry: Registry, json: Json): Evidence {
            json.expectKeys(listOf("expectedEpoch", "ownedFields", "unchangedCreatedRecords", "unchangedCreatedScopes"))
            return Evidence(json.member("expectedEpoch").epoch(),
                json.member("ownedFields").arr().map { item ->
                    item.expectKeys(listOf("target", "version"))
                    val target = RecordSlot.read(item.member("target")).also { it.record.check(registry) }
                    OwnedField(target, SlotVersion.read(target.slot, item.member("version")))
                },
                json.member("unchangedCreatedRecords").arr().map { item ->
                    item.expectKeys(listOf("record", "rowSeq", "footprint"))
                    val record = RecordAddress.read(item.member("record"))
                    CreatedRecordProof(record, item.member("rowSeq").positive(), readFootprint(record.check(registry), item.member("footprint")))
                },
                json.member("unchangedCreatedScopes").arr().map { item ->
                    item.expectKeys(listOf("scope", "seq"))
                    val scope = ScopeRef(item.member("scope"))
                    require(scope.tree != null && registry.governingType?.let { registry.isId(Json.of(scope.tree!!), it) } == true)
                    CreatedScopeProof(scope, item.member("seq").long(0))
                })
        }
    }
}
