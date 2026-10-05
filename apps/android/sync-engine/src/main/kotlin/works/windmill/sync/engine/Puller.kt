package works.windmill.sync.engine

import kotlin.concurrent.withLock
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.*

internal fun ReplicaState.cursorOf(scope: ScopeRef) = cursors[scope.text] ?: Json.objectOf("cursor" to Json.Null, "digest" to Json.of(ScopeDigest.ZERO.hex), "booted" to Json.of(false))
internal fun Json.cursor(): WireCursor? = this["cursor"]?.orNull()?.str()?.let(WireCursor::decode)
internal fun Engine.awaitsGoverningCreate(replica: ReplicaState, scope: ScopeRef): Boolean {
    if (scope.kind !is ScopeRef.Kind.Tree && scope.kind !is ScopeRef.Kind.Overlay) return false
    val type = registry.governingType ?: return false
    val id = scope.text.substringAfterLast('/')
    return replica.entries().any { it.state in setOf("held", "ready", "sent") && it.deltas.any { delta -> delta.key.type == type.name && delta.key.id.string == id && delta.creates } }
}
internal fun Engine.ignoresEnd(replica: ReplicaState, scope: ScopeRef, kind: String): Boolean {
    if (scope.kind is ScopeRef.Kind.Product) return true
    if (kind != "not-found") return false
    if (awaitsGoverningCreate(replica, scope)) return true
    val type = registry.governingType ?: return false
    if (scope.kind !is ScopeRef.Kind.Tree && scope.kind !is ScopeRef.Kind.Overlay) return false
    val product = registry.scopeOfType(type.name, scope) ?: return false
    val key = RecordKey(type.name, RecordID(scope.text.substringAfterLast('/')))
    return listOf(ViewMode.drawn, ViewMode.stored).any { view(replica, product, key, it)?.life?.isAlive == true }
}
fun Engine.pullRequest(scopes: Collection<ScopeRef>): Json? = write(EngineOperation.pull) { replica ->
    scopes.filter { !awaitsGoverningCreate(replica, it) }.takeIf { it.isNotEmpty() }?.let { pulled ->
        Json.objectOf("scopes" to Json.Arr(pulled.map { Json.objectOf("scope" to Json.of(it.text), "cursor" to replica.cursorOf(it).member("cursor")) }))
    }
}
internal fun ReplicaState.covers(entry: Entry): Boolean {
    val cursor = cursorOf(entry.scope).cursor() ?: return false
    return cursor.mode == "live" && entry.state == "acked" && entry.json["resultEpoch"] == meta["serverEpoch"] && entry.json.member("resultSeq").long() <= cursor.seq - if (cursor.key == null) 0 else 1
}
internal fun Engine.resolveIfCovered(replica: ReplicaState, entry: Entry) { if (replica.covers(entry)) replica.move(entry, "resolve", ended) }
internal fun Engine.settle(replica: ReplicaState, scope: ScopeRef, count: Int): Boolean {
    val covered = replica.entries().filter { it.scope == scope && replica.covers(it) }
    covered.take(count).forEach { replica.move(it, "resolve", ended) }
    return covered.size > count
}
internal fun Engine.checkDigest(replica: ReplicaState, scope: ScopeRef, received: Json, seq: Json, appVersion: String) {
    var record = replica.cursorOf(scope)
    if (record["digestStop"] != null) {
        if (record["digestStop"] == Json.of(appVersion)) return
        record = record.with("digestStop" to null)
    }
    if (record["digest"] == received) replica.cursors[scope.text] = record.with("mismatchReset" to null)
    else {
        diagnostic(Json.objectOf("event" to Json.of("sync-digest-mismatch"), "kind" to Json.of(if (scope.kind is ScopeRef.Kind.Product) "product" else if (scope.kind is ScopeRef.Kind.Tree) "tree" else "overlay"), "seq" to seq))
        replica.cursors[scope.text] = if (record.flag("mismatchReset")) record.with("digestStop" to Json.of(appVersion), "mismatchReset" to null)
        else record.with("cursor" to Json.Null, "mismatchReset" to Json.of(true))
    }
}
internal fun Engine.receiveRows(replica: ReplicaState, scope: ScopeRef, rows: List<Row>, staging: Boolean) {
    var digest = ScopeDigest(if (staging) replica.staging.getValue(scope.text).member("digest").str() else replica.cursorOf(scope).member("digest").str())
    for (row in rows) {
        val previous = if (staging) store.stagingRow(replica.id, scope, row.key) else store.row(replica.id, scope, row.key)
        if (previous != null && row.seq < previous.seq) continue
        val type = registry.type(row.key.type)
        val governed = if (type?.json?.get("governs") == Json.of("tree")) listOf(ScopeRef.tree(row.key.id.string!!), ScopeRef.overlay(row.key.id.string!!)) else emptyList()
        if (row.lattice.life?.isAlive == false) {
            if (type?.identity == "derived") {
                val spent = replica.spent[scope.text]?.arr().orEmpty().filter { it.recordKey != row.key }
                replica.spent[scope.text] = Json.Arr((spent + Json.objectOf("t" to Json.of(row.key.type), "id" to row.key.id.json, "born" to row.lattice.born!!.json)).sortedWith { a, b -> a.recordKey.compareTo(b.recordKey) })
            }
            governed.forEach { replica.known[it.text] = Json.of("gone") }
            if (staging) { store.removeStaging(replica.id, scope, row.key) } else store.remove(replica.id, scope, row.key)
            digest = digest.replacing(previous?.json, null)
        } else {
            governed.filter { replica.known[it.text] == Json.of("not-found") }.forEach { replica.known.remove(it.text) }
            if (staging) { store.putStaging(replica.id, scope, row) } else store.put(replica.id, scope, row)
            digest = digest.replacing(previous?.json, row.json)
        }
        changedRows.add(scope to row.key)
    }
    if (staging) replica.staging[scope.text] = Json.objectOf("digest" to Json.of(digest.hex))
    else replica.cursors[scope.text] = replica.cursorOf(scope).with("digest" to Json.of(digest.hex))
    observe(replica, rows.flatMap { it.stamps }); raiseAdmittedHigh(replica, rows.flatMap { it.stamps })
}
internal fun Engine.applyChunk(replica: ReplicaState, requested: Json, page: Json, rows: List<Row>, first: Boolean) {
    val scope = ScopeRef(page.member("scope"))
    val booting = requested === Json.Null || WireCursor.decode(requested.str()).mode == "boot"
    if (first && requested === Json.Null && store.hasRows(replica.id, scope)) {
        store.beginStaging(replica.id, scope)
        replica.staging[scope.text] = Json.objectOf("digest" to Json.of(ScopeDigest.ZERO.hex))
    }
    replica.cursors[scope.text] = replica.cursorOf(scope)
    receiveRows(replica, scope, rows, booting && scope.text in replica.staging)
    replica.cursors[scope.text] = replica.cursorOf(scope).with("behind" to Json.of(true))
}
internal fun Engine.finishPage(replica: ReplicaState, requested: Json, page: Json, count: Int, appVersion: String): Boolean {
    val scope = ScopeRef(page.member("scope")); val cursor = WireCursor.decode(page.member("cursor").str())
    var record = replica.cursorOf(scope).with("cursor" to page.member("cursor"), "behind" to page["more"]?.takeIf { it.bool() })
    val booting = requested === Json.Null || WireCursor.decode(requested.str()).mode == "boot"
    if (booting && cursor.mode == "live") {
        replica.staging.remove(scope.text)?.let { staged ->
            store.swapStaging(replica.id, scope)
            changedScopes.add(scope)
            record = record.with("digest" to staged.member("digest"))
        }
        record = record.with("booted" to Json.of(true))
    }
    replica.cursors[scope.text] = record
    val unsettled = settle(replica, scope, count)
    if (cursor.mode == "live" && cursor.key == null && cursor.seq == page.member("seq").long() && scope.text !in replica.staging) checkDigest(replica, scope, page.member("digest"), page.member("seq"), appVersion)
    return unsettled
}
data class PullSlicing(val chunkRows: Int = 128, val settle: Int = 64, val dieAfter: Int = Int.MAX_VALUE) {
    init { require(chunkRows > 0 && settle > 0 && dieAfter >= 0) }
}
fun Engine.onPullResponse(request: Json, response: SyncResponse, timing: RequestTiming, slicing: PullSlicing? = null, appVersion: String = "1", replicaID: String = activeReplica()): List<Json> {
    var pulledFor = replicaID
    val body = response.body
    val accepted = write(EngineOperation.pull) { replica ->
        if (device.active != pulledFor) return@write false
        body?.get("serverTime")?.let { offset(replica, it.long(), timing) }
        if (replica.unauthenticated(response)) { replica.meta = replica.meta.with("authPaused" to Json.of(true)); false }
        else if (response.status != 200 || body == null) false
        else {
            if (replica.meta["serverEpoch"] === Json.Null) replica.meta = replica.meta.with("serverEpoch" to body.member("epoch"))
            else if (replica.meta.member("serverEpoch") != body.member("epoch")) epochChange(replica, body.member("epoch").str())
            pulledFor = replica.id
            true
        }
    }
    if (!accepted || body == null) return emptyList()
    var left = slicing?.dieAfter ?: Int.MAX_VALUE
    val outcomes = mutableListOf<Json>()
    for (page in body.member("pages").arr()) {
        if (left <= 0) break
        val scope = ScopeRef(page.member("scope"))
        val requested = request.member("scopes").arr().single { it.member("scope") == page.member("scope") }.member("cursor")
        val early = write(EngineOperation.pull) { replica ->
            if (device.active != pulledFor || scope.text in replica.known || selectedScopes?.let { scope !in it } == true) "outside"
            else if (replica.cursorOf(scope).member("cursor") != requested) "stale"
            else when (val kind = page.member("kind").str()) {
                "reset" -> { replica.cursors[scope.text] = replica.cursorOf(scope).with("cursor" to Json.Null); replica.staging.remove(scope.text); store.dropStaging(replica.id, scope); left--; "reset" }
                "gone", "not-found" -> if (ignoresEnd(replica, scope, kind)) "ignored" else { forgetScope(replica, scope); replica.known[scope.text] = Json.of(kind); left--; kind }
                else -> null
            }
        }
        var outcome = early ?: "applied"
        if (early == null) {
            val rows = page.member("rows").arr().map(::Row)
            var from = 0
            var unsettled = false
            do {
                if (left <= 0) { outcome = "partial"; break }
                val size = slicing?.chunkRows ?: writerSlices.chunkRows(scope)
                val to = minOf(rows.size, from + size)
                val chunk = rows.subList(from, to)
                var started = 0L
                val applied = write(EngineOperation.pull) { replica ->
                    if (device.active != pulledFor || scope.text in replica.known || selectedScopes?.let { scope !in it } == true) {
                        outcome = "outside"; return@write null
                    }
                    if (replica.cursorOf(scope).member("cursor") != requested) {
                        outcome = "stale"; return@write null
                    }
                    started = System.nanoTime()
                    applyChunk(replica, requested, page, chunk, from == 0)
                    val finish = to == rows.size && finishPage(replica, requested, page, slicing?.settle ?: writerSlices.settleEntries, appVersion)
                    finish
                }
                val held = System.nanoTime() - started
                if (slicing == null && applied != null) lock.withLock { writerSlices.recordChunk(scope, chunk.size, held) }
                if (applied == null) break
                unsettled = applied; left--; from = to
            } while (from < rows.size)
            while (outcome == "applied" && unsettled) {
                if (left <= 0) { outcome = "unsettled"; break }
                var started = 0L
                var took = 0
                val settled = write(EngineOperation.pull) {
                    if (device.active != pulledFor) return@write null
                    val count = slicing?.settle ?: writerSlices.settleEntries
                    started = System.nanoTime()
                    val before = it.outbox.size
                    val more = settle(it, scope, count)
                    took = before - it.outbox.size
                    more
                }
                val held = System.nanoTime() - started
                if (slicing == null && settled != null) lock.withLock { writerSlices.recordSettle(took, held) }
                if (settled == null) { outcome = "outside"; break }
                unsettled = settled; left--
            }
        }
        outcomes.add(Json.objectOf("scope" to Json.of(scope.text), "outcome" to Json.of(outcome)))
    }
    return outcomes
}
fun Engine.onFrame(frame: Json, appVersion: String = "1", replicaID: String = activeReplica()): String = write(EngineOperation.live) { replica ->
    if (device.active != replicaID) return@write "outside"
    val op = frame.member("op").str()
    if (op !in setOf("change", "gone", "not-found")) return@write "ignored"
    if (replica.servedAsOther(frame["as"])) { replica.meta = replica.meta.with("authPaused" to Json.of(true)); return@write "paused" }
    val scope = ScopeRef(frame.member("scope"))
    if (scope.text in replica.known || selectedScopes?.let { scope !in it } == true) return@write "outside"
    if (op in setOf("gone", "not-found")) {
        if (ignoresEnd(replica, scope, op)) return@write "ignored"
        forgetScope(replica, scope); replica.known[scope.text] = Json.of(op); return@write op
    }
    val record = replica.cursorOf(scope); val cursor = record.cursor()
    val inline = cursor != null && cursor.mode == "live" && cursor.key == null && !record.flag("behind") && frame["epoch"] == replica.meta["serverEpoch"] && frame.member("seq").long() == cursor.seq + 1 && frame["rows"] != null
    if (!inline) return@write "pull"
    val page = Json.objectOf("scope" to Json.of(scope.text), "kind" to Json.of("rows"), "rows" to frame.member("rows"),
        "cursor" to Json.of(WireCursor(frame.member("epoch").str(), "live", frame.member("seq").long()).text), "more" to Json.of(false), "seq" to frame.member("seq"), "digest" to frame.member("digest"))
    applyChunk(replica, record.member("cursor"), page, page.member("rows").arr().map(::Row), true)
    finishPage(replica, record.member("cursor"), page, Int.MAX_VALUE, appVersion)
    "applied"
}
