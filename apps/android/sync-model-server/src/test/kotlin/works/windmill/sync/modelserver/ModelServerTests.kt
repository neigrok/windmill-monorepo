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
    @Test fun gymDocumentEditsCannotInventOrOverflowRevisions() {
        val vector = gymVector("R118 a name and entries edit increments revision once and preserves creation metadata")
        val gym = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/gym.registry.json").readBytes()))
        for (revision in listOf(null, 2_147_483_647L)) {
            val state = ServerState(vector.member("input").member("state")); val scope = "acct:A/gym"
            val key = RecordKey("routine", RecordID("routine0002")); val row = Row(state.rows.getValue(scope).getValue(key))
            val fields = row.lattice.fields.toMutableMap()
            if (revision == null) fields.remove("revision") else fields["revision"] = Register(Json.of(revision), fields.getValue("revision").stamp)
            state.rows.getValue(scope)[key] = row.copy(lattice = Lattice(row.lattice.life, row.lattice.born, fields)).json
            state.scopes.getValue(scope).digest = ScopeDigest.rows(state.rows.getValue(scope).values.toList())
            val before = state.json; val input = vector.member("input")
            val (after, admitted) = Admission(gym, GymServerRules()).admit(input.member("intent"), IntentOrigin("A"), input.member("serverNow").long(), state)
            assertEquals(Json.objectOf("s" to Json.of("refused"), "code" to Json.of("invalid")), admitted.result)
            assertEquals(emptyList<LiveEvent>(), admitted.events)
            assertEquals(before, after.json); assertEquals(before, state.json)
        }
    }
    @Test fun gymCapRefusalRollsBackMetadataSnapshotAndServerClock() {
        val create = gymVector("a routine created with entries takes revision 1").member("input")
        val cap = gymVector("an eleventh note is refused cap").member("input")
        val routine = create.member("intent").member("d").arr().single()
        val fields = routine.member("f").obj().mapValues { Json.array(it.value.arr()[0], Json.Null) } + ("createdDoor" to Json.array(Json.of("ask"), Json.Null))
        val delta = routine.with("born" to Json.Null, "life" to Json.array(Json.of("alive"), Json.Null), "f" to Json.Obj(fields.toList()))
        val intent = Json.objectOf("scope" to Json.of("self/gym"), "d" to Json.Arr(listOf(delta) + cap.member("intent").member("d").arr()))
        val state = ServerState(cap.member("state")); val before = state.json
        val gym = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/gym.registry.json").readBytes()))
        val (after, admitted) = Admission(gym, GymServerRules()).admit(intent, IntentOrigin("A"), cap.member("serverNow").long(), state)
        assertEquals(Json.objectOf("s" to Json.of("refused"), "code" to Json.of("cap"), "detail" to Json.objectOf("type" to Json.of("note"), "cap" to Json.of(10))), admitted.result)
        assertEquals(emptyList<LiveEvent>(), admitted.events)
        assertEquals(before, after.json); assertEquals(before, state.json)
    }
    @Test fun gymThreadCreatedWithoutItsTitleIsInvalid() {
        val input = gymVector("a phone turn creates the conversation, the lifter message and the running Coach message in one intent").member("input")
        assertRefused("invalid", input, without(input.member("intent"), "thread", "title"))
    }
    @Test fun gymThreadDeleteTakesItsMessagesAndUnlinksItsProposals() {
        for (name in listOf("a conversation delete kills its messages and unlinks the proposals naming it", "a conversation delete unlinks the workout proposals naming it")) {
            val vector = gymVector(name); val input = vector.member("input")
            val (after, admitted) = admit(input, input.member("intent"))
            assertEquals(vector.member("expect"), Json.objectOf("result" to admitted.result, "state" to after.json))
        }
    }
    @Test fun gymLifterMessageBoundIsMeasuredInBytes() {
        val input = gymVector("a lifter message of 8,000 bytes is admitted").member("input")
        fun saying(text: String) = input.member("intent").let { intent ->
            intent.with("d" to Json.Arr(intent.member("d").arr().map { d ->
                if (d.member("f")["role"]?.arr()?.first() != Json.of("lifter")) d
                else d.with("f" to d.member("f").with("text" to Json.array(Json.of(text), d.member("f").member("text").arr()[1])))
            }))
        }
        assertEquals(Json.of("ok"), admit(input, saying("é".repeat(4000))).second.result.member("s"))
        assertRefused("invalid", input, saying("é".repeat(4000) + "x"))
    }
    @Test fun gymWritersTerminalStateBeatsInterruptedWhateverItsStamp() {
        val interrupted = gymVector("a server-origin interrupted lands on a running Coach message").member("expect").member("state")
        val writer = gymVector("the writer ends its turn with its text, receipt, calls and truncation").member("input")
        val (after, admitted) = admit(writer.with("state" to interrupted), writer.member("intent"))
        assertEquals(Json.of("ok"), admitted.result.member("s"))
        val row = after.json.member("rows").member("acct:A/gym").arr().single { it.member("id") == Json.of("turn00000001") }.member("f")
        val written = writer.member("intent").member("d").arr().single().member("f")
        assertEquals(written.member("state"), row.member("state"))
        assertEquals(written.member("text"), row.member("text"))
    }
    @Test fun gymMessageFinalHoldsAfterAWritersTerminalAndLeavesTruncatedWritable() {
        for (register in listOf("state", "text", "receipt", "calls")) {
            val input = gymVector("a write of $register after the writer ended its turn is refused message-final").member("input")
            assertRefused("message-final", input, input.member("intent"))
        }
        val truncated = gymVector("truncated stays writable after the writer ended its turn")
        val (after, admitted) = admit(truncated.member("input"), truncated.member("input").member("intent"))
        assertEquals(truncated.member("expect"), Json.objectOf("result" to admitted.result, "state" to after.json))
    }
    @Test fun gymWorkoutProposalWithoutItsWorkoutOrChangesIsRefusedNeverAFault() {
        val replica = gymVector("a replica's workout proposal from the phone Coach door, guarded on the plan, is admitted").member("input")
        assertEquals(Json.of("ok"), admit(replica, replica.member("intent")).second.result.member("s"))
        assertRefused("invalid", replica, without(replica.member("intent"), "workoutProposal", "sessionId"))
        assertRefused("invalid", replica, without(replica.member("intent"), "workoutProposal", "changes"))
        val server = gymVector("a workout proposal naming an absent workout is refused unknown-record").member("input")
        assertRefused("unknown-record", server, without(server.member("intent"), "workoutProposal", "sessionId"))
    }
    private fun admit(input: Json, intent: Json): Pair<ServerState, Admitted> {
        val gym = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/gym.registry.json").readBytes()))
        val origin = input.member("origin"); val account = origin.member("account").str()
        val from = if (origin.member("kind").str() == "replica") IntentOrigin(account, origin.member("replica").str(), origin.member("n").long()) else IntentOrigin(account)
        return Admission(gym, GymServerRules()).admit(intent, from, input.member("serverNow").long(), ServerState(input.member("state")))
    }
    private fun assertRefused(code: String, input: Json, intent: Json) {
        val (after, admitted) = admit(input, intent)
        assertEquals(Json.objectOf("s" to Json.of("refused"), "code" to Json.of(code)), admitted.result)
        assertEquals(emptyList<LiveEvent>(), admitted.events)
        assertEquals(input.member("state"), after.json)
    }
    private fun without(intent: Json, type: String, field: String) = intent.with("d" to Json.Arr(intent.member("d").arr().map { d ->
        if (d.member("t") == Json.of(type)) d.with("f" to d.member("f").with(field to null)) else d
    }))
    private fun gymVector(name: String) = Json.parse(File(System.getProperty("windmill.contract"), "sync/corpus/gym/admit.json").readBytes()).arr().single { it.member("name") == Json.of(name) }
}
