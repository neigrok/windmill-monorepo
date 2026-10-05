package works.windmill.sync.testing

import java.io.File
import java.security.MessageDigest
import java.util.Random
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.Command
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*

class JournalReplayFuzzTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/journal.registry.json").readBytes()))
    private val coverage = listOf("save", "stale", "claim", "replay", "conflict", "blank", "future",
        "rollback", "process death", "http 401 unauthenticated", "reply lost")
    private val start = 1_760_000_000_000L
    private val scope = ScopeRef.product("journal")
    private val key = "acct:A/journal"
    private data class Report(val events: Map<String, Int>, val trace: String)
    private data class Document(val body: String, val mood: Json, val energy: Json, val source: Json, val stamp: Json)

    @Test fun journalReplay() {
        val runs = System.getenv("FUZZ_N")?.toInt() ?: 60
        val steps = System.getenv("FUZZ_STEPS")?.toInt() ?: 160
        val first = System.getenv("FUZZ_SEED")?.toLong() ?: 1L
        require(runs > 0 && steps > 0)
        val producing = coverage.associateWith { 0 }.toMutableMap()
        val totals = linkedMapOf<String, Int>()
        for (seed in first until first + runs) {
            val report = simulate(seed, steps)
            report.events.forEach { (event, count) -> totals[event] = (totals[event] ?: 0) + count }
            coverage.filter { (report.events[it] ?: 0) > 0 }.forEach { producing[it] = producing.getValue(it) + 1 }
        }
        if (runs >= 60 && steps >= 160) assertTrue("journal coverage missing: $producing", producing.values.all { it > 0 })
        println("journal replay fuzz: $runs seeds × $steps steps from $first; events=$totals; seeds producing=$producing")
    }

    @Test fun journalCoverageSurveyAcrossThirtyStartingSeeds() {
        val total = coverage.associateWith { 0 }.toMutableMap()
        repeat(30) { survey ->
            val producing = coverage.associateWith { 0 }.toMutableMap()
            val first = 1 + survey * 1000L
            for (seed in first until first + 60) {
                val report = simulate(seed, 160)
                coverage.filter { (report.events[it] ?: 0) > 0 }.forEach { producing[it] = producing.getValue(it) + 1 }
            }
            assertTrue("journal first seed=$first coverage=$producing", producing.values.all { it > 0 })
            coverage.forEach { total[it] = total.getValue(it) + producing.getValue(it) }
            if ((survey + 1) % 5 == 0) println("journal coverage survey: ${survey + 1}/30 fuzzes complete")
        }
        val mean = total.mapValues { it.value / 30.0 }
        assertTrue("journal survey mean=$mean", mean.values.all { it >= 10 })
        println("journal coverage survey: 30 fuzzes × 60 seeds × 160 steps, first seeds 1,1001,…,29001; no misses; mean producing=$mean")
    }

    @Test fun journalSeedReplaysByteForByte() { assertEquals(simulate(7, 160), simulate(7, 160)) }

    private fun simulate(seed: Long, steps: Int): Report {
        val random = Random(seed)
        val trace = MessageDigest.getInstance("SHA-256")
        val oracle = mutableMapOf<String, Document>()
        val receipts = mutableMapOf<String, Json>()
        val pending = mutableListOf<Pair<String, Json>>()
        val events = linkedMapOf<String, Int>()
        fun count(event: String) { events[event] = (events[event] ?: 0) + 1 }
        val model = ModelServer(registry, JournalServerRules(), ServerState(Json.objectOf("epoch" to Json.of("ep-1"), "clock" to Hlc().json,
            "accounts" to Json.objectOf("A" to Json.objectOf("name" to Json.of("Ann"))))))
        val clock = SimClock(start)
        var gestures = 0
        val identities = object : IdentitySource {
            override fun opaqueID() = "seed-$seed-g${++gestures}"
            override fun draw(bound: Int) = random.nextInt(bound)
        }
        fun open(snapshot: Json? = null) = Engine.memory(registry, snapshot, clock, identities, "r_aaaaaaaaaaaa")
        var engine = open()
        engine.signIn("A", mapOf("journal" to false))
        val handle = ModelServerHandle(model, clock)
        var transport = InMemoryTransport(handle, clock)
        fun document(args: Json) = Document(args.member("body").str(), args.member("mood"), args.member("energy"), args.member("source"), args.member("stamp"))
        fun intent(name: String, args: Json) = Intent(scope, command = Command(name, args)).json
        fun serverCommand(name: String, args: Json): Json = checkNotNull(model.call(ServerCall("A", null, name, args, listOf(intent(name, args))), clock.now()))
        fun dataPlane(state: ServerState) = state.json.with("replicas" to null, "results" to null, "requests" to null)
        // Independent lexicographic winner; the implementation's ContentClock.compare is deliberately not used.
        fun newer(a: Json, b: Json): Boolean {
            val ms = a.member("ms").long().compareTo(b.member("ms").long())
            val counter = a.member("counter").long().compareTo(b.member("counter").long())
            return ms > 0 || ms == 0 && (counter > 0 || counter == 0 && a.member("actor").str() > b.member("actor").str())
        }
        fun row(day: String, state: ServerState) = Row(state.rows.getValue(key).getValue(RecordKey("page", RecordID(day))))
        fun pull() {
            val request = checkNotNull(engine.pullRequest(listOf(scope)))
            val reply = model.pull(request, Credential.Account("A"), clock.now())
            assertEquals(200, reply.status)
            engine.onPullResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(clock.reading(), clock.reading()), PullSlicing(2, 1))
            assertFalse(reply.body.member("pages").arr().any { it["more"] == Json.of(true) })
        }
        fun checkState() {
            val state = model.state
            for ((day, expected) in oracle) {
                val confirmed = row(day, state)
                assertEquals("seed=$seed day=$day body", expected.body, confirmed.texts.getValue("body").text)
                assertFalse(confirmed.texts.getValue("body").merged)
                assertEquals(confirmed.seq, confirmed.texts.getValue("body").rev)
                assertEquals(expected.stamp, confirmed.lattice.fields.getValue("documentStamp").value)
                for ((field, value) in listOf("mood" to expected.mood, "energy" to expected.energy, "source" to expected.source)) assertEquals(value, confirmed.lattice.fields.getValue(field).value)
                assertTrue("future content escaped into envelope", confirmed.stamps.all { it.ms <= clock.now() + Constants.MAX_SKEW_MS })
                val local = engine.read(scope) { it.stored("page", RecordID(day)) }
                assertNotNull(local); local!!
                assertEquals(expected.body, local.texts.getValue("body").text)
                assertFalse(local.texts.getValue("body").merged)
                assertFalse(local.isPending)
                assertEquals(expected.stamp, local.values.getValue("documentStamp"))
                assertEquals(expected.mood, local.values.getValue("mood")); assertEquals(expected.energy, local.values.getValue("energy")); assertEquals(expected.source, local.values.getValue("source"))
                if (expected.body.isEmpty()) count("blank")
            }
            assertTrue(state.clock.ms <= clock.now() + Constants.MAX_SKEW_MS)
            val rows = state.rows[key].orEmpty().values.toList()
            assertEquals(ScopeDigest.rows(rows), state.scopes.getValue(key).digest)
            val revisions = state.revisions[key].orEmpty()
            assertTrue(revisions.all { it.member("text").str().isNotEmpty() && it.member("archivedAt").long() >= clock.now() - 90 * 86_400_000L })
            assertTrue(revisions.size <= 500)
            assertTrue(revisions.sumOf { it.member("text").str().encodeToByteArray().size.toLong() } <= 8_388_608)
            assertTrue(revisions.groupBy { it.member("id") }.values.all { it.size <= 10 })
            val durable = engine.snapshot()
            val local = durable.member("replicas").arr().single { it.member("meta").member("replica").str() == engine.activeReplica() }
            val meta = local.member("meta")
            assertTrue(meta.member("hlc").member("ms").long() <= clock.now() + Constants.MAX_SKEW_MS)
            for (high in listOf("hlcHigh", "admittedHigh")) assertTrue(Stamp(meta.member(high).str()).ms <= clock.now() + Constants.MAX_SKEW_MS)
            val checkpoint = local.member("cursors").member(scope.text)
            assertEquals(Json.of(state.scopes.getValue(key).digest.hex), checkpoint.member("digest"))
            val cursor = WireCursor.decode(checkpoint.member("cursor").str())
            assertEquals("live", cursor.mode); assertNull(cursor.key)
            assertEquals(state.epoch, cursor.epoch); assertEquals(state.scopes.getValue(key).seq, cursor.seq)
            assertNull(checkpoint["digestStop"]); assertNotEquals(Json.of(true), checkpoint["behind"])
            assertTrue(local["outbox"]?.arr().orEmpty().isEmpty())
            trace.update(durable.jcs.encodeToByteArray())
        }
        try {
            // Seed equivalent legacy content through actual server commands, without the CPP_ONLY migration adapter.
            val legacyStamp = Json.objectOf("ms" to Json.of(start + seed.mod(3) * 1_000_000), "counter" to Json.of(2), "actor" to Json.of("legacy:writer"))
            val base = Json.objectOf("day" to Json.of("2026-10-01"), "body" to Json.of("Old seed words."), "mood" to Json.of(6), "energy" to Json.Null, "source" to Json.of("typed"),
                "stamp" to Json.objectOf("ms" to Json.of(start - 1000), "counter" to Json.of(0), "actor" to Json.of("legacy:writer")))
            assertEquals(Json.of("ok"), serverCommand("journal.savePage", base)["s"])
            val legacy = base.with("body" to Json.of("Legacy seed words."), "stamp" to legacyStamp)
            assertEquals(Json.of("ok"), serverCommand("journal.savePage", legacy)["s"])
            oracle["2026-10-01"] = document(legacy); pull(); checkState()
            repeat(steps) { step ->
                clock.advance(1)
                val now = clock.now()
                val name: String; var args: Json
                if (pending.isNotEmpty() && random.nextDouble() < 0.3) {
                    val saved = pending[random.nextInt(pending.size)]; name = saved.first; args = saved.second
                    if (name == "journal.claimPage" && random.nextDouble() < 0.2) args = args.with("body" to Json.of(args.member("body").str() + "changed"))
                } else {
                    val day = "2026-10-${(1 + random.nextInt(5)).toString().padStart(2, '0')}"
                    val body = listOf("", " ", "word ${random.nextInt(30)}")[random.nextInt(3)]
                    val mood = listOf(Json.Null, Json.of(0), Json.of(5), Json.of(10))[random.nextInt(4)]
                    val energy = listOf(Json.Null, Json.of(0), Json.of(7), Json.of(10))[random.nextInt(4)]
                    args = Json.objectOf("day" to Json.of(day), "body" to Json.of(body), "mood" to mood, "energy" to energy, "source" to Json.of(if (random.nextBoolean()) "typed" else "spoken"))
                    if (random.nextDouble() < 0.3) {
                        name = "journal.claimPage"; args = args.with("claimId" to Json.of("claim_${seed}_${step.toString().padStart(4, '0')}"))
                    } else {
                        name = "journal.savePage"
                        val ms = now + listOf(-200L, -10L, 0L, 10_000_000L)[random.nextInt(4)]
                        args = args.with("stamp" to Json.objectOf("ms" to Json.of(ms), "counter" to Json.of(random.nextInt(4)), "actor" to Json.of("device:${random.nextInt(3)}")))
                        if (ms > now + Constants.MAX_SKEW_MS) count("future")
                    }
                    pending.add(name to args)
                }
                val old = oracle[args.member("day").str()]
                val claimId = args["claimId"]?.str(); val receipt = claimId?.let(receipts::get)
                val before = dataPlane(model.state)
                val result = if (random.nextBoolean()) { count("server origin"); serverCommand(name, args) } else {
                    count("replica origin")
                    val gesture = Gesture(emptyList(), command = Command(name, args))
                    if (random.nextInt(40) == 0) {
                        val snapshot = engine.snapshot(); engine.failNextCommit()
                        val failed = assertThrows(CommitFailure::class.java) { engine.commit(scope, gesture) }
                        assertEquals(CommitFailure.Kind.storeFailure, failed.kind); assertEquals(snapshot, engine.snapshot()); count("rollback")
                    }
                    if (random.nextInt(40) == 0) {
                        engine.crashAfterTransactions(1)
                        assertThrows(EngineCrash::class.java) { engine.commit(scope, gesture) }
                        val snapshot = engine.snapshot(); transport.close(); engine.close(); engine = open(snapshot); transport = InMemoryTransport(handle, clock); count("process death")
                    } else assertTrue(engine.commit(scope, gesture) is CommitOutcome.Committed)
                    val request = checkNotNull(engine.nextPush())
                    if (random.nextInt(40) == 0) {
                        val denied = model.push(request, Credential.Unresolved, now)
                        assertEquals(401, denied.status); engine.onPushResponse(request, SyncResponse(denied.status, denied.body), RequestTiming(clock.reading(), clock.reading()))
                        assertEquals(before, dataPlane(model.state)); engine.reauthenticate(); assertEquals(request, engine.nextPush()); count("http 401 unauthenticated")
                    }
                    if (random.nextInt(8) == 0) transport.next = InMemoryTransport.Fault(loseReply = true)
                    var future = transport.request("push", request, Credential.Account("A"), 2)
                    if (!future.isDone) {
                        clock.advance(2)
                        val lost = assertThrows(ExecutionException::class.java) { future.get() }; assertTrue(lost.cause is TimeoutException)
                        assertEquals(request, engine.nextPush()); val admitted = dataPlane(model.state)
                        future = transport.request("push", request, Credential.Account("A"))
                        assertEquals(admitted, dataPlane(model.state)); count("reply lost")
                    }
                    val reply = future.get(); assertEquals(200, reply.status)
                    engine.onPushResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(clock.reading(), clock.reading()))
                    reply.body.member("results").arr().single()
                }
                trace.update(args.jcs.encodeToByteArray()); trace.update(result.jcs.encodeToByteArray())
                val day = args.member("day").str()
                if (name == "journal.claimPage" && receipt != null && receipt != args) {
                    assertEquals(Json.of("claim-conflict"), result["code"]); assertEquals(before, dataPlane(model.state)); count("conflict")
                } else {
                    assertEquals(Json.of("ok"), result["s"])
                    if (name == "journal.savePage") {
                        count("save")
                        if (old == null || newer(args.member("stamp"), old.stamp)) oracle[day] = document(args)
                        else { assertEquals(before, dataPlane(model.state)); count("stale") }
                    } else if (receipt != null) {
                        assertEquals(before, dataPlane(model.state)); count("replay")
                    } else {
                        count("claim"); receipts[claimId!!] = args
                        val here = args.member("body").str(); val head = old?.body ?: ""
                        // Independent claim specification, using only ASCII fuzz text rather than production trim/join.
                        val body = when { head.trim().isEmpty() -> here; here.trim().isEmpty() -> head; here.contains(head.trim()) -> here; else -> head.trimEnd() + "\n\n" + here.trimStart() }
                        val stamp = row(day, model.state).lattice.fields.getValue("documentStamp").value
                        assertEquals(Json.of("srv"), stamp.member("actor"))
                        assertTrue(stamp.member("ms").long() >= now)
                        assertTrue(stamp.member("counter").long() in 0 until Stamp.COUNTER_LIMIT)
                        if (old != null) assertTrue(newer(stamp, old.stamp))
                        oracle[day] = Document(body, args.member("mood").orNull() ?: old?.mood ?: Json.Null,
                            args.member("energy").orNull() ?: old?.energy ?: Json.Null, args.member("source"), stamp)
                    }
                }
                pull(); checkState()
            }
            trace.update(model.state.json.jcs.encodeToByteArray())
            return Report(events, trace.digest().joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') })
        } finally { transport.close(); engine.close(); clock.close() }
    }
}
