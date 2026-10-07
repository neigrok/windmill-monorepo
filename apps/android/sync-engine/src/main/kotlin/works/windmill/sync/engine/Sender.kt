package works.windmill.sync.engine

import kotlin.concurrent.withLock
import works.windmill.sync.core.*

data class SyncResponse(val status: Int, val body: Json? = null)
data class RequestTiming(val send: ClockReading, val recv: ClockReading)
internal fun Engine.offset(replica: ReplicaState, serverTime: Long, timing: RequestTiming) {
    val (send, recv) = timing
    if (recv.jumped(send)) return
    val previous = replica.meta["clockReading"]?.let(::ClockReading)
    val retained = if (previous != null && recv.jumped(previous)) emptyList() else replica.meta.items("offsetSamples")
    val sample = Json.objectOf("offset" to Json.of(serverTime - Math.floorDiv(send.wall + recv.wall, 2)), "rtt" to Json.of(recv.mono - send.mono))
    val samples = (retained + sample).takeLast(Constants.OFFSET_SAMPLES)
    val best = samples.asReversed().minBy { it.member("rtt").long() }
    replica.meta = replica.meta.with("offsetSamples" to Json.Arr(samples), "clockReading" to recv.json, "serverOffsetMs" to best.member("offset"))
}
internal fun ReplicaState.servedAsOther(principal: Json?) = account != null && principal != Json.of(account!!)
internal fun ReplicaState.unauthenticated(response: SyncResponse) = response.status == 401 ||
    response.status == 409 && response.body?.get("error") == Json.of("account-mismatch") ||
    response.status in setOf(200, 409) && servedAsOther(response.body?.get("as"))
internal fun Engine.heldBack(replica: ReplicaState): Set<Entry> {
    val sources = Dependents(registry)
    val touched = mutableSetOf<Pair<ScopeRef, RecordKey>>()
    val back = mutableSetOf<Entry>()
    for (entry in replica.entries()) {
        if (entry.state == "ready") {
            val keys = (entry.deltas.map { it.key } + entry.intent.guards.map { it.key }).map { entry.scope to it }
            if (sources.of(entry).any || keys.any { it in touched }) { back.add(entry); touched.addAll(keys) }
        }
        if (entry.state == "held" || entry in back || entry.json["orphanOf"] != null && entry.state in setOf("sent", "ready")) sources.absorb(entry.scope, entry.deltas, entry.stamp)
    }
    return back
}
internal fun ReplicaState.pushRequest(intents: List<Intent>) = Json.objectOf("replica" to Json.of(id), "account" to Json.of(account!!),
    "ackThrough" to meta.member("ackThrough"), "intents" to Json.Arr(intents.map { it.json }))
fun Engine.nextPush(limit: Int = Constants.PUSH_MAX_INTENTS): Json? = write(EngineOperation.push) { replica ->
    require(limit > 0)
    if (replica.state != "bound" || replica.meta.flag("authPaused")) return@write null
    val max = minOf(Constants.PUSH_MAX_INTENTS, limit)
    fun sent() = replica.entries().filter { it.state == "sent" }.sortedBy { it.json.member("n").long() }
    if (sent().none { it.intent.command != null }) {
        val intents = sent().map { it.intent }.toMutableList()
        var back = heldBack(replica)
        for (entry in replica.entries().filter { it.state == "ready" }) {
            if (entry !in replica.outbox || entry.state != "ready") continue
            if (entry in back) { if (entry.intent.command != null) break; continue }
            val n = replica.meta.member("nextN").long()
            val intent = entry.intent.copy(n = n)
            if (replica.pushRequest(listOf(intent)).jcs.encodeToByteArray().size > pushMaxBytes) {
                refuse(replica, entry, "outgrown", "too-large"); back = heldBack(replica); continue
            }
            if (intents.size >= max || intents.isNotEmpty() && replica.pushRequest(intents + intent).jcs.encodeToByteArray().size > pushMaxBytes) break
            entry.intent = intent
            entry.json = entry.json.with("n" to Json.of(n), "digest" to Json.of(Sha256.hex(intent.json.jcs.encodeToByteArray())))
            replica.move(entry, "number", ended); replica.meta = replica.meta.with("nextN" to Json.of(n + 1)); intents.add(intent)
            if (intent.command != null) break
        }
    }
    sent().take(max).takeIf { it.isNotEmpty() }?.let { replica.pushRequest(it.map { it.intent }) }
}
fun Engine.onHello(response: SyncResponse, timing: RequestTiming) { write(EngineOperation.hello) { replica ->
    response.body?.get("serverTime")?.let { offset(replica, it.long(), timing) }
    if (replica.unauthenticated(response)) replica.meta = replica.meta.with("authPaused" to Json.of(true))
} }
fun Engine.onPushResponse(request: Json, response: SyncResponse, timing: RequestTiming, dieAfter: Int = Int.MAX_VALUE): Json? {
    val body = response.body
    val requestedReplica = request.member("replica").str()
    val proceed = write(EngineOperation.push) { _ ->
        val replica = device.replicas.firstOrNull { it.id == requestedReplica } ?: return@write false
        body?.get("serverTime")?.let { offset(replica, it.long(), timing) }
        if (replica.unauthenticated(response)) { replica.meta = replica.meta.with("authPaused" to Json.of(true)); false }
        else if (response.status == 409) { reidentify(replica); actor = identities.actorID(); false } else true
    }
    if (!proceed) return null
    if (response.status in setOf(400, 413)) return write(EngineOperation.push) { _ ->
        val replica = device.replicas.firstOrNull { it.id == requestedReplica } ?: return@write null
        if (response.status == 400) diagnostic(Json.objectOf("event" to Json.of("sync-push-malformed")))
        val intents = request.member("intents").arr()
        if (intents.size > 1) return@write Json.objectOf("limit" to Json.of((intents.size + 1) / 2))
        val n = intents.single().member("n").long()
        replica.entries().firstOrNull { it.state == "sent" && it.json.member("n").long() == n }?.let { entry ->
            replica.meta = replica.meta.with("nextN" to Json.of(n))
            replica.entries().filter { it.state == "sent" && it.json.member("n").long() > n }.forEach { replica.move(it, "rewind", ended) }
            onRefused(replica, entry, Json.objectOf("s" to Json.of("refused"), "code" to Json.of(if (response.status == 400) "invalid" else "too-large")), body ?: Json.objectOf())
        }; null
    }
    if (response.status != 200 || body == null) return null
    var left = dieAfter
    val results = body.member("results").arr().sortedBy { it.member("n").long() }
    var from = 0
    do {
        if (left <= 0) return null
        val size = if (dieAfter == Int.MAX_VALUE) writerSlices.resultsPerBatch else 1
        val to = minOf(results.size, from + size)
        var started = 0L
        val handled = write(EngineOperation.push) { _ ->
            val replica = device.replicas.firstOrNull { it.id == requestedReplica } ?: return@write 0
            started = System.nanoTime()
            var recorded = 0
            for (result in results.subList(from, to)) {
                val entry = replica.entries().firstOrNull { it.state == "sent" && it.json.member("n") == result.member("n") } ?: continue
                if (replica.meta["serverEpoch"] === Json.Null) replica.meta = replica.meta.with("serverEpoch" to body.member("epoch"))
                if (result.member("s").str() == "refused") onRefused(replica, entry, result, body)
                else {
                    applyIntentResultDeviceWrites(replica, entry.intent, entry.gestureId, PushResult(result), body.member("epoch").str())
                    replica.move(entry, "ok", ended)
                    entry.json = entry.json.with("resultSeq" to result.member("seq"), "resultEpoch" to body.member("epoch"))
                    raiseAdmittedHigh(replica, entry.intent.deltas.flatMap { it.lattice.stamps })
                    result["write"]?.let { applyWriteMap(replica, entry, it.arr()) }
                    resolveIfCovered(replica, entry)
                }
                recorded++
            }
            if (to == results.size) {
                if (replica.meta["serverEpoch"] === Json.Null) replica.meta = replica.meta.with("serverEpoch" to body.member("epoch"))
                replica.meta = replica.meta.with("ackThrough" to body.member("lastN"))
                if (replica.meta.member("serverEpoch") != body.member("epoch")) epochChange(replica, body.member("epoch").str())
            }
            recorded
        }
        val held = System.nanoTime() - started
        if (dieAfter == Int.MAX_VALUE) lock.withLock { writerSlices.recordResults(handled, held) }
        left -= handled; from = to
    } while (from < results.size)
    return null
}

class SenderWait {
    var k = 0; private set
    var until = 0L; private set
    var floor = 0L; private set
    var afterSkew = false; private set
    internal fun snapshot() = Triple(k, until, afterSkew)
    internal fun restoreBackoff(earlier: Triple<Int, Long, Boolean>) { k = earlier.first; until = maxOf(floor, earlier.second); afterSkew = earlier.third }
    fun backoff(now: Long, draw: (Int) -> Int, liveHint: Boolean = false, afterSkew: Boolean = false) {
        until = maxOf(floor, now + draw(minOf(if (liveHint) 30_000L else 300_000L, 1_000L shl minOf(k, 9)).toInt()))
        k++; this.afterSkew = afterSkew
    }
    fun unavailable(now: Long, retryAfterMs: Long, draw: (Int) -> Int, liveHint: Boolean = false) { floor = now + retryAfterMs; backoff(now, draw, liveHint) }
    fun retry(now: Long, retryAfterMs: Long) { floor = now + retryAfterMs; until = maxOf(until, floor) }
    fun results(codes: List<String>, now: Long, draw: (Int) -> Int, liveHint: Boolean = false) {
        if ("clock-skew" in codes) backoff(now, draw, liveHint, true) else if (codes.isNotEmpty()) k = 0
    }
    fun kick(now: Long) { if (afterSkew && now < until) return; k = 0; until = maxOf(now, floor); afterSkew = false }
    fun due(now: Long) = now >= until
    fun leaveMayPush(now: Long) = now >= floor
}

internal fun Engine.applyIntentResultDeviceWrites(replica: ReplicaState, intent: Intent, gestureId: String,
    result: PushResult, epoch: String) {
    val product = registry.product(intent.scope) ?: return
    val rows = replica.device[product]?.obj().orEmpty().toMutableMap()
    for (write in intentResultWrites(intent, result, epoch, gestureId, rows.toMap())) {
        if (registry.products[product]?.get("device")?.obj()?.values?.none { Pattern(it.member("keyPattern").str()).matches(write.key) } != false)
            throw works.windmill.sync.api.CommitFailure.malformed("device-key")
        if (write.value == null) rows.remove(write.key) else rows[write.key] = write.value!!
    }
    if (rows.isEmpty()) replica.device.remove(product) else replica.device[product] = Json.Obj(rows.toList())
}
