package works.windmill.domain.kit

import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.MeasureUnit

enum class AbilityClass { read, add, change, remove }
enum class AgentRule { runs, proposes, withheld }
enum class AbilitySeats { any, bound }

// Whose store a turn runs against.
enum class Seat { anon, bound }

// `declared` is false for an ability the server declares no tool for; the phone does not run it either.
data class Ability(val name: String, val kind: AbilityClass, val agent: AgentRule, val seats: AbilitySeats,
    val declared: Boolean, val phrase: String, val input: Json, val result: Json) {
    constructor(entry: Json) : this(
        entry.member("name").str(),
        AbilityClass.valueOf(entry.member("class").str()),
        AgentRule.valueOf(entry.member("agent").str()),
        AbilitySeats.valueOf(entry.member("seats").str()),
        entry["declared"]?.bool() ?: true,
        entry.member("phrase").str(),
        entry.member("input"),
        entry.member("result"),
    ) {
        entry.expectKeys(listOf("name", "description", "input", "result", "class", "agent", "seats", "phrase", "ui"), listOf("declared", "since"))
        if (entry["since"]?.str()?.startsWith("catalog/") == false) throw JsonError("since")
    }

    fun admits(seat: Seat): Boolean = seats == AbilitySeats.any || seat == Seat.bound
}

class Catalog(document: Json) {
    val version: String
    val abilities: List<Ability>

    init {
        document.expectKeys(listOf("catalog", "abilities"))
        version = document.member("catalog").str()
        abilities = document.member("abilities").arr().map { Ability(it) }
        if (abilities.map { it.name }.toSet().size != abilities.size) throw JsonError("duplicate-ability")
    }

    fun ability(named: String): Ability? = abilities.firstOrNull { it.name == named }

    fun offered(seat: Seat): List<Ability> = abilities.filter { it.agent != AgentRule.withheld && it.declared && it.admits(seat) }
}

data class SchemaFault(val path: Path, val reason: String)

// The keywords a catalog's schemas check at every depth; any other, `multipleOf` among them, passes. The first fault is the answer.
class JsonSchema(val schema: Json) {
    fun fault(value: Json): SchemaFault? = fault(value, schema, Path(""))

    private fun fault(value: Json, schema: Json, path: Path): SchemaFault? {
        val rules = (schema as? Json.Obj)?.members ?: return null
        val expected = rules["type"]
        if (expected != null && !matches(value, expected)) return SchemaFault(path, "not ${expected.jcs}")
        val allowed = rules["enum"]
        if (allowed is Json.Arr && value !in allowed.values) return SchemaFault(path, "not one of the enum")
        val constant = rules["const"]
        if (constant != null && constant != value) return SchemaFault(path, "not the constant")
        return when (value) {
            is Json.Obj -> objectFault(value.members, rules, path)
            is Json.Arr -> arrayFault(value.values, rules, path)
            is Json.Str -> stringFault(value.value, rules, path)
            is Json.Num -> numberFault(value.value, rules, path)
            else -> null
        }
    }

    private fun matches(value: Json, type: Json): Boolean {
        if (type is Json.Arr) return type.values.any { matches(value, it) }
        return when ((type as? Json.Str)?.value) {
            "object" -> value is Json.Obj
            "array" -> value is Json.Arr
            "string" -> value is Json.Str
            "boolean" -> value is Json.Bool
            "null" -> value is Json.Null
            "number" -> value is Json.Num
            "integer" -> value is Json.Num && kotlin.math.floor(value.value) == value.value
            else -> false
        }
    }

    private fun objectFault(members: Map<String, Json>, rules: Map<String, Json>, path: Path): SchemaFault? {
        val properties = (rules["properties"] as? Json.Obj)?.members ?: emptyMap()
        val required = (rules["required"] as? Json.Arr)?.values ?: emptyList()
        for (name in required) if (name is Json.Str && name.value !in members) return SchemaFault(path + name.value, "required")
        if (rules["additionalProperties"] == Json.Bool(false)) {
            for (key in members.keys) if (key !in properties) return SchemaFault(path + key, "not a property")
        }
        for ((key, property) in properties) {
            val member = members[key] ?: continue
            fault(member, property, path + key)?.let { return it }
        }
        return null
    }

    private fun arrayFault(items: List<Json>, rules: Map<String, Json>, path: Path): SchemaFault? {
        val fewest = integer(rules["minItems"])
        if (fewest != null && items.size < fewest) return SchemaFault(path, "fewer than $fewest items")
        val most = integer(rules["maxItems"])
        if (most != null && items.size > most) return SchemaFault(path, "more than $most items")
        if (rules["uniqueItems"] == Json.Bool(true)) {
            val seen = linkedSetOf<Json>()
            for ((index, item) in items.withIndex()) if (!seen.add(item)) return SchemaFault(path + index, "repeats an item")
        }
        val itemSchema = rules["items"] ?: return null
        for ((index, item) in items.withIndex()) fault(item, itemSchema, path + index)?.let { return it }
        return null
    }

    private fun stringFault(text: String, rules: Map<String, Json>, path: Path): SchemaFault? {
        val length = MeasureUnit.chars.length(text)
        val shortest = integer(rules["minLength"])
        if (shortest != null && length < shortest) return SchemaFault(path, "shorter than $shortest")
        val longest = integer(rules["maxLength"])
        if (longest != null && length > longest) return SchemaFault(path, "longer than $longest")
        val pattern = (rules["pattern"] as? Json.Str)?.value ?: return null
        val matched = try { Regex(pattern).matches(text) } catch (_: IllegalArgumentException) { false }
        return if (matched) null else SchemaFault(path, "not $pattern")
    }

    private fun numberFault(value: Double, rules: Map<String, Json>, path: Path): SchemaFault? {
        val minimum = rules["minimum"]
        if (minimum is Json.Num && value < minimum.value) return SchemaFault(path, "below ${minimum.jcs}")
        val maximum = rules["maximum"]
        if (maximum is Json.Num && value > maximum.value) return SchemaFault(path, "above ${maximum.jcs}")
        return null
    }

    private fun integer(json: Json?): Long? {
        val value = (json as? Json.Num)?.value ?: return null
        val whole = value.toLong()
        return whole.takeIf { it != Long.MAX_VALUE && it.toDouble() == value }
    }
}
