package works.windmill.sync.engine

import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.withLock
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID

class ObservationTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val scope = ScopeRef.product("probe")
    private val initial = Json.objectOf("active" to Json.of("replica"), "replicas" to Json.array(freshReplica("replica").json()))
    private fun engine(store: MemoryStore = MemoryStore(registry, initial)): Engine {
        var sequence = 0
        return Engine(registry, store, object : EngineClock { override fun now() = 1_000L }, object : IdentitySource {
            override fun opaqueID() = "g${++sequence}"
            override fun draw(bound: Int) = 0
        }, "actor")
    }
    @Test fun queuedPartialRefreshCannotPublishRecordsFromTheSignedOutAccount() = runBlocking<Unit> {
        engine().use { engine ->
            engine.signIn("A", mapOf("probe" to false))
            for (id in listOf("card0001", "card0002")) engine.commit(scope, Gesture(listOf(
                Change.create("card", NewID.Given(RecordID(id)), mapOf("title" to Json.of(id))))))
            val view = engine.records(scope, "card")
            assertEquals(2, loaded(view).records.size)
            val transitioned = AtomicBoolean(false)
            val published = CopyOnWriteArrayList<RecordsView.Snapshot>()
            val observing = launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
                view.state.collect { if (transitioned.get() && it is RecordsView.State.Loaded) published.add(it.snapshot) }
            }
            try {
                engine.lock.withLock {
                    engine.commit(scope, Gesture(listOf(Change.update("card", RecordID("card0001"), mapOf("title" to Json.of("Updated"))))))
                    // The only background reader has captured its touched keys and now waits for the writer.
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while (!engine.lock.hasQueuedThreads() && System.nanoTime() < deadline) Thread.yield()
                    assertTrue("partial refresh queued", engine.lock.hasQueuedThreads())
                    assertTrue(engine.signOut("keep").flag("complete"))
                    transitioned.set(true)
                }
                assertTrue(engine.read(scope) { it.drawn("card") }.isEmpty())
                loaded(view) { it.records.isEmpty() }
                assertTrue("published old-account records: $published", published.all { it.records.isEmpty() })
            } finally { observing.cancel() }
        }
    }

    @Test fun accountTransitionClearsTheSnapshotEvenWhenTheNewSeatCannotBeRead() = runBlocking<Unit> {
        val delegate = MemoryStore(registry, initial)
        val failReads = AtomicBoolean(false)
        val attempted = AtomicBoolean(false)
        val store = object : EngineStore by delegate {
            override fun <T> read(body: () -> T): T {
                if (failReads.get()) { attempted.set(true); throw StoreFailure() }
                return delegate.read(body)
            }
        }
        var sequence = 0
        Engine(registry, store, object : EngineClock { override fun now() = 1_000L }, object : IdentitySource {
            override fun opaqueID() = "g${++sequence}"; override fun draw(bound: Int) = 0
        }, "actor").use { engine ->
            engine.signIn("A", mapOf("probe" to false))
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001"))))))
            val view = engine.records(scope, "card")
            assertEquals(1, loaded(view).records.size)
            failReads.set(true)
            engine.signOut("keep")
            withTimeout(5_000) { while (!attempted.get()) delay(1) }
            assertEquals(RecordsView.State.Loading, view.state.value)
            failReads.set(false)
            assertTrue(loaded(view).records.isEmpty())
        }
    }
    private suspend fun loaded(view: RecordsView, matches: (RecordsView.Snapshot) -> Boolean = { true }): RecordsView.Snapshot = withTimeout(5_000) {
        (view.state.first { it is RecordsView.State.Loaded && matches(it.snapshot) } as RecordsView.State.Loaded).snapshot
    }
    @Test fun firstReadFailureKeepsLoadingAndRetryLoadsWithoutAnotherWrite() = runBlocking<Unit> {
        val store = MemoryStore(registry, initial)
        store.failNextRead = true
        engine(store).use { engine ->
            val view = engine.records(scope, "card")
            withTimeout(1_000) { while (store.failNextRead) delay(1) }
            assertEquals(RecordsView.State.Loading, view.state.value)
            assertEquals(RecordsView.Snapshot(emptyList(), true), loaded(view))
        }
    }
    @Test fun failedRefreshKeepsItsSnapshotAndOwesEveryChangeUntilRetry() = runBlocking<Unit> {
        val store = MemoryStore(registry, initial)
        engine(store).use { engine ->
            val view = engine.records(scope, "card")
            val old = loaded(view)
            store.failNextRead = true
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")), mapOf("title" to Json.of("One"))))))
            withTimeout(1_000) { while (store.failNextRead) delay(1) }
            assertEquals(RecordsView.State.Loaded(old), view.state.value)
            engine.commit(scope, Gesture(listOf(Change.update("card", RecordID("card0001"), mapOf("title" to Json.of("Two"))))))
            val next = loaded(view) { it.records.singleOrNull()?.values?.get("title") == Json.of("Two") }
            assertEquals("Two", next.record(RecordID("card0001"))!!.values["title"]!!.str())
            assertNull(next.record(RecordID("card0002")))
        }
    }
    @Test fun oneTouchedRecordCostsOneReadEvenInTenThousandRowView() = runBlocking<Unit> {
        val store = MemoryStore(registry, initial)
        store.transaction { repeat(10_000) {
            val id = RecordID("c${it.toString().padStart(7, '0')}")
            store.put("replica", scope, Row(RecordKey("run", id), Lattice(Life("alive", Stamp("1:0:a")), Stamp("1:0:a")), seq = 1))
        } }
        engine(store).use { engine ->
            val view = engine.records(scope, "run")
            assertEquals(10_000, loaded(view).records.size)
            val before = store.rowsRead
            engine.commit(scope, Gesture(listOf(Change.update("run", RecordID("c0000123"), mapOf("label" to Json.of("Changed"))))))
            loaded(view) { it.record(RecordID("c0000123"))?.values?.get("label") == Json.of("Changed") }
            assertTrue("reads=${store.rowsRead - before}", store.rowsRead - before <= 4)
        }
    }
    @Test fun narrowedViewRereadsOnlyTouchedRecordsAndDropsRowsWhoseReferenceMoved() = runBlocking<Unit> {
        val store = MemoryStore(registry, initial)
        val key = RecordKey("lap", RecordID("lap00001"))
        fun row(ref: String) = Row(key, Lattice(Life("alive", Stamp("1:0:a")), Stamp("1:0:a"),
            mapOf("runId" to Register(Json.of(ref), Stamp("1:0:a")))), seq = 1)
        store.transaction { store.put("replica", scope, row("run00001")) }
        engine(store).use { engine ->
            val view = engine.records(scope, "lap", "runId", RecordID("run00001"))
            loaded(view) { it.records.size == 1 }
            engine.write { store.put("replica", scope, row("run00002")); engine.changedRows.add(scope to key) }
            loaded(view) { it.records.isEmpty() }
        }
    }
    @Test fun cachedViewsKeepIdentityWhileHeldAndKeysIncludeReferenceAndMode() = runBlocking<Unit> {
        engine().use { engine ->
            val view = engine.records(scope, "lap", "runId", RecordID("run00001"))
            loaded(view)
            repeat(10) { engine.records(scope, "lap", "runId", RecordID("r${it.toString().padStart(7, '0')}")) }
            assertSame(view, engine.records(scope, "lap", "runId", RecordID("run00001")))
            assertNotSame(view, engine.records(scope, "lap", "runId", RecordID("run00001"), ViewMode.stored))
            assertThrows(CommitFailure::class.java) { engine.records(scope, "lap", "runId") }
            assertThrows(CommitFailure::class.java) { engine.records(scope, "card", "title", RecordID("run00001")) }
        }
    }
    @Test fun scopeFirstPullAndLifecycleRefreshHaveExplicitLoadedState() = runBlocking<Unit> {
        engine().use { engine ->
            engine.reconcile(setOf(scope))
            val view = engine.records(scope, "card")
            assertFalse(loaded(view).firstPullComplete)
            engine.write { replica -> replica.cursors[scope.text] = Json.objectOf("booted" to Json.of(true), "cursor" to Json.Null, "digest" to Json.of(ScopeDigest.ZERO.hex)) }
            assertTrue(loaded(view) { it.firstPullComplete }.firstPullComplete)
            engine.reconcile(emptySet())
            assertTrue(loaded(view).firstPullComplete)
        }
    }
    @Test fun shutdownCancelsRetriesAndLeavesLastViewStateReadable() = runBlocking<Unit> {
        val store = MemoryStore(registry, initial)
        store.failNextRead = true
        val engine = engine(store)
        val view = engine.records(scope, "card")
        withTimeout(1_000) { while (store.failNextRead) delay(1) }
        engine.close()
        delay(250)
        assertEquals(RecordsView.State.Loading, view.state.value)
        assertThrows(CommitFailure::class.java) { engine.records(scope, "card") }
    }
    @Test fun noticesOffersAndStatusAreCachedAndFollowCommittedState() = runBlocking<Unit> {
        engine().use { engine ->
            val notices = engine.notices("probe")
            val offers = engine.offers
            val status = engine.status
            assertSame(notices, engine.notices("probe")); assertSame(offers, engine.offers); assertSame(status, engine.status)
            assertTrue(notices.notices.value.isEmpty()); assertTrue(offers.offers.value.isEmpty()); assertEquals(0, status.state.value.ready)
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")))), hold = true))
            withTimeout(5_000) { offers.offers.first { it.size == 1 } }
            engine.releaseHeld(true)
            withTimeout(5_000) { offers.offers.first { it.isEmpty() }; status.state.first { it.ready == 1 } }
            engine.write { replica -> replica.notices.add(Json.objectOf("id" to Json.of("notice:g2/0"), "scope" to Json.of(scope.text), "code" to Json.of("cap"),
                "at" to Json.of(1_000), "content" to Json.objectOf("d" to Json.array()))) }
            val notice = withTimeout(5_000) { notices.notices.first { it.size == 1 }.single() }
            assertEquals("probe", notice.product); assertEquals(RefusalCode.cap, notice.code)
            engine.dismissNotice(notice.id)
            withTimeout(5_000) { notices.notices.first { it.isEmpty() } }
        }
    }
    @Test fun anActiveNoticeCollectorRetainsItsNativeViewThroughGarbageCollection() = runBlocking<Unit> {
        engine().use { engine ->
            val received = Channel<List<Notice>>(Channel.UNLIMITED)
            val observing = launch {
                engine.notices("probe").notices.collect { received.send(it) }
            }
            try {
                assertTrue(withTimeout(5_000) { received.receive() }.isEmpty())
                val reference = WeakReference(engine.notices("probe"))
                repeat(10) { System.gc(); delay(20) }
                assertNotNull("a suspended collector must retain the native view that feeds it", reference.get())
                engine.write { replica -> replica.notices.add(Json.objectOf("id" to Json.of("notice:g2/0"),
                    "scope" to Json.of(scope.text), "code" to Json.of("cap"), "at" to Json.of(1_000),
                    "content" to Json.objectOf("d" to Json.array()))) }
                assertEquals("notice:g2/0", withTimeout(5_000) { received.receive() }.single().id)
            } finally { observing.cancelAndJoin(); received.close() }
        }
    }
    @Test fun statusReportsNetworkPauseUpgradeAccountAndUnfinishedSignIn() = runBlocking<Unit> {
        engine().use { engine ->
            val status = engine.status
            engine.networkStatus(online = false, upgradeRequired = true)
            val network = withTimeout(5_000) { status.state.first { !it.online && it.upgradeRequired } }
            assertNull(network.account)
            engine.write(EngineOperation.lifecycle) { replica ->
                replica.meta = replica.meta.with("state" to Json.of("bound"), "account" to Json.of("acct"), "authPaused" to Json.of(true))
                engine.device.meta = Json.objectOf("pendingSignIn" to Json.objectOf("account" to Json.of("next")))
            }
            val next = withTimeout(5_000) { status.state.first { it.account == "acct" } }
            assertTrue(next.authPaused); assertEquals("next", next.pendingSignIn)
        }
    }
    @Test fun smallViewReadFailureRetainsOldStateAndRetriesWithoutNewChanges() = runBlocking<Unit> {
        val delegate = MemoryStore(registry, initial)
        val failReads = java.util.concurrent.atomic.AtomicBoolean(false)
        val store = object : EngineStore by delegate {
            override fun <T> read(body: () -> T): T { if (failReads.get()) throw StoreFailure(); return delegate.read(body) }
        }
        var sequence = 0
        Engine(registry, store, object : EngineClock { override fun now() = 1_000L }, object : IdentitySource {
            override fun opaqueID() = "g${++sequence}"; override fun draw(bound: Int) = 0
        }, "actor").use { engine ->
            val status = engine.status
            val old = status.state.value
            failReads.set(true)
            engine.networkStatus(online = false, upgradeRequired = false)
            delay(30)
            assertEquals(old, status.state.value)
            failReads.set(false)
            withTimeout(5_000) { status.state.first { !it.online } }
        }
    }

}
