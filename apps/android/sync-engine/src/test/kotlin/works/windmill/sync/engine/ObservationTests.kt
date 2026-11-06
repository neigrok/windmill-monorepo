package works.windmill.sync.engine

import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
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
import works.windmill.sync.schema.SyncSchema

class ObservationTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val scope = ScopeRef.product("probe")
    private val initial = Json.objectOf("active" to Json.of("replica"), "replicas" to Json.array(freshReplica("replica").json()))
    // A store whose reads keep failing for as long as a test holds them so: a retry on the clock cannot move the state a test is reading.
    private class HeldReads(private val delegate: MemoryStore) : EngineStore by delegate {
        val failing = AtomicBoolean(false)
        val attempted = AtomicBoolean(false)
        override fun <T> read(body: () -> T): T {
            if (failing.get()) {
                attempted.set(true)
                throw StoreFailure()
            }
            return delegate.read(body)
        }
    }
    private fun engine(store: EngineStore = MemoryStore(registry, initial)): Engine {
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
    // §7.12: every change of the active replica is heard once, in order, after its transaction; a change that rolled back, a sign-in that rebinds the anon replica and a commit say nothing; the flow ends with the engine.
    @Test fun everyChangeOfTheActiveReplicaIsHeardOnceAndInOrder() = runBlocking<Unit> {
        var drawn = 0
        val identities = object : IdentitySource {
            override fun opaqueID() = "g${++drawn}"
            override fun draw(bound: Int) = 0
            override fun replicaID() = "rp_${++drawn}"
        }
        Engine(registry, MemoryStore(registry, initial), object : EngineClock { override fun now() = 1_000L }, identities, "actor").use { engine ->
            val heard = CopyOnWriteArrayList<ActiveReplicaChange>()
            val hearing = launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) { engine.activeReplicaChanges().collect { heard.add(it) } }
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001"))))))
            assertEquals(emptyList<ActiveReplicaChange>(), heard.toList())

            engine.failNextCommit()
            assertThrows(CommitFailure::class.java) { engine.signIn("A", mapOf("probe" to false)) }
            assertEquals(emptyList<ActiveReplicaChange>(), heard.toList())

            engine.signIn("A", mapOf("probe" to false))
            assertEquals("replica", engine.activeReplica())
            assertEquals(emptyList<ActiveReplicaChange>(), heard.toList())

            assertTrue(engine.signOut("keep").flag("complete"))
            val anon = engine.activeReplica()
            engine.signIn("A", mapOf("probe" to false))
            engine.reidentify()
            val reidentified = engine.activeReplica()
            assertTrue(engine.signOut("keep").flag("complete"))
            assertEquals(listOf(ActiveReplicaChange("replica", anon), ActiveReplicaChange(anon, "replica"),
                ActiveReplicaChange("replica", reidentified), ActiveReplicaChange(reidentified, engine.activeReplica())), heard.toList())

            engine.close()
            withTimeout(5_000) { hearing.join() }
            assertTrue(hearing.isCompleted)
        }
    }
    // §7.12: the rebind that keeps the id is heard on its own flow, and only it: a move to another replica and a sign-out are the other flow's, and a rollback says nothing.
    @Test fun aSignInThatRebindsTheActiveReplicaIsHeardOnItsOwnFlow() = runBlocking<Unit> {
        var drawn = 0
        val identities = object : IdentitySource {
            override fun opaqueID() = "g${++drawn}"
            override fun draw(bound: Int) = 0
            override fun replicaID() = "rp_${++drawn}"
        }
        Engine(registry, MemoryStore(registry, initial), object : EngineClock { override fun now() = 1_000L }, identities, "actor").use { engine ->
            val heard = CopyOnWriteArrayList<String>()
            val hearing = launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) { engine.activeReplicaRebinds().collect { heard.add(it) } }
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001"))))))
            engine.failNextCommit()
            assertThrows(CommitFailure::class.java) { engine.signIn("A", mapOf("probe" to false)) }
            assertEquals(emptyList<String>(), heard.toList())

            engine.signIn("A", mapOf("probe" to false))
            assertEquals(listOf("replica"), heard.toList())

            assertTrue(engine.signOut("keep").flag("complete"))
            engine.signIn("A", mapOf("probe" to false))
            engine.reidentify()
            assertEquals(listOf("replica"), heard.toList())

            engine.close()
            withTimeout(5_000) { hearing.join() }
        }
    }

    // The Main thread asks which replica is active; a transaction holding the lock, however long, does not hold it up.
    @Test fun theActiveReplicaAnswersWhileATransactionHoldsTheLock() = runBlocking<Unit> {
        engine().use { engine ->
            val answered = java.util.concurrent.CompletableFuture<String>()
            engine.lock.withLock {
                java.util.concurrent.Executors.newSingleThreadExecutor().let { other ->
                    other.execute { answered.complete(engine.activeReplica()) }
                    assertEquals("replica", answered.get(5, TimeUnit.SECONDS))
                    other.shutdown()
                }
            }
            engine.close()
            assertThrows(CommitFailure::class.java) { engine.activeReplica() }
        }
    }

    // Main asks the revision while a transaction runs: it answers at once with the revision whose state a read can still see, moves only once the commit is durable, and the observers hear the new one after.
    @Test fun theRevisionAnswersThroughATransactionAndMovesWithItsCommit() = runBlocking<Unit> {
        Engine.memory(SyncSchema.registry).use { engine ->
            val gym = ScopeRef.product("gym")
            val before = engine.readRevision()
            val inside = CountDownLatch(1)
            val release = CountDownLatch(1)
            val writer = thread {
                engine.commit(gym) { _ ->
                    inside.countDown()
                    release.await()
                    Gesture(listOf(Change.create("routine", NewID.Given(RecordID("rt_00000001")), mapOf("name" to Json.of("Push"), "position" to Json.of(0), "entries" to Json.array())))) to Unit
                }
            }
            assertTrue(inside.await(5, TimeUnit.SECONDS))
            assertEquals("a transaction holds the lock, and the question does not wait on it", before,
                CompletableFuture.supplyAsync { engine.readRevision() }.get(5, TimeUnit.SECONDS))
            release.countDown()
            writer.join()
            val after = engine.readRevision()
            assertTrue(after > before)
            assertEquals(after, withTimeout(5_000) { engine.revisions().first { it >= after } })
            engine.read(gym) { read ->
                assertEquals("the revision after a commit names a state that holds it", after, engine.readRevision())
                assertEquals(listOf("rt_00000001"), read.drawn("routine").map { it.id.string })
            }
        }
    }

    // A sign-in asks its decision until it is answered, and keys read across every replica the phone retains.
    @Test fun aSignInAskingAndDeviceKeysAcrossRetainedReplicas() = runBlocking<Unit> {
        Engine.memory(SyncSchema.registry).use { engine ->
            val gym = ScopeRef.product("gym")
            fun routine(id: String) = Change.create("routine", NewID.Given(RecordID(id)), mapOf("name" to Json.of(id), "position" to Json.of(0), "entries" to Json.array()))
            assertFalse(engine.signInAsking())
            engine.commit(gym, Gesture(listOf(routine("rt_00000001")), local = listOf(DeviceWrite("picture:pictureone", Json.of(1)), DeviceWrite("runningTurn", Json.of("message01")))))
            val question = engine.signIn("A", mapOf("gym" to true))
            assertFalse(question.flag("complete"))
            assertTrue(engine.signInAsking())
            val pins = question.items("due").associate { it.member("product").str() to it.member("counted").arr().map(Json::str) }
            assertTrue(engine.signIn("A", mapOf("gym" to true), mapOf("gym" to "add"), pins).flag("complete"))
            assertFalse(engine.signInAsking())
            assertTrue(engine.signOut("keep").flag("complete"))
            engine.commit(gym, Gesture(listOf(routine("rt_00000002")), local = listOf(DeviceWrite("picture:picturetwo", Json.of(3)))))
            assertEquals(setOf("picture:pictureone", "picture:picturetwo"), engine.retainedDeviceKeys("gym", "picture:"))
        }
    }

    private suspend fun loaded(view: RecordsView, matches: (RecordsView.Snapshot) -> Boolean = { true }): RecordsView.Snapshot = withTimeout(60_000) {
        (view.state.first { it is RecordsView.State.Loaded && matches(it.snapshot) } as RecordsView.State.Loaded).snapshot
    }
    @Test fun firstReadFailureKeepsLoadingAndRetryLoadsWithoutAnotherWrite() = runBlocking<Unit> {
        val store = HeldReads(MemoryStore(registry, initial)).apply { failing.set(true) }
        engine(store).use { engine ->
            val view = engine.records(scope, "card")
            withTimeout(60_000) { while (!store.attempted.get()) delay(1) }
            assertEquals(RecordsView.State.Loading, view.state.value)
            store.failing.set(false)
            assertEquals(RecordsView.Snapshot(emptyList(), true), loaded(view))
        }
    }
    @Test fun failedRefreshKeepsItsSnapshotAndOwesEveryChangeUntilRetry() = runBlocking<Unit> {
        val store = HeldReads(MemoryStore(registry, initial))
        engine(store).use { engine ->
            val view = engine.records(scope, "card")
            val old = loaded(view)
            store.failing.set(true)
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")), mapOf("title" to Json.of("One"))))))
            withTimeout(60_000) { while (!store.attempted.get()) delay(1) }
            assertEquals(RecordsView.State.Loaded(old), view.state.value)
            store.failing.set(false)
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
    @Test fun statusNamesTheQueuedRecordsOfAScopeWhoseLastPushFailedAndWhetherItWasAnswered() = runBlocking<Unit> {
        engine().use { engine ->
            val one = RecordKey("card", RecordID("card0001")); val two = RecordKey("card", RecordID("card0002"))
            engine.signIn("A", mapOf("probe" to false))
            val status = engine.status.state
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(one.id)))))
            val request = engine.nextPush()!!
            engine.recordPushFailure(request, PushFailure.unanswered)
            assertEquals(SyncStatus.Snapshot(account = "A", sent = 1, failedPushes = mapOf(scope to setOf(one)), unansweredPushes = setOf(scope)),
                withTimeout(5_000) { status.first { it.failedPushes.isNotEmpty() } })
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(two.id)))))
            assertEquals(SyncStatus.Snapshot(account = "A", ready = 1, sent = 1, failedPushes = mapOf(scope to setOf(one, two)), unansweredPushes = setOf(scope)),
                withTimeout(5_000) { status.first { it.ready == 1 } })
            engine.recordPushFailure(request, PushFailure.answered)
            assertEquals(SyncStatus.Snapshot(account = "A", ready = 1, sent = 1, failedPushes = mapOf(scope to setOf(one, two))),
                withTimeout(5_000) { status.first { it.unansweredPushes.isEmpty() } })
            engine.recordPushFailure(request, null)
            assertEquals(SyncStatus.Snapshot(account = "A", ready = 1, sent = 1), withTimeout(5_000) { status.first { it.failedPushes.isEmpty() } })
            engine.recordPushFailure(request, PushFailure.answered)
            assertTrue(engine.signOut("discard").flag("complete"))
            assertEquals(SyncStatus.Snapshot(), withTimeout(5_000) { status.first { it.account == null } })
            engine.recordPushFailure(request, PushFailure.answered)
            assertEquals(emptyMap<String, Map<ScopeRef, PushFailure>>(), engine.pushFailures)
        }
    }
    @Test fun aPushEndHoldsItsScopesBackUnlessTheServerTookItOrItChangesTheNextPush() {
        val envelope = Json.objectOf("serverTime" to Json.of(5_000), "epoch" to Json.of("ep-1"), "as" to Json.of("A"))
        val ends = listOf<Pair<String, Reply<SyncResponse>>>(
            "no answer" to Reply.Unreachable,
            "taken" to Reply.Answer(SyncResponse(200, envelope)),
            "taken as another account" to Reply.Answer(SyncResponse(200, envelope.with("as" to Json.of("B")))),
            "malformed" to Reply.Answer(SyncResponse(400)),
            "too large" to Reply.Answer(SyncResponse(413)),
            "conflict" to Reply.Answer(SyncResponse(409, envelope.with("error" to Json.of("gap")))),
            "account mismatch" to Reply.Answer(SyncResponse(409, envelope.with("error" to Json.of("account-mismatch")))),
            "conflict without an epoch" to Reply.Answer(SyncResponse(409, envelope.with("error" to Json.of("gap"), "epoch" to null))),
            "conflict with an unknown code" to Reply.Answer(SyncResponse(409, envelope.with("error" to Json.of("unknown")))),
            "unauthenticated" to Reply.Answer(SyncResponse(401)),
            "forbidden" to Reply.Failed(SyncResponse(403)),
            "a proxy's 426" to Reply.Answer(SyncResponse(426)),
            "upgrade required" to Reply.Answer(SyncResponse(426, envelope.with("error" to Json.of("upgrade-required")))),
            "unavailable" to Reply.Answer(SyncResponse(503, envelope.with("retryAfterMs" to Json.of(10)))),
            "server fault" to Reply.Answer(SyncResponse(500)),
        )
        assertEquals(listOf("no answer" to PushFailure.unanswered, "taken" to null, "taken as another account" to null, "malformed" to null,
            "too large" to null, "conflict" to null, "account mismatch" to null, "conflict without an epoch" to PushFailure.answered,
            "conflict with an unknown code" to PushFailure.answered, "unauthenticated" to PushFailure.answered, "forbidden" to PushFailure.answered,
            "a proxy's 426" to PushFailure.answered, "upgrade required" to PushFailure.answered, "unavailable" to PushFailure.unavailable,
            "server fault" to PushFailure.unavailable), ends.map { (end, reply) -> end to reply.pushFailure("A") })
    }
    @Test fun signedInWorkIsHeldBackOfflinePausedForAnUpgradeOrByItsScopesFailedPush() {
        val one = RecordKey("card", RecordID("card0001")); val two = RecordKey("card", RecordID("card0002"))
        val sending = SyncStatus.Snapshot(account = "A")
        val states = listOf("sending" to sending, "offline" to sending.copy(online = false), "paused" to sending.copy(authPaused = true),
            "upgrade required" to sending.copy(upgradeRequired = true), "push failed" to sending.copy(failedPushes = mapOf(scope to setOf(one))),
            "another scope's push failed" to sending.copy(failedPushes = mapOf(ScopeRef.tree("b_00000001") to setOf(one))),
            "signed out and offline" to SyncStatus.Snapshot(online = false))
        assertEquals(listOf("sending" to listOf(false, false), "offline" to listOf(true, true), "paused" to listOf(true, true),
            "upgrade required" to listOf(true, true), "push failed" to listOf(true, false), "another scope's push failed" to listOf(false, false),
            "signed out and offline" to listOf(false, false)), states.map { (state, status) -> state to listOf(one, two).map { status.holdsBack(scope, it) } })
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
