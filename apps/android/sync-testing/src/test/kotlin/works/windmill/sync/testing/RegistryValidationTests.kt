package works.windmill.sync.testing

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.sync.core.*

@RunWith(Parameterized::class)
class RegistryValidationTests(private val name: String, private val input: Json, private val valid: Boolean) {
    @Test fun validatesTheRegistry() {
        if (!valid) {
            assertThrows(name, IllegalArgumentException::class.java) { Registry(input) }
            return
        }
        val registry = Registry(input)
        assertEquals(Json.Obj(input.obj().filterKeys { it != "\$schema" }.toList()), registry.json)
    }

    companion object {
        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> {
            val root = File(System.getProperty("windmill.contract"), "sync")
            val probe = Json.parse(File(root, "probe.registry.json").readBytes())
            val cases = mutableListOf<Array<Any>>()
            fun bad(name: String, path: List<String>, value: Json?) {
                cases += arrayOf(name, changed(probe, path, value), false)
            }
            fun at(vararg path: String) = path.toList()
            fun type(name: String) = at("types", probe.member("types").arr().indexOfFirst { it.member("type").str() == name }.toString())
            fun field(typeName: String, name: String) = type(typeName) + at("fields", name)
            fun command(name: String) = at("commands", probe.member("commands").arr().indexOfFirst { it.member("name").str() == name }.toString())
            fun obj(text: String) = Json.parse(text)
            val string = Json.of("wrong")
            val empty = Json.Arr(emptyList())
            val product = at("products", "probe")
            val card = type("card")
            val meta = type("meta")
            val start = command("probe.start")
            val size = field("card", "size")
            val device = product + at("device", "picture")

            for (file in listOf("probe", "gym", "journal")) {
                cases += arrayOf("valid $file", Json.parse(File(root, "$file.registry.json").readBytes()), true)
            }
            for (domain in listOf(
                "{\"type\":\"string\",\"nullable\":false,\"unit\":\"bytes\",\"min\":5,\"max\":1}",
                "{\"type\":\"number\",\"integer\":false,\"min\":5,\"max\":1,\"quantum\":0.5}",
                "{\"type\":\"array\",\"items\":{\"type\":\"json\"},\"maxItems\":0}",
                "{\"type\":\"object\",\"properties\":{},\"required\":[\"missing\"]}",
            )) cases += arrayOf("valid domain $domain", changed(probe, size + "domain", obj(domain)), true)
            for (key in listOf("registry", "version", "minVersion", "products", "types", "commands")) bad("root missing $key", at(key), null)
            for (key in listOf("version", "minVersion")) for (value in listOf(Json.of(0), Json.of(1.5), string)) bad("$key ${value.jcs}", at(key), value)
            bad("root unknown", at("colour"), string)
            bad("schema non-string", at("\$schema"), Json.of(false))
            bad("registry name", at("registry"), Json.of("Probe"))
            bad("products shape", at("products"), empty)
            bad("types shape", at("types"), string)
            bad("commands shape", at("commands"), string)
            bad("product name", at("products", "Bad"), obj("{}"))
            bad("product unknown", product + "colour", string)
            bad("surface unknown", product + "surfaces", obj("[\"watch\"]"))
            bad("surface repeated", product + "surfaces", obj("[\"android\",\"android\"]"))
            for (code in listOf("stale", "Late", "late-", "late--again")) bad("refusal $code", product + "codes", Json.Arr(listOf(Json.of(code))))
            bad("refusal repeated", product + "codes", obj("[\"late\",\"late\"]"))
            bad("cross-product refusal repeated", at("products"), obj("{\"probe\":{\"codes\":[\"late\"]},\"other\":{\"codes\":[\"late\"]}}"))
            bad("device row name", product + at("device", "Bad"), obj("{\"keyPattern\":\"^a$\"}"))
            bad("device pattern absent", device + "keyPattern", null)
            bad("device pattern non-portable", device + "keyPattern", Json.of("^.+$"))
            bad("device unknown", device + "colour", string)
            bad("device localOnly shape", device + "localOnly", string)
            bad("device value domain", device + "value", obj("{\"type\":\"string\",\"max\":4}"))

            for (key in listOf("type", "scope", "identity", "life", "origins", "fields")) bad("type missing $key", card + key, null)
            bad("type unknown", card + "colour", string)
            bad("type name", card + "type", Json.of("Card"))
            bad("type duplicated", at("types"), Json.Arr(probe.member("types").arr() + probe.member("types").arr().first()))
            for (value in listOf("product:elsewhere", "product:Probe", "device", "tree:")) bad("type scope $value", card + "scope", Json.of(value))
            bad("identity enum", card + "identity", string)
            bad("life shape", card + "life", string)
            bad("minted life false", card + "life", Json.of(false))
            for (key in listOf("idSpace", "idPattern", "revivable", "deadRows", "mint")) bad("minted missing $key", card + key, null)
            bad("idSpace enum", card + "idSpace", string)
            bad("deadRows enum", card + "deadRows", string)
            bad("revivable shape", card + "revivable", string)
            bad("revivable spent", card + "revivable", Json.of(true))
            bad("singletonId shape", meta + "singletonId", Json.of(3))
            bad("singleton missing id", meta + "singletonId", null)
            bad("singleton life", meta + "life", Json.of(true))
            bad("keyed missing deadRows", type("fact") + "deadRows", null)
            bad("primary false", card + "primary", Json.of(false))
            bad("primary shape", card + "primary", string)
            for (value in listOf("[]", "[\"server\"]", "[\"replica\",\"ghost\"]", "[\"replica\",\"replica\"]")) bad("type origins $value", card + "origins", obj(value))
            for (value in listOf(Json.of(0), Json.of(1.5), string)) bad("cap ${value.jcs}", card + "cap", value)
            bad("derived missing rule", type("tag") + "derive", null)
            bad("derive on minted", card + "derive", obj("{\"fallback\":\"card\"}"))
            for (value in listOf("{}", "{\"fallback\":3}", "{\"fallback\":\"Bad\"}", "{\"fallback\":\"bad--id\"}", "{\"fallback\":\"tag\",\"extra\":1}")) bad("derive $value", type("tag") + "derive", obj(value))
            bad("seeded on derived", type("tag") + "seeded", obj("{\"seedMax\":4,\"ordinalMax\":9}"))
            for (value in listOf("{}", "{\"seedMax\":0,\"ordinalMax\":9}", "{\"seedMax\":4,\"ordinalMax\":0}", "{\"seedMax\":4,\"ordinalMax\":9,\"extra\":1}")) bad("seeded $value", card + "seeded", obj(value))
            for (key in listOf("prefix", "alphabet", "length")) bad("mint missing $key", card + at("mint", key), null)
            bad("mint unknown", card + at("mint", "extra"), string)
            bad("mint alphabet short", card + at("mint", "alphabet"), Json.of("a"))
            bad("mint alphabet wrong", card + at("mint", "alphabet"), Json.of("ab!"))
            bad("mint prefix wrong", card + at("mint", "prefix"), Json.of("!"))
            for (length in listOf(0L, 4L, 4_294_967_304L)) bad("mint length $length", card + at("mint", "length"), Json.of(length))
            bad("mint on keyed", type("day") + "mint", probe.member("types").arr().first().member("mint"))
            bad("governs scope", card + "governs", Json.of("overlay"))
            bad("governs scoped id", type("board") + "idSpace", Json.of("scope"))
            bad("governs outside product", type("board") + "scope", Json.of("tree"))
            bad("governs on singleton", meta + "governs", Json.of("tree"))
            bad("visibleWhen on life", card + "visibleWhen", obj("[\"title\"]"))
            bad("visibleWhen empty", meta + "visibleWhen", empty)
            bad("visibleWhen unknown", meta + "visibleWhen", obj("[\"ghost\"]"))
            bad("visibleWhen repeated", meta + "visibleWhen", obj("[\"title\",\"title\"]"))
            bad("wholePut false", type("fact") + "wholePut", Json.of(false))
            bad("wholePut on minted", card + "wholePut", Json.of(true))
            bad("wholePut field not lww", field("fact", "value") + "kind", Json.of("const"))
            bad("wholePut text", type("fact") + at("fields", "memo"), obj("{\"kind\":\"text\",\"writer\":\"client\",\"unit\":\"bytes\",\"max\":8}"))

            bad("key on minted", card + "key", obj("{\"ref\":\"board\"}"))
            bad("key reference unknown", type("mark") + at("key", "ref"), Json.of("ghost"))
            bad("key reference self", type("mark") + at("key", "ref"), Json.of("mark"))
            bad("key tuple self", type("link") + at("key", "tuple", "1", "ref"), Json.of("link"))
            cases += arrayOf("key two-type cycle", changed(changed(probe, type("mark") + at("key", "ref"), Json.of("link")), type("link") + at("key", "tuple", "1", "ref"), Json.of("mark")), false)
            bad("key closed", type("mark") + at("key", "extra"), string)
            for (value in listOf("[]", "[{\"name\":\"from\",\"ref\":\"card\"}]", "[{\"name\":\"From\",\"ref\":\"card\"},{\"name\":\"to\",\"ref\":\"card\"}]", "[{\"name\":3,\"ref\":\"card\"},{\"name\":\"to\",\"ref\":\"card\"}]", "[{\"name\":\"from\",\"ref\":\"card\",\"extra\":1},{\"name\":\"to\",\"ref\":\"card\"}]")) bad("key tuple $value", type("link") + at("key", "tuple"), obj(value))
            bad("field name", card + at("fields", "Bad"), obj("{\"kind\":\"lww\",\"writer\":\"client\"}"))
            for (key in listOf("kind", "writer")) bad("field missing $key", size + key, null)
            for (key in listOf("kind", "writer")) bad("field enum $key", size + key, string)
            bad("field unknown", size + "colour", string)
            bad("field unknown ref", size + "ref", Json.of("ghost"))
            bad("parent false", field("lap", "runId") + "parent", Json.of(false))
            bad("parent without ref", size + "parent", Json.of(true))
            bad("parent twice", field("lap", "at"), obj("{\"kind\":\"lww\",\"writer\":\"client\",\"ref\":\"run\",\"parent\":true}"))
            bad("rank missing", field("card", "tier") + "rank", null)
            bad("rank empty", field("card", "tier") + "rank", obj("{}"))
            bad("rank non-integer", field("card", "tier") + "rank", obj("{\"low\":1.5}"))
            bad("rank on lww", size + "rank", obj("{\"low\":1}"))
            bad("serialNext on lww", size + "serialNext", empty)
            bad("serialNext absent", field("lap", "no") + "serialNext", null)
            bad("serialNext unknown", field("lap", "no") + "serialNext", obj("[\"ghost\"]"))
            bad("serialNext repeated", field("lap", "no") + "serialNext", obj("[\"runId\",\"runId\"]"))
            bad("serial writer client", field("lap", "no") + "writer", Json.of("client"))
            bad("serial default", field("lap", "no") + "default", Json.of(1))
            bad("text default", field("mark", "memo") + "default", Json.of(""))
            bad("text maximum absent", field("mark", "memo") + "max", null)
            bad("field bound unit absent", field("card", "title") + "unit", null)
            for (key in listOf("min", "max")) bad("field fractional $key", field("card", "title") + key, Json.of(1.5))
            bad("field negative minimum", field("card", "title") + "min", Json.of(-1))
            bad("field zero maximum", field("card", "title") + "max", Json.of(0))
            bad("field unit enum", field("card", "title") + "unit", string)
            bad("default off quantum", size + "default", Json.of(1.005))
            bad("default off bounds", field("card", "title") + "default", Json.of("a".repeat(300)))
            bad("default ref malformed", field("lap", "runId") + "default", string)
            bad("opens outside enum", field("meta", "visibility") + "opens", obj("[\"secret\"]"))
            bad("opens empty", field("meta", "visibility") + "opens", empty)
            bad("opens client", field("meta", "visibility") + "writer", Json.of("client"))
            bad("opens wrong placement", size + "opens", obj("[\"x\"]"))
            bad("order field keyed", type("day") + at("fields", "ord"), obj("{\"kind\":\"lww\",\"writer\":\"client\",\"domain\":{\"type\":\"fracKey\"}}"))

            val domains = listOf(
                "{}", "{\"type\":\"unknown\"}", "{\"type\":\"string\",\"extra\":1}", "{\"type\":\"string\",\"nullable\":1}",
                "{\"type\":\"string\",\"enum\":[]}", "{\"type\":\"string\",\"enum\":[\"x\",\"x\"]}", "{\"type\":\"string\",\"enum\":[1]}",
                "{\"type\":\"string\",\"pattern\":\"^.+$\"}", "{\"type\":\"string\",\"min\":1}", "{\"type\":\"string\",\"unit\":\"bytes\",\"min\":-1}",
                "{\"type\":\"string\",\"unit\":\"bytes\",\"max\":0}", "{\"type\":\"string\",\"quantum\":0.5}",
                "{\"type\":\"number\",\"integer\":1}", "{\"type\":\"number\",\"min\":\"x\"}", "{\"type\":\"number\",\"max\":null}",
                "{\"type\":\"number\",\"quantum\":0.3}", "{\"type\":\"number\",\"quantum\":0}", "{\"type\":\"number\",\"quantum\":5e-324}",
                "{\"type\":\"array\"}", "{\"type\":\"array\",\"items\":{\"type\":\"string\",\"max\":4}}", "{\"type\":\"array\",\"items\":{\"type\":\"json\"},\"maxItems\":-1}",
                "{\"type\":\"array\",\"items\":{\"type\":\"json\"},\"maxItems\":1.5}", "{\"type\":\"object\"}",
                "{\"type\":\"object\",\"properties\":{\"Bad\":{\"type\":\"json\"}}}", "{\"type\":\"object\",\"properties\":{},\"required\":[\"Bad\"]}",
                "{\"type\":\"object\",\"properties\":{},\"required\":[\"x\",\"x\"]}", "{\"type\":\"object\",\"properties\":{\"kg\":{\"type\":\"number\",\"quantum\":0.3}}}",
                "{\"type\":\"boolean\",\"enum\":[true]}", "{\"type\":\"fracKey\",\"max\":4}", "{\"type\":\"stamp\",\"pattern\":\"^a$\"}", "{\"type\":\"id\",\"items\":{\"type\":\"json\"}}", "{\"type\":\"json\",\"integer\":true}",
            )
            for (domain in domains) bad("domain $domain", size + "domain", obj(domain))

            for (key in listOf("name", "scope", "origins", "serverInternal", "args")) bad("command missing $key", start + key, null)
            bad("command unknown", start + "colour", string)
            bad("command name", start + "name", Json.of("probe.Start"))
            bad("command duplicated", at("commands"), Json.Arr(probe.member("commands").arr() + probe.member("commands").arr().first()))
            bad("command scope", start + "scope", Json.of("product:elsewhere"))
            for (value in listOf("[]", "[\"replica\",\"ghost\"]", "[\"replica\",\"replica\"]")) bad("command origins $value", start + "origins", obj(value))
            bad("serverInternal shape", start + "serverInternal", string)
            bad("serverInternal replica", start + "serverInternal", Json.of(true))
            bad("beforePull replica", start + "beforePull", Json.of(true))
            bad("beforePull shape", start + "beforePull", string)
            bad("predicts unknown", start + "predicts", obj("[\"ghost\"]"))
            bad("predicts wholePut", start + "predicts", obj("[\"fact\"]"))
            bad("predicts repeated", start + "predicts", obj("[\"run\",\"run\"]"))
            bad("arg name", start + at("args", "Bad"), obj("{\"type\":\"json\"}"))
            bad("arg missing type", start + at("args", "label", "type"), null)
            bad("arg kind", start + at("args", "label", "type"), string)
            bad("arg unknown ref", start + at("args", "label", "type"), Json.of("ref<ghost>"))
            bad("arg optional shape", start + at("args", "label", "optional"), string)
            bad("arg unknown", start + at("args", "label", "extra"), string)
            bad("arg nested domain", start + at("args", "label", "domain"), obj("{\"type\":\"array\",\"items\":{\"type\":\"number\",\"quantum\":0.3}}"))
            return cases
        }

        private fun changed(value: Json, path: List<String>, replacement: Json?): Json {
            if (path.isEmpty()) return replacement!!
            if (value is Json.Arr) {
                val index = path.first().toInt()
                return Json.Arr(value.values.mapIndexed { i, member -> if (i == index) changed(member, path.drop(1), replacement) else member })
            }
            val members = value.obj().toMutableMap()
            val key = path.first()
            if (path.size > 1) members[key] = changed(members.getValue(key), path.drop(1), replacement)
            else if (replacement == null) members.remove(key) else members[key] = replacement
            return Json.Obj(members.toList())
        }
    }
}

class RegistryCompositionTests {
    private val root = File(System.getProperty("windmill.contract"), "sync")
    private fun registry(name: String) = Registry(Json.parse(File(root, "$name.registry.json").readBytes()))

    @Test fun composesCurrentProductRegistriesLosslessly() {
        val parts = listOf(registry("gym"), registry("journal"))
        val composed = Registry.compose("windmill", parts)
        assertEquals(setOf("gym", "journal"), composed.products.keys)
        assertEquals(parts.flatMap { it.types.map(TypeDef::json) }, composed.types.map(TypeDef::json))
        assertEquals(parts.flatMap { it.commands }, composed.commands)
        assertEquals(4L, composed.version)
        assertEquals(4L, composed.minVersion)
    }

    @Test fun compositionRejectsEmptyInvalidNameDuplicateProductAndVersionMismatch() {
        val gym = registry("gym")
        val journal = registry("journal")
        assertThrows(IllegalArgumentException::class.java) { Registry.compose("windmill", emptyList()) }
        assertThrows(IllegalArgumentException::class.java) { Registry.compose("Windmill", listOf(gym)) }
        assertThrows(IllegalArgumentException::class.java) { Registry.compose("windmill", listOf(gym, gym)) }
        for (key in listOf("version", "minVersion")) {
            val mismatch = Registry(Json.Obj(journal.json.obj().map { (name, value) -> name to if (name == key) Json.of(5) else value }))
            assertThrows(IllegalArgumentException::class.java) { Registry.compose("windmill", listOf(gym, mismatch)) }
        }
    }
}
