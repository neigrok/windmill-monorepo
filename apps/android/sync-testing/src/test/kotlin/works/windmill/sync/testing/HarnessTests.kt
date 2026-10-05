package works.windmill.sync.testing

import java.util.concurrent.*
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.modelserver.*
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineCrash
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.engine.reidentify
import works.windmill.sync.engine.reauthenticate
import works.windmill.sync.engine.onHello
import works.windmill.sync.engine.RequestTiming
import works.windmill.sync.engine.SyncResponse

class HarnessTests {
    @Test fun clockAdvancesJumpsSkewsRebootsAndCancelsWithoutLeaks() {
        SimClock(100).use { clock ->
            val a = clock.sleepUntil(10); val b = clock.sleepUntil(20); val cancelled = clock.sleepUntil(30)
            val initial = clock.reading(); clock.jump(5000); clock.skew(30)
            assertEquals(0L, clock.monotonicMs); assertEquals(5130L, clock.now()); assertTrue(clock.reading().jumped(initial)); assertFalse(a.isDone)
            assertTrue(cancelled.cancel(false)); assertEquals(2, clock.sleeping)
            clock.advance(10); assertEquals(Unit, a.get(1, TimeUnit.SECONDS)); assertFalse(b.isDone)
            val boot = clock.reading(); clock.reboot(); assertTrue(clock.reading().jumped(boot))
            clock.close(); assertTrue(b.isCancelled); assertEquals(0, clock.sleeping)
            assertThrows(IllegalStateException::class.java) { clock.sleepUntil(99) }
        }
    }
    @Test fun cancellationRacesAdvanceAndShutdown() {
        val executor = Executors.newFixedThreadPool(4)
        try {
            repeat(128) {
                val clock = SimClock(); val future = clock.sleepUntil(1); val gate = CountDownLatch(1)
                val tasks = listOf(executor.submit { gate.await(); future.cancel(false) }, executor.submit { gate.await(); try { clock.advance(1) } catch (_: IllegalStateException) {} }, executor.submit { gate.await(); clock.close() })
                gate.countDown(); tasks.forEach { it.get(2, TimeUnit.SECONDS) }
                assertTrue(future.isDone); assertEquals(0, clock.sleeping)
            }
        } finally { executor.shutdownNow(); assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS)) }
    }
    @Test fun heldWritesTwoDevicesAndFailedEmptyCommitUseRealMemoryStore() {
        SteppedEngine(CorpusTests.probe, 100, rules = ProbeServerRules()).use { a ->
            a.device().use { b ->
                assertSame(a.clock, b.clock); assertSame(a.server, b.server)
                assertNotEquals(a.engine.snapshot().member("active"), b.engine.snapshot().member("active"))
                val scope = ScopeRef.product("probe"); val day = RecordID("2026-10-04")
                a.engine.commit(scope, Gesture(listOf(Change.put("day", day, true, mapOf("score" to Json.of(2)))), hold = true))
                assertEquals(1, a.drawn(scope, "day").size); assertTrue(a.stored(scope, "day").isEmpty()); assertTrue(b.drawn(scope, "day").isEmpty())
                assertEquals(1, a.undoOffers().size); a.advance(Constants.HOLD_MS); assertTrue(a.undoOffers().isEmpty()); assertEquals(1, a.stored(scope, "day").size)
                val before = a.engine.snapshot(); a.failNextCommit()
                assertThrows(CommitFailure::class.java) { a.engine.commit(scope) { null to Unit } }; assertEquals(before, a.engine.snapshot())
                a.sync()
                assertEquals(a.drawn(scope, "day"), b.drawn(scope, "day"))
                a.leave()
                assertTrue(a.engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.isEmpty())
            }
        }
    }
    @Test fun stepModeLeaveBoundsStalledOutputAndShutdownCancelsPendingRequests() {
        val device = SteppedEngine(CorpusTests.probe, 100, account = "A", rules = ProbeServerRules())
        val scope = ScopeRef.product("probe")
        try {
            device.engine.commit(scope, Gesture(listOf(Change.put("day", RecordID("2026-10-04"), true, mapOf("score" to Json.of(2)))), hold = true))
            device.transport.next = InMemoryTransport.Fault(drop = true)
            val before = device.clock.monotonicMs
            device.leave()
            assertEquals(2_000L, device.clock.monotonicMs - before)
            assertEquals(0, device.transport.inFlight); assertEquals(0, device.clock.sleeping)
            assertTrue(device.engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.none { it["state"] == Json.of("held") })
            device.sync()
            assertTrue(device.engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.isEmpty())
            device.transport.next = InMemoryTransport.Fault(drop = true)
            val pending = device.transport.request("hello")
            assertFalse(pending.isDone)
            device.close()
            assertTrue(pending.isCompletedExceptionally)
            assertEquals(0, device.transport.inFlight); assertEquals(0, device.clock.sleeping)
        } finally { device.close() }
    }
    @Test fun postCommitCrashIsDurableWhileStoreFailureRollsBack() {
        SimClock(100).use { clock ->
            val engine = Engine.memory(CorpusTests.probe, clock = clock)
            val scope = ScopeRef.product("probe")
            val gesture = Gesture(listOf(Change.put("day", RecordID("2026-10-04"), true, mapOf("score" to Json.of(2)))))
            try {
                val before = engine.snapshot()
                val actor = engine.actor
                assertThrows(EngineCrash::class.java) { engine.commit<Unit>(scope) { engine.actor = "r_cccccccccccc"; throw EngineCrash() } }
                assertEquals(before, engine.snapshot()); assertEquals(actor, engine.actor)
                engine.failNextCommit()
                assertThrows(CommitFailure::class.java) { engine.commit(scope, gesture) }
                assertEquals(before, engine.snapshot())
                engine.crashAfterTransactions(1)
                assertThrows(EngineCrash::class.java) { engine.commit(scope, gesture) }
                val durable = engine.snapshot()
                assertNotEquals(before, durable)
                Engine.memory(CorpusTests.probe, durable, clock).use { reopened ->
                    assertEquals(durable, reopened.snapshot())
                    assertEquals(engine.read(scope) { it.drawn("day") }, reopened.read(scope) { it.drawn("day") })
                }
            } finally { engine.close() }
        }
    }
    @Test fun stepModeRetriesFailedPullsBeforeQuiescing() {
        val faults = listOf(InMemoryTransport.Fault(drop = true), InMemoryTransport.Fault(loseReply = true),
            InMemoryTransport.Fault(delayMs = Constants.REQUEST_TIMEOUT_MS.toLong() + 1))
        for (fault in faults) SteppedEngine(CorpusTests.probe, 100, account = "A", rules = ProbeServerRules()).use { device ->
            val scope = ScopeRef.product("probe")
            device.engine.commit(scope, Gesture(listOf(Change.put("day", RecordID("2026-10-04"), true, mapOf("score" to Json.of(2))))))
            assertTrue(device.senderStep())
            device.transport.next = fault
            val before = device.clock.monotonicMs
            assertTrue(device.pullerStep())
            assertEquals(Constants.REQUEST_TIMEOUT_MS.toLong(), device.clock.monotonicMs - before)
            assertFalse(device.engine.read(scope) { it.firstPullComplete() })
            assertEquals(0, device.transport.inFlight); assertEquals(0, device.clock.sleeping)
            assertTrue(device.pullerStep())
            assertTrue(device.engine.read(scope) { it.firstPullComplete() })
            device.sync()
            assertTrue(device.engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.isEmpty())
        }
    }
    @Test fun stepModeDropsPullRepliesAcrossAccountLineage() {
        SteppedEngine(CorpusTests.probe, 100, account = "A", rules = ProbeServerRules()).use { device ->
            val scope = ScopeRef.product("probe")
            var afterSwitch: Json? = null
            device.clock.sleepUntil(10).thenRun {
                device.engine.signOut("keep")
                device.engine.signIn("B", emptyMap())
                afterSwitch = device.engine.snapshot()
            }
            device.transport.next = InMemoryTransport.Fault(delayMs = 20)
            assertTrue(device.pullerStep())
            assertNotNull(afterSwitch)
            assertEquals(afterSwitch, device.engine.snapshot())
            assertTrue(device.pullerStep())
            assertTrue(device.engine.read(scope) { it.firstPullComplete() })
            assertEquals(0, device.transport.inFlight); assertEquals(0, device.clock.sleeping)
        }
    }
    @Test fun stepModeLeavesBackoffPendingUntilTheClockAdvances() {
        SteppedEngine(CorpusTests.probe, 100, account = "A", rules = ProbeServerRules()).use { device ->
            val scope = ScopeRef.product("probe")
            device.clock.skew(600_000)
            device.engine.commit(scope, Gesture(listOf(Change.put("day", RecordID("2026-10-04"), true, mapOf("score" to Json.of(2))))))
            assertTrue(device.senderStep())
            assertEquals(listOf(1), device.skewRefusals().values.toList())
            val before = device.clock.monotonicMs
            device.sync()
            assertEquals(before, device.clock.monotonicMs)
            assertFalse(device.senderStep())
            device.clock.advance(500)
            device.sync()
            assertTrue(device.engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.isEmpty())
            assertEquals(100L, device.server.clock.now())
        }
    }
    @Test fun stepModeReopensLiveChannelsAfterReplicaRenewalAndClosesOnLeave() {
        SteppedEngine(CorpusTests.probe, 100, account = "A", rules = ProbeServerRules()).use { device ->
            assertTrue(device.pullerStep())
            assertTrue(device.server.isOpen(1))
            device.engine.reidentify()
            device.pullerStep()
            assertFalse(device.server.isOpen(1)); assertTrue(device.server.isOpen(2))
            device.leave()
            assertFalse(device.server.isOpen(2))
            device.pullerStep()
            assertTrue(device.server.isOpen(3))
            device.close()
            assertFalse(device.server.isOpen(3))
        }
    }
    @Test fun stepModePausesPullAndLiveUntilReauthenticated() {
        SteppedEngine(CorpusTests.probe, 100, account = "A", rules = ProbeServerRules()).use { device ->
            assertTrue(device.pullerStep()); assertTrue(device.server.isOpen(1))
            device.engine.onHello(SyncResponse(401), RequestTiming(device.clock.reading(), device.clock.reading()))
            val paused = device.engine.snapshot()
            val fault = InMemoryTransport.Fault(drop = true)
            device.transport.next = fault
            assertFalse(device.pullerStep())
            assertEquals(paused, device.engine.snapshot())
            assertEquals(fault, device.transport.next); assertFalse(device.server.isOpen(1))
            device.transport.next = InMemoryTransport.Fault()
            device.engine.reauthenticate()
            assertTrue(device.pullerStep()); assertTrue(device.server.isOpen(2))
        }
    }
    private fun transport(clock: SimClock) = InMemoryTransport(ModelServerHandle(ModelServer(CorpusTests.probe, ProbeServerRules()), clock), clock)
    @Test fun droppedAndLostRepliesTimeoutAndRetryDeduplicates() {
        val clock = SimClock(100)
        transport(clock).use { t ->
            val c = Credential.Account("A"); val stamp = Stamp.of(100, 0, "a")
            val intent = Intent(ScopeRef.product("probe"), 1, listOf(Delta(RecordKey("day", RecordID("2026-10-04")), Lattice(Life("alive", stamp), fields = mapOf("score" to Register(Json.of(2), stamp)))))).json
            val push = Json.objectOf("account" to Json.of("A"), "replica" to Json.of("rp_" + "a".repeat(32)), "ackThrough" to Json.of(0), "intents" to Json.array(intent))
            t.next = InMemoryTransport.Fault(drop = true); val dropped = t.request("push", push, c, 10)
            assertNull(t.server.snapshot()["replicas"]); clock.advance(10)
            assertTrue(assertThrows(ExecutionException::class.java) { dropped.get(1, TimeUnit.SECONDS) }.cause is TimeoutException)
            t.next = InMemoryTransport.Fault(loseReply = true); val lost = t.request("push", push, c, 10)
            val admitted = t.server.snapshot(); assertNotNull(admitted["results"]); clock.advance(10)
            assertTrue(assertThrows(ExecutionException::class.java) { lost.get(1, TimeUnit.SECONDS) }.cause is TimeoutException)
            t.next = InMemoryTransport.Fault(duplicate = true); val replay = t.request("push", push, c).get(1, TimeUnit.SECONDS)
            assertEquals(200, replay.status); assertEquals(admitted, t.server.snapshot()); assertEquals(0, t.inFlight); assertEquals(0, clock.sleeping)
        }; clock.close()
    }
    @Test fun delayReorderTimeoutCancelAndCloseSettleEveryFuture() {
        val clock = SimClock(); val t = transport(clock)
        t.next = InMemoryTransport.Fault(delayMs = 20); val delayed = t.request("hello", timeoutMs = 30)
        assertTrue(t.request("hello").isDone); assertFalse(delayed.isDone); clock.advance(20); assertEquals(200, delayed.get(1, TimeUnit.SECONDS).status)
        t.next = InMemoryTransport.Fault(delayMs = 20); val timed = t.request("hello", timeoutMs = 10); clock.advance(10)
        assertTrue(assertThrows(ExecutionException::class.java) { timed.get(1, TimeUnit.SECONDS) }.cause is TimeoutException); assertEquals(0, clock.sleeping)
        t.next = InMemoryTransport.Fault(drop = true); val cancelled = t.request("hello"); cancelled.cancel(false); assertEquals(0, clock.sleeping)
        t.next = InMemoryTransport.Fault(drop = true); val pending = t.request("hello"); t.close(); assertTrue(pending.isCompletedExceptionally)
        assertEquals(0, clock.sleeping); assertEquals(0, t.inFlight); assertThrows(IllegalStateException::class.java) { t.request("hello") }
        clock.close()
    }
    @Test fun transportConcurrentRequestsAndShutdownDoNotLeak() {
        val clock = SimClock(); val t = transport(clock); val executor = Executors.newFixedThreadPool(4)
        try {
            val gate = CountDownLatch(1)
            val futures = (1..128).map { executor.submit { gate.await(); try { t.request("hello").get(2, TimeUnit.SECONDS) } catch (_: IllegalStateException) {} catch (_: ExecutionException) {} } }
            val closing = executor.submit { gate.await(); t.close() }; gate.countDown()
            (futures + closing).forEach { it.get(3, TimeUnit.SECONDS) }; assertEquals(0, t.inFlight); assertEquals(0, clock.sleeping)
        } finally { t.close(); clock.close(); executor.shutdownNow(); assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS)) }
    }
}
