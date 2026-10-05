package works.windmill.sync.core

class RegistryError(val code: String) : IllegalArgumentException(code)

enum class MeasureUnit {
    chars, bytes;
    fun length(text: String): Int = if (this == bytes) text.encodeToByteArray().size
        else text.length - text.count { it.code in 0xDC00..0xDFFF }
}

class Quantum(val step: Double) {
    init {
        val reciprocal = 1 / step
        require(step.isFinite() && step > 0 && (step == kotlin.math.floor(step) || (reciprocal.isFinite() && reciprocal == kotlin.math.floor(reciprocal))))
    }
    fun rounded(value: Double): Double {
        val result = if (step == kotlin.math.floor(step)) halfAway(value / step) * step
            else halfAway(value * (1 / step)) / (1 / step)
        return if (result == 0.0) 0.0 else result
    }
    fun holds(value: Double): Boolean = rounded(value) == value
    companion object {
        fun halfAway(value: Double): Double {
            val magnitude = kotlin.math.abs(value)
            val floor = kotlin.math.floor(magnitude)
            val rounded = floor + if (magnitude - floor >= 0.5) 1 else 0
            return if (value < 0) -rounded else rounded
        }
    }
}

data class Bounds(val unit: MeasureUnit, val min: Long? = null, val max: Long? = null) {
    fun admits(value: Json): Boolean {
        val size = unit.length((value as? Json.Str)?.value ?: value.jcs)
        return size.toLong() >= (min ?: 0) && size.toLong() <= (max ?: Long.MAX_VALUE)
    }
    companion object {
        fun read(json: Json): Bounds? {
            val unit = json["unit"]?.str()
            if (unit == null) {
                if (json["min"] != null || json["max"] != null) throw RegistryError("bound-unit")
                return null
            }
            return Bounds(MeasureUnit.valueOf(unit), json["min"]?.long(0), json["max"]?.long(1))
        }
    }
}

// The portable pattern parser rejects dialect extensions before delegating whole-value matching to Kotlin Regex.
class Pattern(val source: String) {
    val regex: Regex
    init {
        if (source.length < 2 || source.first() != '^' || source.last() != '$' || source.any { it.code !in 32..126 }) {
            throw RegistryError("pattern")
        }
        PatternSyntax(source.substring(1, source.length - 1)).parse()
        regex = Regex(source)
    }
    fun matches(text: String): Boolean = regex.matches(text)
}

internal class PatternSyntax(val body: String) {
    var at = 0
    val special = "^$\\.*+?()[]{}|"
    fun fail(): Nothing = throw RegistryError("pattern")
    fun parse() { sequence(false); if (at != body.length) fail() }
    fun sequence(group: Boolean) {
        while (at < body.length && body[at] != ')') {
            if (body[at] == '|') {
                if (!group) fail()
                at++; continue
            }
            atom()
            if (at == body.length) continue
            when (body[at]) {
                '?', '*', '+' -> at++
                '{' -> {
                    at++
                    val min = number()
                    var max: Int? = min
                    if (body.getOrNull(at) == ',') {
                        at++
                        max = if (body.getOrNull(at) == '}') null else number()
                    }
                    if (body.getOrNull(at++) != '}' || (max != null && max < min)) fail()
                }
            }
        }
    }
    fun number(): Int {
        val start = at
        while (body.getOrNull(at) in '0'..'9') at++
        val value = body.substring(start, at).toIntOrNull() ?: fail()
        if (value > 65535) fail()
        return value
    }
    fun atom() {
        when (val c = body[at++]) {
            '\\' -> if ((body.getOrNull(at++) ?: fail()) !in special + "/") fail()
            '(' -> {
                if (body.getOrNull(at) == '?') {
                    if (!body.startsWith("?:", at)) fail()
                    at += 2
                }
                sequence(true)
                if (body.getOrNull(at++) != ')') fail()
            }
            '[' -> {
                if (body.getOrNull(at) in listOf(':', '^', ']')) fail()
                val start = at
                val items = mutableListOf<Pair<Char, Boolean>>()
                while (body.getOrNull(at) != ']') {
                    val member = body.getOrNull(at++) ?: fail()
                    if (member in "[&~") fail()
                    if (member == '\\') {
                        val escaped = body.getOrNull(at++) ?: fail()
                        if (escaped !in special + "/-") fail()
                        items.add(escaped to false)
                    } else items.add(member to (member == '-'))
                }
                if (items.isEmpty() || body.substring(start, at).contains("--")) fail()
                for (i in 1 until items.lastIndex) {
                    if (!items[i].second) continue
                    val low = items[i - 1]; val high = items[i + 1]
                    if (low.second || high.second || low.first > high.first) fail()
                    if (i + 2 < items.lastIndex && items[i + 2].second) fail()
                }
                at++
            }
            else -> if (c in special) fail()
        }
    }
}

class Domain(val json: Json) {
    val type: String = json.member("type").str()
    val nullable: Boolean = json["nullable"]?.bool() ?: false
    val quantum: Quantum? = json["quantum"]?.num()?.let(::Quantum)
    val pattern: Pattern? = json["pattern"]?.str()?.let(::Pattern)
    val items: Domain? = json["items"]?.let(::Domain)
    val properties: Map<String, Domain> = json["properties"]?.obj()?.mapValues { Domain(it.value) } ?: emptyMap()
    val required: List<String> = json["required"]?.distinctStrings() ?: emptyList()
    val bounds: Bounds? = if (type == "string") Bounds.read(json) else null
    init {
        val optional = when (type) {
            "string" -> listOf("enum", "pattern", "unit", "min", "max")
            "number" -> listOf("integer", "min", "max", "quantum")
            "array" -> listOf("items", "maxItems")
            "object" -> listOf("properties", "required")
            "boolean", "fracKey", "stamp", "id", "json" -> emptyList()
            else -> throw RegistryError("domain")
        }
        json.expectKeys(listOf("type") + when (type) { "array" -> listOf("items"); "object" -> listOf("properties"); else -> emptyList() }, optional + "nullable")
        json["enum"]?.let { require(it.distinctStrings().isNotEmpty()) }
        json["integer"]?.bool()
        json["min"]?.num(); json["max"]?.num(); json["maxItems"]?.long(0)
        require(properties.keys.all { it.matches(Regex("[a-z][A-Za-z0-9]*")) })
        require(required.all { it.matches(Regex("[a-z][A-Za-z0-9]*")) })
    }
    fun admits(value: Json): Boolean {
        if (value === Json.Null) return nullable
        return when (type) {
            "string" -> value is Json.Str && (json["enum"]?.arr()?.contains(value) != false) &&
                (pattern?.matches(value.value) != false) && (bounds?.admits(value) != false)
            "number" -> value is Json.Num &&
                (json["integer"]?.bool() != true || (value.value == value.value.toLong().toDouble() && kotlin.math.abs(value.value) <= Json.MAX_SAFE_INTEGER)) &&
                value.value >= (json["min"]?.num() ?: Double.NEGATIVE_INFINITY) &&
                value.value <= (json["max"]?.num() ?: Double.POSITIVE_INFINITY) && (quantum?.holds(value.value) != false)
            "boolean" -> value is Json.Bool
            "fracKey" -> value is Json.Str && try { FractionalKey(value.value); true } catch (_: FractionalKeyError) { false }
            "stamp" -> value is Json.Str && try { Stamp(value.value); true } catch (_: StampError) { false }
            "id" -> value is Json.Str
            "json" -> true
            "array" -> value is Json.Arr && value.values.size.toLong() <= (json["maxItems"]?.long(0) ?: Long.MAX_VALUE) && value.values.all { items!!.admits(it) }
            "object" -> value is Json.Obj && value.members.keys.containsAll(required) && value.members.all { (key, member) -> properties[key]?.admits(member) == true }
            else -> false
        }
    }
    fun rounded(value: Json): Json = when {
        type == "number" && value is Json.Num && quantum != null -> {
            val rounded = quantum.rounded(value.value)
            if (rounded.isFinite()) Json.of(rounded) else value
        }
        type == "array" && value is Json.Arr -> Json.Arr(value.values.map { items!!.rounded(it) })
        type == "object" && value is Json.Obj -> Json.Obj(value.members.map { (key, member) -> key to (properties[key]?.rounded(member) ?: member) })
        else -> value
    }
}

class FieldDef(val name: String, val json: Json) {
    val kind = json.member("kind").str()
    val writer = json.member("writer").str()
    val domain = json["domain"]?.let(::Domain)
    val bounds = Bounds.read(json)
    val rank = json["rank"]?.obj()?.mapValues { it.value.long() } ?: emptyMap()
    val ref = json["ref"]?.str()
    val default: Json? = json["default"]
    val parent: Boolean get() = json["parent"]?.bool() ?: false
    val quantum: Quantum? get() = domain?.quantum
    val isLattice: Boolean get() = kind != "text" && kind != "serial"
    init {
        require(name.matches(Regex("[a-z][A-Za-z0-9]*")))
        json.expectKeys(listOf("kind", "writer"), listOf("ref", "parent", "unit", "min", "max", "domain", "default", "serialNext", "rank", "opens"))
        require(kind in listOf("lww", "ranked", "fww", "const", "time", "serial", "text"))
        require(writer in listOf("client", "server"))
        require((json["rank"] != null) == (kind == "ranked") && (json["serialNext"] != null) == (kind == "serial"))
        require(kind != "ranked" || rank.isNotEmpty())
        require(kind != "text" || bounds?.max != null)
        require(kind != "serial" || writer == "server")
        require(default == null || isLattice)
        require(json["parent"] == null || (json["parent"]!!.bool() && ref != null))
        json["serialNext"]?.let { require(it.distinctStrings().all { name -> name.matches(Regex("[a-z][A-Za-z0-9]*")) }) }
        json["opens"]?.let { require(writer == "server" && it.distinctStrings().isNotEmpty()) }
    }
}

class TypeDef(val json: Json) {
    val name = json.member("type").str()
    val scope = json.member("scope").str()
    val identity = json.member("identity").str()
    val life = json.member("life").bool()
    val idPattern = json["idPattern"]?.str()?.let(::Pattern)
    val fields = json.member("fields").obj().mapValues { FieldDef(it.key, it.value) }
    val seeded = json["seeded"]
    val mint = json["mint"]?.let(::Mint)
    val cap = json["cap"]?.long(1)
    val hasBorn: Boolean get() = identity == "minted" || identity == "derived"
    init {
        require(name.matches(Regex("[a-z][A-Za-z0-9]*")))
        require(scope == "tree" || scope == "overlay" || scope.matches(Regex("product:[a-z][a-z0-9]*")))
        json.expectKeys(listOf("type", "scope", "identity", "life", "origins", "fields"), listOf("idSpace", "idPattern", "key", "singletonId", "derive", "seeded", "mint", "wholePut", "revivable", "deadRows", "governs", "cap", "visibleWhen", "primary"))
        require(identity in listOf("minted", "derived", "keyed", "singleton"))
        val origins = json.member("origins").distinctStrings()
        require("replica" in origins && origins.all { it in listOf("replica", "server") })
        json["idSpace"]?.let { require(it.str() in listOf("scope", "global")) }
        json["deadRows"]?.let { require(it.str() in listOf("keep", "spent")) }
        json["singletonId"]?.str()
        json["primary"]?.let { require(it.bool()) }
        json["derive"]?.let {
            it.expectKeys(listOf("fallback"))
            require(it.member("fallback").str().matches(Regex("[a-z0-9]+(-[a-z0-9]+)*")))
        }
        require(idPattern != null || json["key"] != null)
        if (hasBorn) require(life && mint != null && json["idSpace"] != null && idPattern != null && json["revivable"] != null && json["deadRows"] != null)
        if (identity == "derived") require(json["derive"] != null)
        if (identity == "singleton") require(!life && json["singletonId"] != null && idPattern != null)
        if (identity == "keyed" && life) require(json["deadRows"] != null)
        require(json["derive"] == null || identity == "derived")
        require(seeded == null || identity == "minted")
        require(mint == null || hasBorn)
        require(json["key"] == null || identity == "keyed")
        if (json["revivable"]?.bool() == true) require(json["deadRows"]?.str() == "keep")
        if (json["governs"] != null) require(json["governs"]!!.str() == "tree" && scope.startsWith("product:") && identity == "minted" && json["revivable"]?.bool() == false && json["idSpace"]?.str() == "global")
        if (json["wholePut"] != null) require(json["wholePut"]!!.bool() && identity == "keyed" && life && fields.values.none { it.kind == "text" } && fields.values.filter { it.writer == "client" && it.isLattice }.all { it.kind == "lww" })
        if (json["visibleWhen"] != null) require(!life && json["visibleWhen"]!!.distinctStrings().isNotEmpty() && json["visibleWhen"]!!.distinctStrings().all(fields::containsKey))
        require(fields.values.count { it.json["parent"]?.bool() == true } <= 1)
        require(fields.values.none { it.domain?.type == "fracKey" } || hasBorn)
        for (field in fields.values) {
            require(field.json["serialNext"]?.distinctStrings()?.all(fields::containsKey) != false)
            if (field.json["opens"] != null) {
                require(scope == "tree" && identity == "singleton")
                val allowed = field.domain?.json?.get("enum")?.distinctStrings()
                require(allowed == null || field.json["opens"]!!.distinctStrings().all { it in allowed })
            }
        }
        if (mint != null && idPattern != null) require(mint.alphabet.all { idPattern.matches(mint.prefix + it.toString().repeat(mint.length)) })
        seeded?.expectKeys(listOf("seedMax", "ordinalMax"))
        seeded?.member("seedMax")?.long(1); seeded?.member("ordinalMax")?.long(1)
        json["key"]?.let { key ->
            if (key["ref"] != null) {
                key.expectKeys(listOf("ref"))
                require(key.member("ref").str().matches(Regex("[a-z][A-Za-z0-9]*")))
            }
            else {
                key.expectKeys(listOf("tuple"))
                require(key.member("tuple").arr().size >= 2)
                for (part in key.member("tuple").arr()) {
                    part.expectKeys(listOf("name", "ref"))
                    require(part.member("name").str().matches(Regex("[a-z][A-Za-z0-9]*")))
                    require(part.member("ref").str().matches(Regex("[a-z][A-Za-z0-9]*")))
                }
            }
        }
    }
}

// Lossless descriptors for generated registries. No source JSON member is removed except $schema.
class Registry(input: Json) {
    val json: Json = input.let {
        it.expectKeys(listOf("registry", "version", "minVersion", "products", "types", "commands"), listOf("\$schema"))
        it["\$schema"]?.str()
        Json.Obj(it.obj().filterKeys { key -> key != "\$schema" }.toList())
    }
    val name = json.member("registry").str()
    val version = json.member("version").long(1)
    val minVersion = json.member("minVersion").long(1)
    val products = json.member("products").obj()
    val types = json.member("types").arr().map(::TypeDef)
    val commands = json.member("commands").arr()
    init {
        require(name.matches(Regex("[a-z][a-z0-9-]*")))
        require(types.map { it.name }.distinct().size == types.size)
        require(commands.map { it.member("name").str() }.distinct().size == commands.size)
        val codes = mutableSetOf<String>()
        for ((name, product) in products) {
            require(name.matches(Regex("[a-z][a-z0-9]*")))
            product.expectKeys(emptyList(), listOf("surfaces", "device", "codes"))
            require(product["surfaces"]?.distinctStrings()?.all { it in listOf("web", "ios", "android") } != false)
            for (code in product["codes"]?.distinctStrings() ?: emptyList()) {
                require(code.matches(Regex("[a-z][a-z0-9]*(-[a-z0-9]+)*")) && code !in engineCodes && codes.add(code))
            }
            for ((name, row) in product["device"]?.obj() ?: emptyMap()) {
                require(name.matches(Regex("[a-z][A-Za-z0-9]*")))
                row.expectKeys(listOf("keyPattern"), listOf("localOnly", "value"))
                Pattern(row.member("keyPattern").str()); row["localOnly"]?.bool(); row["value"]?.let(::Domain)
            }
        }
        for (type in types) {
            fun refs(type: TypeDef): List<String> = type.json["key"]?.let { key ->
                key["ref"]?.str()?.let(::listOf) ?: key.member("tuple").arr().map { it.member("ref").str() }
            } ?: emptyList()
            val pending = refs(type).toMutableList()
            val seen = mutableSetOf<String>()
            while (pending.isNotEmpty()) {
                val target = pending.removeAt(pending.lastIndex)
                require(target != type.name)
                val definition = type(target) ?: throw RegistryError("unknown-key-reference")
                if (seen.add(target)) pending.addAll(refs(definition))
            }
            if (type.scope.startsWith("product:")) require(type.scope.drop(8) in products)
            for (field in type.fields.values) {
                require(field.ref == null || type(field.ref) != null)
                require(field.default == null || admits(field.default, field))
            }
        }
        for (command in commands) {
            command.expectKeys(listOf("name", "scope", "origins", "serverInternal", "args"), listOf("predicts", "beforePull"))
            require(command.member("name").str().matches(Regex("[a-z][a-z0-9]*\\.[a-z][A-Za-z0-9]*")))
            val origins = command.member("origins").distinctStrings()
            require(origins.isNotEmpty() && origins.all { it in listOf("replica", "server") })
            require(!command.member("serverInternal").bool() || "replica" !in origins)
            require(command["beforePull"]?.bool() != true || command.member("serverInternal").bool())
            val scope = command.member("scope").str()
            require(scope in listOf("tree", "overlay") || (scope.startsWith("product:") && scope.drop(8) in products))
            for ((name, arg) in command.member("args").obj()) {
                require(name.matches(Regex("[a-z][A-Za-z0-9]*")))
                arg.expectKeys(listOf("type"), listOf("optional", "domain"))
                arg["optional"]?.bool(); arg["domain"]?.let(::Domain)
                val kind = arg.member("type").str()
                require(kind in listOf("json", "time", "instant") || (kind.startsWith("ref<") && kind.endsWith('>') && type(kind.drop(4).dropLast(1)) != null))
            }
            require(command["predicts"]?.distinctStrings()?.all { name -> type(name)?.json?.get("wholePut")?.bool() != true && type(name) != null } != false)
        }
    }
    fun type(name: String): TypeDef? = types.firstOrNull { it.name == name }
    fun command(name: String): CommandDef? = commands.firstOrNull { it.member("name").str() == name }?.let(::CommandDef)
    fun isId(id: Json, type: TypeDef): Boolean {
        val key = type.json["key"]
        if (key != null) {
            if (key["ref"] != null) {
                val target = type(key.member("ref").str()) ?: return false
                return isId(id, target) && (type.idPattern?.let { id is Json.Str && it.matches(id.value) } != false)
            }
            val parts = key.member("tuple").arr()
            return id is Json.Arr && id.values.size == parts.size && parts.indices.all { i ->
                type(parts[i].member("ref").str())?.let { isId(id.values[i], it) } == true
            }
        }
        if (id !is Json.Str || type.idPattern?.matches(id.value) != true) return false
        return type.identity != "singleton" || id.value == type.json.member("singletonId").str()
    }
    fun admits(value: Json, field: FieldDef): Boolean {
        if (field.kind == "ranked" && (value as? Json.Str)?.value !in field.rank) return false
        if (field.kind == "time" && (value !is Json.Num || value.value < 0 || value.value > Json.MAX_SAFE_INTEGER || value.value != value.value.toLong().toDouble())) return false
        if (field.domain?.admits(value) == false) return false
        if (value === Json.Null) return field.domain?.nullable ?: (field.ref == null)
        if (field.ref != null && type(field.ref)?.let { isId(value, it) } != true) return false
        return field.bounds?.admits(value) != false
    }
    companion object {
        val engineCodes = setOf("not-found", "scope-dead", "forbidden", "invalid", "too-large", "clock-skew", "id-taken", "id-spent", "unknown-record", "record-dead", "parent-dead", "stale", "cap", "base-unknown", "request-conflict", "request-running", "internal", "target-merged")
        fun compose(name: String, parts: List<Registry>): Registry {
            require(parts.isNotEmpty() && parts.all { it.version == parts[0].version && it.minVersion == parts[0].minVersion })
            val productPairs = parts.flatMap { it.products.toList() }
            return Registry(Json.objectOf(
                "registry" to Json.of(name), "version" to Json.of(parts[0].version), "minVersion" to Json.of(parts[0].minVersion),
                "products" to Json.Obj(productPairs), "types" to Json.Arr(parts.flatMap { it.types.map(TypeDef::json) }),
                "commands" to Json.Arr(parts.flatMap { it.commands }),
            ))
        }
    }
}

class ArgumentDef(val name: String, val json: Json) {
    val type: String = json.member("type").str()
    val optional: Boolean = json["optional"]?.bool() ?: false
    val domain: Domain? = json["domain"]?.let(::Domain)
    val ref: String? get() = if (type.startsWith("ref<") && type.endsWith('>')) type.drop(4).dropLast(1) else null
}

class CommandDef(val json: Json) {
    val name: String = json.member("name").str()
    val scope: String = json.member("scope").str()
    val origins: List<String> = json.member("origins").distinctStrings()
    val serverInternal: Boolean = json.member("serverInternal").bool()
    val beforePull: Boolean = json["beforePull"]?.bool() ?: false
    val args: Map<String, ArgumentDef> = json.member("args").obj().mapValues { ArgumentDef(it.key, it.value) }
    val predicts: List<String> = json["predicts"]?.distinctStrings() ?: emptyList()
}

fun Json.distinctStrings(): List<String> {
    val values = arr().map { it.str() }
    require(values.distinct().size == values.size)
    return values
}
