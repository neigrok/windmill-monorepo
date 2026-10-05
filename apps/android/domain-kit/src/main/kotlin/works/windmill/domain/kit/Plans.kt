package works.windmill.domain.kit

import works.windmill.sync.api.Change
import works.windmill.sync.api.DeviceWrite
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.api.OrderAnchor
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.RegisterRef
import works.windmill.sync.api.TextEdit
import works.windmill.sync.core.Command
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RecordKey
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.TypeDef
import works.windmill.sync.core.compareBytes
import works.windmill.sync.core.lives

interface ServerCommand {
    val name: String
    val specs: List<ValueSpec>
    val args: Map<String, Json>
}

data class Prediction(val kind: Kind, val type: String, val id: RecordID, val values: Map<String, Json>, val texts: Map<String, String> = emptyMap()) {
    enum class Kind { Create, Update, Write, Remove }
    companion object {
        fun <E : Entity<E>> create(type: EntityType<E>, id: Id<E>, values: Map<String, Json>): Prediction = Prediction(Kind.Create, type.type, id.record, values)
        fun <E : Entity<E>> update(type: EntityType<E>, id: Id<E>, values: Map<String, Json>): Prediction = Prediction(Kind.Update, type.type, id.record, values)
        fun <E : Entity<E>> write(type: EntityType<E>, id: Id<E>, values: Map<String, Json>, texts: Map<String, String> = emptyMap()): Prediction = Prediction(Kind.Write, type.type, id.record, values, texts)
        fun <E : Entity<E>> remove(type: EntityType<E>, id: Id<E>): Prediction = Prediction(Kind.Remove, type.type, id.record, emptyMap())
    }
}

class PlanError(val rule: Int, val reason: String) : IllegalArgumentException("plan rule $rule: $reason")

class Plan {
    private val writing: MutableList<Operation> = mutableListOf()
    val operations: List<Operation> get() = writing.toList()
    var command: Command? = null
        private set
    val predictions: MutableList<Prediction> = mutableListOf()
    val deviceWrites: MutableList<DeviceWrite> = mutableListOf()
    var supersededGestures: List<String> = emptyList()
        private set
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
    private fun <E : Writable<E>> append(kind: Operation.Kind, value: Valid<E>) {
        writing += Operation(kind, EntityFacts(value.type), value.id.record, value.written, value.checked)
    }
    val isHeld: Boolean get() = operations.any { it.kind == Operation.Kind.Remove && it.entity.heldRemoval == true }
    fun gesture(scope: ScopeRef, registry: Registry): Gesture {
        val changes = operations.mapNotNull { it.change(scope, registry) }
        val keys = operations.map { RecordKey(it.entity.type, it.recordID(registry)) }
        if (keys.distinct().size != keys.size) throw PlanError(2, "two operations name one record")
        if (isHeld && (operations.any { it.kind != Operation.Kind.Remove || it.entity.heldRemoval != true } || command != null || predictions.isNotEmpty()))
            throw PlanError(3, "a held plan contains more than held removals and device writes")
        val guards = operations.flatMap { operation ->
            val definition = registry.type(operation.entity.type)
            val fields = when (val kind = operation.kind) {
                is Operation.Kind.Update -> if (kind.guarded) kind.named.filter { definition?.fields?.get(it)?.isLattice == true } else emptyList()
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
        val predict = predictions.map { p ->
            if (command?.let { registry.command(it.name)?.predicts?.contains(p.type) } != true) throw PlanError(5, "the command does not predict ${p.type}")
            when (p.kind) {
                Prediction.Kind.Create -> Change.create(p.type, NewID.Given(p.id), p.values)
                Prediction.Kind.Update -> Change.update(p.type, p.id, p.values)
                Prediction.Kind.Write -> Change.write(p.type, p.id, p.values, p.texts.mapValues { TextEdit(it.value) })
                Prediction.Kind.Remove -> if (registry.type(p.type)?.identity == "keyed") Change.put(p.type, p.id, false) else Change.delete(p.type, p.id)
            }
        }
        return Gesture(changes, atomic = changes.size > 1, hold = isHeld, guards = guards, retire = retire,
            supersede = supersededGestures, command = command, predict = predict, local = deviceWrites.toList())
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
        if (entity.scope != scope || !registry.lives(entity.type, scope)) throw PlanError(1, "${entity.type} lives outside $scope")
        if (d.identity == "derived") throw PlanError(0, "the kit writes no derived type")
        return when (val kind = kind) {
            is Kind.Create -> {
                if (entity.isOrdered || (kind.named != null && d.identity == "minted")) throw PlanError(4, "create does not place an ordered or partial minted type")
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
                    d.identity == "minted" -> Change.update(entity.type, id, values, texts)
                    d.identity == "keyed" && d.life -> Change.put(entity.type, id, null, values, texts)
                    else -> Change.write(entity.type, recordID(d), values, texts)
                }
            }
            Kind.Remove -> when {
                d.identity == "minted" -> Change.delete(entity.type, id)
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
        val values = if (d.identity == "minted") written.filter { (name, value) -> value !== Json.Null || d.fields[name]?.kind != "time" } else written
        if (anchor != null && d.identity != "minted") throw PlanError(0, "an anchored create names a non-minted type")
        if (d.identity != "minted" && names.isEmpty()) throw PlanError(8, "a keyed create writes no field")
        return when {
            d.identity == "minted" -> Change.create(entity.type, NewID.Given(id), values, texts, anchor)
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
