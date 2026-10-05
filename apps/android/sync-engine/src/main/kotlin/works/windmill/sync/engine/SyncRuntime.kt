package works.windmill.sync.engine

import kotlin.concurrent.withLock
import kotlinx.coroutines.*
import works.windmill.sync.api.CommitFailure
import kotlinx.coroutines.channels.Channel
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
object CoroutineSleeper : EngineSleeper { override suspend fun sleep(ms: Long) { delay(ms) } }

class SyncRuntime(private val engine: Engine, private val transport: SyncTransport, private val tokens: SessionTokens,
    private val appVersion: String, private val sleeper: EngineSleeper = CoroutineSleeper,
    private val products: List<String> = listOf("gym"), private val liveHint: () -> Boolean = { false }) : AutoCloseable {
    private data class Seat(val replica: String, val account: String?, val token: String?)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val senderTurn = Mutex()
    private val pullerTurn = Mutex()
    private val liveTurn = Mutex()
    private val senderWake = Channel<Unit>(Channel.CONFLATED)
    private val pullerWake = Channel<Unit>(Channel.CONFLATED)
    private val liveWake = Channel<Unit>(Channel.CONFLATED)
    private val wait = SenderWait()
    private val heldWake = Channel<Unit>(Channel.CONFLATED)
    private val pullWaits = mutableMapOf<ScopeRef, SenderWait>()
    @Volatile private var pullFloor = 0L
    private val nextPull = mutableMapOf<ScopeRef, Long>()
    private val pullWanted = java.util.concurrent.ConcurrentHashMap.newKeySet<ScopeRef>()
    @Volatile private var foreground = false
    @Volatile private var online = true
    @Volatile private var closed = false
    @Volatile var upgradeRequired = false; private set
    @Volatile private var socket: LiveConnection? = null
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
    init {
        scope.launch { engine.changes.collect { change ->
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
        scope.launch {
            while (isActive && !closed) {
                try {
                    val due = engine.lock.withLock { engine.device.current().entries().filter { it.state == "held" }.minOfOrNull { it.json.member("releaseAt").long() } }
                    if (due == null) { heldWake.receiveCatching(); continue }
                    val remaining = due - engine.clock.now()
                    if (remaining > 0) wait(heldWake, remaining) else engine.releaseHeld()
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: CommitFailure) {
                    if (failure.kind != CommitFailure.Kind.storeFailure) throw failure
                    sleeper.sleep(Constants.BACKOFF_BASE_MS)
                }
            }
        }
        scope.launch {
            while (isActive && !closed) {
                try { while (engine.sweepReleased()) { yield() } } catch (_: Exception) { engine.report(EngineOperation.storage, EngineOutcome.failure) }
                sleeper.sleep(1_000)
            }
        }
        scope.launch { while (isActive && !closed) {
            try { if (foreground && online) senderStep() } catch (_: Exception) { engine.report(EngineOperation.push, EngineOutcome.failure) }
            wait(senderWake, 1_000)
        } }
        scope.launch { while (isActive && !closed) {
            try { if (foreground && online) pullerStep() } catch (_: Exception) { engine.report(EngineOperation.pull, EngineOutcome.failure) }
            wait(pullerWake, 1_000)
        } }
        scope.launch { var k = 0
            while (isActive && !closed) {
                if (!foreground || !online || seat() == null) { socket?.close(); socket = null; wait(liveWake, 30_000); continue }
                val start = mono()
                try { liveStep(); if (mono() - start >= 30_000) k = 0 }
                catch (_: CancellationException) { if (!isActive) break }
                catch (_: Exception) { engine.report(EngineOperation.live, EngineOutcome.failure) }
                if (foreground && online && seat() != null) {
                    engine.subscriptions(products).forEach(pullWanted::add); pullerWake.trySend(Unit)
                    val pause = engine.draw(minOf(30_000L, 1_000L shl minOf(k++, 5)).toInt()).toLong()
                    wait(liveWake, pause)
                }
            }
            socket?.close(); socket = null
        }
    }
    private fun <T> storageIO(body: () -> T): T = try { body() }
        catch (failure: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure); throw failure }
    @Synchronized fun launch(forkGuard: ForkGuardStore) {
        if (launched) return
        val copy = storageIO { forkGuard.load() }
        val started = engine.start(copy?.let(Json::of) ?: Json.Null)
        val guard = engine.lock.withLock { engine.device.meta.member("forkGuard").str() }
        if (guard != copy) storageIO { forkGuard.save(guard) }
        val needed = engine.lock.withLock {
            val replica = engine.device.current()
            setOfNotNull(if (replica.state == "bound") replica.account else null, started["pendingSignIn"]?.get("account")?.str())
        }
        storageIO { tokens.accounts() }.filter { it !in needed }.forEach { try { tokens.delete(it) } catch (_: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure) } }
        val activeAccount = engine.lock.withLock { engine.device.current().takeIf { it.state == "bound" }?.account }
        val missing = activeAccount != null && storageIO { tokens.token(activeAccount) } == null
        if (missing) engine.write(EngineOperation.lifecycle) { replica ->
            if (replica.account == activeAccount) replica.meta = replica.meta.with("authPaused" to Json.of(true))
        }
        launched = true
    }
    fun enter() { foreground = true; scope.launch { senderTurn.withLock { wait.kick(mono()) }; engine.subscriptions(products).forEach(pullWanted::add); wakeAll() } }
    fun connectivity(online: Boolean) {
        this.online = online; engine.networkStatus(online = online)
        if (!online) { socket?.close(); socket = null }
        scope.launch { senderTurn.withLock { wait.kick(mono()) }; engine.subscriptions(products).forEach(pullWanted::add); wakeAll() }
    }
    suspend fun leave() {
        foreground = false; socket?.close(); socket = null
        engine.releaseHeld(true)
        if (online && wait.leaveMayPush(mono())) deadline(2_000) { senderStep(leaving = true) }
        wakeAll()
    }
    suspend fun hello(token: String?): Reply<SyncResponse> {
        val sentFor = engine.lock.withLock { engine.device.current().let { it.id to it.account } }
        val send = engine.clock.reading(); val reply = deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.hello(token) } ?: Reply.Unreachable; val recv = engine.clock.reading()
        val response = when (reply) { is Reply.Answer -> reply.value; is Reply.Failed -> reply.response; else -> null }
        if (response != null) {
            val sameReplica = engine.lock.withLock { engine.device.current().let { it.id == sentFor.first && it.account == sentFor.second } }
            val sameToken = sentFor.second == null || storageIO { tokens.token(sentFor.second!!) } == token
            if (sameReplica && sameToken) engine.onHello(response, RequestTiming(send, recv))
            else response.body?.get("serverTime")?.let { time -> engine.write(EngineOperation.hello) { engine.offset(it, time.long(), RequestTiming(send, recv)) } }
            if (response.status == 426 || response.body?.get("minSchema")?.long()?.let { it > engine.registry.version } == true) { upgradeRequired = true; engine.networkStatus(upgradeRequired = true) }
        }
        return reply
    }
    suspend fun signIn(account: String, token: String): SignInSession {
        engine.lock.withLock { val active = engine.device.current(); if (active.state == "bound" && active.account != account) throw EngineError(EngineError.Code.signedIn, active.account) }
        storageIO { tokens.save(account, token) }
        val alreadyBound = engine.lock.withLock { engine.device.current().let { it.state == "bound" && it.account == account } }
        if (alreadyBound) { engine.reauthenticate(); socket?.close(); socket = null; wakeAll(); return SignInSession(this, account, emptyMap(), Json.objectOf("complete" to Json.of(true), "due" to Json.array())) }
        val replaced = engine.lock.withLock { engine.device.meta["pendingSignIn"]?.get("account")?.str() }
        engine.write(EngineOperation.lifecycle) { replica ->
            if (replica.state == "bound") throw EngineError(EngineError.Code.signedIn, replica.account)
            replica.entries().filter { it.state == "held" }.forEach { replica.move(it, "release", engine.ended) }
            engine.device.meta = engine.device.meta.with("pendingSignIn" to Json.objectOf("account" to Json.of(account)))
        }
        if (replaced != null && replaced != account) try { tokens.delete(replaced) } catch (_: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure) }
        return continueSignIn(account, token)
    }
    suspend fun resumeSignIn(): SignInSession? {
        val account = engine.lock.withLock { engine.device.meta["pendingSignIn"]?.get("account")?.str() } ?: return null
        val token = storageIO { tokens.token(account) } ?: throw EngineError(EngineError.Code.unauthenticated)
        return continueSignIn(account, token)
    }
    private suspend fun continueSignIn(account: String, token: String): SignInSession {
        val reply = hello(token)
        val response = when (reply) { is Reply.Answer -> reply.value; is Reply.Failed -> reply.response; else -> throw EngineError(EngineError.Code.unreachable) }
        if (upgradeRequired || response.status == 426) throw EngineError(EngineError.Code.upgradeRequired)
        if (response.status == 401) throw EngineError(EngineError.Code.unauthenticated)
        if (response.status != 200) throw EngineError(EngineError.Code.unreachable)
        if (response.body?.get("as") != Json.of(account) || response.body["holdsRecords"] == null) throw EngineError(EngineError.Code.unauthenticated)
        val holds = response.body.member("holdsRecords").obj().mapValues { it.value.bool() }
        val result = engine.lock.withLock {
            if (engine.device.meta["pendingSignIn"]?.get("account") != Json.of(account)) throw EngineError(EngineError.Code.signInEnded)
            engine.signIn(account, holds)
        }
        socket?.close(); socket = null
        wakeAll(); return SignInSession(this, account, holds, result)
    }
    internal fun finishSignIn(session: SignInSession, answers: Map<String, LineageAnswer>) {
        val result = engine.lock.withLock {
            if (engine.device.meta["pendingSignIn"]?.get("account") != Json.of(session.account)) throw EngineError(EngineError.Code.signInEnded)
            engine.signIn(session.account, session.holdsRecords, answers.mapValues { it.value.name }, session.decisions.associate { it.product to it.counted })
        }
        if (!result.member("complete").bool()) throw EngineError(EngineError.Code.signInChanged)
        socket?.close(); socket = null; wakeAll()
    }
    internal fun cancelSignIn() { engine.report(EngineOperation.lifecycle, EngineOutcome.success) }
    suspend fun signOut(): SignOutSession {
        val account = engine.lock.withLock { engine.device.current().account } ?: throw EngineError(EngineError.Code.notSignedIn)
        engine.releaseHeld(true)
        if (signOutHold != account) deadline(Constants.SIGNOUT_FLUSH_MS.toLong()) {
            var first = true
            while (true) {
                if (!runSenderStep(leaving = first, draining = true)) break
                first = false
                yield()
            }
        }
        activePush?.cancel()
        return withTimeout(Constants.SIGNOUT_FLUSH_MS) { senderTurn.withLock {
            engine.lock.withLock {
                if (engine.device.current().let { it.state != "bound" || it.account != account }) throw EngineError(EngineError.Code.notSignedIn)
            }
            socket?.close(); socket = null
            signOutHold = account; signOutSerial++
            try { SignOutSession(this@SyncRuntime, account, signOutSerial, engine.signOut()).also { wakeAll() } }
            catch (failure: Throwable) { signOutHold = null; wakeAll(); throw failure }
        } }
    }
    internal suspend fun finishSignOut(session: SignOutSession, choice: SignOutChoice): Json = senderTurn.withLock {
        if (session.hold != signOutSerial || signOutHold != session.account) throw EngineError(EngineError.Code.signOutEnded)
        val result = engine.lock.withLock {
            val active = engine.device.current()
            if (active.state != "bound" || active.account != session.account) throw EngineError(EngineError.Code.signOutEnded)
            engine.signOut(choice.name, session.counted)
        }
        if (!result.member("complete").bool()) throw EngineError(EngineError.Code.signOutChanged,
            ready = result.member("ready").long().toInt(), sent = result.member("sent").long().toInt(), pending = result["pending"]?.long()?.toInt() ?: 0)
        signOutHold = null; signOutSerial++
        try { tokens.delete(session.account) } catch (_: Exception) { engine.report(EngineOperation.lifecycle, EngineOutcome.failure) }
        wakeAll(); result
    }
    internal suspend fun cancelSignOut(session: SignOutSession) = senderTurn.withLock {
        if (session.hold == signOutSerial) { signOutHold = null; signOutSerial++; wakeAll() }
        engine.report(EngineOperation.lifecycle, EngineOutcome.success)
    }
    fun reauthenticate(token: String) {
        val account = engine.lock.withLock { engine.device.current().account } ?: throw EngineError(EngineError.Code.notSignedIn)
        storageIO { tokens.save(account, token) }; engine.reauthenticate(); socket?.close(); socket = null; scope.launch { senderTurn.withLock { wait.kick(mono()) }; wakeAll() }
    }
    suspend fun senderStep(leaving: Boolean = false): Boolean = runSenderStep(leaving, false)
    private suspend fun runSenderStep(leaving: Boolean, draining: Boolean): Boolean {
        if (closed) return false
        val work = scope.async { senderStepInLane(leaving, draining) }
        try { return work.await() } finally { if (!currentCoroutineContext().isActive) work.cancel() }
    }
    private suspend fun senderStepInLane(leaving: Boolean, draining: Boolean): Boolean = senderTurn.withLock {
        if (closed || !online || upgradeRequired || !leaving && !draining && !foreground || !leaving && !wait.due(mono()) || leaving && !wait.leaveMayPush(mono())) return@withLock false
        val earlier = if (leaving) wait.snapshot() else null
        try {
            val seat = seat() ?: return@withLock false
            if (signOutHold == seat.account) return@withLock false
            val request = engine.nextPush(pushLimit) ?: return@withLock false
            if (!current(seat)) return@withLock false
            val send = engine.clock.reading()
            activePush = currentCoroutineContext()[Job]
            val reply = try { deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.push(request, seat.token!!) } ?: Reply.Unreachable }
                finally { activePush = null }
            val recv = engine.clock.reading()
            val answered = when (reply) { is Reply.Answer -> reply.value; is Reply.Failed -> reply.response; else -> null }
            if (answered?.status == 426) { upgradeRequired = true; engine.networkStatus(upgradeRequired = true); return@withLock false }
            val stillCurrent = current(seat)
            val suppliedTokenChanged = seat.account?.let { storageIO { tokens.token(it) } }?.let { it != seat.token } == true
            val authFailure = answered?.let { response -> response.status == 401 || response.status == 409 && response.body?.get("error") == Json.of("account-mismatch") || response.status in setOf(200, 409) && response.body?.get("as") != seat.account?.let(Json::of) } == true
            if (suppliedTokenChanged && authFailure) {
                answered?.body?.get("serverTime")?.let { time -> engine.write(EngineOperation.push) { engine.device.replicas.firstOrNull { it.id == seat.replica }?.let { original -> engine.offset(original, time.long(), RequestTiming(send, recv)) } } }
                return@withLock false
            }
            if (!stillCurrent) {
                if (answered != null) engine.onPushResponse(request, answered, RequestTiming(send, recv))
                return@withLock false
            }
            var again = false
            val hint = try { liveHint() } catch (_: Exception) { engine.report(EngineOperation.push, EngineOutcome.failure); false }
            when {
                answered != null -> {
                    val response = answered
                    if (response.status == 426) { upgradeRequired = true; engine.networkStatus(upgradeRequired = true); return@withLock false }
                    val next = engine.onPushResponse(request, response, RequestTiming(send, recv))
                    pushLimit = next?.get("limit")?.long()?.toInt() ?: Constants.PUSH_MAX_INTENTS
                    val body = response.body
                    conflicts = if (response.status == 409) conflicts + 1 else 0
                    when {
                        response.status in setOf(400, 413) || response.status == 409 && conflicts == 1 -> again = true
                        response.status == 503 -> wait.unavailable(mono(), body?.get("retryAfterMs")?.long() ?: 0, engine::draw, hint)
                        response.status != 200 -> wait.backoff(mono(), engine::draw, hint)
                        else -> {
                            body?.get("retry")?.let { wait.retry(mono(), it.member("retryAfterMs").long()) }
                            val codes = body?.items("results")?.filter { result -> request.member("intents").arr().any { it.member("n") == result.member("n") } }?.map { it["code"]?.str() ?: "ok" }.orEmpty()
                            wait.results(codes, mono(), engine::draw, hint)
                            if (codes.isEmpty() && body?.get("retry") == null) wait.backoff(mono(), engine::draw, hint)
                            again = codes.isNotEmpty() && "clock-skew" !in codes && body?.get("retry") == null
                        }
                    }
                }
                else -> { conflicts = 0; wait.backoff(mono(), engine::draw, hint) }
            }
            if (draining) again else true
        } finally { if (earlier != null) wait.restoreBackoff(earlier) }
    }
    suspend fun pullerStep(): Boolean = pullerTurn.withLock {
        if (closed || !foreground || !online || upgradeRequired || mono() < pullFloor) return@withLock false
        val seat = pullSeat() ?: return@withLock false
        val scopes = engine.subscriptions(products)
        engine.reconcile(scopes)
        pullWaits.keys.retainAll(scopes); nextPull.keys.retainAll(scopes)
        val dueDoubts = engine.lock.withLock { engine.doubts.due(mono()) }
        pullWanted.addAll(dueDoubts)
        val due = scopes.sorted().filter { target ->
            val stopped = engine.lock.withLock { engine.device.current().cursors[target.text]?.get("digestStop") == Json.of(appVersion) }
            val cooldown = pullWaits.getOrPut(target, ::SenderWait)
            !stopped && (target in dueDoubts || cooldown.due(mono())) && (target in pullWanted || (nextPull[target] ?: 0) <= mono())
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
            if (!current(seat)) break
            val request = engine.pullRequest(planned) ?: continue
            val pulled = request.member("scopes").arr().map { ScopeRef(it.member("scope")) }
            engine.lock.withLock { dueDoubts.filter { it in pulled }.forEach(engine.doubts::pulling) }
            pulled.forEach { pullWanted.remove(it) }
            val send = engine.clock.reading()
            val reply = deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.pull(request, seat.token) } ?: Reply.Unreachable
            val recv = engine.clock.reading()
            val answered = when (reply) { is Reply.Answer -> reply.value; is Reply.Failed -> reply.response; else -> null }
            if (answered?.status == 426) { upgradeRequired = true; engine.networkStatus(upgradeRequired = true); break }
            if (!current(seat)) break
            if (answered != null) {
                val response = answered
                if (response.status == 426) { upgradeRequired = true; engine.networkStatus(upgradeRequired = true); break }
                val outcomes = engine.onPullResponse(request, response, RequestTiming(send, recv), appVersion = appVersion, replicaID = seat.replica)
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
                    for (target in pulled) { pullWaits.getValue(target).kick(mono()); nextPull[target] = mono() + Constants.PULL_FALLBACK_MS }
                    response.body?.items("pages")?.filter { it.flag("more") }?.forEach { pullWanted.add(ScopeRef(it.member("scope"))) }
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
            engine.lock.withLock { for (target in dueDoubts.filter { it in pulled }) engine.doubts.repulled(target, mono(), engine::draw) }
        }
        true
    }
    private suspend fun liveStep() = liveTurn.withLock {
        val seat = seat() ?: return@withLock
        val reply = deadline(Constants.REQUEST_TIMEOUT_MS.toLong()) { transport.openLive(seat.token!!) } ?: Reply.Unreachable
        if (reply is Reply.Failed && reply.response.status == 426) { upgradeRequired = true; engine.networkStatus(upgradeRequired = true) }
        if (!current(seat) || !foreground || !online || closed) { (reply as? Reply.Answer)?.value?.close(); return@withLock }
        if (reply is Reply.Failed) {
            if (reply.response.status == 401) engine.write(EngineOperation.live) { it.meta = it.meta.with("authPaused" to Json.of(true)) }
            if (reply.response.status == 426) { upgradeRequired = true; engine.networkStatus(upgradeRequired = true) }
            return@withLock
        }
        val connection = (reply as? Reply.Answer)?.value ?: return@withLock
        socket = connection
        try { coroutineScope {
            val following = mutableSetOf<ScopeRef>()
            var heard = mono(); var pongDue: Long? = null
            val incoming = Channel<Json?>(1)
            val reader = launch { try { while (isActive) { val frame = connection.receive(); incoming.send(frame); if (frame == null) break } } finally { incoming.close() } }
            try { while (isActive && current(seat) && foreground && online && !closed) {
                val scopes = engine.subscriptions(products).filter { engine.lock.withLock { (it in following || engine.doubts.mayFollow(it)) && !engine.awaitsGoverningCreate(engine.device.current(), it) && engine.device.current().cursors[it.text]?.get("digestStop") != Json.of(appVersion) } }.toSet()
                for (scope in following - scopes) { connection.send(Json.objectOf("op" to Json.of("unsub"), "scope" to scope.json)); engine.lock.withLock { engine.doubts.unfollowed(scope, mono()) } }
                for (scope in scopes - following) { connection.send(Json.objectOf("op" to Json.of("sub"), "scope" to scope.json)); engine.lock.withLock { engine.doubts.followed(scope, mono()) } }
                following.clear(); following.addAll(scopes)
                if (pongDue?.let { mono() >= it } == true) throw IllegalStateException("live-pong-timeout")
                if (pongDue == null && mono() - heard >= Constants.LIVE_PING_MS) { connection.send(Json.objectOf("op" to Json.of("ping"))); pongDue = mono() + Constants.LIVE_PONG_MS }
                val item = withTimeoutOrNull(1_000) { incoming.receiveCatching() }
                if (item == null) continue
                val frame = item.getOrNull() ?: break
                heard = mono(); if (frame.member("op").str() == "pong") pongDue = null
                val op = frame.member("op").str()
                if (op in setOf("gone", "not-found")) { val target = ScopeRef(frame.member("scope")); following.remove(target); engine.lock.withLock { engine.doubts.unfollowed(target, mono()) } }
                val outcome = pullerTurn.withLock { if (current(seat)) engine.onFrame(frame, appVersion, seat.replica) else "outside" }
                if (outcome == "pull") { pullWanted.add(ScopeRef(frame.member("scope"))); pullerWake.trySend(Unit) }
                if (outcome == "ignored" && op in setOf("gone", "not-found")) engine.lock.withLock { engine.doubts.end(ScopeRef(frame.member("scope")), mono(), engine::draw) }
                if (outcome == "paused") break
            } } finally { reader.cancel(); following.forEach { target -> engine.lock.withLock { engine.doubts.unfollowed(target, mono()) } } }
        } } finally { connection.close(); socket = null }
    }
    suspend fun shutdown(timeoutMs: Long = 2_000) {
        close()
        withTimeoutOrNull(timeoutMs) { scope.coroutineContext[Job]?.join() }
    }
    override fun close() {
        if (!closed) { closed = true; activePush?.cancel(); socket?.close(); socket = null; scope.cancel(); senderWake.close(); pullerWake.close(); liveWake.close(); heldWake.close() }
    }
}
