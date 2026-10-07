package works.windmill.sync.modelserver

import works.windmill.sync.core.*

// null is a server stamp slot; client slots always carry a non-unset stamp.
data class PlannedRegister(val value: Json, val stamp: Stamp?)
data class PlannedLife(val state: String, val stamp: Stamp?)
data class TextReplacement(val text: String, val archiveNonempty: Boolean = false, val archive: Json = Json.objectOf())
data class PlannedDelta(val key: RecordKey, val op: String, val life: PlannedLife? = null, val born: Stamp? = null,
    val mintsBorn: Boolean = false, val fields: Map<String, PlannedRegister> = emptyMap(), val texts: Map<String, TextWrite> = emptyMap(),
    val serials: Map<String, Json> = emptyMap(), val replacements: Map<String, TextReplacement> = emptyMap()) {
    val serverRegisters: List<String> get() = buildList {
        if (life != null && life.stamp == null) add("life"); if (mintsBorn) add("born")
        addAll(fields.filterValues { it.stamp == null }.keys.sorted())
    }
    fun given(name: String): Stamp? = when (name) { "life" -> life?.stamp; "born" -> born; else -> fields[name]?.stamp }
    fun minted(stamp: Stamp?): Delta = Delta(key, Lattice(life?.let { Life(it.state, it.stamp ?: stamp!!) }, if (mintsBorn) stamp!! else born,
        fields.mapValues { Register(it.value.value, it.value.stamp ?: stamp!!) }), texts)
    companion object {
        fun create(key: RecordKey, fields: Map<String, Json> = emptyMap()) = PlannedDelta(key, "create", PlannedLife("alive", null), mintsBorn = true, fields = fields.mapValues { PlannedRegister(it.value, null) })
        fun update(key: RecordKey, born: Stamp?, fields: Map<String, Json>) = PlannedDelta(key, if (born == null) "write" else "update", born = born, fields = fields.mapValues { PlannedRegister(it.value, null) })
        fun delete(key: RecordKey, born: Stamp?) = PlannedDelta(key, if (born == null) "put" else "delete", PlannedLife("dead", null), born = born)
        fun copy(row: Row): PlannedDelta {
            val life = row.lattice.life?.let { PlannedLife(it.state, it.stamp) }
            val born = if (row.lattice.born == null) null else life?.stamp
            return PlannedDelta(row.key, if (born != null) "create" else if (life != null) "put" else "write", life, born, fields = row.lattice.fields.mapValues { PlannedRegister(it.value.value, it.value.stamp) })
        }
    }
}
data class CheckedCommand(val definition: CommandDef, val args: Map<String, Json>) { val name get() = definition.name; fun string(name: String) = (args[name] as? Json.Str)?.value ?: "" }
data class CheckedIntent(val scope: ScopeRef, val deltas: List<PlannedDelta>, val guards: List<Guard>, val command: CheckedCommand?)
fun Json.with(vararg members: Pair<String, Json?>): Json = Json.Obj(obj().toMutableMap().apply { for ((key, value) in members) if (value == null) remove(key) else put(key, value) }.toList())
private fun Json.holdsNul(): Boolean = when (this) { is Json.Str -> '\u0000' in value; is Json.Arr -> values.any { it.holdsNul() }; is Json.Obj -> members.any { '\u0000' in it.key || it.value.holdsNul() }; else -> false }

object IdentityRules {
    fun op(type: TypeDef, life: PlannedLife?, born: Stamp?, mintsBorn: Boolean = false): String? = when {
        type.hasBorn -> if (born == null && !mintsBorn) null else if (life == null) { if (mintsBorn) null else "update" }
            else if (life.state == "alive" && life.stamp == null && mintsBorn) "create"
            else if (mintsBorn) null else if (life.state == "dead") "delete" else if (life.stamp == born) "create" else "revive"
        type.identity == "keyed" && type.life -> if (life != null && born == null && !mintsBorn) "put" else null
        else -> if (life == null && born == null && !mintsBorn) "write" else null
    }
    // apply / ok / refusal code.
    fun verdict(op: String, state: IdState, born: Stamp?, revivable: Boolean): String {
        val same = born != null && born == state.row?.lattice?.born
        return when (op) {
            "put", "write" -> "apply"
            "create" -> when (state.state) { "none" -> "apply"; "foreign" -> "id-taken"; "alive" -> if (same) "apply" else "id-taken"; else -> if (same) "ok" else "id-spent" }
            "update" -> when { state.state in listOf("none", "foreign") || !same -> "unknown-record"; state.isAlive -> "apply"; else -> "record-dead" }
            "delete" -> when { state.state == "none" || same -> "apply"; state.isAlive -> "unknown-record"; else -> "ok" }
            "revive" -> when { !same -> "unknown-record"; state.isAlive || revivable -> "apply"; else -> "id-spent" }
            else -> "invalid"
        }
    }
}
object IntentShape {
    fun check(json: Json, replica: Boolean, registry: Registry, now: Long): CheckedIntent = try {
        json.expectKeys(listOf("scope"), listOf("n", "d", "guard", "cmd", "gestureId")); require(!json.holdsNul())
        val scope = ScopeRef(json.member("scope")); val kind = registry.scopeKind(scope) ?: throw Refusal("invalid")
        if (scope.tree != null) require(registry.governingType?.let { registry.isId(Json.of(scope.tree!!), it) } == true)
        json["gestureId"]?.str()
        val deltas = json["d"]?.arr()?.map { delta(it, replica, registry, kind) }.orEmpty()
        require(deltas.map { it.key }.distinct().size == deltas.size)
        val guards = json["guard"]?.arr()?.map { value ->
            value.expectKeys(listOf("field", "id", "stamp", "t")); val guard = Guard(value); val type = registry.type(guard.key.type)
            require(type?.scope == kind && registry.isId(guard.key.id.json, type) && type.fields[guard.field]?.isLattice == true && guard.stamp != Stamp.UNSET)
            guard
        }.orEmpty()
        val command = json["cmd"]?.let { value ->
            value.expectKeys(listOf("args", "name")); val def = registry.command(value.member("name").str()) ?: throw Refusal("invalid")
            val args = value.member("args").obj(); require(def.scope == kind && args.keys.all { it in def.args })
            for ((name, arg) in def.args) {
                val input = args[name]; if (input == null) { require(arg.optional); continue }
                require(arg.domain?.admits(input) != false)
                require(when { arg.ref != null -> registry.isId(input, registry.type(arg.ref!!)!!); arg.type in listOf("time", "instant") -> input is Json.Num && input.long(0) >= 0; else -> true })
            }
            CheckedCommand(def, args)
        }
        require(deltas.isNotEmpty() || command != null)
        val bound = now + Constants.MAX_SKEW_MS
        if (deltas.any { delta -> (listOfNotNull(delta.life?.stamp, delta.born) + delta.fields.values.mapNotNull { it.stamp }).any { it.ms > bound } }) throw Refusal("clock-skew")
        val clamped = deltas.map { delta -> delta.copy(fields = delta.fields.mapValues { (name, reg) ->
            if (registry.type(delta.key.type)?.fields?.get(name)?.kind == "time" && reg.value.long() > bound) reg.copy(value = Json.of(now)) else reg
        }) }
        val checkedCommand = command?.let { cmd -> cmd.copy(args = cmd.args.mapValues { (name, value) ->
            when (cmd.definition.args.getValue(name).type) {
                "time" -> if (value.long() > bound) Json.of(now) else value
                "instant" -> { if (value.long() > bound) throw Refusal("invalid"); value }; else -> value
            }
        }) }
        CheckedIntent(scope, clamped, guards, checkedCommand)
    } catch (refusal: Refusal) { throw refusal } catch (_: IllegalArgumentException) { throw Refusal("invalid") }
    private fun slot(value: Json, replica: Boolean): Stamp? {
        if (value === Json.Null && !replica) return null
        return Stamp(value.str()).also { require(it != Stamp.UNSET) }
    }
    private fun delta(json: Json, replica: Boolean, registry: Registry, kind: String): PlannedDelta {
        json.expectKeys(listOf("t", "id"), listOf("life", "born", "f", "x"))
        val key = json.recordKey; val type = registry.type(key.type) ?: throw Refusal("invalid")
        require(type.scope == kind && registry.isId(key.id.json, type))
        val life = json["life"]?.arr()?.also { require(it.size == 2 && it[0].str() in listOf("alive", "dead")) }?.let { PlannedLife(it[0].str(), slot(it[1], replica)) }
        val born = json["born"]?.let { slot(it, replica) }; val mint = json["born"] === Json.Null
        val op = IdentityRules.op(type, life, born, mint) ?: throw Refusal("invalid")
        val fields = json["f"]?.obj()?.mapValues { (name, value) ->
            val field = type.fields[name] ?: throw Refusal("invalid"); val pair = value.arr()
            require(field.isLattice && (!replica || field.writer == "client") && pair.size == 2 && registry.admits(pair[0], field))
            PlannedRegister(pair[0], slot(pair[1], replica))
        }.orEmpty()
        val texts = json["x"]?.obj()?.mapValues { (name, value) ->
            val field = type.fields[name] ?: throw Refusal("invalid")
            require(field.kind == "text" && (!replica || field.writer == "client")); value.expectKeys(listOf("base", "text"))
            val base = value.member("base"); require(base.obj().size == 1)
            base["rev"]?.long(0) ?: base.member("text").str()
            TextWrite(value)
        }.orEmpty()
        if (type.json["wholePut"]?.bool() == true) {
            require(life != null)
            if (life.state == "dead") require(fields.isEmpty()) else {
                require(type.fields.values.filter { it.writer == "client" && it.isLattice }.all { it.name in fields })
                require(fields.values.all { it.stamp == life.stamp })
            }
        }
        return PlannedDelta(key, op, life, born, mint, fields, texts)
    }
}
