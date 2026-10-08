package works.windmill.sync.testing

import java.util.Random
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.*
import works.windmill.sync.modelserver.*

class ServerPropertyTests {
    @Test fun absentDeleteSurvivesRestartAndPreventsAnotherReplicasCreateReplay() {
        val cases = listOf("card" to "card0001", "board" to "b_00000001", "tag" to "restored")
        for ((type, id) in cases) {
            val scope = if (type == "tag") ScopeKey("tree:b_00000001") else ScopeKey("acct:A/probe")
            val key = RecordKey(type, RecordID(id))
            val born = Stamp("100:0:a"); val death = Stamp("101:0:b")
            val initial = ServerState().also { it.scopes[scope.text] = ScopeRecord("A") }
            val admission = Admission(CorpusTests.probe, ProbeServerRules())
            val deletion = Intent(scope.ref, deltas = listOf(Delta(key, Lattice(Life("dead", death), born)))).json
            val (deleted, answer) = admission.admit(deletion, IntentOrigin("A", "rp_delete", 1), 200, initial)
            assertEquals(Json.objectOf("s" to Json.of("ok"), "seq" to Json.of(1)), answer.result)
            val stored = deleted.idState(key, scope, CorpusTests.probe)
            val row = checkNotNull(stored.row)
            assertEquals("dead", stored.state)
            assertEquals(Lattice(Life("dead", death), born), row.lattice)
            assertEquals(1L, row.seq)
            assertEquals(ScopeDigest.ZERO, deleted.scopes.getValue(scope.text).digest)
            assertEquals(type == "card", deleted.spent[scope.text]?.containsKey(key) == true)
            val replay = Intent(scope.ref, deltas = listOf(Delta(key, Lattice(Life("alive", born), born)))).json
            val (after, replayed) = admission.admit(replay, IntentOrigin("A", "rp_creator", 1), 201, ServerState(deleted.json))
            assertEquals(Json.objectOf("s" to Json.of("ok"), "seq" to Json.of(1)), replayed.result)
            assertEquals(emptyList<LiveEvent>(), replayed.events)
            assertEquals(deleted.json, after.json)
        }
    }

    @Test fun wrongBirthDeleteRefusesWithoutChangingTheRecreatedRecord() {
        val scope = ScopeKey("acct:A/probe"); val key = RecordKey("card", RecordID("card0001"))
        val born = Stamp("200:0:server")
        val admission = Admission(CorpusTests.probe, ProbeServerRules())
        val create = Intent(scope.ref, deltas = listOf(Delta(key, Lattice(Life("alive", born), born)))).json
        val (created, _) = admission.admit(create, IntentOrigin("A", "rp_creator", 1), 200, ServerState())
        val deletion = Intent(scope.ref, deltas = listOf(Delta(key, Lattice(Life("dead", Stamp("201:0:client")), Stamp("100:0:server"))))).json
        val (after, answer) = admission.admit(deletion, IntentOrigin("A", "rp_delete", 1), 201, created)
        assertEquals(Json.objectOf("s" to Json.of("refused"), "code" to Json.of("unknown-record")), answer.result)
        assertEquals(emptyList<LiveEvent>(), answer.events)
        assertEquals(created.json, after.json)
    }

    @Test fun property4AdmissionPermutations() {
        var admissions = 0
        repeat(128) { seed ->
            val random = Random(seed.toLong()); val stamp = Stamp.of(1, 0, "a")
            val key = RecordKey("card", RecordID("record01")); val row = Row(key, Lattice(Life("alive", stamp), stamp), seq = 1)
            val initial = ServerState(); initial.rows["acct:A/probe"] = mutableMapOf(key to row.json)
            initial.scopes["acct:A/probe"] = ScopeRecord("A", seq = 1, counters = mutableMapOf("card" to 1), digest = ScopeDigest.row(row.json))
            val intents = List(32) {
                val s = Stamp.of((2 + random.nextInt(8)).toLong(), random.nextInt(3).toLong(), if (random.nextBoolean()) "a" else "b")
                val fields = mapOf("title" to Register(Json.of("title-${random.nextInt(4)}"), s), "claim" to Register(Json.of("claim-${random.nextInt(3)}"), s),
                    "tier" to Register(Json.of(listOf("draft", "review", "done", "dropped")[random.nextInt(4)]), s))
                Intent(ScopeRef.product("probe"), deltas = listOf(Delta(key, Lattice(born = stamp, fields = fields)))).json
            }
            val admission = Admission(CorpusTests.probe, ProbeServerRules())
            var expected: Json? = null
            repeat(8) { permutation ->
                var state = initial.copy()
                val shuffled = intents.shuffled(Random(seed * 31L + permutation))
                for (intent in shuffled) {
                    val (next, answer) = admission.admit(intent, IntentOrigin("A", "rp_test", 1), 100, state)
                    assertEquals("seed=$seed permutation=$permutation", Json.of("ok"), answer.result["s"]); state = next; admissions++
                }
                val lattice = Row(state.rows.getValue("acct:A/probe").getValue(key)).lattice.json
                if (expected == null) expected = lattice else assertEquals("seed=$seed permutation=$permutation", expected, lattice)
            }
        }
        println("property 4: 128 seeds × 8 permutations × 32 intents, $admissions admissions")
    }
    @Test fun property7TextOccurrencePreservation() {
        var merges = 0; var occurrences = 0
        val vocabulary = listOf("a", "b", "c", "dd", " ", "  ", "\n", "\t ", "é", "e\u0301")
        repeat(128) { seed ->
            val random = Random(seed.toLong())
            fun text() = List(random.nextInt(10)) { vocabulary[random.nextInt(vocabulary.size)] }.joinToString("")
            repeat(64) {
                val base = text(); val head = text(); val mine = text()
                val bt = TextMerge.tokens(base); val scripts = listOf(head, mine).map { TextMerge.script(bt, TextMerge.tokens(it)) }
                for ((side, script) in scripts.withIndex()) {
                    assertEquals(bt, script.filter { it.first != TextMerge.Edit.insert }.map { it.second })
                    assertEquals(TextMerge.tokens(if (side == 0) head else mine), script.filter { it.first != TextMerge.Edit.delete }.map { it.second })
                }
                val kept = scripts.map { script -> script.filter { it.first != TextMerge.Edit.insert }.map { it.first == TextMerge.Edit.keep } }
                for (work in listOf(Constants.MERGE_WORK_CELLS, 1)) {
                    val merged = TextMerge.diff3(base, head, mine, work); val output = TextMerge.tokens(merged.text)
                    // Index each occurrence in its edit script. Each side must inject its required occurrences, in
                    // order, into distinct output positions; equal token strings never collapse two occurrences.
                    for ((side, script) in scripts.withIndex()) {
                        var baseIndex = 0; val required = mutableListOf<Pair<Int, String>>()
                        for ((scriptIndex, edit) in script.withIndex()) {
                            val (kind, token) = edit
                            if (kind == TextMerge.Edit.insert || kind == TextMerge.Edit.keep && kept[1 - side][baseIndex]) {
                                if (!token.codePoints().allMatch(TextMerge::isWhitespace)) required.add(scriptIndex to token)
                            }
                            if (kind != TextMerge.Edit.insert) baseIndex++
                        }
                        var after = -1
                        for ((scriptIndex, token) in required) {
                            val position = (after + 1 until output.size).firstOrNull { output[it] == token }
                            assertNotNull("seed=$seed work=$work side=$side occurrence=$scriptIndex base=$base head=$head mine=$mine output=${merged.text}", position)
                            after = position!!; occurrences++
                        }
                    }
                    merges++
                }
            }
        }
        println("property 7: 128 seeds × 64 triples × 2 work bounds, $merges merges, $occurrences occurrence checks")
    }
}
