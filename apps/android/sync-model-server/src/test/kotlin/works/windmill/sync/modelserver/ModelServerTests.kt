package works.windmill.sync.modelserver

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.*

class ModelServerTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    @Test fun processClockDoesNotStepBackAcrossRestoreAndRefusalsAreScripted() {
        val server = ModelServer(registry, ProbeServerRules()); val c = Credential.Account("A")
        assertEquals(100L, server.hello(c, 100).body.member("serverTime").long())
        val copy = server.state; copy.epoch = "mutated"; copy.accounts["A"] = "changed"
        assertEquals("ep-1", server.state.epoch); assertTrue(server.state.accounts.isEmpty())
        server.restore(ServerState()); assertEquals(100L, server.hello(c, 10).body.member("serverTime").long())
        val stamp = Stamp.of(100, 0, "a"); val intent = Intent(ScopeRef.product("probe"), 1, listOf(Delta(RecordKey("day", RecordID("2026-10-04")), Lattice(Life("alive", stamp), fields = mapOf("score" to Register(Json.of(1), stamp)))))).json
        val request = Json.objectOf("replica" to Json.of("rp_" + "a".repeat(32)), "account" to Json.of("A"), "ackThrough" to Json.of(0), "intents" to Json.array(intent))
        val detail = Json.objectOf("rule" to Json.of("custom")); server.refuse(code = "custom-rule", detail = detail)
        val reply = server.push(request, c, 5)
        assertEquals(Json.of("custom-rule"), reply.body.member("results").arr().single()["code"])
        assertEquals(detail, reply.body.member("results").arr().single()["detail"]); assertNull(server.state.json["rows"])
        assertEquals(reply.body.member("results"), server.push(request, c, 0).body.member("results"))
    }
    @Test fun faultsRollBackProductRowsAndClockThenPoisonAndContinue() {
        val rules = object : ServerRules {
            override fun check(changes: List<RecordChange>, context: RuleContext): List<PlannedDelta> {
                context.product = Json.objectOf("mustRollback" to Json.of(true)); throw IllegalStateException("rule-crash")
            }
        }
        val server = ModelServer(registry, rules); val stamp = Stamp.of(100, 0, "a")
        val intent = Intent(ScopeRef.product("probe"), 1, listOf(Delta(RecordKey("day", RecordID("2026-10-04")), Lattice(Life("alive", stamp), fields = mapOf("score" to Register(Json.of(1), stamp)))))).json
        val request = Json.objectOf("replica" to Json.of("rp_" + "a".repeat(32)), "account" to Json.of("A"), "ackThrough" to Json.of(0), "intents" to Json.array(intent))
        repeat(Constants.K_POISON) { n ->
            val answer = server.push(request, Credential.Account("A"), 100)
            assertNull(server.state.json["rows"]); assertNull(server.state.json["scopes"]); assertNull(server.state.json["product"]); assertEquals(Hlc().json, server.state.json["clock"])
            if (n < Constants.K_POISON - 1) assertNotNull(answer.body["retry"]) else assertEquals(Json.of("internal"), answer.body.member("results").arr().single()["code"])
        }
        assertEquals(1L, server.state.replicas.values.single().member("lastN").long())
    }
    @Test fun credentialFailureAndSocketShutdownLeaveNoFrames() {
        val server = ModelServer(registry, ProbeServerRules())
        assertEquals(401, server.pull(byteArrayOf(0), Credential.Unresolved, 1).status)
        assertNull(server.connect(Credential.Unresolved))
        val socket = server.connect(Credential.Absent)!!
        server.subscribe(socket, listOf(ScopeRef.product("probe")))
        assertEquals(Json.of("not-found"), server.frames(socket).single()["op"])
        server.close(socket); assertFalse(server.isOpen(socket)); server.subscribe(socket, listOf(ScopeRef.tree("b_00000000")))
        assertTrue(server.frames(socket).isEmpty())
    }
}
