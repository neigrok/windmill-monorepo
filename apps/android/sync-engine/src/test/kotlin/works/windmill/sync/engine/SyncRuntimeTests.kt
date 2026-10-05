package works.windmill.sync.engine

import java.io.File
import kotlin.concurrent.withLock
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID

class SyncRuntimeTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val product = ScopeRef.product("probe")

    private class Tokens : SessionTokens {
        val values = ConcurrentHashMap<String, String>()
        var failSave = false
        var failDelete = false
        override fun token(account: String) = values[account]
        override fun save(account: String, token: String) { if (failSave) error("secret-token/private-content"); values[account] = token }
        override fun delete(account: String) { if (failDelete) error("secret-token/private-content"); values.remove(account) }
        override fun accounts() = values.keys.toSet()
    }
    private class Identities : IdentitySource {
        private var gestures = 0
        private var replicas = 0
        private var actors = 0
        private var guards = 0
        override fun opaqueID() = "g${++gestures}"
        override fun draw(bound: Int) = 0
        override fun replicaID() = "rp_${(++replicas).toString(16).padStart(32, '0')}"
        override fun actorID() = "r_${(++actors).toString(16).padStart(12, '0')}"
        override fun forkGuard() = "fg_${++guards}"
    }
    private class Clock : EngineClock {
        @Volatile var wall = 5_000L
        @Volatile var beforeReading: () -> Unit = {}
        override fun now() = wall
        override fun reading(): ClockReading { beforeReading(); return ClockReading(wall, wall, "boot-1") }
    }
    private class Push(val request: Json, val token: String) {
        val answer = CompletableDeferred<Reply<SyncResponse>>()
        val cancelled = CompletableDeferred<Unit>()
    }
    private class Pull(val request: Json, val token: String?) {
        val answer = CompletableDeferred<Reply<SyncResponse>>()
        val cancelled = CompletableDeferred<Unit>()
    }
    private class Socket : LiveConnection {
        val closed = CompletableDeferred<Unit>()
        private val closing = AtomicBoolean(false)
        val frames = Channel<Json>(Channel.UNLIMITED)
        val sends = CopyOnWriteArrayList<Json>()
        var stallSend = false
        val sending = CompletableDeferred<Unit>()
        val sendCancelled = CompletableDeferred<Unit>()
        override suspend fun send(request: Json) {
            check(!closing.get()); sends.add(request); sending.complete(Unit)
            if (stallSend) try { awaitCancellation() }
                catch (cancelled: CancellationException) { sendCancelled.complete(Unit); throw cancelled }
        }
        override suspend fun receive() = frames.receiveCatching().getOrNull()
        override fun close() { if (closing.compareAndSet(false, true)) { frames.close(); closed.complete(Unit) } }
    }
    private class Transport : SyncTransport {
        val pushes = Channel<Push>(Channel.UNLIMITED)
        val pulls = Channel<Pull>(Channel.UNLIMITED)
        var controlPulls = false
        val pulling = AtomicInteger()
        val opening = AtomicInteger()
        val activePushes = AtomicInteger()
        val maximumPushes = AtomicInteger()
        @Volatile var failPush = false
        val opened = CompletableDeferred<Socket>()
        val hellos = Channel<String?>(Channel.UNLIMITED)
        var holdsRecords = false
        var helloAnswer: CompletableDeferred<Reply<SyncResponse>>? = null
        val socket = Socket()
        override suspend fun hello(token: String?): Reply<SyncResponse> {
            hellos.send(token)
            return helloAnswer?.await() ?: Reply.Answer(SyncResponse(200, Json.objectOf(
                "serverTime" to Json.of(5_000), "epoch" to Json.of("ep-1"), "as" to (token?.removePrefix("token:")?.let(Json::of) ?: Json.Null),
                "schema" to Json.of(2), "minSchema" to Json.of(2), "holdsRecords" to Json.objectOf("probe" to Json.of(holdsRecords)))))
        }
        override suspend fun push(request: Json, token: String): Reply<SyncResponse> {
            val count = activePushes.incrementAndGet()
            maximumPushes.updateAndGet { maxOf(it, count) }
            val push = Push(request, token)
            try {
                if (failPush) throw java.io.IOException("push failed")
                pushes.send(push)
                return push.answer.await()
            }
            catch (cancelled: CancellationException) { push.cancelled.complete(Unit); throw cancelled }
            finally { activePushes.decrementAndGet() }
        }
        override suspend fun pull(request: Json, token: String?): Reply<SyncResponse> {
            pulling.incrementAndGet()
            if (controlPulls) {
                val pull = Pull(request, token)
                try { pulls.send(pull); return pull.answer.await() }
                catch (cancelled: CancellationException) { pull.cancelled.complete(Unit); throw cancelled }
            }
            return Reply.Answer(SyncResponse(200, Json.objectOf("serverTime" to Json.of(5_000), "epoch" to Json.of("ep-1"),
                "as" to (token?.removePrefix("token:")?.let(Json::of) ?: Json.Null), "pages" to Json.array())))
        }
        override suspend fun openLive(token: String): Reply<LiveConnection> {
            opening.incrementAndGet(); opened.complete(socket); return Reply.Answer(socket)
        }
    }
    private inner class Fixture(bound: Boolean = true, snapshot: Json? = null,
        sleeper: EngineSleeper = object : EngineSleeper { override suspend fun sleep(ms: Long) = awaitCancellation() },
        pendingDeviceWork: PendingDeviceWork = { _, _ -> emptyList() }) : AutoCloseable {
        val events = CopyOnWriteArrayList<EngineEvent>()
        val tokens = Tokens()
        val clock = Clock()
        val engine = Engine.memory(registry, snapshot, clock, Identities(), "r_aaaaaaaaaaaa", telemetry = EngineTelemetry { events.add(it) }, pendingDeviceWork = pendingDeviceWork)
        val transport = Transport()
        val runtime = SyncRuntime(engine, transport, tokens, "1", sleeper, listOf("probe"))
        init { if (bound) tokens.save("A", "token:A"); if (bound && snapshot == null) engine.signIn("A", mapOf("probe" to false)) }
        fun create(held: Boolean = false) = engine.commit(product, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")),
            mapOf("title" to Json.of("Title")))), hold = held))
        suspend fun push() = withTimeout(2_000) { transport.pushes.receive() }
        suspend fun pull() = withTimeout(2_000) { transport.pulls.receive() }
        override fun close() { runtime.close(); engine.close() }
    }
    private fun ok(request: Json, account: String = "A") = Reply.Answer(SyncResponse(200, Json.objectOf("serverTime" to Json.of(5_000),
        "epoch" to Json.of("ep-1"), "as" to Json.of(account), "lastN" to request.member("intents").arr().last().member("n"),
        "results" to Json.Arr(request.member("intents").arr().map { Json.objectOf("n" to it.member("n"), "s" to Json.of("ok"), "seq" to Json.of(1)) }))))
    private suspend fun until(body: () -> Boolean) = withTimeout(2_000) { while (!body()) delay(5) }

    @Test fun closingAnEngineWhileItsRuntimeCallbackIsRunningCancelsOwnedWorkersWithoutLeakingFailures() = runBlocking {
        for (closeRuntime in listOf(true, false)) Fixture().use { fixture ->
            val owner = (SyncRuntime::class.java.getDeclaredField("scope").also { it.isAccessible = true }
                .get(fixture.runtime) as CoroutineScope).coroutineContext[Job]!!
            val workers = owner.children.toList()
            val completions = workers.map { worker -> CompletableDeferred<Throwable?>().also { ended ->
                worker.invokeOnCompletion { ended.complete(it) }
            } }
            val entered = CompletableDeferred<Unit>()
            val release = java.util.concurrent.CountDownLatch(1)
            val once = AtomicBoolean(true)
            fixture.clock.beforeReading = {
                if (once.compareAndSet(true, false)) {
                    entered.complete(Unit)
                    check(release.await(2, java.util.concurrent.TimeUnit.SECONDS))
                }
            }
            try {
                fixture.engine.subscribe(product)
                withTimeout(2_000) { entered.await() }
                if (closeRuntime) fixture.runtime.close()
                fixture.engine.close()
            } finally { release.countDown() }
            withTimeout(2_000) { workers.joinAll() }
            assertTrue(owner.isCancelled)
            assertTrue(completions.map { it.await() }.all { it == null || it is CancellationException })
            assertFalse(fixture.events.any { it.outcome == EngineOutcome.failure })
        }
    }

    @Test fun runtimeWorkerBoundariesReportUnexpectedFailuresAndPropagateCancellation() = runBlocking {
        for (cancelled in listOf(false, true)) Fixture().use { fixture ->
            val owner = (SyncRuntime::class.java.getDeclaredField("scope").also { it.isAccessible = true }
                .get(fixture.runtime) as CoroutineScope).coroutineContext[Job]!!
            val collector = owner.children.first()
            val completion = CompletableDeferred<Throwable?>()
            collector.invokeOnCompletion { completion.complete(it) }
            val once = AtomicBoolean(true)
            fixture.clock.beforeReading = {
                if (once.compareAndSet(true, false)) {
                    if (cancelled) throw CancellationException("cancelled")
                    throw java.io.IOException("secret-token/private-content")
                }
            }
            fixture.engine.subscribe(product)
            val failure = withTimeout(2_000) { completion.await() }
            if (cancelled) assertTrue(failure is CancellationException) else assertNull(failure)
            fixture.engine.report(EngineOperation.hello, EngineOutcome.refused)
            until { fixture.events.any { it.operation == EngineOperation.hello && it.outcome == EngineOutcome.refused } }
            assertEquals(if (cancelled) emptyList() else listOf(EngineEvent(EngineOperation.sync, EngineOutcome.failure)),
                fixture.events.filter { it.outcome == EngineOutcome.failure })
            assertTrue(owner.isActive)
        }
    }

    private class ReleaseSleeper : EngineSleeper {
        class Sleep(val ms: Long) { val resume = CompletableDeferred<Unit>(); val ended = CompletableDeferred<Unit>() }
        val sleeps = CopyOnWriteArrayList<Sleep>()
        val failedWriter = AtomicReference<Thread?>()
        val retries = Channel<Sleep>(Channel.UNLIMITED)
        override suspend fun sleep(ms: Long) {
            val sleep = Sleep(ms); sleeps.add(sleep)
            if (failedWriter.compareAndSet(Thread.currentThread(), null)) retries.trySend(sleep)
            try { sleep.resume.await() } finally { sleep.ended.complete(Unit) }
        }
    }
    private inner class FailedReleaseFixture(failures: Int) : AutoCloseable {
        val clock = Clock()
        val sleeper = ReleaseSleeper()
        val transport = Transport()
        val attempts = AtomicInteger()
        val initial = Engine.memory(registry, clock = clock, identities = Identities(), actor = "r_aaaaaaaaaaaa").use { seed ->
            seed.signIn("A", mapOf("probe" to false))
            seed.commit(product, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")))), hold = true))
            clock.wall = seed.undoOffers().single().releaseAt
            seed.snapshot()
        }
        private val delegate = MemoryStore(registry, initial)
        private val store = object : EngineStore by delegate {
            override fun <T> transaction(body: () -> T): T = delegate.transaction {
                fun held() = DeviceState(delegate.metadata()).current().entries().any { it.state == "held" }
                val wasHeld = held()
                body().also {
                    if (wasHeld && !held() && attempts.incrementAndGet() <= failures) {
                        sleeper.failedWriter.set(Thread.currentThread()); throw StoreFailure()
                    }
                }
            }
        }
        val engine = Engine(registry, store, clock, Identities(), "r_aaaaaaaaaaaa")
        val runtime = SyncRuntime(engine, transport, Tokens().also { it.save("A", "token:A") }, "1", sleeper, listOf("probe"))
        override fun close() { runtime.close(); engine.close() }
    }

    @Test fun releaseTimerRetriesStorageFailuresAtOneSecondAndEventuallySendsTheHeldGesture() = runBlocking {
        FailedReleaseFixture(failures = 3).use { fixture ->
            repeat(3) { index ->
                until { fixture.attempts.get() == index + 1 }
                val retry = withTimeout(2_000) { fixture.sleeper.retries.receive() }
                assertEquals(Constants.BACKOFF_BASE_MS, retry.ms)
                assertEquals("held", fixture.engine.snapshot().let { snapshot -> snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") } }.member("outbox").arr().single().member("state").str())
                retry.resume.complete(Unit)
            }
            until { fixture.attempts.get() == 4 }
            fixture.runtime.enter()
            val push = withTimeout(2_000) { fixture.transport.pushes.receive() }
            assertEquals(1, push.request.member("intents").arr().size)
            push.answer.complete(ok(push.request))
            until { fixture.engine.snapshot().let { snapshot -> snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") } }.member("outbox").arr().single().member("state") == Json.of("acked") }
            assertEquals(4, fixture.attempts.get())
            assertTrue(fixture.engine.undoOffers().isEmpty())
        }
    }

    @Test fun shutdownCancelsReleaseBackoffWithoutRetryingOrPublishingTheFailedRelease() = runBlocking {
        FailedReleaseFixture(failures = 3).use { fixture ->
            until { fixture.attempts.get() == 1 }
            val retry = withTimeout(2_000) { fixture.sleeper.retries.receive() }
            assertEquals(Constants.BACKOFF_BASE_MS, retry.ms)
            fixture.runtime.close()
            withTimeout(2_000) { while (fixture.sleeper.sleeps.any { !it.ended.isCompleted }) delay(1) }
            retry.resume.complete(Unit)
            assertEquals(1, fixture.attempts.get())
            assertEquals("held", fixture.engine.snapshot().let { snapshot -> snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") } }.member("outbox").arr().single().member("state").str())
            assertTrue(fixture.transport.pushes.tryReceive().isFailure)
        }
    }

    @Test fun concurrentSenderTurnsRetryExactlyTheSameNumberedBatchAfterALostReply() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val first = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            val second = async { fixture.runtime.senderStep(leaving = true) }
            delay(30)
            assertEquals(1, fixture.transport.activePushes.get())
            assertTrue(fixture.transport.pushes.tryReceive().isFailure)
            request.answer.complete(Reply.Unreachable)
            assertTrue(first.await())
            val retry = fixture.push()
            assertEquals(request.request, retry.request)
            assertEquals("token:A", retry.token)
            retry.answer.complete(ok(retry.request))
            assertTrue(second.await())
            assertEquals(1, fixture.transport.maximumPushes.get())
            assertEquals("acked", fixture.engine.device.current().entries().single().state)
        }
    }

    @Test fun unreachableReplyKeepsSentIntentDigestNumberAndLineage() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val send = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            val numbered = fixture.engine.device.current().entries().single().json
            request.answer.complete(Reply.Unreachable); assertTrue(send.await())
            assertEquals(numbered, fixture.engine.device.current().entries().single().json)
            assertEquals("sent", numbered.member("state").str())
            assertEquals("A", numbered.member("lineage").str())
            assertEquals(0L, fixture.engine.device.current().meta.member("ackThrough").long())
        }
    }

    @Test fun sameAccountSignInReauthenticatesAndPreservesItsReplicaAndHeldWork() = runBlocking {
        Fixture().use { fixture ->
            fixture.create(held = true)
            fixture.engine.write(EngineOperation.lifecycle) { it.meta = it.meta.with("authPaused" to Json.of(true)) }
            val replica = fixture.engine.activeReplica()
            val work = fixture.engine.device.current().entries().single().json
            assertTrue(fixture.runtime.signIn("A", "token:A-new").isComplete)
            assertEquals(replica, fixture.engine.activeReplica())
            assertEquals(work, fixture.engine.device.current().entries().single().json)
            assertEquals("held", fixture.engine.device.current().entries().single().state)
            assertFalse(fixture.engine.device.current().meta.member("authPaused").bool())
            assertEquals("token:A-new", fixture.tokens.token("A"))
            assertTrue(fixture.transport.hellos.tryReceive().isFailure)
        }
    }

    @Test fun missingTokenPausesWithoutNumberingOrSending() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val work = fixture.engine.device.current().entries().single().json
            fixture.tokens.values.remove("A")
            assertFalse(fixture.runtime.senderStep(leaving = true))
            assertTrue(fixture.engine.device.current().meta.member("authPaused").bool())
            assertEquals(work, fixture.engine.device.current().entries().single().json)
            assertTrue(fixture.transport.pushes.tryReceive().isFailure)
        }
    }

    @Test fun helloMadeUnderOldTokenCannotPauseAReauthenticatedSeat() = runBlocking {
        Fixture().use { fixture ->
            val answer = CompletableDeferred<Reply<SyncResponse>>()
            fixture.transport.helloAnswer = answer
            val hello = async { fixture.runtime.hello("token:A") }
            assertEquals("token:A", withTimeout(2_000) { fixture.transport.hellos.receive() })
            fixture.runtime.reauthenticate("token:A-new")
            answer.complete(Reply.Answer(SyncResponse(401)))
            hello.await()
            assertFalse(fixture.engine.device.current().meta.member("authPaused").bool())
            assertEquals("token:A-new", fixture.tokens.token("A"))
        }
    }

    @Test fun pushServedAsAnotherAccountPausesWithoutApplyingItsResults() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val send = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            val numbered = fixture.engine.device.current().entries().single().json
            request.answer.complete(ok(request.request, "B")); assertTrue(send.await())
            assertTrue(fixture.engine.device.current().meta.member("authPaused").bool())
            assertEquals(numbered, fixture.engine.device.current().entries().single().json)
            assertEquals(0L, fixture.engine.device.current().meta.member("ackThrough").long())
            assertFalse(fixture.runtime.senderStep(leaving = true))
            assertTrue(fixture.transport.pushes.tryReceive().isFailure)
        }
    }

    @Test fun latePushReplyAfterSignOutUpdatesOnlyTheSendingDormantReplica() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val send = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            assertTrue(fixture.engine.signOut("keep").member("complete").bool())
            fixture.tokens.save("B", "token:B"); fixture.engine.signIn("B", mapOf("probe" to false))
            val before = fixture.engine.device.current().json()
            request.answer.complete(ok(request.request)); send.await()
            assertEquals(before, fixture.engine.device.current().json())
            assertEquals("B", fixture.engine.device.current().account)
            val dormant = fixture.engine.device.replicas.single { it.account == "A" }
            assertEquals("dormant", dormant.state)
            assertEquals("acked", dormant.entries().single().state)
            assertEquals(1L, dormant.meta.member("ackThrough").long())
        }
    }

    @Test fun shutdownCancelsAHangingBackgroundPushAndKeepsItRetryable() = runBlocking {
        Fixture().use { fixture ->
            fixture.create(); fixture.runtime.enter()
            val request = fixture.push()
            fixture.runtime.shutdown(1_000)
            withTimeout(1_000) { request.cancelled.await() }
            assertEquals(0, fixture.transport.activePushes.get())
            assertEquals("sent", fixture.engine.device.current().entries().single().state)
            assertFalse(fixture.runtime.senderStep(leaving = true))
            fixture.engine.report(EngineOperation.shutdown, EngineOutcome.success)
            until { fixture.events.any { it.operation == EngineOperation.shutdown } }
            assertFalse(fixture.events.any { it.operation == EngineOperation.push && it.outcome == EngineOutcome.failure })
        }
    }

    @Test fun leaveClosesLiveAndPreventsFurtherPullsUntilForegroundReturns() = runBlocking {
        Fixture().use { fixture ->
            fixture.runtime.enter()
            val socket = withTimeout(2_000) { fixture.transport.opened.await() }
            until { fixture.transport.pulling.get() > 0 }
            fixture.runtime.leave()
            withTimeout(1_000) { socket.closed.await() }
            val pulls = fixture.transport.pulling.get()
            assertFalse(fixture.runtime.pullerStep())
            delay(50)
            assertEquals(pulls, fixture.transport.pulling.get())
        }
    }

    @Test fun anonymousReplicaPullsItsExplicitReadableTreeWithoutCredentialsOrLive() = runBlocking {
        Fixture(bound = false).use { fixture ->
            val tree = ScopeRef.tree("b_00000001")
            fixture.transport.controlPulls = true
            fixture.engine.subscribe(tree); fixture.runtime.enter()
            val request = fixture.pull()
            assertNull(request.token)
            assertEquals(listOf(tree.text), request.request.member("scopes").arr().map { it.member("scope").str() })
            request.answer.complete(Reply.Answer(SyncResponse(200, Json.objectOf("serverTime" to Json.of(5_000),
                "epoch" to Json.of("ep-1"), "as" to Json.Null, "pages" to Json.array()))))
            assertEquals(0, fixture.transport.opening.get())
            assertFalse(fixture.runtime.senderStep(leaving = true))
        }
    }

    @Test fun boundReplicaRetainsExplicitTreeAlongsideItsProductSubscriptions() = runBlocking {
        Fixture().use { fixture ->
            val tree = ScopeRef.tree("b_00000001")
            fixture.transport.controlPulls = true
            fixture.engine.subscribe(tree); fixture.runtime.enter()
            val request = fixture.pull()
            assertEquals(setOf(product.text, tree.text), request.request.member("scopes").arr().map { it.member("scope").str() }.toSet())
            request.answer.complete(Reply.Unreachable)
            Unit
        }
    }

    @Test fun unavailablePullWaitBlocksANewScopeUntilItsGlobalServerDeadline() = runBlocking {
        Fixture().use { fixture ->
            fixture.transport.controlPulls = true
            fixture.runtime.enter()
            val first = fixture.pull()
            first.answer.complete(Reply.Failed(SyncResponse(503, Json.objectOf("retryAfterMs" to Json.of(10_000)))))
            delay(30)
            fixture.engine.subscribe(ScopeRef.tree("b_00000001"))
            val turn = async { fixture.runtime.pullerStep() }
            delay(30)
            val extra = fixture.transport.pulls.tryReceive()
            extra.getOrNull()?.answer?.complete(Reply.Unreachable)
            turn.await()
            assertTrue("503 asked every pull to wait, including a newly subscribed scope", extra.isFailure)
            assertEquals(1, fixture.transport.pulling.get())
            fixture.clock.wall += 10_000
            val due = async { fixture.runtime.pullerStep() }
            val next = fixture.pull()
            assertEquals(setOf(product.text, "tree/b_00000001"), next.request.member("scopes").arr().map { it.member("scope").str() }.toSet())
            next.answer.complete(Reply.Unreachable); due.await(); Unit
        }
    }

    @Test fun lateLiveFrameAfterAccountChangeCannotPauseTheNewAccount() = runBlocking {
        Fixture().use { fixture ->
            fixture.runtime.enter()
            val socket = withTimeout(2_000) { fixture.transport.opened.await() }
            until { socket.sends.any { it["op"] == Json.of("sub") } }
            assertTrue(fixture.engine.signOut("keep").member("complete").bool())
            fixture.tokens.save("B", "token:B"); fixture.engine.signIn("B", mapOf("probe" to false))
            socket.frames.trySend(Json.objectOf("op" to Json.of("change"), "scope" to Json.of(product.text), "as" to Json.of("A"),
                "epoch" to Json.of("ep-1"), "seq" to Json.of(1)))
            withTimeout(2_000) { socket.closed.await() }
            assertEquals("B", fixture.engine.device.current().account)
            assertFalse(fixture.engine.device.current().meta.member("authPaused").bool())
        }
    }

    @Test fun trafficWithoutPongCannotExtendTheOutstandingPingDeadline() = runBlocking {
        Fixture().use { fixture ->
            fixture.runtime.enter()
            val socket = withTimeout(2_000) { fixture.transport.opened.await() }
            until { socket.sends.any { it["op"] == Json.of("sub") } }
            fixture.clock.wall += Constants.LIVE_PING_MS
            until { socket.sends.any { it["op"] == Json.of("ping") } }
            fixture.clock.wall += 100
            socket.frames.send(Json.objectOf("op" to Json.of("unknown")))
            delay(30)
            fixture.clock.wall += Constants.LIVE_PONG_MS
            socket.frames.trySend(Json.objectOf("op" to Json.of("unknown")))
            withTimeout(2_000) { socket.closed.await() }
        }
    }

    @Test fun shutdownCancelsStalledLiveOutputAndItsPendingPull() = runBlocking {
        Fixture().use { fixture ->
            fixture.transport.socket.stallSend = true
            fixture.transport.controlPulls = true
            fixture.runtime.enter()
            val pending = fixture.pull()
            val socket = withTimeout(2_000) { fixture.transport.opened.await() }
            withTimeout(2_000) { socket.sending.await() }
            fixture.runtime.shutdown(1_000)
            withTimeout(1_000) { socket.closed.await(); socket.sendCancelled.await(); pending.cancelled.await() }
            assertFalse(fixture.runtime.pullerStep())
            fixture.engine.report(EngineOperation.shutdown, EngineOutcome.success)
            until { fixture.events.any { it.operation == EngineOperation.shutdown } }
            assertFalse(fixture.events.any { it.operation == EngineOperation.pull && it.outcome == EngineOutcome.failure })
        }
    }

    @Test fun typed401FailurePausesWithoutRewritingTheSentPush() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val send = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            val numbered = fixture.engine.device.current().entries().single().json
            request.answer.complete(Reply.Failed(SyncResponse(401))); assertTrue(send.await())
            assertTrue(fixture.engine.device.current().meta.member("authPaused").bool())
            assertEquals(numbered, fixture.engine.device.current().entries().single().json)
        }
    }

    @Test fun sameRuntimeLaunchRunsStartupOnce() {
        Fixture().use { fixture ->
            var copy: String? = null
            var saves = 0
            val guard = object : ForkGuardStore {
                override fun load() = copy
                override fun save(value: String) { saves++; copy = value }
            }
            fixture.runtime.launch(guard)
            val actor = fixture.engine.actor
            val snapshot = fixture.engine.snapshot()
            fixture.runtime.launch(guard)
            assertEquals(actor, fixture.engine.actor)
            assertEquals(snapshot, fixture.engine.snapshot())
            assertEquals(1, saves)
        }
    }

    @Test fun forkGuardSaveFailureReportsAndNextStartupReidentifiesWithoutLosingWork() = runBlocking {
        Fixture().use { fixture ->
            fixture.create(held = true)
            val id = fixture.engine.activeReplica()
            val bad = object : ForkGuardStore {
                override fun load(): String? = null
                override fun save(value: String) { error("secret-token/private-content") }
            }
            assertThrows(IllegalStateException::class.java) { fixture.runtime.launch(bad) }
            assertEquals(id, fixture.engine.activeReplica())
            assertEquals("ready", fixture.engine.device.current().entries().single().state)
            val pending = fixture.engine.device.current().entries().single().json
            assertNotNull(fixture.engine.device.meta["forkGuard"])
            until { fixture.events.any { it.operation == EngineOperation.lifecycle && it.outcome == EngineOutcome.failure } }
            assertTrue(fixture.events.none { it.toString().contains("secret-token") || it.toString().contains("private-content") })
            fixture.runtime.close()
            val restarted = SyncRuntime(fixture.engine, fixture.transport, fixture.tokens, "1", products = listOf("probe"))
            try {
                var copy: String? = null
                restarted.launch(object : ForkGuardStore {
                    override fun load() = copy
                    override fun save(value: String) { copy = value }
                })
                assertNotEquals(id, fixture.engine.activeReplica())
                assertEquals(pending, fixture.engine.device.current().entries().single().json)
                assertEquals(fixture.engine.device.meta.member("forkGuard").str(), copy)
            } finally { restarted.close() }
        }
    }

    @Test fun forkGuardLoadFailureLeavesStartupUnchangedAndReportsStaticFailure() = runBlocking {
        Fixture().use { fixture ->
            fixture.create(held = true)
            val actor = fixture.engine.actor
            val before = fixture.engine.snapshot()
            assertThrows(IllegalStateException::class.java) { fixture.runtime.launch(object : ForkGuardStore {
                override fun load(): String? = error("secret-token/private-content")
                override fun save(value: String) = fail("load failed before save")
            }) }
            assertEquals(actor, fixture.engine.actor)
            assertEquals(before, fixture.engine.snapshot())
            until { fixture.events.any { it.operation == EngineOperation.lifecycle && it.outcome == EngineOutcome.failure } }
            assertTrue(fixture.events.none { it.toString().contains("secret-token") || it.toString().contains("private-content") })
        }
    }

    @Test fun tokenSaveFailureLeavesReplicaUntouchedAndReportsOnlyStaticLabels() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.tokens.failSave = true
            val before = fixture.engine.snapshot()
            val failure = runCatching { fixture.runtime.signIn("A", "secret-token/private-content") }.exceptionOrNull()
            assertTrue(failure is IllegalStateException)
            assertEquals(before, fixture.engine.snapshot())
            assertTrue(fixture.tokens.values.isEmpty())
            until { fixture.events.any { it.operation == EngineOperation.lifecycle && it.outcome == EngineOutcome.failure } }
            assertTrue(fixture.events.none { it.toString().contains("secret-token") || it.toString().contains("private-content") })
        }
    }

    @Test fun tokenDeleteFailureLeavesSignOutDurableAndStartupRetriesCredentialCleanup() = runBlocking {
        Fixture().use { fixture ->
            fixture.tokens.failDelete = true
            assertTrue(fixture.runtime.signOut().finish(SignOutChoice.keep).member("complete").bool())
            assertEquals("anon", fixture.engine.device.current().state)
            assertEquals("dormant", fixture.engine.device.replicas.single { it.account == "A" }.state)
            assertEquals("token:A", fixture.tokens.values["A"])
            until { fixture.events.any { it.operation == EngineOperation.lifecycle && it.outcome == EngineOutcome.failure } }
            assertTrue(fixture.events.none { it.toString().contains("secret-token") || it.toString().contains("private-content") })
            fixture.tokens.failDelete = false
            var copy: String? = null
            fixture.runtime.launch(object : ForkGuardStore {
                override fun load() = copy
                override fun save(value: String) { copy = value }
            })
            assertTrue(fixture.tokens.values.isEmpty())
        }
    }

    @Test fun pendingSignOutFreezesSendingAndRejectsStaleDiscardUntilCancelled() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val decision = async { fixture.runtime.signOut() }
            fixture.push().answer.complete(Reply.Unreachable)
            val question = withTimeout(2_000) { decision.await() }
            assertEquals(1, question.unsent)
            fixture.engine.commit(product, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0002")),
                mapOf("title" to Json.of("Second"))))))
            assertFalse(fixture.runtime.senderStep(leaving = true))
            assertTrue(fixture.transport.pushes.tryReceive().isFailure)
            val stale = runCatching { question.finish(SignOutChoice.discard) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signOutChanged, stale.code)
            assertEquals(2, stale.ready + stale.sent + stale.pending)
            assertEquals("A", fixture.engine.device.current().account)
            assertEquals(2, fixture.engine.device.current().entries().size)
            question.cancel()
            val resumed = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            assertEquals(2, request.request.member("intents").arr().size)
            request.answer.complete(Reply.Unreachable)
            assertTrue(resumed.await())
        }
    }

    @Test fun signOutCancelsItsActivePushWithoutReportingFailureAndTheSameRequestCanResume() = runBlocking {
        val flushing = CompletableDeferred<Unit>()
        val expired = CompletableDeferred<Unit>()
        val sleeper = object : EngineSleeper {
            override suspend fun sleep(ms: Long) {
                if (ms == Constants.SIGNOUT_FLUSH_MS.toLong()) { flushing.complete(Unit); expired.await() }
                else awaitCancellation()
            }
        }
        Fixture(sleeper = sleeper).use { fixture ->
            fixture.create(); fixture.runtime.enter()
            val request = fixture.push()
            val decision = async { fixture.runtime.signOut() }
            withTimeout(2_000) { flushing.await() }; expired.complete(Unit)
            val question = withTimeout(2_000) { decision.await() }
            withTimeout(2_000) { request.cancelled.await() }
            assertEquals(0, fixture.transport.activePushes.get())
            assertEquals("sent", fixture.engine.device.current().entries().single().state)
            question.cancel(); fixture.runtime.enter()
            val resumed = fixture.push()
            assertEquals(request.request, resumed.request)
            resumed.answer.complete(ok(resumed.request))
            until { fixture.engine.device.current().meta.member("ackThrough") == Json.of(1) }
            fixture.engine.report(EngineOperation.shutdown, EngineOutcome.success)
            until { fixture.events.any { it.operation == EngineOperation.shutdown } }
            assertFalse(fixture.events.any { it.operation == EngineOperation.push && it.outcome == EngineOutcome.failure })
            assertTrue(fixture.runtime.signOut().finish(SignOutChoice.keep).member("complete").bool())
            assertEquals("anon", fixture.engine.device.current().state)
        }
    }

    @Test fun signOutFencesANumberedWorkerBeforeTransportAndCancellingTheAttemptReleasesItsFence() = runBlocking {
        for (cancel in listOf(false, true)) {
            val flushing = CompletableDeferred<Unit>()
            val expired = CompletableDeferred<Unit>()
            val sleeper = object : EngineSleeper {
                override suspend fun sleep(ms: Long) {
                    if (ms == Constants.SIGNOUT_FLUSH_MS.toLong()) { flushing.complete(Unit); expired.await() }
                    else awaitCancellation()
                }
            }
            Fixture(sleeper = sleeper).use { fixture ->
                val numbered = CompletableDeferred<Unit>()
                val release = java.util.concurrent.CountDownLatch(1)
                val paused = AtomicBoolean(false)
                fixture.create()
                fixture.clock.beforeReading = {
                    if (fixture.engine.lock.withLock { fixture.engine.device.current().entries().any { it.state == "sent" } } && paused.compareAndSet(false, true)) {
                        numbered.complete(Unit); release.await()
                    }
                }
                val hold = SyncRuntime::class.java.getDeclaredField("signOutHold").apply { isAccessible = true }
                val sender = async { fixture.runtime.senderStep(leaving = true) }
                try {
                    withTimeout(2_000) { numbered.await() }
                    val original = fixture.engine.nextPush()!!
                    val decision = async { fixture.runtime.signOut() }
                    withTimeout(2_000) { flushing.await() }; expired.complete(Unit)
                    until { hold.get(fixture.runtime) == "A" }
                    assertTrue(fixture.transport.pushes.tryReceive().isFailure)
                    if (cancel) {
                        decision.cancelAndJoin()
                        assertNull(hold.get(fixture.runtime))
                        release.countDown()
                    } else {
                        release.countDown()
                        val question = withTimeout(2_000) { decision.await() }
                        assertFalse(sender.await())
                        assertTrue(fixture.transport.pushes.tryReceive().isFailure)
                        assertEquals(original, fixture.engine.nextPush())
                        question.cancel()
                    }
                    val resumed = if (cancel) sender else async { fixture.runtime.senderStep(leaving = true) }
                    val request = fixture.push()
                    assertEquals(original, request.request)
                    request.answer.complete(ok(request.request))
                    assertTrue(resumed.await())
                    assertEquals(Json.of(1), fixture.engine.device.current().meta.member("ackThrough"))
                    fixture.engine.report(EngineOperation.shutdown, EngineOutcome.success)
                    until { fixture.events.any { it.operation == EngineOperation.shutdown } }
                    assertFalse(fixture.events.any { it.operation == EngineOperation.push && it.outcome == EngineOutcome.failure })
                } finally { release.countDown(); sender.cancelAndJoin() }
            }
        }
    }

    @Test fun aGenuineBackgroundPushExceptionStillReportsFailureAndRetainsItsRetry() = runBlocking {
        Fixture().use { fixture ->
            fixture.transport.failPush = true
            fixture.create(); fixture.runtime.enter()
            until { fixture.events.any { it.operation == EngineOperation.push && it.outcome == EngineOutcome.failure } }
            assertEquals("sent", fixture.engine.device.current().entries().single().state)
            val request = fixture.engine.nextPush()!!
            fixture.transport.failPush = false
            fixture.runtime.enter()
            val resumed = fixture.push()
            assertEquals(request, resumed.request)
            resumed.answer.complete(ok(resumed.request))
            until { fixture.engine.device.current().meta.member("ackThrough") == Json.of(1) }
        }
    }

    @Test fun explicitUnsubscribeForgetsCachedTreeAndItsCursor() {
        Fixture(bound = false).use { fixture ->
            val tree = ScopeRef.tree("b_00000001")
            fixture.engine.subscribe(tree)
            fixture.engine.reconcile(setOf(tree))
            fixture.engine.write(EngineOperation.pull) { replica ->
                replica.cursors[tree.text] = Json.objectOf("booted" to Json.of(true), "cursor" to Json.Null)
                fixture.engine.store.put(replica.id, tree, Row(RecordKey("tag", RecordID("tag00001")),
                    Lattice(Life("alive", Stamp("1:0:server")), Stamp("1:0:server")), seq = 1))
            }
            assertTrue(tree in fixture.engine.subscriptions(listOf("probe")))
            fixture.engine.unsubscribe(tree)
            assertTrue(fixture.engine.subscriptions(listOf("probe")).isEmpty())
            assertNull(fixture.engine.device.current().cursors[tree.text])
            assertTrue(fixture.engine.store.rows(fixture.engine.activeReplica(), tree).isEmpty())
            assertTrue(fixture.engine.read(tree) { it.firstPullComplete() })
        }
    }

    @Test fun governingDeleteRemovesAutomaticTreeSubscriptionsAfterReconcile() {
        Fixture().use { fixture ->
            val id = RecordID("b_00000001")
            fixture.engine.commit(product, Gesture(listOf(Change.create("board", NewID.Given(id)))))
            val scopes = fixture.engine.subscriptions(listOf("probe"))
            assertEquals(setOf(product, ScopeRef.tree(id.string!!), ScopeRef.overlay(id.string!!)), scopes)
            fixture.engine.reconcile(scopes)
            fixture.engine.commit(product, Gesture(listOf(Change.delete("board", id))))
            assertEquals(setOf(product), fixture.engine.subscriptions(listOf("probe")))
        }
    }

    @Test fun staleHelloUpgradeStillStopsTheReauthenticatedClientWithoutPausingIt() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val answer = CompletableDeferred<Reply<SyncResponse>>()
            fixture.transport.helloAnswer = answer
            val hello = async { fixture.runtime.hello("token:A") }
            withTimeout(2_000) { fixture.transport.hellos.receive() }
            fixture.runtime.reauthenticate("token:A-new")
            answer.complete(Reply.Failed(SyncResponse(426)))
            hello.await()
            assertTrue(fixture.runtime.upgradeRequired)
            assertFalse(fixture.engine.device.current().meta.member("authPaused").bool())
            assertFalse(fixture.runtime.senderStep(leaving = true))
            assertEquals("ready", fixture.engine.device.current().entries().single().state)
        }
    }

    @Test fun stalePushUpgradeStopsNewAccountWithoutApplyingOldResults() = runBlocking {
        Fixture().use { fixture ->
            fixture.create()
            val send = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            fixture.engine.signOut("keep")
            fixture.tokens.save("B", "token:B"); fixture.engine.signIn("B", mapOf("probe" to false))
            fixture.create()
            val before = fixture.engine.device.current().json()
            request.answer.complete(Reply.Failed(SyncResponse(426)))
            assertFalse(send.await())
            assertTrue(fixture.runtime.upgradeRequired)
            assertEquals(before, fixture.engine.device.current().json())
            assertFalse(fixture.runtime.senderStep(leaving = true))
        }
    }

    @Test fun stalePullUpgradeStopsNewAccountWithoutApplyingOldPages() = runBlocking {
        Fixture().use { fixture ->
            fixture.transport.controlPulls = true
            fixture.runtime.enter()
            val request = fixture.pull()
            fixture.engine.signOut("keep")
            fixture.tokens.save("B", "token:B"); fixture.engine.signIn("B", mapOf("probe" to false))
            val before = fixture.engine.device.current().json()
            request.answer.complete(Reply.Failed(SyncResponse(426)))
            until { fixture.runtime.upgradeRequired }
            assertEquals(before, fixture.engine.device.current().json())
            assertFalse(fixture.runtime.pullerStep())
        }
    }

    @Test fun injectedRequestDeadlineCancelsStalledPushAndPreservesItsExactRetry() = runBlocking {
        val elapsed = CompletableDeferred<Unit>()
        val sleeper = object : EngineSleeper {
            override suspend fun sleep(ms: Long) { if (ms == Constants.REQUEST_TIMEOUT_MS.toLong()) elapsed.await() else awaitCancellation() }
        }
        Fixture(sleeper = sleeper).use { fixture ->
            fixture.create()
            val sending = async { fixture.runtime.senderStep(leaving = true) }
            val request = fixture.push()
            val numbered = fixture.engine.device.current().entries().single().json
            elapsed.complete(Unit)
            assertTrue(withTimeout(2_000) { sending.await() })
            withTimeout(2_000) { request.cancelled.await() }
            assertEquals(numbered, fixture.engine.device.current().entries().single().json)
            assertEquals(0, fixture.transport.activePushes.get())
        }
    }

    @Test fun helloFailuresUseLifecycleCodesAndKeepTheDurablePendingSignIn() = runBlocking {
        for ((status, code) in listOf(401 to EngineError.Code.unauthenticated,
            503 to EngineError.Code.unreachable, 426 to EngineError.Code.upgradeRequired)) {
            Fixture(bound = false).use { fixture ->
                fixture.transport.helloAnswer = CompletableDeferred(Reply.Failed(SyncResponse(status)))
                val failure = runCatching { fixture.runtime.signIn("A", "token:A") }.exceptionOrNull()
                assertTrue("$status", failure is EngineError)
                assertEquals(code, (failure as EngineError).code)
                assertEquals("anon", fixture.engine.device.current().state)
                assertEquals(Json.of("A"), fixture.engine.device.meta.member("pendingSignIn").member("account"))
                assertEquals("token:A", fixture.tokens.token("A"))
            }
        }
    }

    @Test fun beginningSignInReleasesUndoBeforeTheHelloEvenWhenTheHelloNeverAnswers() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create(held = true)
            assertEquals(1, fixture.engine.undoOffers().size)
            fixture.transport.helloAnswer = CompletableDeferred()
            val pending = async { fixture.runtime.signIn("A", "token:A") }
            withTimeout(2_000) { fixture.transport.hellos.receive() }
            assertTrue(fixture.engine.undoOffers().isEmpty())
            assertEquals("ready", fixture.engine.device.current().entries().single().state)
            assertEquals(Json.of("A"), fixture.engine.device.meta.member("pendingSignIn").member("account"))
            pending.cancelAndJoin()
            assertEquals("ready", fixture.engine.device.current().entries().single().state)
        }
    }

    @Test fun pendingSignInResumesWithItsSavedTokenAfterAnUnreachableHello() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            val work = fixture.engine.device.current().entries().single().json
            fixture.transport.helloAnswer = CompletableDeferred(Reply.Unreachable)
            val failure = runCatching { fixture.runtime.signIn("A", "token:A") }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.unreachable, failure.code)
            fixture.transport.helloAnswer = null
            assertTrue(fixture.runtime.resumeSignIn()!!.isComplete)
            assertEquals("A", fixture.engine.device.current().account)
            assertEquals(work.with("lineage" to Json.of("A")), fixture.engine.device.current().entries().single().json)
            assertNull(fixture.engine.device.meta["pendingSignIn"])
            assertNull(fixture.runtime.resumeSignIn())
        }
    }

    @Test fun replacedPendingSignInRejectsItsLateHelloWithoutChangingTheNewAccount() = runBlocking {
        Fixture(bound = false).use { fixture ->
            val first = CompletableDeferred<Reply<SyncResponse>>()
            val second = CompletableDeferred<Reply<SyncResponse>>()
            fun hello(account: String) = Reply.Answer(SyncResponse(200, Json.objectOf("serverTime" to Json.of(5_000),
                "epoch" to Json.of("ep-1"), "as" to Json.of(account), "schema" to Json.of(2), "minSchema" to Json.of(2),
                "holdsRecords" to Json.objectOf("probe" to Json.of(false)))))
            fixture.transport.helloAnswer = first
            val old = async { runCatching { fixture.runtime.signIn("A", "token:A") } }
            assertEquals("token:A", withTimeout(2_000) { fixture.transport.hellos.receive() })
            fixture.transport.helloAnswer = second
            val replacement = async { fixture.runtime.signIn("B", "token:B") }
            assertEquals("token:B", withTimeout(2_000) { fixture.transport.hellos.receive() })
            second.complete(hello("B")); assertTrue(replacement.await().isComplete)
            val before = fixture.engine.device.current().json()
            first.complete(hello("A"))
            val failure = old.await().exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signInEnded, failure.code)
            fun withoutClock(value: Json) = value.with("meta" to value.member("meta").with(
                "clockReading" to null, "offsetSamples" to null, "serverOffsetMs" to null))
            assertEquals(withoutClock(before), withoutClock(fixture.engine.device.current().json()))
            assertEquals("B", fixture.engine.device.current().account)
            assertNull(fixture.tokens.token("A"))
            assertEquals("token:B", fixture.tokens.token("B"))
        }
    }

    @Test fun signInRequiresEveryLineageAnswerAndKeepsItsDecisionUntilAnswered() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create(held = true)
            fixture.transport.holdsRecords = true
            val session = fixture.runtime.signIn("A", "token:A")
            assertFalse(session.isComplete)
            assertEquals(mapOf("card" to 1), session.decisions.single().count)
            assertEquals("ready", fixture.engine.device.current().entries().single().state)
            val before = fixture.engine.snapshot()
            val failure = runCatching { session.complete(emptyMap()) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.decisionMissing, failure.code)
            assertEquals("probe", failure.product)
            assertEquals(before, fixture.engine.snapshot())
            session.complete(mapOf("probe" to LineageAnswer.add))
            assertTrue(session.isComplete)
            assertEquals("A", fixture.engine.device.current().account)
            assertNull(fixture.engine.device.meta["pendingSignIn"])
        }
    }

    @Test fun changedSignInCountRequiresANewSessionBeforeItsLineageAnswerCanApply() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            fixture.transport.holdsRecords = true
            val old = fixture.runtime.signIn("A", "token:A")
            fixture.engine.commit(product, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0002")),
                mapOf("title" to Json.of("Second"))))))
            val before = fixture.engine.snapshot()
            val changed = runCatching { old.complete(mapOf("probe" to LineageAnswer.add)) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signInChanged, changed.code)
            assertFalse(old.isComplete)
            assertEquals(before, fixture.engine.snapshot())
            val resumed = fixture.runtime.resumeSignIn()!!
            assertEquals(mapOf("card" to 2), resumed.decisions.single().count)
            resumed.complete(mapOf("probe" to LineageAnswer.add))
            assertTrue(resumed.isComplete)
            assertEquals(listOf("A", "A"), fixture.engine.device.current().entries().map { it.json.member("lineage").str() })
            val ended = runCatching { old.complete(mapOf("probe" to LineageAnswer.discard)) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signInEnded, ended.code)
            assertEquals(2, fixture.engine.device.current().entries().size)
        }
    }

    @Test fun cancelledSignInLeavesItsDurablePendingAccountAndCredentialForResume() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            fixture.transport.holdsRecords = true
            val cancelled = fixture.runtime.signIn("A", "token:A")
            val before = fixture.engine.snapshot()
            cancelled.cancel()
            assertEquals(before, fixture.engine.snapshot())
            assertEquals("token:A", fixture.tokens.token("A"))
            val ended = runCatching { cancelled.complete(mapOf("probe" to LineageAnswer.add)) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signInEnded, ended.code)
            val resumed = fixture.runtime.resumeSignIn()!!
            resumed.complete(mapOf("probe" to LineageAnswer.discard))
            assertTrue(resumed.isComplete)
            assertEquals("A", fixture.engine.device.current().account)
            assertTrue(fixture.engine.device.current().entries().isEmpty())
            assertNull(fixture.engine.device.meta["pendingSignIn"])
        }
    }

    @Test fun abandoningAnAppSignInClearsItsResumeCredentialAndKeepsAnonymousWork() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            fixture.transport.holdsRecords = true
            val session = fixture.runtime.signIn("A", "token:A")
            val work = fixture.engine.device.current().entries().single().json
            session.cancel()
            assertFalse(fixture.runtime.abandonSignIn("A", "token:A"))
            assertNull(fixture.engine.device.meta["pendingSignIn"])
            assertNull(fixture.tokens.token("A"))
            assertNull(fixture.runtime.resumeSignIn())
            assertEquals("anon", fixture.engine.device.current().state)
            assertEquals(work, fixture.engine.device.current().entries().single().json)
        }
    }

    @Test fun anAbandonedStalledHelloCannotSelectItsAccountWhenItEventuallyAnswers() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            val answer = CompletableDeferred<Reply<SyncResponse>>()
            fixture.transport.helloAnswer = answer
            val pending = async { runCatching { fixture.runtime.signIn("A", "token:A") } }
            assertEquals("token:A", withTimeout(2_000) { fixture.transport.hellos.receive() })
            val work = fixture.engine.device.current().entries().single().json
            assertFalse(fixture.runtime.abandonSignIn("A", "token:A"))
            answer.complete(Reply.Answer(SyncResponse(200, Json.objectOf("serverTime" to Json.of(5_000),
                "epoch" to Json.of("ep-1"), "as" to Json.of("A"), "schema" to Json.of(2), "minSchema" to Json.of(2),
                "holdsRecords" to Json.objectOf("probe" to Json.of(false))))))
            assertEquals(EngineError.Code.signInEnded, (pending.await().exceptionOrNull() as EngineError).code)
            assertEquals("anon", fixture.engine.device.current().state)
            assertEquals(work, fixture.engine.device.current().entries().single().json)
        }
    }

    @Test fun abandoningAnOldTokenCannotCancelANewerAttemptForTheSameAccount() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            fixture.transport.holdsRecords = true
            fixture.runtime.signIn("A", "token:A")
            fixture.tokens.save("A", "replacement:A")
            val before = fixture.engine.snapshot()
            assertFalse(fixture.runtime.abandonSignIn("A", "token:A"))
            assertEquals(before, fixture.engine.snapshot())
            assertEquals("replacement:A", fixture.tokens.token("A"))
            assertEquals(Json.of("A"), fixture.engine.device.meta.member("pendingSignIn").member("account"))
        }
    }

    @Test fun aCompletedSignInWinsALateAppCancellationAndKeepsItsCredential() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            fixture.transport.holdsRecords = true
            val session = fixture.runtime.signIn("A", "token:A")
            session.complete(mapOf("probe" to LineageAnswer.add))
            val before = fixture.engine.snapshot()
            assertTrue(fixture.runtime.abandonSignIn("A", "token:A"))
            assertEquals(before, fixture.engine.snapshot())
            assertEquals("token:A", fixture.tokens.token("A"))
            assertEquals("A", fixture.engine.device.current().account)
        }
    }

    @Test fun failedCredentialDeletionDoesNotResumeAnAbandonedSignInOrLoseItsWork() = runBlocking {
        Fixture(bound = false).use { fixture ->
            fixture.create()
            fixture.transport.holdsRecords = true
            fixture.runtime.signIn("A", "token:A")
            val work = fixture.engine.device.current().entries().single().json
            fixture.tokens.failDelete = true
            assertNotNull(runCatching { fixture.runtime.abandonSignIn("A", "token:A") }.exceptionOrNull())
            assertNull(fixture.engine.device.meta["pendingSignIn"])
            assertEquals("anon", fixture.engine.device.current().state)
            assertEquals(work, fixture.engine.device.current().entries().single().json)
            fixture.tokens.failDelete = false
            assertFalse(fixture.runtime.abandonSignIn("A", "token:A"))
            assertNull(fixture.tokens.token("A"))
        }
    }

    @Test fun replacedSignOutCannotFinishOrCancelTheNewSessionsSenderHold() = runBlocking {
        Fixture().use { fixture ->
            val replaced = fixture.runtime.signOut()
            assertEquals(0, replaced.unsent)
            fixture.create()
            val current = fixture.runtime.signOut()
            assertEquals(1, current.ready)
            val ended = runCatching { replaced.finish(SignOutChoice.keep) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signOutEnded, ended.code)
            replaced.cancel()
            assertFalse(fixture.runtime.senderStep(leaving = true))
            assertTrue(fixture.transport.pushes.tryReceive().isFailure)
            assertEquals("A", fixture.engine.device.current().account)
            assertTrue(current.finish(SignOutChoice.keep).member("complete").bool())
            assertEquals(listOf(DormantReplica("A", ready = 1, sent = 0, pending = 0)), fixture.engine.dormantReplicas())
            assertEquals("anon", fixture.engine.device.current().state)
            assertTrue(fixture.engine.discardDormant("A"))
            assertFalse(fixture.engine.discardDormant("A"))
            assertTrue(fixture.engine.dormantReplicas().isEmpty())
        }
    }

    @Test fun changedPendingDeviceValueRejectsDiscardUntilItIsCountedAgain() = runBlocking {
        Fixture(pendingDeviceWork = { _, rows -> rows.keys.toList() }).use { fixture ->
            fixture.engine.commit(product, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.objectOf("revision" to Json.of(1))))))
            val old = fixture.runtime.signOut()
            assertEquals(1, old.pending)
            assertEquals(1, old.unsent)
            fixture.engine.commit(product, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.objectOf("revision" to Json.of(2))))))
            val before = fixture.engine.snapshot()
            val changed = runCatching { old.finish(SignOutChoice.discard) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signOutChanged, changed.code)
            assertEquals(1, changed.pending)
            assertEquals(before, fixture.engine.snapshot())
            val current = fixture.runtime.signOut()
            assertTrue(current.finish(SignOutChoice.discard).member("complete").bool())
            assertNull(fixture.tokens.token("A"))
            assertTrue(fixture.engine.device.replicas.none { it.account == "A" })
            assertEquals("anon", fixture.engine.device.current().state)
        }
    }
    @Test fun reidentificationWhileSignOutIsOpenKeepsItsHoldAndAllowsKeep() = runBlocking {
        Fixture().use { fixture ->
            fixture.runtime.connectivity(false)
            fixture.create()
            val session = fixture.runtime.signOut()
            val replica = fixture.engine.activeReplica()
            fixture.engine.reidentify()
            assertNotEquals(replica, fixture.engine.activeReplica())
            assertEquals(1, session.ready)
            assertTrue(session.finish(SignOutChoice.keep).member("complete").bool())
            assertEquals("anon", fixture.engine.device.current().state)
            assertEquals(1, fixture.engine.dormantReplicas().single().ready)
        }
    }

    @Test fun dueDoubtKeepsItsDeadlineUntilAPullActuallyStartsAndReschedulesOnFailure() {
        val doubts = Doubts()
        val tree = ScopeRef.tree("b_00000001")
        doubts.end(tree, 100) { 20 }
        assertEquals(emptyList<ScopeRef>(), doubts.due(119))
        assertEquals(listOf(tree), doubts.due(120))
        assertEquals(listOf(tree), doubts.due(130))
        doubts.pulling(tree)
        assertTrue(doubts.due(130).isEmpty())
        doubts.repulled(tree, 140) { 40 }
        assertEquals(listOf(tree), doubts.due(180))
    }

    @Test fun rowsEndingDoubtRestartTheFollowedStretchBeforeItsBackoffCanReset() {
        val doubts = Doubts()
        val tree = ScopeRef.tree("b_00000001")
        doubts.followed(tree, 0)
        val bounds = mutableListOf<Int>()
        val draw: (Int) -> Int = { bound -> bounds.add(bound); 0 }
        doubts.end(tree, 10, draw)
        doubts.rows(tree, 20)
        doubts.end(tree, 30, draw)
        doubts.rows(tree, 40)
        doubts.unfollowed(tree, 30_040)
        doubts.end(tree, 30_050, draw)
        assertEquals(listOf(1_000, 2_000, 1_000), bounds)
    }

    @Test fun scheduledDoubtRepullPullsItsScopeAloneBesideOtherSubscribedScopes() = runBlocking {
        Fixture().use { fixture ->
            val tree = ScopeRef.tree("b_00000001")
            fixture.engine.subscribe(tree)
            fixture.engine.lock.withLock { fixture.engine.doubts.end(tree, fixture.clock.wall, fixture.engine::draw) }
            fixture.transport.controlPulls = true
            fixture.runtime.enter()
            val ordinary = fixture.pull()
            assertEquals(listOf(product.text), ordinary.request.member("scopes").arr().map { it.member("scope").str() })
            ordinary.answer.complete(Reply.Unreachable)
            val repull = fixture.pull()
            assertEquals(listOf(tree.text), repull.request.member("scopes").arr().map { it.member("scope").str() })
            repull.answer.complete(Reply.Unreachable)
            Unit
        }
    }

}
