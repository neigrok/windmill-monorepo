package works.windmill.sync.testing

import java.util.Random
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.Command
import works.windmill.sync.modelserver.ProbeServerRules
import works.windmill.sync.modelserver.with

// These are real-engine contracts, never a client algorithm implemented in test support.
// Every seed must execute the production sender, puller and clock-skew recovery.
@RunWith(Parameterized::class)
class EnginePropertyTests(private val seed: Long) {
    @Test fun property3DrawnEqualsAdmittedRowsAfterResultsAndPull() {
        val random = Random(seed)
        SteppedEngine(CorpusTests.probe, 1_800_000_000_000, seed, "A", ProbeServerRules()).use { device ->
            val scope = ScopeRef.product("probe"); val id = RecordID("record01")
            fun compareRows() {
                val rows = device.server.snapshot()["rows"]?.get("acct:A/probe")?.arr().orEmpty().map(::Row)
                val actual = device.drawn(scope, "card")
                val expected = rows.filter { it.key.type == "card" && it.isAlive }
                assertEquals(expected.map { it.key.id }, actual.map { it.id })
                for ((server, client) in expected.zip(actual)) {
                    assertEquals(server.lattice.fields.mapValues { it.value.value }, client.values)
                    assertEquals(server.lattice.life, client.life); assertEquals(server.lattice.born, client.born)
                }
            }
            assertTrue(device.engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(id), mapOf("title" to Json.of("first")))))) is CommitOutcome.Committed)
            assertTrue(device.senderStep()); compareRows()
            assertTrue(device.pullerStep()); compareRows()
            device.sync()
            repeat(64) { step ->
                assertTrue(device.engine.commit(scope, Gesture(listOf(Change.update("card", id, mapOf("title" to Json.of("$seed-$step-${random.nextInt(99)}")))))) is CommitOutcome.Committed)
                assertTrue(device.senderStep()); compareRows()
                assertTrue(device.pullerStep()); compareRows()
                device.sync(); compareRows()
                assertTrue(device.engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.isEmpty())
            }
        }
    }
    @Test fun property8SkewRecoveryTerminatesUnderHoldsUndoRetireEpochAnd409() {
        val random = Random(seed)
        SteppedEngine(CorpusTests.probe, 1_800_000_000_000, seed, "A", ProbeServerRules()).use { device ->
            val scope = ScopeRef.product("probe"); val day = RecordID("2026-10-04"); val id = RecordID("record01")
            device.clock.skew(600_000)
            device.engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(id), mapOf("title" to Json.of("future"))))))
            device.engine.commit(scope, Gesture(listOf(Change.put("day", day, true, mapOf("score" to Json.of(1))))))
            val held = device.engine.commit(scope, Gesture(listOf(Change.put("day", day, false)), hold = true)) as CommitOutcome.Committed
            if (random.nextBoolean()) device.engine.undo(held.receipt.gestureId)
            device.engine.commit(scope, Gesture(listOf(Change.put("day", day, true, mapOf("score" to Json.of(2)))), retire = listOf(RecordRef("day", day))))
            val orphan = RecordID("orphan01")
            val source = device.engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(orphan), mapOf("title" to Json.of("held source")))), hold = true)) as CommitOutcome.Committed
            device.engine.commit(scope, Gesture(listOf(Change.update("card", orphan, mapOf("title" to Json.of("dependent"))))))
            assertTrue(device.engine.undo(source.receipt.gestureId))
            device.engine.commit(scope, Gesture(emptyList(), command = Command("probe.start", Json.objectOf("id" to Json.of("run00001"), "startedAt" to Json.of(device.clock.now()), "join" to Json.of(true))),
                predict = listOf(Change.create("run", NewID.Given(RecordID("run00001")), mapOf("startedAt" to Json.of(device.clock.now()))))))
            device.engine.commit(scope, Gesture(listOf(Change.update("card", id, mapOf("title" to Json.of("later"))))))
            if (random.nextBoolean()) {
                val snapshot = device.server.snapshot()
                device.server.restore(snapshot.with("epoch" to Json.of("ep-${seed + 2}")))
            } else {
                // A cloned binding ahead of the client's n forces the real sender through replica-forked (409).
                val active = device.engine.snapshot().member("active").str()
                device.server.restore(device.server.snapshot().with("replicas" to Json.objectOf(active to Json.objectOf("account" to Json.of("A"), "lastN" to Json.of(99)))))
            }
            device.engine.releaseHeld(true)
            val frozen = device.server.clock.now()
            val beforeSync = device.clock.monotonicMs
            device.sync()
            assertEquals("sync must not consume the sender's skew backoff", beforeSync, device.clock.monotonicMs)
            assertEquals(frozen, device.server.clock.now())
            fun outstanding() = device.engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
            assertTrue("recovered entries must wait for their sender deadline", outstanding().isNotEmpty())
            var recoverySteps = 0
            while (outstanding().isNotEmpty() && recoverySteps++ < 64) {
                // Step mode returns at a wait. Drive only the client's clock; the server stays frozen for INV-14.
                device.clock.advance(1_000)
                val before = device.clock.monotonicMs
                device.sync()
                assertEquals("sync must not advance a sender wait", before, device.clock.monotonicMs)
                assertEquals(frozen, device.server.clock.now())
            }
            assertTrue(device.skewRefusals().isNotEmpty())
            assertTrue(device.skewRefusals().values.all { it <= 1 })
            assertTrue("skew recovery must drain within 64 client-clock steps", outstanding().isEmpty())
        }
    }
    companion object {
        @JvmStatic @Parameterized.Parameters(name = "seed {0}") fun seeds() = (1L..128L).map { arrayOf<Any>(it) }
    }
}
