package works.windmill.sync.modelserver

import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.*

class ComposedServerRulesTests {
    @Test fun threeProductsDispatchOnceAndRollbackTheThirdRefusal() {
        val names = listOf("alpha", "beta", "gamma")
        val registry = Registry.compose("three", names.map { name -> Registry(Json.parse("""{
            "registry":"$name","version":3,"minVersion":2,"products":{"$name":{}},
            "types":[{"type":"$name","scope":"product:$name","identity":"singleton","singletonId":"$name",
            "idPattern":"^$name$","life":false,"origins":["server","replica"],
            "fields":{"value":{"kind":"lww","writer":"client","domain":{"type":"string"}}}}],
            "commands":[{"name":"$name.set","scope":"product:$name","origins":["server"],"serverInternal":false,"args":{}}]
        }""")) })
        for (refuse in listOf(false, true)) {
            val calls = mutableListOf<String>()
            val products = names.reversed().associateWith { Rules(it, calls, refuse) }
            assertThrows(IllegalArgumentException::class.java) { ComposedServerRules(registry, products - "gamma") }
            assertThrows(IllegalArgumentException::class.java) { ComposedServerRules(registry, products + ("extra" to Rules("extra", calls, false))) }
            val rules = ComposedServerRules(registry, products)
            val admission = Admission(registry, rules)
            val state = ServerState()
            for (name in names) state.scopes["acct:A/$name"] = ScopeRecord("A")
            val before = state.json
            val intent = Json.parse("""{"scope":"self/gamma","cmd":{"name":"gamma.set","args":{}}}""")
            val (after, admitted) = admission.admit(intent, IntentOrigin("A"), 1_000, state)
            assertEquals(listOf("gamma.replay", "gamma.discover", "gamma.run", "alpha.check", "beta.check", "gamma.check"), calls)
            assertEquals(before, state.json)
            if (refuse) {
                assertEquals(Json.parse("""{"s":"refused","code":"invalid"}"""), admitted.result)
                assertEquals(emptyList<LiveEvent>(), admitted.events)
                assertEquals(before, after.json)
                continue
            }
            assertEquals(Json.parse("""{"s":"ok","seq":1,"write":[]}"""), admitted.result)
            assertEquals(listOf("gamma", "alpha", "beta").map { "acct:A/$it" }, admitted.events.map { it.key.text })
            assertEquals(Json.parse("""{"receipt":"gamma","alpha":true,"beta":true,"gamma":true}"""), after.product)
            for (name in names) assertEquals(Json.of("checked"), Row(after.rows.getValue("acct:A/$name").getValue(RecordKey(name, RecordID(name)))).lattice.fields.getValue("value").value)
            calls.clear()
            val replay = intent.with("guard" to Json.parse("""[{"t":"gamma","id":"gamma","field":"value","stamp":"1:0:a"}]"""))
            val (repeated, result) = admission.admit(replay, IntentOrigin("A"), 2_000, after)
            assertEquals(listOf("gamma.replay", "gamma.discover", "gamma.run", "gamma.check"), calls)
            assertEquals(admitted.result, result.result)
            assertEquals(emptyList<LiveEvent>(), result.events)
            assertEquals(after.json, repeated.json)
            val revisions = (1..3).map { Json.parse("""{"t":"gamma","id":"gamma","field":"text","rev":$it,"text":"$it"}""") }
            for ((index, name) in names.withIndex()) assertEquals(revisions.takeLast(index + 1), rules.pruneRevisions(revisions, emptyList(), 2_000, ScopeKey("acct:A/$name"), after))
        }
    }

    private class Rules(val name: String, val calls: MutableList<String>, val refuse: Boolean) : ServerRules {
        override fun replays(command: CheckedCommand, context: RuleContext): Boolean {
            calls += "$name.replay"
            return context.product["receipt"] == Json.of("gamma")
        }
        override fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?): Set<ScopeKey> {
            calls += "$name.discover"
            assertEquals(ScopeKey("acct:A/gamma"), context.scope)
            return if (context.product["receipt"] == null) setOf(ScopeKey("acct:A/alpha"), ScopeKey("acct:A/beta")) else emptySet()
        }
        override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome {
            calls += "$name.run"
            assertEquals("gamma.set", command.name)
            if (context.product["receipt"] != null) return CommandOutcome(product = context.product)
            fun delta(name: String) = PlannedDelta.update(RecordKey(name, RecordID(name)), null, mapOf("value" to Json.of("command")))
            return CommandOutcome(listOf(delta("gamma")), product = context.product.with("receipt" to Json.of("gamma")),
                into = listOf("alpha", "beta").associate { ScopeKey("acct:A/$it") to listOf(delta(it)) })
        }
        override fun check(changes: List<RecordChange>, context: RuleContext): List<PlannedDelta> {
            calls += "$name.check"
            assertEquals(ScopeKey("acct:A/$name"), context.scope)
            assertEquals(ScopeKey("acct:A/gamma"), context.originScope)
            if (changes.isEmpty()) return emptyList()
            assertEquals(listOf("alpha", "beta", "gamma"), changes.map { it.key.type }.sorted())
            assertEquals(Json.of("command"), context.record(RecordKey(name, RecordID(name)))!!.lattice.fields.getValue("value").value)
            if (refuse && name == "gamma") throw Refusal("invalid")
            context.product = context.product.with(name to Json.of(true))
            return listOf(PlannedDelta.update(RecordKey(name, RecordID(name)), null, mapOf("value" to Json.of("checked"))))
        }
        override fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState) = revisions.takeLast(mapOf("alpha" to 1, "beta" to 2, "gamma" to 3).getValue(name))
    }
}
