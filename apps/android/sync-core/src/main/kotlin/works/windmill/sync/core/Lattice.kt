package works.windmill.sync.core

class JoinError(val code: String) : IllegalArgumentException(code)

data class Register(val value: Json, val stamp: Stamp) {
    constructor(json: Json) : this(json.arr().also { require(it.size == 2) }[0], Stamp(json.arr()[1].str()))
    val json: Json get() = Json.array(value, stamp.json)
}

data class Life(val state: String, val stamp: Stamp) {
    init { require(state == "alive" || state == "dead") }
    constructor(json: Json) : this(json.arr().also { require(it.size == 2) }[0].str(), Stamp(json.arr()[1].str()))
    val isAlive: Boolean get() = state == "alive"
    val json: Json get() = Json.array(Json.of(state), stamp.json)
}

class Lattice(val life: Life? = null, val born: Stamp? = null, fields: Map<String, Register> = emptyMap()) {
    val fields: Map<String, Register> = fields.toMap()
    constructor(json: Json) : this(
        json["life"]?.let(::Life), json["born"]?.str()?.let(::Stamp),
        json["f"]?.obj()?.mapValues { Register(it.value) } ?: emptyMap(),
    )
    init { require(fields.keys.all { name -> name.all { it.code in 32..126 } }) }
    val stamps: List<Stamp> get() = listOfNotNull(life?.stamp, born) + fields.values.map { it.stamp }
    val json: Json get() = Json.Obj(buildList {
        life?.let { add("life" to it.json) }
        born?.let { add("born" to it.json) }
        if (fields.isNotEmpty()) add("f" to Json.Obj(fields.map { it.key to it.value.json }))
    })
    override fun equals(other: Any?): Boolean = other is Lattice && json == other.json
    override fun hashCode(): Int = json.hashCode()
}

object Join {
    fun lww(a: Register?, b: Register?): Register? {
        if (a == null) return b
        if (b == null) return a
        if (a.stamp != b.stamp) return if (a.stamp > b.stamp) a else b
        return if (a.value.precedes(b.value)) b else a
    }
    fun fww(a: Register?, b: Register?): Register? {
        if (a == null) return b
        if (b == null) return a
        if (a.stamp != b.stamp) return if (a.stamp < b.stamp) a else b
        return if (b.value.precedes(a.value)) b else a
    }
    fun ranked(a: Register?, b: Register?, rank: Map<String, Long>): Register? {
        if (a == null) return b
        if (b == null) return a
        val rankA = (a.value as? Json.Str)?.value?.let(rank::get) ?: throw JoinError("unranked")
        val rankB = (b.value as? Json.Str)?.value?.let(rank::get) ?: throw JoinError("unranked")
        if (rankA != rankB) return if (rankA > rankB) a else b
        return lww(a, b)
    }
    fun life(a: Life?, b: Life?): Life? {
        if (a == null) return b
        if (b == null) return a
        if (a.stamp != b.stamp) return if (a.stamp > b.stamp) a else b
        return if (a.isAlive) a else b
    }
    fun born(a: Stamp?, b: Stamp?): Stamp? {
        if (a == null) return b
        if (b == null) return a
        return minOf(a, b)
    }
    fun register(field: FieldDef?, a: Register?, b: Register?): Register? {
        if (field == null) {
            if (a != null && b != null) throw JoinError("unknown-field-on-both-sides")
            return a ?: b
        }
        return when (field.kind) {
            "lww" -> lww(a, b)
            "ranked" -> ranked(a, b, field.rank)
            "fww", "const", "time" -> fww(a, b)
            else -> throw JoinError("not-joinable")
        }
    }
    fun record(type: TypeDef?, a: Lattice, b: Lattice): Lattice = Lattice(
        life(a.life, b.life), born(a.born, b.born),
        (a.fields.keys + b.fields.keys).associateWith { register(type?.fields?.get(it), a.fields[it], b.fields[it])!! },
    )
}
