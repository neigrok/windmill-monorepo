package works.windmill.sync.core

data class RecordID(val json: Json) : Comparable<RecordID> {
    constructor(id: String) : this(Json.of(id))
    constructor(parts: List<String>) : this(Json.Arr(parts.map(Json::of)))
    init {
        if (json !is Json.Str && (json !is Json.Arr || json.values.isEmpty() || json.values.any { it !is Json.Str })) throw JsonError("record-id")
    }
    val text: String get() = json.jcs
    val string: String? get() = (json as? Json.Str)?.value
    val parts: List<String>? get() = (json as? Json.Arr)?.values?.map { it.str() }
    override fun compareTo(other: RecordID): Int = compareBytes(text, other.text)
    override fun toString(): String = string ?: text
    companion object {
        fun pair(a: String, b: String): RecordID = RecordID(listOf(a, b))
        fun fromText(text: String): RecordID = RecordID(Json.parse(text))
    }
}

data class RecordKey(val type: String, val id: RecordID) : Comparable<RecordKey> {
    val json: Json get() = Json.array(Json.of(type), id.json)
    override fun compareTo(other: RecordKey): Int = compareBytes(type, other.type).takeIf { it != 0 } ?: id.compareTo(other.id)
    override fun toString(): String = "$type $id"
}

object AccountID {
    fun isWellFormed(id: String): Boolean = id.encodeToByteArray().size <= Constants.ACCOUNT_ID_BYTES &&
        Json.of(id).jcs.encodeToByteArray().size == id.encodeToByteArray().size + 2
    val widest: String = "a".repeat(Constants.ACCOUNT_ID_BYTES)
}

data class ScopeRef(val kind: Kind) : Comparable<ScopeRef> {
    sealed interface Kind {
        data class Product(val name: String) : Kind
        data class Tree(val id: String) : Kind
        data class Overlay(val id: String) : Kind
        data class Device(val product: String) : Kind
    }
    constructor(text: String) : this(decode(text))
    constructor(json: Json) : this(json.str())
    val text: String get() = when (val kind = kind) {
        is Kind.Product -> "self/${kind.name}"
        is Kind.Tree -> "tree/${kind.id}"
        is Kind.Overlay -> "self/overlay/${kind.id}"
        is Kind.Device -> "device/${kind.product}"
    }
    val tree: String? get() = when (val kind = kind) { is Kind.Tree -> kind.id; is Kind.Overlay -> kind.id; else -> null }
    val json: Json get() = Json.of(text)
    override fun equals(other: Any?): Boolean = other is ScopeRef && text == other.text
    override fun hashCode(): Int = text.hashCode()
    override fun compareTo(other: ScopeRef): Int = compareBytes(text, other.text)
    override fun toString(): String = text
    companion object {
        fun product(name: String): ScopeRef = ScopeRef(Kind.Product(name))
        fun tree(id: String): ScopeRef = ScopeRef(Kind.Tree(id))
        fun overlay(id: String): ScopeRef = ScopeRef(Kind.Overlay(id))
        fun device(product: String): ScopeRef = ScopeRef(Kind.Device(product))
        fun decode(text: String): Kind {
            val parts = text.split('/')
            if (text.any { it.code !in 32..126 } || parts.any { it.isEmpty() }) throw JsonError("scope-ref")
            return when {
                parts.size == 3 && parts[0] == "self" && parts[1] == "overlay" -> Kind.Overlay(parts[2])
                parts.size == 2 && parts[0] == "self" -> Kind.Product(parts[1])
                parts.size == 2 && parts[0] == "tree" -> Kind.Tree(parts[1])
                parts.size == 2 && parts[0] == "device" -> Kind.Device(parts[1])
                else -> throw JsonError("scope-ref")
            }
        }
    }
}

data class TextState(val text: String, val rev: Long, val merged: Boolean) {
    constructor(json: Json) : this(json.member("text").str(), json.member("rev").long(), json.member("merged").bool())
    val json: Json get() = Json.objectOf("text" to Json.of(text), "rev" to Json.of(rev), "merged" to Json.of(merged))
}

data class Row(val key: RecordKey, val lattice: Lattice = Lattice(), val texts: Map<String, TextState> = emptyMap(),
    val serials: Map<String, Json> = emptyMap(), val seq: Long, val rc: Long? = null, val ru: Long? = null) {
    constructor(json: Json) : this(RecordKey(json.member("t").str(), RecordID(json.member("id"))), Lattice(json),
        readMap(json["x"], ::TextState), readMap(json["v"]) { it }, json.member("seq").long(), json["rc"]?.long(), json["ru"]?.long())
    val isAlive: Boolean get() = lattice.life?.isAlive ?: true
    val stamps: List<Stamp> get() = lattice.stamps
    val json: Json get() = Json.Obj(buildList {
        add("t" to Json.of(key.type)); add("id" to key.id.json); add("seq" to Json.of(seq))
        addAll(lattice.json.obj().toList())
        if (texts.isNotEmpty()) add("x" to Json.Obj(texts.map { it.key to it.value.json }))
        if (serials.isNotEmpty()) add("v" to Json.Obj(serials.toList()))
        rc?.let { add("rc" to Json.of(it)) }; ru?.let { add("ru" to Json.of(it)) }
    })
}

sealed interface TextBase {
    val json: Json
    data class Rev(val rev: Long) : TextBase { override val json: Json get() = Json.objectOf("rev" to Json.of(rev)) }
    data class Text(val text: String) : TextBase { override val json: Json get() = Json.objectOf("text" to Json.of(text)) }
    companion object {
        fun fromJson(json: Json): TextBase = json["rev"]?.let { Rev(it.long()) } ?: Text(json.member("text").str())
    }
}

data class TextWrite(val text: String, val base: TextBase) {
    constructor(json: Json) : this(json.member("text").str(), TextBase.fromJson(json.member("base")))
    val json: Json get() = Json.objectOf("text" to Json.of(text), "base" to base.json)
}

data class Delta(val key: RecordKey, val lattice: Lattice = Lattice(), val texts: Map<String, TextWrite> = emptyMap()) {
    constructor(json: Json) : this(RecordKey(json.member("t").str(), RecordID(json.member("id"))), Lattice(json), readMap(json["x"], ::TextWrite))
    val json: Json get() = Json.Obj(buildList {
        add("t" to Json.of(key.type)); add("id" to key.id.json); addAll(lattice.json.obj().toList())
        if (texts.isNotEmpty()) add("x" to Json.Obj(texts.map { it.key to it.value.json }))
    })
    val creates: Boolean get() = lattice.life?.let { it.isAlive && it.stamp == lattice.born } ?: false
    val removes: Boolean get() = lattice.life?.isAlive == false
}

data class Guard(val key: RecordKey, val field: String, val stamp: Stamp?) {
    constructor(json: Json) : this(RecordKey(json.member("t").str(), RecordID(json.member("id"))), json.member("field").str(),
        json.member("stamp").orNull()?.str()?.let(::Stamp))
    val json: Json get() = Json.objectOf("t" to Json.of(key.type), "id" to key.id.json, "field" to Json.of(this.field), "stamp" to (stamp?.json ?: Json.Null))
}

data class Command(val name: String, val args: Json) {
    constructor(json: Json) : this(json.member("name").str(), json.member("args"))
    val json: Json get() = Json.objectOf("name" to Json.of(name), "args" to args)
}

data class Intent(val scope: ScopeRef, val n: Long? = null, val deltas: List<Delta> = emptyList(),
    val guards: List<Guard> = emptyList(), val command: Command? = null, val gestureId: String? = null) {
    constructor(json: Json) : this(ScopeRef(json.member("scope")), json["n"]?.long(), json["d"]?.arr()?.map(::Delta) ?: emptyList(),
        json["guard"]?.arr()?.map(::Guard) ?: emptyList(), json["cmd"]?.let(::Command), json["gestureId"]?.str())
    val json: Json get() = Json.Obj(buildList {
        add("scope" to scope.json); n?.let { add("n" to Json.of(it)) }
        if (deltas.isNotEmpty()) add("d" to Json.Arr(deltas.map { it.json }))
        if (guards.isNotEmpty()) add("guard" to Json.Arr(guards.map { it.json }))
        command?.let { add("cmd" to it.json) }; gestureId?.let { add("gestureId" to Json.of(it)) }
    })
}

fun <V> readMap(json: Json?, decode: (Json) -> V): Map<String, V> = json?.obj()?.mapValues { (name, value) ->
    if (name.any { it.code !in 32..126 }) throw JsonError("map-name")
    decode(value)
} ?: emptyMap()

val Registry.governingType: TypeDef? get() = types.firstOrNull { it.json["governs"]?.str() == "tree" }
fun Registry.scopeKind(scope: ScopeRef): String? {
    try { ScopeRef(scope.text) } catch (_: JsonError) { return null }
    return when (val kind = scope.kind) {
        is ScopeRef.Kind.Product -> if (kind.name in products) "product:${kind.name}" else null
        is ScopeRef.Kind.Tree -> "tree"
        is ScopeRef.Kind.Overlay -> "overlay"
        is ScopeRef.Kind.Device -> null
    }
}
fun Registry.product(scope: ScopeRef): String? = when (val kind = scope.kind) {
    is ScopeRef.Kind.Product -> kind.name.takeIf { it in products }
    is ScopeRef.Kind.Device -> kind.product.takeIf { it in products }
    else -> governingType?.scope?.removePrefix("product:")
}
fun Registry.governingRecord(scope: ScopeRef): Pair<RecordKey, ScopeRef>? {
    val tree = scope.tree ?: return null
    val type = governingType ?: return null
    return RecordKey(type.name, RecordID(tree)) to ScopeRef.product(type.scope.removePrefix("product:"))
}
fun Registry.scopeOfType(type: String, from: ScopeRef): ScopeRef? = when (val scope = type(type)?.scope) {
    "tree" -> from.tree?.let(ScopeRef::tree)
    "overlay" -> from.tree?.let(ScopeRef::overlay)
    null -> null
    else -> ScopeRef.product(scope.removePrefix("product:"))
}
fun Registry.lives(type: String, scope: ScopeRef): Boolean = scopeKind(scope)?.let { it == type(type)?.scope } ?: false
fun TypeDef.references(id: RecordID, values: Map<String, Json>): List<RecordKey> = buildList {
    json["key"]?.let { key ->
        key["ref"]?.let { add(RecordKey(it.str(), id)) }
        key["tuple"]?.arr()?.zip(id.parts ?: emptyList())?.forEach { (part, value) -> add(RecordKey(part.member("ref").str(), RecordID(value))) }
    }
    for ((name, field) in fields) if (field.ref != null && values[name] is Json.Str) add(RecordKey(field.ref, RecordID(values.getValue(name))))
}
