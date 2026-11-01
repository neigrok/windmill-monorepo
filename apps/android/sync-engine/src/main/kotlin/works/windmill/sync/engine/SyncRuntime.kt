package works.windmill.sync.engine

import kotlin.concurrent.withLock
import kotlinx.coroutines.*
import works.windmill.sync.api.CommitFailure
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.sync.core.*

interface SessionTokens {
    fun token(account: String): String?
    fun save(account: String, token: String)
    fun delete(account: String)
    fun accounts(): Set<String>
}
interface ForkGuardStore {
    fun load(): String?
    fun save(value: String)
}
interface EngineSleeper { suspend fun sleep(ms: Long) }
// How the pulls of `replica` stand: `sent` numbers the pulls asked of the server and `ended` counts those that ended;
// `caughtUp` is the number of the latest one that landed with every scope it named caught up; `failed` says the latest
// to end did not land, and `blocked` that no pull can be attempted now.
data class Pulls(val replica: String? = null, val sent: Long = 0, val ended: Long = 0, val caughtUp: Long = 0,
    val failed: Boolean = false, val blocked: Boolean = false) {
    fun of(replica: String): Pulls = if (replica == this.replica) this else Pulls(replica, blocked = blocked)
    fun sending(replica: String): Pulls = of(replica).let { it.copy(sent = it.sent + 1) }
    fun ending(replica: String, number: Long, landed: Boolean, caughtUp: Boolean): Pulls = if (replica != this.replica) this else
        copy(ended = ended + 1, failed = !landed, caughtUp = if (caughtUp) maxOf(this.caughtUp, number) else this.caughtUp)
    // Nothing more is coming for a reader who asked at `asked`: no pull can run, or the latest failed with none in flight
    // and ended after the ask.
    fun stalled(asked: Pulls?): Boolean = blocked ||
        failed && sent == ended && (asked == null || asked.replica != replica || ended > asked.ended)
}
object CoroutineSleeper : EngineSleeper { override suspend fun sleep(ms: Long) { delay(ms) } }

class SyncRuntime(private val engine: Engine, private val transport: SyncTransport, private val tokens: SessionTokens,
    private val appVersion: String, private val sleeper: EngineSleeper = CoroutineSleeper,
    private val products: List<String> = listOf("gym"), private val liveHint: () -> Boolean = { false },
    private val activityAllowed: () -> Boolean = { true },
    private val signOutDrainAllowed: () -> Boolean = activityAllowed) : AutoCloseable {
    private data class Seat(val replica: String, val account: String?, val token: String?)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val senderTurn = Mutex()
    private val pullerTurn = Mutex()
    private val liveTurn = Mutex()
    private val signInTurn = Mutex()
    private val senderWake = Channel<Unit>(Channel.CONFLATED)
    private val pullerWake = Channel<Unit>(Channel.CONFLATED)
    private val liveWake = Channel<Unit>(Channel.CONFLATED)
    private val wait = SenderWait()
    private val helloWait = SenderWait()
    // §7.5 the live socket's reopen backoff: its own `k` and the 30 s ceiling, stepped only by the live worker. A wake from a pull or a
    // frame never cuts it short. A close the client made, a return to the foreground or the network, or a socket nobody wanted (no seat)
    // opens at once when wanted, keeping `k`; a re-authentication opens it at once from k = 0.
    private val liveWait = SenderWait()
    private val liveReauthenticated = java.util.concurrent.atomic.AtomicBoolean()
    private val liveClosedByClient = java.util.concurrent.atomic.AtomicReference<LiveConnection?>()
    // How a live step ended (§7.5): `refused` an open that failed and `dropped` a socket the server or the network ended,
    // both reconnects; `closed` a close the client made, or a step that opened nothing because no socket is wanted.
    private enum class LiveEnd { refused, dropped, closed }
    private val heldWake = Channel<Unit>(Channel.CONFLATED)
    private val pullWaits = mutableMapOf<ScopeRef, SenderWait>()
    @Volatile private var pullFloor = 0L
    private val nextPull = mutableMapOf<ScopeRef, Long>()
    private val pullWanted = java.util.concurrent.ConcurrentHashMap.newKeySet<ScopeRef>()
    @Volatile private var foreground = false
    @Volatile private var online = true
    @Volatile private var closed = false
    @Volatile private var readinessGeneration = 0L
    @Volatile var upgradeRequired = false; private set
    private val endedPulls = MutableStateFlow(Pulls())
    val pulls: StateFlow<Pulls> = endedPulls.asStateFlow()
    @Volatile private var socket: LiveConnection? = null
    private var socketOpenedAt: Long? = null
    @Volatile private var signOutHold: String? = null
    @Volatile private var activePush: Job? = null
    private var launched = false
    private var pushLimit = Constants.PUSH_MAX_INTENTS
    private var conflicts = 0
    private var signOutSerial = 0L
    private fun mono() = engine.clock.reading().mono
    private fun seat(): Seat? {
        val selected = engine.lock.withLock {
            if (engine.closed) return@withLock null
            val replica = engine.device.current()
            if (replica.state != "bound" || replica.meta.flag("authPaused") || upgradeRequired) return@withLock null
            replica.id to (replica.account ?: return@withLock null)
        } ?: return null
        val token = storageIO { tokens.token(selected.second) }
        if (token == null) {
            engine.write(EngineOperation.lifecycle) { replica ->
                if (replica.id == selected.first && replica.account == selected.second) replica.meta = replica.meta.with("authPaused" to Json.of(true))
            }
            return null
        }
        return Seat(selected.first, selected.second, token)
    }
    private fun pullSeat(): Seat? {
        val selected = engine.lock.withLock {
            if (engine.closed || upgradeRequired) return@withLock null
            val replica = engine.device.current()
            if (replica.meta.flag("authPaused")) return@withLock null
            replica.id to replica.account
        } ?: return null
        return if (selected.second == null) Seat(selected.first, null, null) else seat()
    }
    private fun current(seat: Seat) = pullSeat() == seat
    private suspend fun wait(wake: Channel<Unit>, ms: Long) = coroutineScope {
        val timer = async { sleeper.sleep(ms.coerceAtLeast(1)) }
        val kicked = async { wake.receiveCatching() }
        try { kotlinx.coroutines.selects.select<Unit> { timer.onAwait { }; kicked.onAwait { } } }
        finally { timer.cancel(); kicked.cancel() }
    }
    private suspend fun <T> deadline(ms: Long, body: suspend () -> T): T? = coroutineScope {
        val task = async { body() }
        val timer = async { sleeper.sleep(ms) }
        try { kotlinx.coroutines.selects.select<T?> { task.onAwait { it }; timer.onAwait { null } } }
        finally { task.cancel(); timer.cancel() }
    }
    private fun wakeAll() { senderWake.trySend(Unit); pullerWake.trySend(Unit); liveWake.trySend(Unit) }
    // Set before the old token's socket closes, so the live worker resets `k` once that close has ended its step.
    private fun reopenLiveFresh() { liveReauthenticated.set(true); liveWake.trySend(Unit) }
    // §7.5 a close the client makes: its socket's end pulls nothing and raises no backoff.
    private fun closeLive() { socket?.let { open -> liveClosedByClient.set(open); open.close() }; socket = null }
    private fun liveWanted() = activityAllowed() && foreground && online && seat() != null
    private fun launchWorker(operation: EngineOperation, body: suspend CoroutineScope.() -> Unit) = scope.launch {
        try { body() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            // Cancellation cannot interrupt synchronous work already running when the engine closes.
            if (failure is CommitFailure && failure.kind == CommitFailure.Kind.notWritable &&
                failure.description == "closed" && engine.lock.withLock { engine.closed }) close()
            else engine.report(operation, EngineOutcome.failure)
        }
    }
    init {
        launchWorker(EngineOperation.sync) { engine.changes.collect { change ->
            if (change.version == Long.MIN_VALUE) { close(); return@collect }
            heldWake.trySend(Unit)
            when (change.operation) {
                EngineOperation.commit, EngineOperation.undo, EngineOperation.release, EngineOperation.lifecycle, EngineOperation.subscription -> {
                    senderTurn.withLock { wait.kick(mono()) }; senderWake.trySend(Unit)
                    engine.subscriptions(products).forEach(pullWanted::add); pullerWake.trySend(Unit); liveWake.trySend(Unit)
                }
                EngineOperation.push -> { engine.subscriptions(products).forEach(pullWanted::add); pullerWake.trySend(Unit) }
                EngineOperation.pull, EngineOperation.live -> liveWake.trySend(Unit)
                else -> Unit
            }
        } }
        launchWorker(EngineOperation.release) {
            while (isActive && !closed) {
                try {
                    if (!activityAllowed()) { wait(heldWake, 1_000); continue }
                    val due = engine.lock.withLock { engine.device.current().entries().filter { it.state == "held" }.minOfOrNull { it.json.member("releaseAt").long() } }
                    if (due == null) { heldWake.receiveCatching(); continue }
                    val remaining = due - engine.clock.now()
                    if (remaining > 0) wait(heldWake, remaining) else engine.lock.withLock { if (activityAllowed()) engine.releaseHeld() }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: CommitFailure) {
                    if (failure.kind != CommitFailure.Kind.storeFailure) throw failure
                    sleeper.sleep(Constants.BACKOFF_BASE_MS)
                }
            }
        }
        launchWorker(EngineOperation.storage) {
            while (isActive && !closed) {
                try { while (engine.lock.withLock { activityAllowed() && engine.sweepReleased() }) { yield() } }
                catch (cancelled: CancellationException) { if (!isActive) throw cancelled }
                catch (_: Exception) { engine.report(EngineOperation.storage, EngineOutcome.failure) }
                sleeper.sleep(1_000)
            }
        }
        launchWorker(EngineOperation.push) { while (isActive && !closed) {
            try { if (activityAllowed() && foreground && online) senderStep() }
            catch (cancelled: CancellationException) { if (!isActive) throw cancelled }
            catch (_: Exception) { engine.report(EngineOperation.push, EngineOutcome.failure) }
            wait(senderWake, 1_000)
        } }
        launchWorker(EngineOperation.pull) { while (isActive && !closed) {
            try { publishPullable(); if (activityAllowed() && foreground && online) pullerStep() }
            catch (cancelled: CancellationException) { if (!isActive) throw cancelled }
            catch (_: Exception) { engine.report(EngineOperation.pull, EngineOutcome.failure) }
            wait(pullerWake, 1_000)
        } }
        launchWorker(EngineOperation.live) { var readiness = readinessGeneration; var reopenNow = false; var faulted = false
            while (isActive && !closed) {
                try {
                    if (readinessGeneration != readiness) { readiness = readinessGeneration; reopenNow = true }
                    if (!liveWanted()) { faulted = false; reopenNow = true; closeLive(); wait(liveWake, 30_000); continue }
                    faulted = false
                    if (liveReauthenticated.getAndSet(false)) liveWait.kick(mono()) else if (reopenNow) liveWait.ask(mono())
                    reopenNow = false
                    val pause = liveWait.until - mono()
                    if (pause > 0) { wait(liveWake, pause); continue }
                    val end = liveStep()
                    // §7.5: a socket that stayed open 30 s resets the reopen backoff, however it ended.
                    if (socketOpenedAt?.let { mono() - it >= 30_000 } == true) liveWait.kick(mono())
                    socketOpenedAt = null
                    // §7.5: a close the client made pulls nothing, and a socket still wanted opens again at once. A failed open or
                    // an ended socket is a reconnect: the puller runs at once, and the next open waits out the backoff.
                    if (end == LiveEnd.closed || !liveWanted()) { liveWait.ask(mono()); continue }
                    engine.subscriptions(products).forEach(pullWanted::add); pullerWake.trySend(Unit)
                    liveWait.backoff(mono(), engine::draw, liveHint = true)
                    wait(liveWake, liveWait.until - mono())
                } catch (cancelled: CancellationException) { if (!isActive) break }
                catch (_: Exception) {
                    // The seat could not be read (its token's storage, the replica): reported once a run, then the whole backoff,
                    // which no wake cuts short.
                    if (!faulted) engine.report(EngineOperation.live, EngineOutcome.failure)
                    faulted = true
                    liveWait.backoff(mono(), engine::draw, liveHint = true)
                    while (isActive && liveWait.until > mono()) wait(liveWake, liveWait.until - mono())
                }
            }
            closeLive()
        }
    }
    private fun <T> storageIO(body: () -> T): T = try { body() }
        catch (failure: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure); throw failure }
    // §9.6 426 upgrade-required: nothing more is sent or pulled until the app is upgraded; the status says so.
    private fun requireUpgrade() { upgradeRequired = true; engine.networkStatus(upgradeRequired = true) }
    @Synchronized fun launch(forkGuard: ForkGuardStore) {
        if (launched || !activityAllowed()) return
        val copy = storageIO { forkGuard.load() }
        val started = engine.lock.withLock {
            if (!activityAllowed()) return
            engine.start(copy?.let(Json::of) ?: Json.Null)
        }
        val guard = engine.lock.withLock { engine.device.meta.member("forkGuard").str() }
        if (guard != copy) storageIO { forkGuard.save(guard) }
        val needed = engine.lock.withLock {
            val replica = engine.device.current()
            setOfNotNull(if (replica.state == "bound") replica.account else null, started["pendingSignIn"]?.get("account")?.str())
        }
        storageIO { tokens.accounts() }.filter { it !in needed }.forEach { if (!activityAllowed()) return; try { tokens.delete(it) } catch (_: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure) } }
        val activeAccount = engine.lock.withLock { engine.device.current().takeIf { it.state == "bound" }?.account }
        val missing = activeAccount != null && storageIO { tokens.token(activeAccount) } == null
        if (missing) engine.write(EngineOperation.lifecycle) { replica ->
            if (replica.account == activeAccount) replica.meta = replica.meta.with("authPaused" to Json.of(true))
        }
        launched = true
    }
    fun enter() {
        if (!activityAllowed()) return
        heldWake.trySend(Unit)
        engine.lock.withLock { if (!foreground) { foreground = true; readinessGeneration++ } }
        launchWorker(EngineOperation.sync) { senderTurn.withLock { wait.kick(mono()) }; engine.subscriptions(products).forEach(pullWanted::add); wakeAll() }
    }
    fun connectivity(online: Boolean) {
        if (!activityAllowed()) return
        heldWake.trySend(Unit)
        val reconnected = engine.lock.withLock {
            val reconnected = online && !this.online
            if (this.online != online) readinessGeneration++
            this.online = online
            reconnected
        }
        engine.networkStatus(online = online)
        if (!online) closeLive()
        if (reconnected) launchWorker(EngineOperation.hello) {
            val account = engine.lock.withLock { engine.device.current().takeIf { it.state == "bound" }?.account }
            account?.let { storageIO { tokens.token(it) } }?.let { hello(it, activityAllowed) }
        }
        launchWorker(EngineOperation.sync) { senderTurn.withLock { wait.kick(mono()) }; engine.subscriptions(products).forEach(pullWanted::add); wakeAll() }
    }
    // A person asked for the account's copy again: each subscribed scope pulls once now, with no seat to pull as nothing
    // is asked, and a failure steps the backoff on from where it stood. A retry-after still holds.
    suspend fun pullAgain(): Boolean {
        if (!pulling() || pullSeat() == null) return false
        pullerTurn.withLock {
            engine.subscriptions(products).forEach { target -> pullWaits.getOrPut(target, ::SenderWait).ask(mono()); pullWanted.add(target) }
        }
        pullerWake.trySend(Unit)
        return true
    }
    suspend fun leave() {
        engine.lock.withLock { if (foreground) { foreground = false; readinessGeneration++ } }
        closeLive()
        engine.lock.withLock { if (activityAllowed()) engine.releaseHeld(true) }
        if (online && wait.leaveMayPush(mono())) deadline(2_000) { senderStep(leaving = true) }
        wakeAll()
    }
    suspend fun hello(token: String?): Reply<SyncResponse> = hello(token) { true }
    private suspend fun hello(token: String?, allowed: () -> Boolean): Reply<SyncResponse> {
        if (!allowed()) return Reply.Unreachable
        val sentFor = engine.lock.withLock { engine.device.current().let { it.id to it.account } }
        val send = engine.clock.reading(); val reply = deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.hello(token) } ?: Reply.Unreachable; val recv = engine.clock.reading()
        if (!allowed()) return reply
        val response = reply.answer
        if (response != null) {
            val sameReplica = engine.lock.withLock { engine.device.current().let { it.id == sentFor.first && it.account == sentFor.second } }
            val sameToken = sentFor.second == null || storageIO { tokens.token(sentFor.second!!) } == token
            if (sameReplica && sameToken) engine.lock.withLock {
                val active = engine.device.current()
                if (allowed() && active.id == sentFor.first && active.account == sentFor.second) {
                    engine.onHello(response, RequestTiming(send, recv))
                    engine.write(EngineOperation.hello) { replica ->
                        if (response.unauthenticated(replica.account)) replica.meta = replica.meta.with("serverSchema" to null)
                        else if (response.status == 200 && replica.account != null && response.body?.get("as") == Json.of(replica.account!!))
                            response.body["schema"]?.let { replica.meta = replica.meta.with("serverSchema" to it) }
                    }
                }
            }
            else response.body?.get("serverTime")?.let { time -> engine.write(EngineOperation.hello) { engine.offset(it, time.long(), RequestTiming(send, recv)) } }
            if (response.requiresUpgrade || response.body?.get("minSchema")?.long()?.let { it > engine.registry.version } == true) requireUpgrade()
        }
        return reply
    }
    suspend fun signIn(account: String, token: String): SignInSession {
        val alreadyBound = signInTurn.withLock {
            engine.lock.withLock { val active = engine.device.current(); if (active.state == "bound" && active.account != account) throw EngineError(EngineError.Code.signedIn, active.account) }
            storageIO { tokens.save(account, token) }
            val bound = engine.lock.withLock { engine.device.current().let { it.state == "bound" && it.account == account } }
            if (!bound) {
                val replaced = engine.lock.withLock { engine.device.meta["pendingSignIn"]?.get("account")?.str() }
                engine.write(EngineOperation.lifecycle) { replica ->
                    if (replica.state == "bound") throw EngineError(EngineError.Code.signedIn, replica.account)
                    replica.entries().filter { it.state == "held" }.forEach { replica.move(it, "release", engine.ended) }
                    engine.device.meta = engine.device.meta.with("pendingSignIn" to Json.objectOf("account" to Json.of(account)))
                }
                if (replaced != null && replaced != account) try { tokens.delete(replaced) } catch (_: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure) }
            }
            bound
        }
        if (alreadyBound) {
            engine.reauthenticate(); reopenLiveFresh(); closeLive(); wakeAll()
            launchWorker(EngineOperation.hello) { hello(token) }
            return SignInSession(this, account, emptyMap(), Json.objectOf("complete" to Json.of(true), "due" to Json.array()))
        }
        return continueSignIn(account, token)
    }
    suspend fun resumeSignIn(): SignInSession? {
        val account = engine.lock.withLock { engine.device.meta["pendingSignIn"]?.get("account")?.str() } ?: return null
        val token = storageIO { tokens.token(account) } ?: throw EngineError(EngineError.Code.unauthenticated)
        return continueSignIn(account, token)
    }
    private suspend fun continueSignIn(account: String, token: String): SignInSession {
        val reply = hello(token)
        if (storageIO { tokens.token(account) } != token) throw EngineError(EngineError.Code.signInEnded)
        val response = reply.answer ?: throw EngineError(EngineError.Code.unreachable)
        if (upgradeRequired) throw EngineError(EngineError.Code.upgradeRequired)
        if (response.status == 401) throw EngineError(EngineError.Code.unauthenticated)
        if (response.status != 200) throw EngineError(EngineError.Code.unreachable)
        if (response.body?.get("as") != Json.of(account) || response.body["holdsRecords"] == null) throw EngineError(EngineError.Code.unauthenticated)
        val holds = response.body.member("holdsRecords").obj().mapValues { it.value.bool() }
        val serverSchema = response.body.member("schema").long()
        val result = engine.lock.withLock {
            if (engine.device.meta["pendingSignIn"]?.get("account") != Json.of(account)) throw EngineError(EngineError.Code.signInEnded)
            engine.signIn(account, holds, serverSchema = serverSchema)
        }
        closeLive()
        wakeAll(); return SignInSession(this, account, holds, result, serverSchema)
    }
    internal fun finishSignIn(session: SignInSession, answers: Map<String, LineageAnswer>) {
        val result = engine.lock.withLock {
            if (engine.device.meta["pendingSignIn"]?.get("account") != Json.of(session.account)) throw EngineError(EngineError.Code.signInEnded)
            engine.signIn(session.account, session.holdsRecords, answers.mapValues { it.value.name }, session.decisions.associate { it.product to it.counted }, session.serverSchema)
        }
        if (!result.member("complete").bool()) throw EngineError(EngineError.Code.signInChanged)
        closeLive(); wakeAll()
    }
    internal fun cancelSignIn() { engine.report(EngineOperation.lifecycle, EngineOutcome.success) }
    suspend fun abandonSignIn(account: String, token: String): Boolean = signInTurn.withLock {
        val matched = storageIO { tokens.token(account) } == token
        val completed = engine.write(EngineOperation.lifecycle) { active ->
            if (active.state == "bound" && active.account == account) return@write true
            if (matched && engine.device.meta["pendingSignIn"]?.get("account") == Json.of(account))
                engine.device.meta = engine.device.meta.with("pendingSignIn" to null)
            false
        }
        if (matched && !completed) storageIO { tokens.delete(account) }
        wakeAll()
        completed
    }
    suspend fun signOut(): SignOutSession {
        val account = engine.lock.withLock { engine.device.current().account } ?: throw EngineError(EngineError.Code.notSignedIn)
        val alreadyHeld = signOutHold == account
        engine.releaseHeld(true)
        if (!alreadyHeld) deadline(Constants.SIGNOUT_FLUSH_MS.toLong()) {
            var first = true
            while (true) {
                if (!runSenderStep(leaving = first, draining = true)) break
                first = false
                yield()
            }
        }
        val hold = engine.lock.withLock {
            if (engine.device.current().let { it.state != "bound" || it.account != account }) throw EngineError(EngineError.Code.notSignedIn)
            signOutHold = account; ++signOutSerial
        }
        try {
            activePush?.cancel()
            return withTimeout(Constants.SIGNOUT_FLUSH_MS) { senderTurn.withLock {
                engine.lock.withLock {
                    if (signOutHold != account || signOutSerial != hold) throw EngineError(EngineError.Code.signOutEnded)
                    if (engine.device.current().let { it.state != "bound" || it.account != account }) throw EngineError(EngineError.Code.notSignedIn)
                }
                closeLive()
                SignOutSession(this@SyncRuntime, account, hold, engine.signOut()).also { wakeAll() }
            } }
        } catch (failure: Throwable) {
            engine.lock.withLock { if (signOutSerial == hold) { signOutHold = null; signOutSerial++ } }
            wakeAll(); throw failure
        }
    }
    internal suspend fun finishSignOut(session: SignOutSession, choice: SignOutChoice): Json = senderTurn.withLock {
        val result = engine.lock.withLock {
            if (session.hold != signOutSerial || signOutHold != session.account) throw EngineError(EngineError.Code.signOutEnded)
            val active = engine.device.current()
            if (active.state != "bound" || active.account != session.account) throw EngineError(EngineError.Code.signOutEnded)
            val result = engine.signOut(choice.name, session.counted)
            if (result.member("complete").bool()) { signOutHold = null; signOutSerial++ }
            result
        }
        if (!result.member("complete").bool()) throw EngineError(EngineError.Code.signOutChanged,
            ready = result.member("ready").long().toInt(), sent = result.member("sent").long().toInt(), pending = result["pending"]?.long()?.toInt() ?: 0)
        try { tokens.delete(session.account) } catch (_: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure) }
        wakeAll(); result
    }
    internal suspend fun cancelSignOut(session: SignOutSession) = senderTurn.withLock {
        engine.lock.withLock { if (session.hold == signOutSerial) { signOutHold = null; signOutSerial++; wakeAll() } }
        engine.report(EngineOperation.lifecycle, EngineOutcome.success)
    }
    fun reauthenticate(token: String) {
        val account = engine.lock.withLock { engine.device.current().account } ?: throw EngineError(EngineError.Code.notSignedIn)
        storageIO { tokens.save(account, token) }; engine.reauthenticate(); reopenLiveFresh(); closeLive(); launchWorker(EngineOperation.lifecycle) { senderTurn.withLock { wait.kick(mono()) }; wakeAll() }
        launchWorker(EngineOperation.hello) { hello(token) }
    }
    suspend fun senderStep(leaving: Boolean = false): Boolean = runSenderStep(leaving, false)
    private suspend fun runSenderStep(leaving: Boolean, draining: Boolean): Boolean {
        if (closed) return false
        val work = scope.async { senderStepInLane(leaving, draining) }
        try { return work.await() } finally { if (!currentCoroutineContext().isActive) work.cancel() }
    }
    private suspend fun senderStepInLane(leaving: Boolean, draining: Boolean): Boolean = senderTurn.withLock {
        fun admitted() = activityAllowed() || draining && signOutDrainAllowed()
        if (!admitted() || closed || !online || upgradeRequired || !leaving && !draining && !foreground || !leaving && !wait.due(mono()) || leaving && !wait.leaveMayPush(mono())) return@withLock false
        val earlier = if (leaving) wait.snapshot() else null
        try {
            val seat = seat() ?: return@withLock false
            if (signOutHold == seat.account || !helloWait.due(mono())) return@withLock false
            val queued = engine.lock.withLock {
                val replica = engine.device.current()
                val back = engine.heldBack(replica)
                val entries = replica.entries()
                entries.any { it.state == "sent" } || entries.filter { it.state == "ready" }
                    .takeWhile { it !in back || it.intent.command == null }.any { it !in back }
            }
            if (!queued) return@withLock false
            val (epoch, generation) = engine.lock.withLock { engine.device.current().meta["serverEpoch"] to readinessGeneration }
            fun ready() = admitted() && !closed && online && (leaving || draining || foreground) && readinessGeneration == generation
            var response: SyncResponse? = null
            var compatible = false
            var invalidated = false
            try {
                response = hello(seat.token, ::admitted).answer
                if (!current(seat) || !ready()) { invalidated = true; return@withLock false }
                compatible = !upgradeRequired && response?.status == 200 && response.body?.get("as") == Json.of(seat.account!!) &&
                    response.body["schema"]?.long()?.let { it >= engine.registry.minVersion } == true
            } finally {
                if (!compatible && !invalidated) {
                    val now = mono()
                    helloWait.retry(now, Constants.BACKOFF_BASE_MS)
                    if (response?.status == 503) helloWait.unavailable(now,
                        maxOf(Constants.BACKOFF_BASE_MS, response.body?.get("retryAfterMs")?.long() ?: 0), engine::draw)
                    else helloWait.backoff(now, engine::draw)
                }
            }
            if (!compatible) return@withLock false
            helloWait.kick(mono())
            var changedEpoch = false
            val request = engine.lock.withLock {
                if (!current(seat) || !ready()) return@withLock null
                changedEpoch = engine.device.current().meta["serverEpoch"] != epoch
                if (changedEpoch) null else engine.nextPush(pushLimit)
            } ?: run {
                // An epoch learned during the hello needs another hello before numbering, and a pull never wakes the sender.
                if (changedEpoch) senderWake.trySend(Unit)
                return@withLock changedEpoch
            }
            if (!current(seat) || !ready()) return@withLock false
            val send = engine.clock.reading()
            val job = currentCoroutineContext()[Job]
            if (!engine.lock.withLock {
                if (signOutHold == seat.account || !ready()) false else { activePush = job; true }
            }) return@withLock false
            // §7.4 What holds work back: every push's end records its scopes' failure, or clears it; a cancelled push records nothing.
            try {
                val reply = try { deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.push(request, seat.token!!) } ?: Reply.Unreachable }
                    finally { activePush = null }
                takeReply(request, seat, reply, RequestTiming(send, engine.clock.reading()), draining)
                    .also { engine.recordPushFailure(request, reply.pushFailure(seat.account)) }
            } catch (failure: Exception) {
                if (failure !is CancellationException) engine.recordPushFailure(request, PushFailure.answered)
                throw failure
            }
        } finally { if (earlier != null) wait.restoreBackoff(earlier) }
    }
    // §7.4 a push's reply: the server's upgrade stops sending; one the account's newer token did not make applies only its offset; one for a replica no longer active only records its results; otherwise the answer applies and sets the wait before the next push.
    private suspend fun takeReply(request: Json, seat: Seat, reply: Reply<SyncResponse>, timing: RequestTiming, draining: Boolean): Boolean {
        val response = reply.answer?.takeUnless { it.malformedConflict(seat.account) }
        if (response?.requiresUpgrade == true) { requireUpgrade(); return false }
        val stillCurrent = current(seat)
        val suppliedTokenChanged = seat.account?.let { storageIO { tokens.token(it) } }?.let { it != seat.token } == true
        if (suppliedTokenChanged && response?.unauthenticated(seat.account) == true) {
            response.body?.get("serverTime")?.let { time -> engine.write(EngineOperation.push) { engine.device.replicas.firstOrNull { it.id == seat.replica }?.let { original -> engine.offset(original, time.long(), timing) } } }
            return false
        }
        if (!stillCurrent) {
            if (response != null) engine.onPushResponse(request, response, timing)
            return false
        }
        val hint = try { liveHint() } catch (_: Exception) { engine.report(EngineOperation.push, EngineOutcome.failure); false }
        if (response == null) { conflicts = 0; wait.backoff(mono(), engine::draw, hint); return !draining }
        val next = engine.onPushResponse(request, response, timing)
        pushLimit = next?.get("limit")?.long()?.toInt() ?: Constants.PUSH_MAX_INTENTS
        val body = response.body
        conflicts = if (response.status == 409) conflicts + 1 else 0
        val again = when {
            response.status in setOf(400, 413) || response.status == 409 && conflicts == 1 -> true
            response.status == 503 -> { wait.unavailable(mono(), body?.get("retryAfterMs")?.long() ?: 0, engine::draw, hint); false }
            response.status != 200 -> { wait.backoff(mono(), engine::draw, hint); false }
            else -> {
                body?.get("retry")?.let { wait.retry(mono(), it.member("retryAfterMs").long()) }
                val codes = body?.items("results")?.filter { result -> request.member("intents").arr().any { it.member("n") == result.member("n") } }?.map { it["code"]?.str() ?: "ok" }.orEmpty()
                wait.results(codes, mono(), engine::draw, hint)
                if (codes.isEmpty() && body?.get("retry") == null) wait.backoff(mono(), engine::draw, hint)
                codes.isNotEmpty() && "clock-skew" !in codes && body?.get("retry") == null
            }
        }
        return if (draining) again else true
    }
    private fun pulling() = activityAllowed() && !closed && foreground && online && !upgradeRequired
    // Whether a pull could be attempted at all: on the network, no upgrade required, a seat to pull as, and a subscribed
    // scope not stopped at this version's digest. Re-read each turn of the puller and published beside the pulls.
    private fun publishPullable() {
        val replica = engine.lock.withLock { engine.device.current().id }
        val blocked = !activityAllowed() || closed || !online || upgradeRequired || pullSeat() == null ||
            engine.lock.withLock {
                val cursors = engine.device.current().cursors
                engine.subscriptions(products).all { cursors[it.text]?.get("digestStop") == Json.of(appVersion) }
            }
        endedPulls.update { it.of(replica).copy(blocked = blocked) }
    }
    suspend fun pullerStep(): Boolean = pullerTurn.withLock {
        if (!pulling() || mono() < pullFloor) return@withLock false
        val seat = pullSeat() ?: return@withLock false
        val scopes = engine.subscriptions(products)
        engine.reconcile(scopes)
        pullWaits.keys.retainAll(scopes); nextPull.keys.retainAll(scopes)
        val dueDoubts = engine.lock.withLock { engine.doubts.due(mono()) }
        pullWanted.addAll(dueDoubts)
        val due = scopes.sorted().filter { target ->
            val stopped = engine.lock.withLock { engine.device.current().cursors[target.text]?.get("digestStop") == Json.of(appVersion) }
            val cooldown = pullWaits.getOrPut(target, ::SenderWait)
            !stopped && (target in dueDoubts || cooldown.due(mono())) && (target in pullWanted || socket == null && (nextPull[target] ?: 0) <= mono())
        }
        if (due.isEmpty()) return@withLock false
        val batches = mutableListOf<List<ScopeRef>>()
        var batch = mutableListOf<ScopeRef>()
        for (target in due.filter { it !in dueDoubts }) {
            val proposed = batch + target
            val bytes = engine.pullRequest(proposed)?.jcs?.encodeToByteArray()?.size ?: 0
            if (batch.isNotEmpty() && (proposed.size > Constants.PULL_MAX_SCOPES || bytes > Constants.PULL_MAX_BYTES)) { batches.add(batch); batch = mutableListOf() }
            batch.add(target)
        }
        if (batch.isNotEmpty()) batches.add(batch)
        batches.addAll(due.filter { it in dueDoubts }.map { listOf(it) })
        for (planned in batches) {
            if (!pulling() || !current(seat)) break
            val request = engine.pullRequest(planned) ?: continue
            val pulled = request.member("scopes").arr().map { ScopeRef(it.member("scope")) }
            engine.lock.withLock { dueDoubts.filter { it in pulled }.forEach(engine.doubts::pulling) }
            pulled.forEach { pullWanted.remove(it) }
            val send = engine.clock.reading()
            if (!activityAllowed() || !current(seat)) break
            // Every pull sent ends once, in `pulls`: landed when its answer was applied, caught up when no scope it named has more
            // to read, and unlanded when it failed or a change of seat or activity cut it short.
            val number = endedPulls.updateAndGet { it.sending(seat.replica) }.sent
            var landed = false
            var caughtUp = false
            try {
                val reply = deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.pull(request, seat.token) } ?: Reply.Unreachable
                val recv = engine.clock.reading()
                if (!activityAllowed()) break
                val response = reply.answer
                if (response?.requiresUpgrade == true) { requireUpgrade(); break }
                if (!current(seat)) break
                if (response != null) {
                    val outcomes = engine.lock.withLock {
                        if (!activityAllowed() || !current(seat)) return@withLock null
                        engine.onPullResponse(request, response, RequestTiming(send, recv), appVersion = appVersion, replicaID = seat.replica)
                    } ?: break
                    for (result in outcomes) {
                        val target = ScopeRef(result.member("scope"))
                        val outcome = result.member("outcome").str()
                        engine.lock.withLock {
                            if (outcome == "ignored") engine.doubts.end(target, mono(), engine::draw)
                            else if (outcome == "applied") engine.doubts.rows(target, mono())
                        }
                        if (outcome in setOf("stale", "reset", "partial", "unsettled")) pullWanted.add(target)
                    }
                    if (response.status == 200) {
                        val more = response.body?.items("pages")?.filter { it.flag("more") }.orEmpty()
                        landed = true
                        caughtUp = more.isEmpty() && outcomes.all { it.member("outcome").str() in setOf("applied", "ignored") }
                        for (target in pulled) { pullWaits.getValue(target).kick(mono()); nextPull[target] = mono() + Constants.PULL_FALLBACK_MS }
                        more.forEach { pullWanted.add(ScopeRef(it.member("scope"))) }
                    } else {
                        if (response.status == 503) pullFloor = mono() + (response.body?.get("retryAfterMs")?.long() ?: 0)
                        for (target in pulled) {
                            pullWanted.add(target)
                            if (response.status == 503) pullWaits.getValue(target).unavailable(mono(), response.body?.get("retryAfterMs")?.long() ?: 0, engine::draw, socket != null)
                            else pullWaits.getValue(target).backoff(mono(), engine::draw, socket != null)
                        }
                        if (response.status == 503) break
                    }
                } else for (target in pulled) { pullWanted.add(target); pullWaits.getValue(target).backoff(mono(), engine::draw, socket != null) }
            } finally { endedPulls.update { it.ending(seat.replica, number, landed, caughtUp) } }
            engine.lock.withLock { for (target in dueDoubts.filter { it in pulled }) engine.doubts.repulled(target, mono(), engine::draw) }
        }
        true
    }
    // One open of the live socket and its life, run by the live worker. An exception it did not expect is reported here and
    // ends the step as a socket that failed.
    private suspend fun liveStep(): LiveEnd = try { liveTurn.withLock { liveOpen() } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { engine.report(EngineOperation.live, EngineOutcome.failure); LiveEnd.dropped }
    private suspend fun liveOpen(): LiveEnd {
        if (!activityAllowed() || !foreground || !online || closed) return LiveEnd.closed
        val seat = seat() ?: return LiveEnd.closed
        val reply = deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.openLive(seat.token!!) } ?: Reply.Unreachable
        if (!activityAllowed() || !current(seat) || !foreground || !online || closed) { (reply as? Reply.Answer)?.value?.close(); return LiveEnd.closed }
        // §7.5: a handshake's 426 or 503 proves nothing on its own; the pull the failed open runs hears the server's own verdict.
        if (reply is Reply.Failed) {
            if (reply.response.status == 401) engine.write(EngineOperation.live) { it.meta = it.meta.with("authPaused" to Json.of(true)) }
            return LiveEnd.refused
        }
        val connection = (reply as? Reply.Answer)?.value ?: return LiveEnd.refused
        // §7.5: an open after a failed open or an ended socket pulls every scope once they are followed, for what changed while
        // no socket followed them.
        var catchUp = liveWait.k > 0
        socket = connection; socketOpenedAt = mono()
        fun ended() = if (liveClosedByClient.compareAndSet(connection, null)) LiveEnd.closed else LiveEnd.dropped
        return try { coroutineScope {
            val following = mutableSetOf<ScopeRef>()
            var heard = mono(); var pongDue: Long? = null
            val incoming = Channel<Json?>(1)
            val reader = launch { try { while (isActive) { val frame = connection.receive(); incoming.send(frame); if (frame == null) break } } finally { incoming.close() } }
            try { while (isActive && activityAllowed() && current(seat) && foreground && online && !closed) {
                val scopes = engine.subscriptions(products).filter { engine.lock.withLock { (it in following || engine.doubts.mayFollow(it)) && !engine.awaitsGoverningCreate(engine.device.current(), it) && engine.device.current().cursors[it.text]?.get("digestStop") != Json.of(appVersion) } }.toSet()
                // §9.5: `sub` and `unsub` name their scopes as an array, at most a pull's worth to a frame.
                for (batch in (following - scopes).chunked(Constants.PULL_MAX_SCOPES)) {
                    connection.send(Json.objectOf("op" to Json.of("unsub"), "scopes" to Json.Arr(batch.map { it.json })))
                    engine.lock.withLock { batch.forEach { engine.doubts.unfollowed(it, mono()) } }
                }
                for (batch in (scopes - following).chunked(Constants.PULL_MAX_SCOPES)) {
                    connection.send(Json.objectOf("op" to Json.of("sub"), "scopes" to Json.Arr(batch.map { it.json })))
                    engine.lock.withLock { batch.forEach { engine.doubts.followed(it, mono()) } }
                }
                following.clear(); following.addAll(scopes)
                if (catchUp) { catchUp = false; engine.subscriptions(products).forEach(pullWanted::add); pullerWake.trySend(Unit) }
                if (pongDue?.let { mono() >= it } == true) {
                    engine.report(EngineOperation.live, EngineOutcome.timeout, "unreachable"); throw LiveEnded("live-pong-timeout")
                }
                if (pongDue == null && mono() - heard >= Constants.LIVE_PING_MS) { connection.send(Json.objectOf("op" to Json.of("ping"))); pongDue = mono() + Constants.LIVE_PONG_MS }
                val item = withTimeoutOrNull(1_000) { incoming.receiveCatching() }
                if (!activityAllowed() || !current(seat)) return@coroutineScope LiveEnd.closed
                if (item == null) continue
                val frame = item.getOrNull() ?: return@coroutineScope ended()
                heard = mono(); if (frame.member("op").str() == "pong") pongDue = null
                val op = frame.member("op").str()
                if (op in setOf("gone", "not-found")) { val target = ScopeRef(frame.member("scope")); following.remove(target); engine.lock.withLock { engine.doubts.unfollowed(target, mono()) } }
                val outcome = pullerTurn.withLock { engine.lock.withLock {
                    if (activityAllowed() && current(seat)) engine.onFrame(frame, appVersion, seat.replica) else "outside"
                } }
                if (outcome == "pull") { pullWanted.add(ScopeRef(frame.member("scope"))); pullerWake.trySend(Unit) }
                if (outcome == "ignored" && op in setOf("gone", "not-found")) engine.lock.withLock { engine.doubts.end(ScopeRef(frame.member("scope")), mono(), engine::draw) }
                if (outcome == "paused") return@coroutineScope LiveEnd.closed
            }; LiveEnd.closed } finally { reader.cancel(); following.forEach { target -> engine.lock.withLock { engine.doubts.unfollowed(target, mono()) } } }
        } } catch (_: LiveEnded) { ended() }
        finally { connection.close(); socket = null; liveClosedByClient.compareAndSet(connection, null) }
    }
    suspend fun shutdown(timeoutMs: Long = 2_000) {
        close()
        withTimeoutOrNull(timeoutMs) { scope.coroutineContext[Job]?.join() }
    }
    override fun close() {
        if (!closed) { closed = true; activePush?.cancel(); closeLive(); scope.cancel(); senderWake.close(); pullerWake.close(); liveWake.close(); heldWake.close() }
    }
}
