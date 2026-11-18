package works.windmill.domain.kit

import works.windmill.sync.api.Change
import works.windmill.sync.api.DeviceWrite
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.api.OrderAnchor
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.RegisterRef
import works.windmill.sync.api.ScopedPrediction
import works.windmill.sync.api.TextEdit
import works.windmill.sync.api.UndoSegment
import works.windmill.sync.core.Command
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.EvidenceSelection
import works.windmill.sync.core.RecordAddress
import works.windmill.sync.core.RecordKey
import works.windmill.sync.core.RecordSlot
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Slot
import works.windmill.sync.core.TypeDef
import works.windmill.sync.core.compareBytes
import works.windmill.sync.core.lives

interface ServerCommand {
    val name: String
    val specs: List<ValueSpec>
    val args: Map<String, Json>
}

// §8.4: the values a product expects a command to write, server-written fields included, unvalidated. A prediction names
// the scope it writes when that is not the plan's own: a command with scoped effects (E-7) predicts in every scope it changes.
data class Prediction(val kind: Kind, val type: String, val id: RecordID, val values: Map<String, Json>, val texts: Map<String, String> = emptyMap(),
    val scope: ScopeRef? = null) {
    enum class Kind { Create, Update, Write, Remove }
    companion object {
        fun <E : Entity<E>> create(type: EntityType<E>, id: Id<E>, values: Map<String, Json>, scope: ScopeRef? = null): Prediction =
            Prediction(Kind.Create, type.type, id.record, values, scope = scope)
        fun <E : Entity<E>> update(type: EntityType<E>, id: Id<E>, values: Map<String, Json>, scope: ScopeRef? = null): Prediction =
            Prediction(Kind.Update, type.type, id.record, values, scope = scope)
        fun <E : Entity<E>> write(type: EntityType<E>, id: Id<E>, values: Map<String, Json>, texts: Map<String, String> = emptyMap(), scope: ScopeRef? = null): Prediction =
            Prediction(Kind.Write, type.type, id.record, values, texts, scope)
        fun <E : Entity<E>> remove(type: EntityType<E>, id: Id<E>, scope: ScopeRef? = null): Prediction = Prediction(Kind.Remove, type.type, id.record, emptyMap(), scope = scope)
    }
    fun change(registry: Registry): Change = when (kind) {
        Kind.Create -> Change.create(type, NewID.Given(id), values)
        Kind.Update -> Change.update(type, id, values)
        Kind.Write -> Change.write(type, id, values, texts.mapValues { TextEdit(it.value) })
        Kind.Remove -> if (registry.type(type)?.identity == "keyed") Change.put(type, id, false) else Change.delete(type, id)
    }
}

class PlanError(val rule: Int, val reason: String) : IllegalArgumentException("plan rule $rule: $reason")

// §9.6: one slot of a record an Undo recipe names (a field, a text or its life) in its own scope or, null, the plan's.
class UndoTarget private constructor(val ref: RecordRef, val slot: Slot, val scope: ScopeRef?) {
    // The slot in the engine's form, in `scope` unless the target names its own.
    fun address(scope: ScopeRef): RecordSlot = RecordSlot(RecordAddress(this.scope ?: scope, ref.key), slot)
    companion object {
        fun <E : Entity<E>> field(id: Id<E>, name: String, scope: ScopeRef? = null) = UndoTarget(id.ref, Slot(Slot.Kind.field, name), scope)
        fun <E : Entity<E>> text(id: Id<E>, name: String, scope: ScopeRef? = null) = UndoTarget(id.ref, Slot(Slot.Kind.text, name), scope)
        fun <E : Entity<E>> life(id: Id<E>, scope: ScopeRef? = null) = UndoTarget(id.ref, Slot(Slot.Kind.life), scope)
    }
}

// §9.6: a field target and the value its product treats as unset, for a slot unset before the act; null names none, Json.Null the value null.
data class UndoField(val target: UndoTarget, val defaultValue: Json? = null)

// §9.6: what an Undo of a plan's writes runs (engine §7.3 Undo of an act): earlier values of client fields, texts and lives by the scope's
// restore command, a record the plan creates deleted again while unchanged, or a product inverse command over evidence the engine builds.
sealed interface UndoRecipe {
    data class Fields(val restoreCommand: String, val targets: List<UndoField>) : UndoRecipe
    data class CreatedRecord(val restoreCommand: String, val ref: RecordRef, val scope: ScopeRef? = null) : UndoRecipe
    data class Product(val command: String, val input: Json, val ownedFields: List<UndoTarget> = emptyList(),
        val unchangedCreatedRecords: List<Pair<RecordRef, ScopeRef?>> = emptyList(), val unchangedCreatedScopes: List<ScopeRef> = emptyList()) : UndoRecipe
    companion object {
        fun fields(restoreCommand: String, vararg targets: UndoTarget): UndoRecipe = Fields(restoreCommand, targets.map { UndoField(it) })
        fun <E : Entity<E>> createdRecord(restoreCommand: String, id: Id<E>): UndoRecipe = CreatedRecord(restoreCommand, id.ref)
    }
}

class Plan {
    private val writing: MutableList<Operation> = mutableListOf()
    val operations: List<Operation> get() = writing.toList()
    var command: Command? = null
        private set
    val predictions: MutableList<Prediction> = mutableListOf()
    val deviceWrites: MutableList<DeviceWrite> = mutableListOf()
    var supersededGestures: List<String> = emptyList()
        private set
    private val undoRecipes: MutableList<UndoRecipe> = mutableListOf()
    private var undoEvidence = false
    // §9.6: the recipes an Undo of the plan's act runs, empty for a segment named as evidence alone, or null when the plan does not opt in.
    val undo: List<UndoRecipe>? get() = undoRecipes.toList().takeIf { it.isNotEmpty() || undoEvidence }
    constructor()
    constructor(running: ServerCommand, predicting: List<Prediction> = emptyList()) {
        var args: Json = Json.Obj(running.args.toList())
        for (spec in running.specs) {
            val prefix = "${running.name}."
            check(spec.path.startsWith(prefix)) { "the spec ${spec.path} is not at ${running.name}.<argument>" }
            args = applying(spec, args, spec.path.removePrefix(prefix).split('.'), Path(""))
        }
        args.firstNul(Path(""))?.let { throw Violation("${running.name}.${it.text.substringBefore('.')}", it, Violation.Reason.Nul) }
        command = Command(running.name, args)
        predictions += predicting
    }
    fun <E : Writable<E>> create(value: Valid<E>, fields: List<String>? = null, from: E? = null) {
        append(Operation.Kind.Create(fields?.uniqueInByteOrder(), from?.fields()?.toMap()), value)
    }
    fun <E : Writable<E>> insert(value: Valid<E>, below: RecordID?) { append(Operation.Kind.Insert(below), value) }
    fun <E : Writable<E>> place(value: Valid<E>, below: RecordID?) = insert(value, below)
    fun <E : Writable<E>> update(value: Valid<E>, fields: List<String>? = null, from: E? = null, guarded: Boolean = false) {
        append(Operation.Kind.Update((fields ?: value.checked).uniqueInByteOrder(), from?.fields()?.toMap(), guarded), value)
    }
    fun <E : Writable<E>> revive(value: Valid<E>, fields: List<String>, from: E? = null, guarded: Boolean = false) {
        append(Operation.Kind.Revive(fields.uniqueInByteOrder(), from?.fields()?.toMap(), guarded), value)
    }
    fun <E : Entity<E>> remove(id: Id<E>) {
        check(id.entity is RemovableType<*>) { "${id.entity.type} is not removable" }
        writing += Operation(Operation.Kind.Remove, EntityFacts(id.entity), id.record)
    }
    fun <E : Entity<E>> move(id: Id<E>, below: Id<E>?) {
        check(id.entity is OrderedType<*>) { "${id.entity.type} is unordered" }
        writing += Operation(Operation.Kind.Move(below?.record), EntityFacts(id.entity), id.record)
    }
    fun <E : Entity<E>> guardRead(id: Id<E>, fields: List<String>) { writing += Operation(Operation.Kind.GuardRead(fields.uniqueInByteOrder()), EntityFacts(id.entity), id.record) }
    fun supersede(gestureIds: List<String>) { supersededGestures = gestureIds.toList() }
    fun device(key: String, value: Json?) { deviceWrites += DeviceWrite(key, value) }
    // §9.6: opts the plan's act into Undo after its hold, with the recipes an Undo runs.
    fun undoBy(vararg recipes: UndoRecipe) {
        check(recipes.isNotEmpty()) { "undoBy takes Undo recipes" }
        undoRecipes += recipes
    }
    // §9.6: names the plan's segment for its act's Undo with no recipe of its own. The engine journals the segment's receipts, which prove
    // what another segment's command recipe names as evidence, such as a scope the act created and this segment wrote.
    fun evidenceForUndo() { undoEvidence = true }
    // The plan's recipes in the engine's form as act segment `index` (engine §7.3); a target or record without a scope lives in `scope`.
    fun undoSegment(index: Int, scope: ScopeRef): UndoSegment? = undo?.let { recipes -> UndoSegment(index, recipes.map { recipe -> when (recipe) {
        is UndoRecipe.Fields -> works.windmill.sync.core.UndoRecipe.Fields(recipe.restoreCommand,
            recipe.targets.map { works.windmill.sync.core.UndoRecipe.FieldTarget(it.target.address(scope), it.defaultValue) })
        is UndoRecipe.CreatedRecord -> works.windmill.sync.core.UndoRecipe.CreatedRecord(recipe.restoreCommand, RecordAddress(recipe.scope ?: scope, recipe.ref.key))
        is UndoRecipe.Product -> works.windmill.sync.core.UndoRecipe.Product(recipe.command, recipe.input, EvidenceSelection(recipe.ownedFields.map { it.address(scope) },
            recipe.unchangedCreatedRecords.map { (ref, at) -> RecordAddress(at ?: scope, ref.key) }, recipe.unchangedCreatedScopes))
    } }) }
    private fun <E : Writable<E>> append(kind: Operation.Kind, value: Valid<E>) {
        writing += Operation(kind, EntityFacts(value.type), value.id.record, value.written, value.checked)
    }
    val isHeld: Boolean get() = operations.any { it.kind == Operation.Kind.Remove && it.entity.heldRemoval == true }
    fun gesture(scope: ScopeRef, registry: Registry): Gesture {
        val changes = operations.mapNotNull { it.change(scope, registry) }
        val keys = operations.filter { it.writes }.map { RecordKey(it.entity.type, it.recordID(registry)) }
        if (keys.distinct().size != keys.size) throw PlanError(2, "two operations name one record")
        if (isHeld && (operations.any { it.kind != Operation.Kind.Remove || it.entity.heldRemoval != true } || command != null || predictions.isNotEmpty()))
            throw PlanError(3, "a held plan contains more than held removals and device writes")
        val guards = operations.flatMap { operation ->
            val definition = registry.type(operation.entity.type)
            val fields = when (val kind = operation.kind) {
                is Operation.Kind.Update -> if (kind.guarded) kind.named.filter { definition?.fields?.get(it)?.isLattice == true } else emptyList()
                is Operation.Kind.Revive -> if (kind.guarded) kind.named.filter { definition?.fields?.get(it)?.isLattice == true } else emptyList()
                is Operation.Kind.GuardRead -> kind.fields.also { names ->
                    if (names.any { definition?.fields?.get(it)?.isLattice != true }) throw PlanError(6, "guard names no lattice register")
                }
                else -> emptyList()
            }
            fields.map { RegisterRef(operation.entity.type, operation.recordID(registry), it) }
        }.distinct().sortedWith { a, b ->
            compareBytes(a.type, b.type).takeIf { it != 0 } ?: a.id.compareTo(b.id).takeIf { it != 0 } ?: compareBytes(a.field, b.field)
        }
        val retire = operations.filter { it.creates && registry.type(it.entity.type)?.let { d -> d.identity == "keyed" && d.life } == true }
            .map { it.ref }.sortedWith { a, b -> compareBytes(a.type, b.type).takeIf { it != 0 } ?: a.id.compareTo(b.id) }
        val predicted = predicted(scope, registry)
        val origin = predicted.getValue(scope)
        val others = predicted.keys.filter { it != scope }.sorted()
        return Gesture(changes, atomic = changes.size > 1, hold = isHeld, guards = guards, retire = retire,
            supersede = supersededGestures, command = command, predict = if (others.isEmpty()) origin else emptyList(), local = deviceWrites.toList(),
            scopedPredict = if (others.isEmpty()) null
                else listOfNotNull(origin.takeIf { it.isNotEmpty() }?.let { ScopedPrediction(scope, it) }) + others.map { ScopedPrediction(it, predicted.getValue(it)) })
    }
    // Rule 5: the command predicts the type, in a scope that holds it; a scope other than the plan's needs a command with scoped
    // effects. Each scope's changes, the plan's own always present.
    private fun predicted(scope: ScopeRef, registry: Registry): Map<ScopeRef, List<Change>> {
        val definition = command?.let { registry.command(it.name) }
        val groups = linkedMapOf<ScopeRef, MutableList<Change>>(scope to mutableListOf())
        for (prediction in predictions) {
            val target = prediction.scope ?: scope
            if (!registry.lives(prediction.type, target)) throw PlanError(5, "${prediction.type} is predicted outside its scope")
            if (target != scope && definition?.scopedEffects != true) throw PlanError(5, "${command?.name ?: "a plan"} predicts no other scope")
            if (definition?.predicts?.contains(prediction.type) != true) throw PlanError(5, "the command does not predict ${prediction.type}")
            groups.getOrPut(target) { mutableListOf() } += prediction.change(registry)
        }
        return groups
    }
    companion object {
        fun applying(spec: ValueSpec, json: Json, keys: List<String>, path: Path): Json = when (json) {
            is Json.Arr -> Json.Arr(json.values.mapIndexed { i, item -> applying(spec, item, keys, path + i) })
            is Json.Obj -> {
                val key = keys.firstOrNull()
                if (key == null || key !in json.members) json
                else Json.Obj((json.members + (key to applying(spec, json.members.getValue(key), keys.drop(1), path + key))).toList())
            }
            is Json.Str -> if (keys.isNotEmpty()) json else when (spec) {
                is TextSpec -> Json.of(spec.apply(json.value, path))
                is ChoiceSpec -> Json.of(spec.apply(json.value, path))
                else -> json
            }
            else -> json
        }
    }
}

data class Operation(val kind: Kind, val entity: EntityFacts, val id: RecordID,
    val values: Map<String, Json> = emptyMap(), val checked: List<String> = emptyList()) {
    sealed interface Kind {
        data class Create(val named: List<String>?, val base: Map<String, Json>?) : Kind
        data class Insert(val below: RecordID?) : Kind
        data class Update(val named: List<String>, val base: Map<String, Json>?, val guarded: Boolean) : Kind
        data class Revive(val named: List<String>, val base: Map<String, Json>?, val guarded: Boolean) : Kind
        data object Remove : Kind
        data class Move(val below: RecordID?) : Kind
        data class GuardRead(val fields: List<String>) : Kind
    }
    val ref: RecordRef get() = RecordRef(entity.type, id)
    val writes: Boolean get() = kind !is Kind.GuardRead
    val creates: Boolean get() = kind is Kind.Create || kind is Kind.Insert
    val anchor: RecordID? get() = when (val kind = kind) { is Kind.Insert -> kind.below; is Kind.Move -> kind.below; else -> null }
    fun recordID(registry: Registry): RecordID = registry.type(entity.type)?.let(::recordID) ?: id
    fun recordID(definition: TypeDef): RecordID = definition.json["singletonId"]?.str()?.let(::RecordID) ?: id
    fun change(scope: ScopeRef, registry: Registry): Change? {
        val d = registry.type(entity.type) ?: throw PlanError(0, "the registry has no type ${entity.type}")
        if ((entity.scope != null && entity.scope != scope) || !registry.lives(entity.type, scope)) throw PlanError(1, "${entity.type} lives outside $scope")
        return when (val kind = kind) {
            is Kind.Create -> {
                if (entity.isOrdered || (kind.named != null && d.hasBorn)) throw PlanError(4, "create does not place an ordered or partial minted or derived type")
                creation(d, kind.named ?: values.keys.toList().uniqueInByteOrder(), null, kind.base)
            }
            is Kind.Insert -> creation(d, values.keys.toList().uniqueInByteOrder(),
                OrderAnchor(entity.orderField ?: throw PlanError(4, "insert names an unordered type"), kind.below), null)
            is Kind.Update -> {
                if (kind.named.isEmpty()) throw PlanError(8, "an update names no field")
                for (name in kind.named) when (d.fields[name]?.kind) {
                    "const", "time" -> throw PlanError(7, "an update names a const or time field")
                    "text" -> if (kind.base == null) throw PlanError(7, "a text update has no base")
                }
                checkWhole(d, kind.named)
                val (values, texts) = split(kind.named, d, kind.base)
                when {
                    d.hasBorn -> Change.update(entity.type, id, values, texts)
                    d.identity == "keyed" && d.life -> Change.put(entity.type, id, null, values, texts)
                    else -> Change.write(entity.type, recordID(d), values, texts)
                }
            }
            is Kind.Revive -> {
                if (!d.hasBorn || d.json["revivable"]?.bool() != true) throw PlanError(0, "the type has no revivable life")
                if (kind.named.any { d.fields[it]?.kind in listOf("const", "time", "text") }) throw PlanError(7, "revive names a const, time or text field")
                val (values, _) = split(kind.named, d, kind.base)
                Change.revive(entity.type, id, values)
            }
            Kind.Remove -> when {
                d.hasBorn -> Change.delete(entity.type, id)
                d.identity == "keyed" && d.life -> Change.put(entity.type, id, false)
                else -> throw PlanError(0, "the type has no removable life")
            }
            is Kind.Move -> {
                if (d.identity == "singleton") throw PlanError(0, "a singleton has no order")
                Change.move(entity.type, id, OrderAnchor(entity.orderField ?: throw PlanError(0, "the type is unordered"), kind.below))
            }
            is Kind.GuardRead -> null
        }
    }
    private fun creation(d: TypeDef, names: List<String>, anchor: OrderAnchor?, base: Map<String, Json>?): Change {
        checkWhole(d, names)
        val (written, texts) = split(names, d, base)
        val values = if (d.hasBorn) written.filter { (name, value) -> value !== Json.Null || d.fields[name]?.kind != "time" } else written
        if (anchor != null && !d.hasBorn) throw PlanError(0, "an anchored create names a type without a birth identity")
        // Rule 8: a keyed type with life that declares no field is created by its presence alone.
        val presenceOnly = d.identity == "keyed" && d.life && d.fields.isEmpty()
        if (!d.hasBorn && names.isEmpty() && !presenceOnly) throw PlanError(8, "a keyed create writes no field")
        return when {
            d.hasBorn -> Change.create(entity.type, NewID.Given(id), values, texts, anchor)
            d.identity == "keyed" && d.life -> Change.put(entity.type, id, true, values, texts)
            else -> Change.write(entity.type, recordID(d), values, texts)
        }
    }
    private fun checkWhole(d: TypeDef, names: List<String>) {
        if (d.json["wholePut"]?.bool() == true && d.fields.any { (name, field) -> field.writer == "client" && field.isLattice && name !in names })
            throw PlanError(9, "a whole write leaves out a client field")
    }
    private fun split(names: List<String>, d: TypeDef, base: Map<String, Json>?): Pair<Map<String, Json>, Map<String, TextEdit>> {
        val values = linkedMapOf<String, Json>()
        val texts = linkedMapOf<String, TextEdit>()
        for (name in names) {
            val field = d.fields[name]
            if (field == null || field.writer != "client" || field.kind == "serial" || name == entity.orderField || name !in this.values || name !in checked)
                throw PlanError(6, "${entity.type}.$name is not a checked client field")
            val value = this.values.getValue(name)
            if (field.kind == "text") {
                val text = (value as? Json.Str)?.value ?: throw PlanError(6, "text field holds no text")
                val from = ((base?.get(name) ?: Json.of("")) as? Json.Str)?.value ?: throw PlanError(6, "base holds no text")
                texts[name] = TextEdit(text, from)
            } else values[name] = value
        }
        return values to texts
    }
}
