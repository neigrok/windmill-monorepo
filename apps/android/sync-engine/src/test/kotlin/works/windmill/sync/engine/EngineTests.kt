package works.windmill.sync.engine

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID

class EngineTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val identities = object : IdentitySource {
        var number = 0
        override fun opaqueID() = "id${++number}"
        override fun draw(bound: Int) = 0
    }
    private val scope = ScopeRef.product("probe")
    private fun engine(telemetry: EngineTelemetry = NoEngineTelemetry) = Engine.memory(registry, clock = object : EngineClock { override fun now() = 5_000L }, identities = identities, actor = "actor", telemetry = telemetry)
    private fun create(id: String) = Gesture(listOf(Change.create("card", NewID.Given(RecordID(id)), mapOf("title" to Json.of(id)))))
    @Test fun bodyAndStoreFailuresLeaveNoClockIntentDeviceOrObservationChanges() {
        engine().use { engine ->
            val before = engine.snapshot()
            val thrown = IllegalStateException("caller")
            assertSame(thrown, assertThrows(IllegalStateException::class.java) { engine.commit(scope) { throw thrown; @Suppress("UNREACHABLE_CODE") (null to 1) } })
            assertEquals(before, engine.snapshot())
            engine.failNextCommit()
            val failed = assertThrows(CommitFailure::class.java) { engine.commit(scope, create("card0001")) }
            assertEquals(CommitFailure.Kind.storeFailure, failed.kind)
            assertEquals(before, engine.snapshot())
            assertTrue(engine.commit(scope, create("card0001")) is CommitOutcome.Committed)
        }
    }
    @Test fun memoryJournalRollsBackRowsAndTheirReferenceIndex() {
        engine().use { engine ->
            val store = engine.store as MemoryStore
            val replica = engine.device.current().id
            val row = Row(RecordKey("lap", RecordID("lap00001")), Lattice(fields = mapOf("runId" to Register(Json.of("run00001"), Stamp("1:0:a")))), seq = 1)
            store.failNextCommit = true
            assertThrows(StoreFailure::class.java) { store.transaction { store.put(replica, scope, row) } }
            assertNull(store.row(replica, scope, row.key))
            assertTrue(store.matching(replica, scope, "lap", "runId", RecordID("run00001")).isEmpty())
            store.transaction { store.put(replica, scope, row) }
            assertEquals(listOf(row), store.matching(replica, scope, "lap", "runId", RecordID("run00001")))
        }
    }
    @Test fun aNullBodyReadsOneClockAndWritesNothing() {
        var reads = 0
        Engine.memory(registry, clock = object : EngineClock { override fun now() = (10L + reads++) }, identities = identities, actor = "actor").use { engine ->
            val before = engine.snapshot()
            val result = engine.commit(scope) { context ->
                assertEquals(10L, context.now); null to context.replica
            }
            assertNull(result.first); assertEquals(engine.device.current().id, result.second)
            assertEquals(1, reads); assertEquals(before, engine.snapshot())
        }
    }
    @Test fun readerCannotEscapeItsTransactionAndCaughtMisuseStillFailsACommit() {
        engine().use { engine ->
            var escaped: ScopeReader? = null
            engine.read(scope) { escaped = it }
            assertEquals(CommitFailure.Kind.malformed, assertThrows(CommitFailure::class.java) { escaped!!.drawn("card") }.kind)
            val before = engine.snapshot()
            assertThrows(CommitFailure::class.java) { engine.commit(scope) { context ->
                runCatching { context.drawn("tag") }
                create("card0001") to Unit
            } }
            assertEquals(before, engine.snapshot())
            engine.failNextCommit()
            assertEquals(CommitFailure.Kind.storeFailure, assertThrows(CommitFailure::class.java) { engine.commit(scope) { null to Unit } }.kind)
            assertEquals(before, engine.snapshot())
        }
    }
    @Test fun nestedCommitRollsBackAndReadBodiesCanReadTheSameTransaction() {
        engine().use { engine ->
            val before = engine.snapshot()
            val failure = assertThrows(CommitFailure::class.java) { engine.commit(scope) { engine.commit(scope, create("card0001")); null to Unit } }
            assertEquals(CommitFailure.Kind.malformed, failure.kind)
            assertEquals(before, engine.snapshot())
            engine.commit(scope) { assertNull(engine.read(scope) { it.drawn("card", RecordID("card0001")) }); create("card0001") to Unit }
        }
    }
    @Test fun refusedRetireKeepsTheHoldAndAcceptedRetirePreservesUntouchedFields() {
        engine().use { engine ->
            val stamp = Stamp("1:0:a"); val replica = engine.device.current().id
            engine.store.transaction { repeat(3) { index ->
                engine.store.put(replica, scope, Row(RecordKey("card", RecordID("card000${index + 1}")),
                    Lattice(Life("alive", stamp), stamp, mapOf("title" to Register(Json.of("Original"), stamp), "size" to Register(Json.of(2), stamp))), seq = index.toLong()))
            } }
            val id = RecordID("card0001")
            engine.commit(scope, Gesture(listOf(Change.delete("card", id)), hold = true, gestureId = "del"))
            val before = engine.snapshot()
            val refused = engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0004")))), retire = listOf(RecordRef("card", id))))
            assertEquals(RefusalCode.cap, (refused as CommitOutcome.Refused).code); assertEquals(before, engine.snapshot())
            val result = engine.commit(scope, Gesture(listOf(Change.update("card", id, mapOf("title" to Json.of("Changed")))), retire = listOf(RecordRef("card", id)))) as CommitOutcome.Committed
            assertEquals(listOf("del"), result.receipt.retired)
            assertEquals(Json.of(2), engine.read(scope) { it.drawn("card", id)!!.values["size"] })
            assertEquals(Json.of("Changed"), engine.read(scope) { it.drawn("card", id)!!.values["title"] })
            assertFalse(engine.undo("del"))
            engine.commit(scope, Gesture(listOf(Change.delete("card", id)), hold = true, gestureId = "later"))
            assertTrue(engine.release("later/0")); assertFalse(engine.release("later/0")); assertFalse(engine.undo("later"))
            assertThrows(CommitFailure::class.java) { engine.dismissNotice("missing") }
        }
    }
    @Test fun referenceReadAndObservationDoNotScanTenThousandUnrelatedRows() = runBlocking {
        engine().use { engine ->
            val replica = engine.device.current().id
            val stamp = Stamp("1:0:a")
            engine.store.transaction { repeat(10_000) { index ->
                engine.store.put(replica, scope, Row(RecordKey("lap", RecordID("lap" + index.toString().padStart(5, '0'))),
                    Lattice(Life("alive", stamp), stamp, mapOf("runId" to Register(Json.of(if (index == 0) "run00001" else "run00002"), stamp))), seq = index.toLong()))
            } }
            val before = engine.rowsRead()
            assertEquals(1, engine.read(scope) { it.drawn("lap", "runId", RecordID("run00001")).size })
            assertEquals(2, engine.rowsRead() - before)
            val initial = CompletableDeferred<Unit>()
            val result = async { withTimeout(5_000) { engine.observe(scope, "lap", "runId", RecordID("run00001")).onEach { initial.complete(Unit) }.take(2).toList() } }
            initial.await()
            val beforeUpdate = engine.rowsRead()
            engine.commit(scope, Gesture(listOf(Change.update("lap", RecordID("lap00000"), mapOf("weight" to Json.of(20))))))
            val rows = result.await()
            assertEquals(2, rows.size); assertEquals(Json.of(20), rows.last().single().values["weight"])
            assertTrue("bounded changed-row reads", engine.rowsRead() - beforeUpdate <= 4)
        }
    }
    @Test fun observationCompletesWhenEngineCloses() = runBlocking {
        val engine = engine()
        val initial = CompletableDeferred<Unit>()
        val observer = async { engine.observe(scope, "card").onEach { initial.complete(Unit) }.toList() }
        initial.await(); engine.close()
        assertEquals(listOf(emptyList<Record>()), withTimeout(5_000) { observer.await() })
        assertEquals(CommitFailure.Kind.notWritable, assertThrows(CommitFailure::class.java) { engine.commit(scope, create("card0001")) }.kind)
    }
    @Test fun concurrentCommitsSerializeWithUniqueIncreasingStamps() {
        engine().use { engine ->
            val pool = Executors.newFixedThreadPool(4)
            try {
                val results = (0 until 32).map { i -> pool.submit<CommitOutcome> { engine.commit(scope, Gesture(listOf(Change.create("lap", NewID.Given(RecordID("lap" + i.toString().padStart(5, '0'))))))) } }.map { it.get(5, TimeUnit.SECONDS) }
                val stamps = results.map { (it as CommitOutcome.Committed).receipt.stamp }.sorted()
                assertEquals(32, stamps.toSet().size); assertEquals((0L until 32).toList(), stamps.map { it.counter })
                assertEquals(32, engine.read(scope) { it.drawn("lap").size })
            } finally { pool.shutdownNow() }
        }
    }
    @Test fun writerTimesOutStalledWorkAndSurvivesFailuresAndCancellation() = runBlocking {
        CoroutineWriter(engine(), timeoutMs = 100).use { writer ->
            assertTrue(runCatching { writer.submit { awaitCancellation() } }.exceptionOrNull() is TimeoutCancellationException)
            assertTrue(runCatching { writer.submit<Unit> { throw IllegalStateException("crash") } }.exceptionOrNull() is IllegalStateException)
            assertTrue(runCatching { writer.submit<Unit> { throw CancellationException("caller") } }.exceptionOrNull() is CancellationException)
            assertEquals(42, writer.submit { 42 })
            assertTrue(writer.shutdown())
            assertTrue(runCatching { writer.submit { 7 } }.isFailure)
        }
    }
    @Test fun writerShutdownAndQueueSaturationHaveBoundedDeadlines() = runBlocking {
        val writer = CoroutineWriter(engine(), capacity = 1, timeoutMs = 100)
        val entered = CompletableDeferred<Unit>()
        val running = async { runCatching { writer.submit { entered.complete(Unit); awaitCancellation() } } }
        entered.await()
        val queued = async { runCatching { writer.submit { 1 } } }
        val overflow = async { runCatching { writer.submit { 2 } } }
        delay(10); writer.shutdown()
        withTimeout(1_000) { running.await(); queued.await(); overflow.await() }
        writer.close()
    }
    @Test fun cancellingCallerCancelsItsRunningWorkAndLeavesWriterUsable() = runBlocking {
        CoroutineWriter(engine(), timeoutMs = 5_000).use { writer ->
            val entered = CompletableDeferred<Unit>(); val cancelled = CompletableDeferred<Unit>()
            val caller = launch { writer.submit { entered.complete(Unit); try { awaitCancellation() } finally { cancelled.complete(Unit) } } }
            entered.await(); caller.cancelAndJoin()
            withTimeout(1_000) { cancelled.await() }
            assertEquals(42, withTimeout(1_000) { writer.submit { 42 } })
        }
    }
    @Test fun observerRemovesInvisibleRecordsAndStoredRecordsRetainTheHeldFlag() = runBlocking {
        engine().use { engine ->
            val replica = engine.device.current().id; val stamp = Stamp("1:0:a")
            engine.store.transaction { engine.store.put(replica, scope, Row(RecordKey("card", RecordID("card0001")), Lattice(Life("alive", stamp), stamp), seq = 1)) }
            val entered = CompletableDeferred<Unit>()
            val rows = async { withTimeout(5_000) { engine.observe(scope, "card").onEach { entered.complete(Unit) }.take(2).toList() } }
            entered.await(); engine.commit(scope, Gesture(listOf(Change.delete("card", RecordID("card0001"))), hold = true))
            assertTrue(rows.await().last().isEmpty())
            assertTrue(engine.read(scope) { it.stored("card", RecordID("card0001"))!!.isHeld })
            assertEquals(1, engine.read(scope) { it.stored("card").size })
            assertTrue(engine.read(scope) { it.drawn("card").isEmpty() })
        }
    }
    @Test fun stalledAndThrowingTelemetryCannotBlockOrRollBackTheWriter() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val sink = EngineTelemetry { entered.complete(Unit); awaitCancellation() }
        engine(sink).use { engine ->
            engine.commit(scope, create("card0001")); withTimeout(2_000) { entered.await() }
            repeat(100) { engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.of(it))))) }
            assertEquals(Json.of(99), engine.read(scope) { it.device("rack") })
        }
        val throwingSeen = CompletableDeferred<Unit>()
        engine(EngineTelemetry { throwingSeen.complete(Unit); throw IllegalStateException("private exception text") }).use { engine ->
            assertTrue(engine.commit(scope, create("card0001")) is CommitOutcome.Committed)
            withTimeout(2_000) { throwingSeen.await() }
            assertTrue(engine.commit(scope, Gesture(emptyList())) is CommitOutcome.Committed)
        }
    }
    @Test fun telemetryIsBoundedDropsOldestAndContainsOnlyAllowlistedLabels() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val received = kotlinx.coroutines.channels.Channel<EngineEvent>(100)
        val queue = TelemetryQueue(EngineTelemetry { event ->
            if (event.operation == EngineOperation.storage) { entered.complete(Unit); release.await() }
            received.send(event)
        })
        try {
            queue.offer(EngineOperation.storage, EngineOutcome.failure, "store-failure"); entered.await()
            repeat(1_000) { queue.offer(EngineOperation.commit, EngineOutcome.failure, "private user text and token") }
            queue.offer(EngineOperation.commit, EngineOutcome.refused, "cap"); release.complete(Unit)
            val events = withTimeout(2_000) { List(65) { received.receive() } }
            assertEquals("store-failure", events.first().code); assertEquals("cap", events.last().code)
            assertTrue(events.subList(1, 64).all { it.code == "unknown" })
            assertNull(withTimeoutOrNull(100) { received.receive() })
        } finally { queue.close(); received.cancel() }
    }
}
