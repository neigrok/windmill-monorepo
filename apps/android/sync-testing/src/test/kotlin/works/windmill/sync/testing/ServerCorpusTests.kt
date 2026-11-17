package works.windmill.sync.testing

import java.io.File
import org.junit.Test
import org.junit.Assert.assertEquals
import works.windmill.sync.core.*
import works.windmill.sync.modelserver.*

class ServerCorpusTests {
    @Test fun everyClaimedServerFile() {
        runServerCorpus(CorpusTests.root)
    }
    @Test fun effectsCoalesceIntoOneFramePerChangedScope() {
        val vector = Json.parse(File(CorpusTests.root, "sync/corpus/admit/cross-scope.json").readBytes()).arr().first()
        val input = vector.member("input")
        val registry = Registry(Json.parse(File(CorpusTests.root, "sync/probe.registry.json").readBytes()))
        val delegate = EffectPlanRules(input.member("effectPlan"))
        val steps = mutableListOf<String>()
        val rules = object : ServerRules {
            override fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?): Set<ScopeKey> {
                steps.add("discover")
                check(context.record(RecordKey("card", RecordID("card0009"))) == null && context.deltas.isEmpty())
                return delegate.discoverEffectScopes(context, command)
            }
            override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome {
                steps.add("command")
                return delegate.run(command, context)
            }
            override fun effects(changes: List<RecordChange>, context: RuleContext): Effects {
                steps.add("effects")
                check(changes.size == 3)
                return delegate.effects(changes, context)
            }
        }
        val (state, answer) = Admission(registry, rules).admit(input.member("intent"), IntentOrigin("A"), input.member("serverNow").long(), ServerState(input.member("state")))
        assertEquals(listOf("discover", "command", "effects"), steps)
        assertEquals(vector.member("expect"), Json.objectOf("result" to answer.result, "state" to state.json))
        val expected = listOf("acct:A/probe", "acct:A/overlay/b_00000001", "tree:b_00000001").map { key ->
            val scope = vector.member("expect").member("state").member("scopes").member(key)
            val rows = vector.member("expect").member("state").member("rows").member(key).arr().filter { it["seq"] == scope["seq"] }
            Json.objectOf("key" to Json.of(key), "frame" to Json.objectOf("op" to Json.of("change"), "scope" to ScopeKey(key).ref.json,
                "epoch" to Json.of("ep-1"), "seq" to scope.member("seq"), "digest" to scope.member("digest"), "rows" to Json.Arr(rows)))
        }
        assertEquals(expected, answer.events.map { it.json })
    }
    @Test fun aSameTextReplacementLeavesEveryScopeUnchanged() {
        val vector = Json.parse(File(CorpusTests.root, "sync/corpus/admit/cross-scope.json").readBytes()).arr().first()
        val registry = Registry(Json.parse(File(CorpusTests.root, "sync/probe.registry.json").readBytes()))
        val before = ServerState(vector.member("expect").member("state"))
        val plan = Json.parse("""{"declared":["acct:A/overlay/b_00000001"],"command":{"acct:A/overlay/b_00000001":[{"t":"mark","id":"oak","x":{"memo":{"text":"one two","replace":true}}}]}}""")
        val (after, answer) = Admission(registry, EffectPlanRules(plan)).admit(vector.member("input").member("intent"), IntentOrigin("A"), 2_000_000, before)
        assertEquals(Json.objectOf("s" to Json.of("ok"), "seq" to Json.of(2), "write" to Json.array()), answer.result)
        assertEquals(emptyList<LiveEvent>(), answer.events)
        assertEquals(before.json, after.json)
    }
    @Test fun localRulesReadTheTargetScopeAndCascadeThere() {
        val vector = Json.parse(File(CorpusTests.root, "sync/corpus/admit/check.json").readBytes()).arr()
            .single { it.member("name").str() == "a run delete kills its alive laps in the same seq with one server stamp" }
        val schema = Json.parse(File(CorpusTests.root, "sync/probe.registry.json").readBytes())
        val registry = Registry(schema.with("commands" to Json.Arr(schema.member("commands").arr().map {
            if (it["name"] == Json.of("probe.tick")) it.with("scope" to Json.of("tree")) else it
        })))
        val product = ScopeKey("acct:A/probe")
        val tree = ScopeKey("tree:b_00000001")
        val before = ServerState(vector.member("input").member("state"))
        before.scopes[tree.text] = ScopeRecord("A", seq = 17)
        val expected = ServerState(vector.member("expect").member("state"))
        expected.scopes[tree.text] = ScopeRecord("A", seq = 17)
        val delta = IntentShape.effect(vector.member("input").member("intent").member("d").arr().single(), product, "command", registry)
        val rules = object : ServerRules {
            override val localCheckTypes = setOf("run")
            override fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?) = setOf(product)
            override fun run(command: CheckedCommand, context: RuleContext) = CommandOutcome(product = context.product, into = mapOf(product to listOf(delta)))
            override fun check(changes: List<RecordChange>, context: RuleContext) = ProbeServerRules().check(changes, context)
        }
        val intent = Json.objectOf("scope" to tree.ref.json, "cmd" to Json.objectOf("name" to Json.of("probe.tick"), "args" to Json.objectOf()))
        val (after, answer) = Admission(registry, rules).admit(intent, IntentOrigin("A"), 1_000_000, before)
        assertEquals(Json.objectOf("s" to Json.of("ok"), "seq" to Json.of(17), "write" to Json.array()), answer.result)
        assertEquals(expected.json, after.json)
        assertEquals(listOf(product), answer.events.map { it.key })
    }
}
