package works.windmill.sync.testing

import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeoutException
import works.windmill.sync.core.*
import works.windmill.sync.modelserver.*
import works.windmill.sync.modelserver.Reply
import works.windmill.sync.engine.*

typealias ServerRules = works.windmill.sync.modelserver.ServerRules
typealias NoServerRules = works.windmill.sync.modelserver.NoServerRules

class ModelServerHandle(private val model: ModelServer, val clock: SimClock) {
    @Synchronized fun snapshot(): Json = model.state.json
    @Synchronized fun restore(state: Json) = model.restore(ServerState(state))
    @Synchronized fun refuse(next: Int = 1, code: String, detail: Json? = null) = model.refuse(next, code, detail)
    @Synchronized fun connect(credential: Credential) = model.connect(credential)
    @Synchronized fun subscribe(socket: Int, scopes: List<ScopeRef>) = model.subscribe(socket, scopes)
    @Synchronized fun unsubscribe(socket: Int, scopes: List<ScopeRef>) = model.unsubscribe(socket, scopes)
    @Synchronized fun frames(socket: Int) = model.frames(socket)
    @Synchronized fun close(socket: Int) = model.close(socket)
    @Synchronized fun isOpen(socket: Int) = model.isOpen(socket)
    @Synchronized fun exchange(path: String, body: ByteArray, credential: Credential): Reply = when (path) {
        "hello" -> model.hello(credential, clock.now()); "push" -> model.push(body, credential, clock.now()); "pull" -> model.pull(body, credential, clock.now())
        else -> throw IllegalArgumentException("unknown-endpoint:$path")
    }
}

// An in-memory HTTP port with virtual deadlines. A lost reply still admits its request; a dropped request does not.
class InMemoryTransport(val server: ModelServerHandle, private val clock: SimClock) : AutoCloseable {
    data class Fault(val drop: Boolean = false, val loseReply: Boolean = false, val delayMs: Long = 0, val duplicate: Boolean = false)
    private val lock = Any()
    private val pending = mutableSetOf<CompletableFuture<Reply>>()
    private var closed = false
    private var nextFault = Fault()
    var next: Fault
        get() = synchronized(lock) { nextFault }
        set(value) = synchronized(lock) { nextFault = value }
    fun request(path: String, body: Json = Json.objectOf(), credential: Credential = Credential.Absent, timeoutMs: Long = Constants.REQUEST_TIMEOUT_MS): CompletableFuture<Reply> {
        require(timeoutMs > 0)
        val result = CompletableFuture<Reply>()
        val fault = synchronized(lock) {
            check(!closed) { "transport-closed" }; require(nextFault.delayMs >= 0)
            val fault = nextFault; nextFault = Fault(); pending.add(result); fault
        }
        val timeout = try { clock.sleepUntil(Math.addExact(clock.monotonicMs, timeoutMs)) } catch (error: Exception) {
            synchronized(lock) { pending.remove(result) }; result.completeExceptionally(error); return result
        }
        var delivery: CompletableFuture<Unit>? = null
        result.whenComplete { _, _ -> synchronized(lock) { pending.remove(result) }; timeout.cancel(false); delivery?.cancel(false) }
        timeout.whenComplete { _, failure -> if (failure != null) result.cancel(false) else result.completeExceptionally(TimeoutException("request-timeout")) }
        fun deliver() {
            val reply = try { synchronized(lock) {
                if (result.isDone || closed || fault.drop) return
                val reply = server.exchange(path, body.jcs.encodeToByteArray(), credential)
                if (fault.duplicate) server.exchange(path, body.jcs.encodeToByteArray(), credential)
                reply
            } } catch (error: Exception) { result.completeExceptionally(error); return }
            if (!fault.loseReply) result.complete(reply)
        }
        if (fault.delayMs == 0L) deliver() else {
            delivery = try { clock.sleepUntil(Math.addExact(clock.monotonicMs, fault.delayMs)) } catch (error: Exception) { result.completeExceptionally(error); return result }
            delivery.thenRun(::deliver)
            if (result.isDone) delivery.cancel(false)
        }
        return result
    }
    val inFlight get() = synchronized(lock) { pending.size }
    override fun close() {
        val cancel = synchronized(lock) { if (closed) return; closed = true; pending.toList().also { pending.clear() } }
        cancel.forEach { it.completeExceptionally(IllegalStateException("transport-closed")) }
    }

}

// No client reconciliation is implemented in test support.
// Sender/puller steps include their result batches, page chunks and settling slices; each returns whether it advanced.
interface EngineSteps : AutoCloseable {
    fun start(account: String?)
    fun senderStep(): Boolean
    fun pullerStep(): Boolean
    fun leave()
    fun skewRefusals(): Map<String, Int>
}
fun interface EngineStepsFactory {
    fun create(engine: works.windmill.sync.engine.Engine, transport: InMemoryTransport, clock: SimClock): EngineSteps
}
object EngineIntegration {
    val factory: EngineStepsFactory = EngineStepsFactory(::PortEngineSteps)
    const val waitsFor = "network steps require the simulated-clock constructor; legacy corpus instances replay explicit transitions"
}

// Scheduling is virtual; numbering, result transactions, recovery, chunking and settling belong to Engine.
private class PortEngineSteps(private val engine: Engine, private val transport: InMemoryTransport, private val clock: SimClock) : EngineSteps {
    private val wait = SenderWait()
    private val skew = linkedMapOf<String, Int>()
    private var socket: Int? = null
    private var socketAccount: String? = null
    private var socketReplica: String? = null
    private var following = emptySet<ScopeRef>()
    private var lastPull: Pair<String, String>? = null
    private var pushLimit = Constants.PUSH_MAX_INTENTS
    private var closed = false
    private fun current(): Json = engine.snapshot().let { snapshot -> snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") } }
    private fun account(): String? = current().member("meta")["account"]?.orNull()?.str()
    private fun credential(): Credential = account()?.let(Credential::Account) ?: Credential.Absent
    private fun exchange(path: String, request: Json, timeoutMs: Long = Constants.REQUEST_TIMEOUT_MS.toLong()): Pair<works.windmill.sync.modelserver.Reply?, RequestTiming> {
        val sent = clock.reading()
        val future = transport.request(path, request, credential(), timeoutMs)
        while (!future.isDone) check(clock.advanceToNext()) { "request-without-deadline" }
        return try { future.join() to RequestTiming(sent, clock.reading()) }
        catch (_: java.util.concurrent.CompletionException) { null to RequestTiming(sent, clock.reading()) }
    }
    override fun start(account: String?) {
        check(!closed); engine.start()
        val sent = clock.reading()
        val hello = transport.request("hello", credential = account?.let(Credential::Account) ?: Credential.Absent)
        while (!hello.isDone) check(clock.advanceToNext())
        val reply = hello.join()
        if (account != null) {
            check(reply.status == 200)
            val holds = reply.body["holdsRecords"]?.obj()?.mapValues { it.value.bool() }.orEmpty()
            val result = engine.signIn(account, holds)
            check(result.member("complete").bool()) { "sign-in-requires-decision" }
        }
        engine.onHello(SyncResponse(reply.status, reply.body), RequestTiming(sent, clock.reading()))
    }
    override fun senderStep(): Boolean = send(false)
    private fun send(leaving: Boolean): Boolean {
        check(!closed)
        if (leaving && !wait.leaveMayPush(clock.monotonicMs)) return false
        if (!leaving && !wait.due(clock.monotonicMs)) return false
        val entries = current()["outbox"]?.arr().orEmpty()
        val request = engine.nextPush(pushLimit) ?: return false
        val (reply, timing) = exchange("push", request, if (leaving) 2_000 else Constants.REQUEST_TIMEOUT_MS.toLong())
        if (reply == null) { if (!leaving) wait.backoff(clock.monotonicMs, { it / 2 }); return true }
        val results = reply.body["results"]?.arr().orEmpty()
        for (result in results.filter { it["code"] == Json.of("clock-skew") }) {
            val intent = request.member("intents").arr().single { it.member("n") == result.member("n") }
            val entry = entries.firstOrNull { it["n"] == intent.member("n") || it["intent"]?.get("n") == intent.member("n") }
                ?: current()["outbox"]?.arr()?.firstOrNull { it["n"] == intent.member("n") }
            val id = entry?.get("localId")?.str() ?: entry?.get("id")?.str() ?: error("missing-skew-entry")
            skew[id] = (skew[id] ?: 0) + 1
        }
        val next = engine.onPushResponse(request, SyncResponse(reply.status, reply.body), timing)
        pushLimit = next?.get("limit")?.long()?.toInt() ?: Constants.PUSH_MAX_INTENTS
        if (reply.status == 503 && leaving) wait.retry(clock.monotonicMs, reply.body["retryAfterMs"]?.long() ?: 0)
        else if (reply.status == 503) wait.unavailable(clock.monotonicMs, reply.body["retryAfterMs"]?.long() ?: 0, { it / 2 })
        else {
            if (!leaving) wait.results(results.map { it["code"]?.str() ?: "ok" }, clock.monotonicMs, { it / 2 })
            reply.body["retry"]?.orNull()?.let { wait.retry(clock.monotonicMs, it.member("retryAfterMs").long()) }
        }
        lastPull = null
        return true
    }
    override fun pullerStep(): Boolean {
        check(!closed)
        if (current().member("meta")["authPaused"] == Json.of(true)) {
            socket?.let(transport.server::close); socket = null; following = emptySet(); lastPull = null
            return false
        }
        val account = account()
        val replicaID = engine.activeReplica()
        if (socketAccount != account || socketReplica != replicaID) {
            socket?.let(transport.server::close); socket = null; following = emptySet(); socketAccount = account; socketReplica = replicaID
        }
        val scopes = engine.subscriptions(engine.registry.products.keys.sorted())
        engine.reconcile(scopes)
        if (scopes.isEmpty()) return false
        if (socket == null) socket = transport.server.connect(credential())
        socket?.let { id ->
            transport.server.unsubscribe(id, (following - scopes).toList())
            transport.server.subscribe(id, (scopes - following).toList()); following = scopes
        }
        var framed = false
        socket?.let { id -> for (frame in transport.server.frames(id)) { engine.onFrame(frame, replicaID = replicaID); framed = true } }
        val request = engine.pullRequest(scopes) ?: return framed
        val stamp = transport.server.snapshot().jcs to request.jcs
        if (lastPull == stamp) return framed
        val (reply, timing) = exchange("pull", request)
        if (reply != null) engine.onPullResponse(request, SyncResponse(reply.status, reply.body), timing, replicaID = replicaID)
        lastPull = if (reply?.status == 200 && replicaID == engine.activeReplica()) stamp else null
        return true
    }
    override fun leave() {
        check(!closed); socket?.let(transport.server::close); socket = null; following = emptySet()
        engine.releaseHeld(true); send(true)
    }
    override fun skewRefusals(): Map<String, Int> = skew.toMap()
    override fun close() { if (!closed) { closed = true; socket?.let(transport.server::close); socket = null } }
}
