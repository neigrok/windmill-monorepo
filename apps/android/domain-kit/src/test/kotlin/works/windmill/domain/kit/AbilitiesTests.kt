package works.windmill.domain.kit

import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.Json

class AbilitiesTests {
    fun entry(name: String, kind: String = "read", agent: String = "runs", seats: String = "any", extra: String = ""): String =
        """{"name": "$name", "description": "d", "input": {"type": "object"}, "result": {"type": "array"}, "class": "$kind", "agent": "$agent", "seats": "$seats", "phrase": "read $name", "ui": "$name"$extra}"""

    fun catalog(vararg entries: String): Catalog = Catalog(Json.parse("""{"catalog": "catalog/9", "abilities": [${entries.joinToString(",")}]}"""))

    @Test fun aCatalogReadsItsVersionAndItsAbilitiesInOrder() {
        val read = catalog(entry("second", "remove", "proposes", "bound", """, "since": "catalog/2", "declared": false"""), entry("first"))
        assertEquals("catalog/9", read.version)
        assertEquals(listOf(
            Ability("second", AbilityClass.remove, AgentRule.proposes, AbilitySeats.bound, false, "read second", Json.parse("""{"type":"object"}"""), Json.parse("""{"type":"array"}""")),
            Ability("first", AbilityClass.read, AgentRule.runs, AbilitySeats.any, true, "read first", Json.parse("""{"type":"object"}"""), Json.parse("""{"type":"array"}""")),
        ), read.abilities)
        assertEquals("first", read.ability("first")?.name)
        assertNull(read.ability("absent"))
    }

    @Test fun aSeatIsOfferedWhatIsNeitherWithheldNorUndeclaredAndWhatItAdmits() {
        val read = catalog(
            entry("everyone"), entry("account", seats = "bound"), entry("proposed", agent = "proposes"),
            entry("withheld", agent = "withheld"), entry("undeclared", extra = """, "declared": false"""),
        )
        assertEquals(listOf("everyone", "account", "proposed"), read.offered(Seat.bound).map { it.name })
        assertEquals(listOf("everyone", "proposed"), read.offered(Seat.anon).map { it.name })
        assertTrue(read.ability("account")!!.admits(Seat.bound))
        assertFalse(read.ability("account")!!.admits(Seat.anon))
        assertTrue(read.ability("everyone")!!.admits(Seat.anon))
    }

    @Test fun aMalformedDocumentThrows() {
        val documents = listOf(
            """[]""",
            """{"abilities": []}""",
            """{"catalog": "catalog/9"}""",
            """{"catalog": 2, "abilities": []}""",
            """{"catalog": "catalog/9", "abilities": {}}""",
            """{"catalog": "catalog/9", "abilities": [], "extra": 1}""",
            """{"catalog": "catalog/9", "abilities": [1]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a", kind = "write")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a", agent = "asks")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a", seats = "none")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a", extra = """, "declared": "no"""")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a", extra = """, "since": "2"""")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a", extra = """, "since": 2""")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a", extra = """, "extra": 1""")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a").replace(""""ui": "a"""", """"unknown": "a"""")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a").replace(""""phrase": "read a"""", """"phrase": 1""")}]}""",
            """{"catalog": "catalog/9", "abilities": [${entry("a")}, ${entry("a")}]}""",
        )
        for (document in documents) assertThrows(document, IllegalArgumentException::class.java) { Catalog(Json.parse(document)) }
    }

    @Test fun theSchemaCheckNamesTheFirstFault() {
        val schema = JsonSchema(Json.parse("""{
            "type": "object", "additionalProperties": false, "required": ["id", "entries"],
            "properties": {
                "id": {"type": "string", "minLength": 8, "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+${'$'}"},
                "kind": {"type": "string", "enum": ["read", "add"]},
                "saved": {"type": "boolean", "const": true},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                "load": {"type": "number", "minimum": -500, "maximum": 500},
                "entries": {
                    "type": "array", "minItems": 1, "maxItems": 2, "uniqueItems": true,
                    "items": {"type": "object", "additionalProperties": false, "required": ["exerciseId"], "properties": {"exerciseId": {"type": "string"}}}
                }
            }
        }"""))
        val one = """"entries": [{"exerciseId": "a"}]"""
        for ((value, fault) in listOf(
            """[]""" to SchemaFault(Path(""), """not "object""""),
            """{$one}""" to SchemaFault(Path("id"), "required"),
            """{"id": "abcdefgh"}""" to SchemaFault(Path("entries"), "required"),
            """{"id": "abcdefgh", $one, "extra": 1}""" to SchemaFault(Path("extra"), "not a property"),
            """{"id": "abcdefgh", $one, "kind": "remove"}""" to SchemaFault(Path("kind"), "not one of the enum"),
            """{"id": "abcdefgh", $one, "saved": false}""" to SchemaFault(Path("saved"), "not the constant"),
            """{"id": "abcdefgh", $one, "limit": 1.5}""" to SchemaFault(Path("limit"), """not "integer""""),
            """{"id": "abcdefgh", $one, "limit": 0}""" to SchemaFault(Path("limit"), "below 1"),
            """{"id": "abcdefgh", $one, "load": 500.5}""" to SchemaFault(Path("load"), "above 500"),
            """{"id": "abc", $one}""" to SchemaFault(Path("id"), "shorter than 8"),
            """{"id": "${"a".repeat(65)}", $one}""" to SchemaFault(Path("id"), "longer than 64"),
            """{"id": "abcdefg h", $one}""" to SchemaFault(Path("id"), "not ^[A-Za-z0-9_-]+$"),
            """{"id": "abcdefgh", "entries": []}""" to SchemaFault(Path("entries"), "fewer than 1 items"),
            """{"id": "abcdefgh", "entries": [{"exerciseId": "a"}, {"exerciseId": "b"}, {"exerciseId": "c"}]}""" to SchemaFault(Path("entries"), "more than 2 items"),
            """{"id": "abcdefgh", "entries": [{"exerciseId": "a"}, {"exerciseId": "a"}]}""" to SchemaFault(Path("entries.1"), "repeats an item"),
            """{"id": "abcdefgh", "entries": [{"exerciseId": "a"}, {"exerciseId": 2}]}""" to SchemaFault(Path("entries.1.exerciseId"), """not "string""""),
            """{"id": "abcdefgh", "entries": [{"exerciseId": "a", "sets": []}]}""" to SchemaFault(Path("entries.0.sets"), "not a property"),
            """{"id": "abcdefgh", "entries": [{}]}""" to SchemaFault(Path("entries.0.exerciseId"), "required"),
        )) assertEquals(value, fault, schema.fault(Json.parse(value)))
        assertNull(schema.fault(Json.parse("""{"id": "abcdefgh", "entries": [{"exerciseId": "a"}, {"exerciseId": "b"}], "kind": "add", "saved": true, "limit": 200, "load": -500}""")))
    }

    @Test fun aFaultCarriesItsPathAtEveryDepth() {
        val schema = JsonSchema(Json.parse("""{"properties": {"a": {"properties": {"b": {"items": {"properties": {"c": {"items": {"properties": {"d": {"type": "integer"}}}}}}}}}}}"""))
        assertEquals(SchemaFault(Path("a.b.1.c.2.d"), """not "integer""""),
            schema.fault(Json.parse("""{"a": {"b": [{}, {"c": [{}, {"d": 1}, {"d": "x"}]}]}}""")))
    }

    @Test fun membersAreCheckedInKeyOrderAndRequiredInItsOwnOrder() {
        val required = JsonSchema(Json.parse("""{"required": ["z", "a"], "properties": {"a": {}, "z": {}}}"""))
        assertEquals(SchemaFault(Path("z"), "required"), required.fault(Json.parse("""{}""")))
        val members = JsonSchema(Json.parse("""{"additionalProperties": false, "properties": {"${'�'}": {"type": "string"}, "😀": {"type": "string"}, "a": {"type": "string"}}}"""))
        assertEquals(SchemaFault(Path("a"), """not "string""""), members.fault(Json.parse("""{"${'�'}": 1, "😀": 1, "a": 1}""")))
        assertEquals(SchemaFault(Path("😀"), """not "string""""), members.fault(Json.parse("""{"${'�'}": 1, "😀": 1}""")))
        assertEquals(SchemaFault(Path("extra1"), "not a property"), members.fault(Json.parse("""{"extra2": 1, "extra1": 1, "a": 1}""")))
        val first = JsonSchema(Json.parse("""{"required": ["r"], "additionalProperties": false, "properties": {"a": {"type": "string"}, "r": {}}}"""))
        assertEquals(SchemaFault(Path("r"), "required"), first.fault(Json.parse("""{"extra": 1, "a": 1}""")))
        assertEquals(SchemaFault(Path("extra"), "not a property"), first.fault(Json.parse("""{"extra": 1, "a": 1, "r": 1}""")))
    }

    @Test fun whatTheSubsetDoesNotReadPasses() {
        for (schema in listOf(
            """{"multipleOf": 0.01}""", """{"oneOf": [{"type": "string"}]}""", """{"format": "date"}""", """{"not": {}}""",
            """true""", """false""", """1""", """{"enum": "x"}""", """{"type": ["number"], "minimum": "9"}""",
            """{"maximum": null}""",
        )) assertNull(schema, JsonSchema(Json.parse(schema)).fault(Json.parse("""1.005""")))
        assertNull(JsonSchema(Json.parse("""{"additionalProperties": {"type": "string"}}""")).fault(Json.parse("""{"extra": 1}""")))
        assertNull(JsonSchema(Json.parse("""{"additionalProperties": true}""")).fault(Json.parse("""{"extra": 1}""")))
        assertNull(JsonSchema(Json.parse("""{"required": [1, null]}""")).fault(Json.parse("""{}""")))
        assertNull(JsonSchema(Json.parse("""{"properties": 1, "additionalProperties": true}""")).fault(Json.parse("""{"a": 1}""")))
        assertEquals(SchemaFault(Path("a"), "not a property"), JsonSchema(Json.parse("""{"properties": 1, "additionalProperties": false}""")).fault(Json.parse("""{"a": 1}""")))
        assertNull(JsonSchema(Json.parse("""{"uniqueItems": "yes", "items": 1}""")).fault(Json.parse("""[1, 1]""")))
        assertNull(JsonSchema(Json.parse("""{"minItems": 1.5, "maxItems": 0.5, "minLength": 1.5, "maxLength": 0.5}""")).fault(Json.parse("""[1]""")))
        assertNull(JsonSchema(Json.parse("""{"minLength": 1.5, "maxLength": 0.5}""")).fault(Json.parse(""""ab"""")))
        assertNull(JsonSchema(Json.parse("""{"minItems": 9223372036854775808, "minLength": 1e300}""")).fault(Json.parse("""[1]""")))
        assertNull(JsonSchema(Json.parse("""{"minLength": 1e300, "pattern": 1}""")).fault(Json.parse(""""a"""")))
        assertEquals(SchemaFault(Path(""), "fewer than 1000 items"), JsonSchema(Json.parse("""{"minItems": 1e3}""")).fault(Json.parse("""[]""")))
    }

    @Test fun aTypeIsOneWordOrAListOfThem() {
        val nullable = JsonSchema(Json.parse("""{"type": ["number", "null"]}"""))
        assertNull(nullable.fault(Json.parse("""null""")))
        assertNull(nullable.fault(Json.parse("""123.45""")))
        assertEquals(SchemaFault(Path(""), """not ["number","null"]"""), nullable.fault(Json.parse(""""unavailable"""")))
        for ((type, passes) in listOf(
            "object" to """{}""", "array" to """[]""", "string" to """"s"""", "boolean" to """false""", "null" to """null""",
            "number" to """1.5""", "integer" to """1""", "integer" to """1.0""", "integer" to """1e3""", "integer" to """-0""",
        )) {
            assertNull("$type $passes", JsonSchema(Json.parse("""{"type": "$type"}""")).fault(Json.parse(passes)))
            assertEquals(SchemaFault(Path(""), """not "$type""""), JsonSchema(Json.parse("""{"type": "$type"}""")).fault(if (type == "string") Json.parse("""1""") else Json.parse(""""s"""")))
        }
        assertEquals(SchemaFault(Path(""), """not "float""""), JsonSchema(Json.parse("""{"type": "float"}""")).fault(Json.parse("""1""")))
        assertEquals(SchemaFault(Path(""), "not 5"), JsonSchema(Json.parse("""{"type": 5}""")).fault(Json.parse("""1""")))
        assertEquals(SchemaFault(Path(""), "not []"), JsonSchema(Json.parse("""{"type": []}""")).fault(Json.parse("""1""")))
    }

    @Test fun aPatternMatchesTheWholeStringAndABadOneRefuses() {
        fun fault(pattern: String, text: String): SchemaFault? =
            JsonSchema(Json.objectOf("pattern" to Json.of(pattern))).fault(Json.of(text))
        assertNull(fault("[a-c]+", "abc"))
        assertEquals(SchemaFault(Path(""), "not [a-c]+"), fault("[a-c]+", "abcd"))
        assertEquals(SchemaFault(Path(""), "not [a-c]+"), fault("[a-c]+", "xabc"))
        assertNull(fault("ab|c", "ab"))
        assertNull(fault("ab|c", "c"))
        assertEquals(SchemaFault(Path(""), "not ab|c"), fault("ab|c", "abc"))
        assertEquals(SchemaFault(Path(""), "not [a-z]+$"), fault("[a-z]+$", "abc\n"))
        assertEquals(SchemaFault(Path(""), "not ["), fault("[", "abc"))
        val id = "^[A-Za-z0-9_-]{8,64}$"
        assertNull(fault(id, "tn7Qm2Kx9Lp4Wz8R-1"))
        assertNull(fault(id, "a".repeat(64)))
        for (bad in listOf("", "a".repeat(7), "a".repeat(65), "abcdefgh\n", "abcdefǵh", "abcdefgé", "abcd efgh", "abcdefg😀"))
            assertEquals(bad, SchemaFault(Path(""), "not $id"), fault(id, bad))
    }

    @Test fun aLengthCountsScalarsAsTheStringStands() {
        val one = JsonSchema(Json.parse("""{"minLength": 1, "maxLength": 1}"""))
        assertNull(one.fault(Json.of("😀")))
        assertNull(one.fault(Json.of("é")))
        assertEquals(SchemaFault(Path(""), "longer than 1"), one.fault(Json.of("é")))
        assertEquals(SchemaFault(Path(""), "longer than 1"), one.fault(Json.of("😀😀")))
        assertEquals(SchemaFault(Path(""), "shorter than 1"), one.fault(Json.of("")))
    }

    @Test fun anItemRepeatsWhenItsCanonicalBytesDo() {
        val unique = JsonSchema(Json.parse("""{"uniqueItems": true}"""))
        assertEquals(SchemaFault(Path("1"), "repeats an item"), unique.fault(Json.parse("""[{"a": 1, "b": 2}, {"b": 2, "a": 1}]""")))
        assertEquals(SchemaFault(Path("1"), "repeats an item"), unique.fault(Json.parse("""[1, 1.0]""")))
        assertEquals(SchemaFault(Path("3"), "repeats an item"), unique.fault(Json.parse("""[1, "1", null, null]""")))
        assertNull(unique.fault(Json.array(Json.of("é"), Json.of("é"))))
    }

    @Test fun aReasonStatesItsBoundAsTheWireWritesIt() {
        assertEquals(SchemaFault(Path(""), "below 0.5"), JsonSchema(Json.parse("""{"minimum": 0.5}""")).fault(Json.parse("""0""")))
        assertEquals(SchemaFault(Path(""), "above 1e+21"), JsonSchema(Json.parse("""{"maximum": 1e21}""")).fault(Json.parse("""1e22""")))
        assertEquals(SchemaFault(Path(""), "above 253402300799000"), JsonSchema(Json.parse("""{"maximum": 253402300799000}""")).fault(Json.parse("""253402300799001""")))
    }
}
