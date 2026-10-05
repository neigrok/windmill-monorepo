package works.windmill.domain.testing

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.sync.core.*

private data class CheckedEntity(override val id: Id<CheckedEntity>, val values: Map<String, Json>) : Writable<CheckedEntity> {
    override fun fields() = values
}
private open class CheckedType(override val type: String, val written: Map<String, Json>,
    override val scope: ScopeRef = ScopeRef.product("chk"), override val checks: List<Check<CheckedEntity>> = written.keys.map { Check(it) { value, _ -> value } }) : WritableType<CheckedEntity> {
    override fun decode(f: Fields) = CheckedEntity(Id(f.id, this), written.mapValues { (name, fallback) -> f.json(name) ?: fallback })
    fun sample() = CheckedEntity(Id("item0001", this), written)
}
private open class CheckedDraft(type: String, written: Map<String, Json>, override val savesGuarded: Boolean = false,
    checks: List<Check<CheckedEntity>> = written.keys.map { Check(it) { value, _ -> value } }) : CheckedType(type, written, checks = checks), DraftableType<CheckedEntity>

class ChecksTests {
    private val registry = Registry(Json.parse("""
    {"registry": "check", "version": 1, "minVersion": 1,
     "products": {"chk": {"surfaces": ["ios"], "device": {}}},
     "types": [
       {"type": "item", "scope": "product:chk", "identity": "minted", "idSpace": "global", "idPattern": "^[a-z0-9]{8}$",
        "mint": {"prefix": "", "alphabet": "abcdefghijklmnopqrstuvwxyz0123456789", "length": 8},
        "life": true, "revivable": false, "deadRows": "spent", "origins": ["replica", "server"], "cap": 5,
        "fields": {
          "name": {"kind": "lww", "writer": "client", "unit": "chars", "min": 1, "max": 20, "domain": {"type": "string"}},
          "ord": {"kind": "lww", "writer": "client", "domain": {"type": "fracKey"}},
          "weight": {"kind": "lww", "writer": "client", "domain": {"type": "number", "min": -100, "max": 100, "nullable": true, "quantum": 0.5}},
          "tags": {"kind": "lww", "writer": "client", "unit": "bytes", "max": 400,
                   "domain": {"type": "array", "maxItems": 4, "items": {"type": "object", "required": ["label"],
                              "properties": {"label": {"type": "string", "unit": "chars", "max": 10}}}}},
          "count": {"kind": "serial", "writer": "server", "serialNext": []}}},
       {"type": "page", "scope": "product:chk", "identity": "keyed", "idPattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", "life": false,
        "origins": ["replica", "server"],
        "fields": {
          "body": {"kind": "text", "writer": "client", "unit": "bytes", "max": 100},
          "mood": {"kind": "lww", "writer": "client", "domain": {"type": "number", "integer": true, "min": 0, "max": 10, "nullable": true}}}},
       {"type": "flag", "scope": "product:chk", "identity": "keyed", "idPattern": "^[a-z]+$", "life": false, "origins": ["replica"],
        "fields": {"on": {"kind": "lww", "writer": "client", "domain": {"type": "boolean"}}}},
       {"type": "task", "scope": "product:chk", "identity": "keyed", "idPattern": "^[a-z]+$", "life": false, "origins": ["replica"],
        "fields": {"state": {"kind": "ranked", "writer": "client", "rank": {"open": 0, "done": 1}}}},
       {"type": "shelf", "scope": "product:chk", "identity": "keyed", "idPattern": "^[a-z]+$", "life": false, "origins": ["replica"],
        "fields": {"tags": {"kind": "lww", "writer": "client", "unit": "bytes", "max": 400,
                            "domain": {"type": "array", "maxItems": 5, "items": {"type": "string", "unit": "chars", "max": 10}}}}},
       {"type": "reading", "scope": "product:chk", "identity": "keyed", "idPattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", "life": true,
        "wholePut": true, "deadRows": "spent", "origins": ["replica"],
        "fields": {
          "value": {"kind": "lww", "writer": "client", "domain": {"type": "number", "min": 0, "max": 500}},
          "at": {"kind": "lww", "writer": "client", "domain": {"type": "number", "integer": true, "min": 0}}}}],
     "commands": [
       {"name": "chk.ask", "scope": "product:chk", "origins": ["replica", "server"], "serverInternal": false,
        "args": {"text": {"type": "json", "domain": {"type": "string", "unit": "chars", "max": 50}}, "itemId": {"type": "ref<item>"}}}]}
    """))
    private val name = TextSpec("item.name", MeasureUnit.chars, 1, 20, true, true)
    private val weight = NumberSpec("item.weight", -100.0, 100.0, quantum = .5)
    private val tags = CountSpec("item.tags", 0, 4)
    private val label = TextSpec("item.tags.label", MeasureUnit.chars, 0, 10, true, true)
    private val body = TextSpec("page.body", MeasureUnit.bytes, 0, 100, false, false)
    private val mood = NumberSpec("page.mood", 0.0, 10.0, integer = true)
    private val itemFields = mapOf("name" to Json.of("Bench"), "weight" to Json.of(60), "tags" to Json.Arr(listOf(Json.objectOf("label" to Json.of("push")))))
    private val rules get() = listOf(name, weight, tags, label, body, mood).map(Rule::local)
    private fun book(type: EntityType<*>, rules: List<Rule> = this.rules) = RuleBook(registry, listOf(type), rules)
    private fun check(type: CheckedType, rules: List<Rule> = this.rules, registry: Registry = this.registry) = RegistryCheck.entity(type, type.sample(), RuleBook(registry, listOf(type), rules), registry)
    private fun fails(step: Int, path: String, body: () -> Unit) {
        val failure = assertThrows(CheckFailure::class.java, body)
        assertEquals(step, failure.step); assertEquals(path, failure.path); assertEquals("RegistryCheck", failure.check)
    }
    @Test fun compatibleDeclarationsPass() {
        check(CheckedDraft("item", itemFields, true))
        check(CheckedDraft("page", mapOf("body" to Json.of("sleep"), "mood" to Json.of(7))))
        val command = command(listOf(TextSpec("chk.ask.text", MeasureUnit.chars, 1, 50, true, true)))
        RegistryCheck.command(command, RuleBook(registry, emptyList(), rules + command.specs.map(Rule::local)))
    }
    @Test fun stepOneRequiresProductScopeAndKnownType() {
        fails(1, "item") { RegistryCheck.entity(CheckedType("item", itemFields, ScopeRef.product("elsewhere")), registry) }
        fails(1, "absent") { RegistryCheck.entity(CheckedType("absent", emptyMap()), registry) }
    }
    @Test fun stepTwoRequiresRemovableLife() {
        val flag = object : CheckedType("flag", mapOf("on" to Json.of(false))), RemovableType<CheckedEntity> { override val heldRemoval = false }
        fails(2, "flag") { RegistryCheck.entity(flag, registry) }
    }
    @Test fun stepThreeRequiresClientLwwFractionalOrder() {
        val item = object : CheckedType("item", itemFields), OrderedType<CheckedEntity> { override val orderField = "name" }
        fails(3, "item.name") { RegistryCheck.entity(item, registry) }
    }
    @Test fun stepFourRejectsSerialServerUnknownAndOrderWrites() {
        fails(4, "item.count") { check(CheckedType("item", mapOf("count" to Json.of(1)))) }
        fails(4, "item.missing") { check(CheckedType("item", mapOf("missing" to Json.of(1)))) }
        val ordered = object : CheckedType("item", itemFields + ("ord" to Json.of("a0"))), OrderedType<CheckedEntity> { override val orderField = "ord" }
        fails(4, "item.ord") { check(ordered) }
    }
    @Test fun stepFiveRejectsChecksOfUnwrittenFields() {
        val type = CheckedType("item", mapOf("weight" to Json.of(2)), checks = listOf(Check("name") { value, _ -> value }))
        fails(5, "item.name") { check(type) }
    }
    @Test fun stepSixRejectsSpecWithoutFieldCheck() {
        val type = CheckedType("item", itemFields, checks = emptyList())
        fails(6, "item.name") { check(type) }
    }
    @Test fun stepSixRejectsWideTextOffGridCrowdedAndMissingNestedPath() {
        val type = CheckedDraft("item", itemFields, true)
        fails(6, "item.name") { check(type, rules.filter { it.name != name.path } + Rule.local(TextSpec(name.path, MeasureUnit.chars, 1, 30, true, true))) }
        fails(6, "item.weight") { check(type, rules.filter { it.name != weight.path } + Rule.local(NumberSpec(weight.path, -100.0, 100.0, quantum = .25))) }
        fails(6, "item.tags") { check(type, rules.filter { it.name != tags.path } + Rule.local(CountSpec(tags.path, 0, 5))) }
        fails(6, "item.tags.color") { check(type, rules + Rule.local(TextSpec("item.tags.color", MeasureUnit.chars, 0, 10, true, true))) }
        fails(6, "item.tags.label") { check(type, rules.filter { it.name != label.path } + Rule.local(TextSpec(label.path, MeasureUnit.chars, 0, 11, true, true))) }
    }
    @Test fun rankedChoiceAndArrayStringsRespectRegistry() {
        val state = ChoiceSpec("task.state", listOf("open", "done"))
        val task = CheckedType("task", mapOf("state" to Json.of("open")))
        check(task, listOf(Rule.local(state)))
        fails(6, state.path) { check(task, listOf(Rule.local(ChoiceSpec(state.path, listOf("open", "archived"))))) }
        val shelf = CheckedType("shelf", mapOf("tags" to Json.Arr(listOf(Json.of("rice")))))
        check(shelf, listOf(Rule.local(TextSpec("shelf.tags", MeasureUnit.chars, 0, 10, true, true))))
    }
    @Test fun countSpecLargestEncodingCannotExceedFieldBound() {
        val type = CheckedType("shelf", mapOf("tags" to Json.Arr(emptyList())))
        val smaller = Registry(Json.parse(registry.json.jcs.replace("\"max\":400", "\"max\":100")))
        fails(6, "shelf.tags") { check(type, listOf(Rule.local(CountSpec("shelf.tags", 0, 5)), Rule.local(TextSpec("shelf.tags", MeasureUnit.chars, 0, 10, true, true))), smaller) }
    }
    @Test fun stepSevenRequiresDraftRoundTrip() {
        val lossy = object : CheckedDraft("item", mapOf("name" to Json.of("Bench"))) {
            override fun decode(f: Fields) = CheckedEntity(Id(f.id, this), mapOf("name" to Json.of("")))
        }
        fails(7, "item") { check(lossy, emptyList()) }
    }
    @Test fun stepEightRejectsGuardedText() {
        fails(8, "page") { check(CheckedDraft("page", mapOf("mood" to Json.Null), true), emptyList()) }
    }
    @Test fun stepNineRequiresQuantumSpecsAtEveryDepth() {
        fails(9, "item.weight") { check(CheckedDraft("item", itemFields, true), rules.filter { it.name != weight.path }) }
        val nested = Registry(Json.parse(registry.json.jcs.replace("\"max\":400", "\"max\":900").replace("\"properties\":{\"label\":", "\"properties\":{\"kg\":{\"type\":\"number\",\"quantum\":0.5},\"label\":")))
        fails(9, "item.tags.kg") { check(CheckedDraft("item", itemFields, true), rules, nested) }
        check(CheckedDraft("item", itemFields, true), rules + Rule.local(NumberSpec("item.tags.kg", -100.0, 100.0, quantum = .5)), nested)
    }
    @Test fun stepTenRequiresEveryWrittenNestedStringSpec() {
        fails(10, "item.tags.label") { check(CheckedDraft("item", itemFields, true), rules.filter { it.name != label.path }) }
        check(CheckedType("item", mapOf("weight" to Json.of(60))), listOf(Rule.local(weight)))
    }
    @Test fun stepElevenRequiresWholeUnguardedSave() {
        val both = mapOf("value" to Json.Null, "at" to Json.Null)
        check(CheckedDraft("reading", both), emptyList())
        fails(11, "reading.at") { check(CheckedType("reading", mapOf("value" to Json.Null)), emptyList()) }
        fails(11, "reading") { check(CheckedDraft("reading", both, true), emptyList()) }
    }
    @Test fun stepElevenRequiresUncheckedClientLwwIntegerTimestampOfWholeType() {
        val both = mapOf("value" to Json.Null, "at" to Json.Null)
        val valid = object : CheckedDraft("reading", both, checks = emptyList()), TimestampedType<CheckedEntity> { override val timestampField = "at" }
        check(valid, emptyList())
        val wrong = object : CheckedDraft("reading", both, checks = emptyList()), TimestampedType<CheckedEntity> { override val timestampField = "value" }
        fails(11, "reading.value") { check(wrong, emptyList()) }
        val checked = object : CheckedDraft("reading", both), TimestampedType<CheckedEntity> { override val timestampField = "at" }
        fails(11, "reading.at") { check(checked, emptyList()) }
        val page = object : CheckedDraft("page", mapOf("mood" to Json.Null), checks = emptyList()), TimestampedType<CheckedEntity> { override val timestampField = "mood" }
        fails(11, "page") { check(page, emptyList()) }
    }
    private fun command(specs: List<ValueSpec>, name: String = "chk.ask") = object : ServerCommand { override val name = name; override val specs = specs; override val args = emptyMap<String, Json>() }
    @Test fun commandRequiresKnownArgumentPathRegistryBoundsAndPinnedSpec() {
        fails(0, "chk.unknown") { RegistryCheck.command(command(emptyList(), "chk.unknown"), book(CheckedType("item", itemFields))) }
        val wide = command(listOf(TextSpec("chk.ask.text", MeasureUnit.chars, 0, 500, true, true)))
        fails(6, "chk.ask.text") { RegistryCheck.command(wide, RuleBook(registry, emptyList(), wide.specs.map(Rule::local))) }
        val okay = command(listOf(TextSpec("chk.ask.text", MeasureUnit.chars, 1, 50, true, true)))
        fails(6, "chk.ask.text") { RegistryCheck.command(okay, RuleBook(registry, emptyList(), listOf(Rule.local(TextSpec("chk.ask.text", MeasureUnit.chars, 1, 12, true, true))))) }
        val missing = command(listOf(TextSpec("chk.ask.missing", MeasureUnit.chars, 1, 50, true, true)))
        fails(10, "chk.ask.text") { RegistryCheck.command(missing, RuleBook(registry, emptyList(), missing.specs.map(Rule::local))) }
    }
    @Test fun commandRequiresTextSpecsInBothCommandAndBook() {
        fails(10, "chk.ask.text") { RegistryCheck.command(command(emptyList()), RuleBook(registry, emptyList(), listOf(Rule.local(TextSpec("chk.ask.text", MeasureUnit.chars, 1, 50, true, true))))) }
        fails(10, "chk.ask.text") { RegistryCheck.command(command(listOf(TextSpec("chk.ask.text", MeasureUnit.chars, 1, 50, true, true))), RuleBook(registry, emptyList(), emptyList())) }
    }
    private val mapped = object : Refusals<Boolean> { override fun of(violation: Violation) = false; override fun of(refused: Refused) = false; override fun isGeneric(refusal: Boolean) = refusal }
    private fun withJson(json: Json, body: (String) -> Unit) { val file = File.createTempFile("domain-kit-checks-", ".json"); try { file.writeText(json.jcs); body(file.absolutePath) } finally { file.delete() } }
    private fun vectors(rules: List<Rule>): Json = Json.Arr(rules.filter { it.kind == Rule.Kind.local }.flatMap { rule ->
        listOf(Json.objectOf("name" to Json.of("${rule.name} spec"), "input" to Json.objectOf("spec" to (rule.spec ?: Json.Null)), "expect" to Json.Null),
            Json.objectOf("name" to Json.of("${rule.name} entity"), "input" to Json.objectOf("entity" to Json.of(rule.subject)), "expect" to Json.objectOf("violation" to Json.objectOf("rule" to Json.of(rule.name)))))
    })
    @Test fun ruleBookRequiresUniqueNamesAndEveryLocalVector() {
        val type = CheckedType("item", itemFields)
        val book = book(type)
        withJson(vectors(rules)) { RuleBookCheck.check(book, mapped, it) }
        withJson(vectors(rules)) { file -> assertThrows(CheckFailure::class.java) { RuleBookCheck.check(book(type, rules + rules.first()), mapped, file) } }
        withJson(vectors(rules.filter { it.name != label.path })) { file -> assertEquals(label.path, assertThrows(CheckFailure::class.java) { RuleBookCheck.check(book, mapped, file) }.path) }
        withJson(Json.Arr(vectors(rules).arr().filter { it["name"] != Json.of("${label.path} entity") })) { file -> assertEquals(label.path, assertThrows(CheckFailure::class.java) { RuleBookCheck.check(book, mapped, file) }.path) }
    }
    @Test fun ruleBookChecksBothServerPathsAndLocalBackstopNotice() {
        val seen = mutableListOf<Refused.Path>()
        val refuses = object : Refusals<Refused> { override fun of(violation: Violation): Refused = error("not a code"); override fun of(refused: Refused): Refused { seen.add(refused.path); return refused }; override fun isGeneric(refusal: Refused) = false }
        val book = RuleBook(registry, emptyList(), listOf(Rule.serverDecided("item.duplicate", listOf(RefusalCode("duplicate-name")), "item"), Rule.local("item.local", "item", listOf(RefusalCode("invalid")))))
        withJson(Json.Arr(listOf(Json.objectOf("name" to Json.of("local"), "input" to Json.objectOf("entity" to Json.of("item")), "expect" to Json.objectOf("violation" to Json.objectOf("rule" to Json.of("item.local"))))))) { RuleBookCheck.check(book, refuses, it) }
        assertEquals(listOf(Refused.Path.predicted, Refused.Path.notice, Refused.Path.notice), seen)
        val generic = object : Refusals<Boolean> { override fun of(violation: Violation) = true; override fun of(refused: Refused) = true; override fun isGeneric(refusal: Boolean) = refusal }
        withJson(vectors(rules)) { file -> assertThrows(CheckFailure::class.java) { RuleBookCheck.check(book(CheckedType("item", itemFields)), generic, file) } }
    }
    @Test fun parityRejectsDrift() {
        val book = book(CheckedType("item", itemFields))
        withJson(book.json) { file -> RuleBookParity.check(book, file); assertThrows(CheckFailure::class.java) { RuleBookParity.check(book(CheckedType("item", itemFields), rules.drop(1)), file) } }
    }
}
