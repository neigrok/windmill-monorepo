package works.windmill.sync.engine

import kotlin.concurrent.withLock
import works.windmill.sync.core.*
import works.windmill.sync.api.PendingDeviceWork
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

typealias DeviceValueRewrite = (String, String, Json, String, RecordID, RecordID) -> Json

class EngineError(val code: Code, val account: String? = null, val product: String? = null,
    val ready: Int = 0, val sent: Int = 0, val pending: Int = 0) : IllegalStateException(code.name) {
    enum class Code { notSignedIn, signedIn, unauthenticated, unreachable, upgradeRequired, decisionMissing, signInChanged, signInEnded, signOutChanged, signOutEnded }
}
enum class LineageAnswer { add, discard }
enum class SignOutChoice { keep, discard }
data class SignedOutDecision(val product: String, val count: Map<String, Int>, internal val counted: List<String>)
data class DormantReplica(val account: String, val ready: Int, val sent: Int, val pending: Int) {
    val unsent get() = ready + sent + pending
}

class SignInSession internal constructor(private val runtime: SyncRuntime, val account: String,
    internal val holdsRecords: Map<String, Boolean>, result: Json, internal val serverSchema: Long? = null) {
    val decisions = result.items("due").map { question -> SignedOutDecision(question.member("product").str(),
        question.member("count").obj().mapValues { it.value.long().toInt() }, question.member("counted").arr().map(Json::str)) }
    @Volatile var isComplete = result.member("complete").bool(); private set
    private var cancelled = false
    private val mutex = Mutex()
    suspend fun complete(answers: Map<String, LineageAnswer>) = mutex.withLock {
        if (isComplete) return@withLock
        if (cancelled) throw EngineError(EngineError.Code.signInEnded)
        decisions.firstOrNull { it.product !in answers }?.let { throw EngineError(EngineError.Code.decisionMissing, product = it.product) }
        runtime.finishSignIn(this, answers)
        isComplete = true
    }
    suspend fun cancel() = mutex.withLock { if (!isComplete && !cancelled) { cancelled = true; runtime.cancelSignIn() } }
}

class SignOutSession internal constructor(private val runtime: SyncRuntime, val account: String,
    internal val hold: Long, result: Json) {
    val ready = result.member("ready").long().toInt()
    val sent = result.member("sent").long().toInt()
    val pending = result["pending"]?.long()?.toInt() ?: 0
    val unsent get() = ready + sent + pending
    internal val counted = result.member("counted").arr().map(Json::str)
    private var ended = false
    private val mutex = Mutex()
    suspend fun finish(choice: SignOutChoice): Json = mutex.withLock {
        if (ended) throw EngineError(EngineError.Code.signOutEnded)
        runtime.finishSignOut(this, choice).also { ended = true }
    }
    suspend fun cancel() = mutex.withLock {
        if (!ended) { runtime.cancelSignOut(this); ended = true }
    }
}

internal fun Engine.observe(replica: ReplicaState, stamps: List<Stamp>) {
    val clock = Hlc(replica.meta.member("hlc"))
    var high = Stamp(replica.meta.member("hlcHigh").str())
    for (stamp in stamps) { clock.observe(stamp); high = maxOf(high, stamp) }
    replica.meta = replica.meta.with("hlc" to clock.json, "hlcHigh" to high.json)
}
internal fun Engine.raiseAdmittedHigh(replica: ReplicaState, stamps: List<Stamp>) {
    val high = stamps.fold(Stamp(replica.meta.member("admittedHigh").str()), ::maxOf)
    replica.meta = replica.meta.with("admittedHigh" to high.json)
}
internal fun Engine.activate(previous: String?, replica: ReplicaState) {
    device.active = replica.id
    selectedScopes = null
    doubts.clear()
    if (previous != replica.id) events.add(Json.objectOf("event" to Json.of("activeReplicaChanged"),
        "previous" to (previous?.let(Json::of) ?: Json.Null), "replica" to Json.of(replica.id)))
}
internal fun Engine.reidentify(replica: ReplicaState) {
    Machines.replica.transition(replica.state, "reidentify", replica.state)
    val previous = replica.id
    val active = device.active == previous
    val id = identities.replicaID()
    require(device.replicas.none { it.id == id })
    store.reidentify(previous, id)
    replica.meta = replica.meta.with("replica" to Json.of(id), "nextN" to Json.of(1), "ackThrough" to Json.of(0))
    replica.entries().filter { it.state == "sent" }.forEach { replica.move(it, "reidentify", ended) }
    if (active) activate(previous, replica)
}
fun Engine.reidentify() { write(EngineOperation.lifecycle) { reidentify(it); actor = identities.actorID() } }
internal fun Engine.epochChange(replica: ReplicaState, epoch: String) {
    replica.meta = replica.meta.with("serverEpoch" to Json.of(epoch))
    replica.cursors.replaceAll { _, value -> value.with("cursor" to Json.Null) }
    replica.staging.keys.toList().forEach { store.dropStaging(replica.id, ScopeRef(it)) }
    replica.staging.clear()
    replica.entries().filter { it.state == "acked" && it.json["resultEpoch"]?.str() != epoch }.forEach { entry ->
        recoverWriteTargets(entry)
        replica.move(entry, "epoch", ended)
    }
    reidentify(replica); actor = identities.actorID()
}
fun Engine.epochChange(epoch: String) { write(EngineOperation.lifecycle) { epochChange(it, epoch) } }
fun Engine.start(backupGuard: Json? = null): Json = write(EngineOperation.lifecycle) {
    for (replica in device.replicas) replica.entries().filter { it.state == "held" }.forEach { replica.move(it, "release", ended) }
    actor = identities.actorID()
    var reidentified = false
    if (backupGuard != null) {
        if (device.meta["forkGuard"] != null && backupGuard != device.meta["forkGuard"]) {
            device.replicas.forEach(::reidentify); reidentified = true
        }
        if (device.meta["forkGuard"] == null || reidentified) device.meta = device.meta.with("forkGuard" to Json.of(identities.forkGuard()))
    }
    Json.objectOf("actor" to Json.of(actor), "reidentified" to Json.of(reidentified)).with("pendingSignIn" to device.meta["pendingSignIn"])
}
internal fun Engine.entriesOf(replica: ReplicaState, product: String) = replica.entries().filter { registry.product(it.scope) == product }
internal fun Engine.pendingKeys(replica: ReplicaState, product: String): List<String> {
    val rows = replica.device[product]?.obj().orEmpty()
    return pendingDeviceWork(product, rows).distinct().sorted().filter { it in rows }
}
internal fun Engine.lineageWork(replica: ReplicaState, product: String): List<String> =
    entriesOf(replica, product).map { it.id } + pendingKeys(replica, product).map { key ->
        "device:$product:$key:${Sha256.hex(replica.device.getValue(product).member(key).jcs.encodeToByteArray())}"
    }
internal fun Engine.anonCount(replica: ReplicaState, product: String): Json {
    val records = entriesOf(replica, product).flatMap { entry -> entry.deltas.map { entry.scope to it.key } }.distinct()
    val counts = records.groupingBy { it.second.type }.eachCount().toMutableMap()
    for (key in pendingKeys(replica, product)) {
        val detail = replica.device.getValue(product).member(key)["count"]?.obj()
        if (detail == null) { counts["pending"] = Math.addExact(counts["pending"] ?: 0, 1); continue }
        for ((type, value) in detail) {
            require(type == "pending" || registry.type(type) != null)
            val amount = value.long()
            require(amount in 0..Int.MAX_VALUE.toLong())
            counts[type] = Math.addExact(counts[type] ?: 0, amount.toInt())
        }
    }
    return Json.Obj(counts.map { it.key to Json.of(it.value) })
}
fun Engine.anonCount(replica: String, product: String): Json = lock.withLock { ensureOpen(); anonCount(device.replicas.single { it.id == replica }, product) }
fun Engine.signIn(account: String, holdsRecords: Map<String, Boolean>, decisions: Map<String, String> = emptyMap(), counted: Map<String, List<String>> = emptyMap(), serverSchema: Long? = null): Json = write(EngineOperation.lifecycle) {
    val previous = device.active
    val anon = device.replicas.firstOrNull { it.state == "anon" }
    anon?.entries()?.filter { it.state == "held" }?.forEach { anon.move(it, "release", ended) }
    val due = registry.products.keys.sorted().filter { holdsRecords[it] == true && anon != null && lineageWork(anon, it).isNotEmpty() }.map { product ->
        Json.objectOf("kind" to Json.of("signed-out"), "product" to Json.of(product), "count" to anonCount(anon!!, product),
            "counted" to Json.Arr(lineageWork(anon, product).map(Json::of)))
    }
    if (due.any { question ->
            val product = question.member("product").str()
            decisions[product] !in setOf("add", "discard") || counted[product]?.let { it != question.member("counted").arr().map(Json::str) } == true
        }) {
        device.meta = device.meta.with("pendingSignIn" to Json.objectOf("account" to Json.of(account)))
        return@write Json.objectOf("complete" to Json.of(false), "due" to Json.Arr(due))
    }
    for (question in due) {
        val product = question.member("product").str()
        if (decisions[product] != "discard") continue
        entriesOf(anon!!, product).forEach { anon.move(it, "discard", ended) }; anon.device.remove(product)
    }
    val dormant = device.replicas.firstOrNull { it.state == "dormant" && it.account == account }
    val hasAnonymousWork = anon != null && (anon.outbox.isNotEmpty() || registry.products.keys.any { pendingKeys(anon, it).isNotEmpty() })
    val target = when {
        dormant != null -> dormant.also {
            it.meta = it.meta.with("state" to Json.of(Machines.replica.transition("dormant", "sign-in", "bound")))
            it.cursors.clear(); it.staging.keys.toList().forEach { scope -> store.dropStaging(it.id, ScopeRef(scope)) }; it.staging.clear()
        }
        hasAnonymousWork -> anon!!.also {
            it.meta = it.meta.with("state" to Json.of(Machines.replica.transition("anon", "sign-in", "bound")), "account" to Json.of(account))
        }
        else -> freshReplica(identities.replicaID(), account).also { device.replicas.add(it) }
    }
    if (anon != null && anon !== target && hasAnonymousWork) {
        for (entry in anon.entries()) {
            entry.json = entry.json.with("commitOrder" to Json.of(1 + (target.outbox.maxOfOrNull { it.order } ?: 0)))
            target.outbox.add(entry)
        }
        for ((product, rows) in anon.device) target.device[product] = Json.Obj(rows.obj().toMutableMap().apply { putAll(target.device[product]?.obj().orEmpty()) }.toList())
        target.notices.addAll(anon.notices)
        Machines.replica.transition("anon", "sign-in", "deleted")
        store.purgeReplica(anon.id); device.replicas.remove(anon)
    }
    target.outbox.forEach { it.json = it.json.with("lineage" to Json.of(account)) }
    observe(target, target.entries().flatMap { listOf(it.stamp) + it.deltas.flatMap { delta -> delta.lattice.stamps } })
    target.meta = target.meta.with("authPaused" to Json.of(false))
    serverSchema?.let { target.meta = target.meta.with("serverSchema" to Json.of(it)) }
    device.meta = device.meta.with("pendingSignIn" to null); activate(previous, target)
    Json.objectOf("complete" to Json.of(true), "due" to Json.Arr(due))
}
fun Engine.signOut(choice: String? = null, counted: List<String>? = null,
    pendingDeviceWork: PendingDeviceWork = this.pendingDeviceWork): Json = write(EngineOperation.lifecycle) { bound ->
    Machines.replica.transition(bound.state, "sign-out-keep", "dormant")
    val previous = bound.id
    bound.entries().filter { it.state == "held" }.forEach { bound.move(it, "release", ended) }
    val unsent = bound.entries().filter { it.state in setOf("ready", "sent") }
    val pending = bound.device.toSortedMap().flatMap { (product, rows) -> pendingDeviceWork(product, rows.obj()).distinct().sorted().mapNotNull { key ->
        rows[key]?.let { "device:$product:$key:${Sha256.hex(it.jcs.encodeToByteArray())}" }
    } }
    val pins = unsent.map { it.id } + pending
    val question = Json.objectOf("unsent" to Json.of(pins.size), "ready" to Json.of(unsent.count { it.state == "ready" }),
        "sent" to Json.of(unsent.count { it.state == "sent" }), "counted" to Json.Arr(pins.map(Json::of)))
        .with("pending" to pending.takeIf { it.isNotEmpty() }?.let { Json.of(it.size) })
    if (choice != "keep" && !(choice == "discard" && (counted == null || counted == pins))) return@write question.with("complete" to Json.of(false))
    bound.entries().filter { it.state == "acked" }.forEach { bound.move(it, "resolve", ended) }
    if (choice == "keep") {
        bound.meta = bound.meta.with("state" to Json.of("dormant"))
        store.purgeReplica(bound.id)
        bound.spent.clear(); bound.cursors.clear(); bound.staging.clear(); bound.known.clear()
    } else {
        Machines.replica.transition("bound", "sign-out-discard", "deleted")
        bound.entries().forEach { bound.move(it, "discard", ended) }; store.purgeReplica(bound.id); device.replicas.remove(bound)
    }
    val anon = device.replicas.firstOrNull { it.state == "anon" } ?: freshReplica(identities.replicaID()).also { device.replicas.add(it) }
    activate(previous, anon); question.with("complete" to Json.of(true))
}
fun Engine.discardUnsent(replica: String) { write(EngineOperation.lifecycle) {
    val target = device.replicas.single { it.id == replica }
    Machines.replica.transition(target.state, "discard", "deleted")
    target.entries().forEach { target.move(it, "discard", ended) }; store.purgeReplica(target.id); device.replicas.remove(target)
} }
fun Engine.dormantReplicas(): List<DormantReplica> = lock.withLock {
    ensureOpen()
    device.replicas.filter { it.state == "dormant" }.map { replica ->
        val pending = replica.device.entries.sumOf { (product, rows) -> pendingDeviceWork(product, rows.obj()).toSet().count { it in rows.obj() } }
        DormantReplica(replica.account!!, replica.outbox.count { it.state == "ready" }, replica.outbox.count { it.state == "sent" }, pending)
    }
}
fun Engine.discardDormant(account: String): Boolean = write(EngineOperation.lifecycle) {
    val target = device.replicas.firstOrNull { it.state == "dormant" && it.account == account } ?: return@write false
    target.entries().forEach { target.move(it, "discard", ended) }; store.purgeReplica(target.id); device.replicas.remove(target)
    true
}
fun Engine.reauthenticate() { write(EngineOperation.lifecycle) { it.meta = it.meta.with("authPaused" to Json.of(false)); doubts.clear() } }
