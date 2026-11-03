package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.Contract
import works.windmill.sync.core.Json

class CatalogTests {
    @Test fun theCatalogOffersBySeat() {
        val catalog = Catalog(Contract.json("gym/catalog.json"))
        val bound = catalog.offered(Seat.bound).map { it.name }
        assertEquals(listOf("list_routines", "list_exercises", "list_sessions", "get_session", "get_sessions", "last_time", "get_last_times", "get_stats",
            "list_notes", "list_bodyweight", "create_routine", "create_exercise", "save_note", "share_session",
            "propose_routine_change", "propose_routine_removal", "propose_workout_change", "revoke_share"), bound)
        assertEquals(bound - listOf("save_note", "share_session", "revoke_share"), catalog.offered(Seat.anon).map { it.name })
        assertEquals(18, bound.size)
        assertEquals(15, catalog.offered(Seat.anon).size)
        assertEquals("catalog/2", catalog.version)
        assertEquals(37, catalog.abilities.size)
        assertEquals(AgentRule.withheld, catalog.ability("log_set")?.agent)
        assertEquals(false, catalog.ability("get_record")?.declared)
        assertEquals("wrote a proposal for one of your routines", catalog.ability("propose_routine_change")?.phrase)
        assertNull(catalog.ability("no_such_ability"))
    }

    // Swift's Regex reads `.`, `\d`, `\w` and `\s` by Unicode, java.util.regex by ASCII: a new pattern is checked on both first.
    @Test fun everyPatternIsOneBothEnginesReadAlike() {
        val catalog = Catalog(Contract.json("gym/catalog.json"))
        val patterns = catalog.abilities.flatMap { patterns(it.input) + patterns(it.result) }.toSet()
        assertEquals(setOf("^[A-Za-z0-9_-]{8,64}$"), patterns)
    }

    @Test fun everyDeclaredInputAcceptsAValidCallAndRefusesEachBrokenOne() {
        val declared = Catalog(Contract.json("gym/catalog.json")).abilities.filter { it.declared }
        assertEquals(25, declared.size)
        var broken = 0
        for (ability in declared) {
            val schema = JsonSchema(ability.input)
            assertNull("${ability.name} with what it requires", schema.fault(valid(ability.input, everyMember = false)))
            val call = valid(ability.input, everyMember = true)
            assertNull("${ability.name} with every member", schema.fault(call))
            for ((value, fault) in breakages(ability.input, call, Path(""))) {
                assertEquals("${ability.name} ${value.jcs}", fault, schema.fault(value))
                broken++
            }
        }
        assertEquals(345, broken)
    }

    @Test fun theAbilitiesCorpusCallsAndGoldensStandInsideTheirSchemas() {
        val catalog = Catalog(Contract.json("gym/catalog.json"))
        var answers = 0
        for (path in Contract.files("gym/abilities")) for (case in Contract.json(path).arr()) {
            val call = case.member("call")
            val ability = catalog.ability(call.member("name").str())!!
            val expect = case["expect"] ?: continue
            val result = expect["result"] ?: continue
            assertNull("$path · ${case.member("case").str()}", JsonSchema(ability.input).fault(call.member("input")))
            assertNull("$path · ${case.member("case").str()}", JsonSchema(ability.result).fault(result))
            answers++
        }
        assertEquals(50, answers)
    }

    @Test fun theSchemaCheckReadsARealInputAtDepth() {
        val catalog = Catalog(Contract.json("gym/catalog.json"))
        assertEquals(SchemaFault(Path("sessionIds.1"), "repeats an item"),
            JsonSchema(catalog.ability("get_sessions")!!.input).fault(Json.parse("""{"sessionIds": ["a", "a"]}""")))
        val metrics = listOf("list_sessions", "get_session", "get_sessions", "get_stats", "get_record").flatMap { metrics(catalog.ability(it)!!.result) }
        assertEquals(11, metrics.size)
        for (schema in metrics) {
            assertEquals(Json.parse("""{"type": ["number", "null"]}"""), schema)
            assertNull(JsonSchema(schema).fault(Json.Null))
            assertNull(JsonSchema(schema).fault(Json.of(123.45)))
            assertEquals(SchemaFault(Path(""), """not ["number","null"]"""), JsonSchema(schema).fault(Json.of("unavailable")))
        }
    }

    fun metrics(schema: Json): List<Json> = when (schema) {
        is Json.Arr -> schema.values.flatMap { metrics(it) }
        is Json.Obj -> schema.members.flatMap { (key, value) ->
            (if (key in listOf("tonnageKg", "volumeKg", "topE1rm", "e1rm")) listOf(value) else emptyList()) + metrics(value)
        }
        else -> emptyList()
    }

    fun patterns(schema: Json): List<String> = when (schema) {
        is Json.Arr -> schema.values.flatMap { patterns(it) }
        is Json.Obj -> schema.members.flatMap { (key, value) -> if (key == "pattern" && value is Json.Str) listOf(value.value) else patterns(value) }
        else -> emptyList()
    }

    // A value inside the schema; the salt keeps the items of a `uniqueItems` array apart.
    fun valid(schema: Json, everyMember: Boolean, salt: Int = 0): Json {
        val rules = schema.obj()
        rules["enum"]?.let { return it.arr()[salt % it.arr().size] }
        return when (val type = rules.getValue("type").str()) {
            "object" -> {
                val required = rules["required"]?.arr()?.map { it.str() } ?: emptyList()
                Json.Obj((rules["properties"]?.obj() ?: emptyMap()).filterKeys { everyMember || it in required }
                    .map { (key, property) -> key to valid(property, everyMember) })
            }
            "array" -> Json.Arr(List((rules["minItems"]?.long()?.toInt() ?: 0).coerceAtLeast(if (everyMember) 1 else 0)) { index ->
                valid(rules.getValue("items"), everyMember, salt = index)
            })
            "string" -> Json.of("abcdefgh".plus(salt).padEnd(rules["minLength"]?.long()?.toInt() ?: 0, 'a'))
            "boolean" -> Json.of(true)
            "integer", "number" -> Json.of(rules["minimum"]?.num() ?: 1.0)
            else -> error("no valid value of $type")
        }
    }

    // `call` broken in one place, each beside the one fault it must answer.
    fun breakages(schema: Json, call: Json, path: Path): List<Pair<Json, SchemaFault>> {
        val rules = schema.obj()
        val type = rules.getValue("type").str()
        val wrong = if (type == "string") Json.of(1) else Json.of("wrong")
        val own = mutableListOf(wrong to SchemaFault(path, "not \"$type\""))
        rules["enum"]?.let { own += Json.of("none of these") to SchemaFault(path, "not one of the enum") }
        rules["minimum"]?.let { own += Json.of(it.num() - 1) to SchemaFault(path, "below ${it.jcs}") }
        rules["maximum"]?.let { own += Json.of(it.num() + 1) to SchemaFault(path, "above ${it.jcs}") }
        if (type == "integer") own += Json.of((rules["minimum"]?.num() ?: 1.0) + 0.5) to SchemaFault(path, "not \"integer\"")
        rules["minLength"]?.long()?.takeIf { it > 0 }?.let { own += Json.of("a".repeat(it.toInt() - 1)) to SchemaFault(path, "shorter than $it") }
        rules["maxLength"]?.long()?.let { own += Json.of("a".repeat(it.toInt() + 1)) to SchemaFault(path, "longer than $it") }
        rules["pattern"]?.let { own += Json.of("not an id!") to SchemaFault(path, "not ${it.str()}") }
        rules["minItems"]?.long()?.takeIf { it > 0 }?.let { own += Json.Arr(emptyList()) to SchemaFault(path, "fewer than $it items") }
        rules["maxItems"]?.long()?.let { most ->
            val many = List(most.toInt() + 1) { valid(rules.getValue("items"), everyMember = true, salt = it) }
            own += Json.Arr(many) to SchemaFault(path, "more than $most items")
        }
        if (rules["uniqueItems"] == Json.Bool(true)) {
            own += Json.Arr(call.arr() + call.arr()) to SchemaFault(path + 1, "repeats an item")
        }
        return own + when (type) {
            "object" -> objectBreakages(rules, call.obj(), path)
            "array" -> call.arr().flatMapIndexed { index, item ->
                breakages(rules.getValue("items"), item, path + index).map { (broken, fault) ->
                    Json.Arr(call.arr().toMutableList().also { it[index] = broken }) to fault
                }
            }
            else -> emptyList()
        }
    }

    fun objectBreakages(rules: Map<String, Json>, call: Map<String, Json>, path: Path): List<Pair<Json, SchemaFault>> {
        val required = rules["required"]?.arr()?.map { it.str() } ?: emptyList()
        val missing = required.map { name -> Json.Obj((call - name).toList()) to SchemaFault(path + name, "required") }
        val extra = if (rules["additionalProperties"] == Json.Bool(false)) {
            listOf(Json.Obj(call.toList() + ("zzzUnknown" to Json.of(1))) to SchemaFault(path + "zzzUnknown", "not a property"))
        } else emptyList()
        val nested = (rules["properties"]?.obj() ?: emptyMap()).flatMap { (key, property) ->
            breakages(property, call.getValue(key), path + key).map { (broken, fault) ->
                Json.Obj((call + (key to broken)).toList()) to fault
            }
        }
        return missing + extra + nested
    }
}
