package works.windmill.sync.modelserver

import works.windmill.sync.core.*

data class LiveEvent(val key: ScopeKey, val frame: Json? = null, val dead: Boolean = false) {
    val json: Json get() = Json.objectOf("key" to Json.of(key.text)).with(if (dead) "dead" to Json.of(true) else "frame" to frame)
    companion object {
        fun change(key: ScopeKey, epoch: String, seq: Long, digest: ScopeDigest, rows: List<Row>, inlineLimit: Int): LiveEvent {
            val page = Json.Arr(rows.sortedBy { it.key }.map { it.pageForm.json })
            val frame = Json.objectOf("op" to Json.of("change"), "scope" to key.ref.json, "epoch" to Json.of(epoch), "seq" to Json.of(seq), "digest" to Json.of(digest.hex))
                .with("rows" to page.takeIf { it.jcs.encodeToByteArray().size <= inlineLimit })
            return LiveEvent(key, frame)
        }
    }
}
internal class Feed(val registry: Registry, val limits: ServerLimits) {
    fun page(requested: String, cursor: String?, account: String?, state: ServerState): Json {
        fun answer(kind: String) = Json.objectOf("scope" to Json.of(requested), "kind" to Json.of(kind))
        val ref = try { ScopeRef(requested) } catch (_: IllegalArgumentException) { return answer("not-found") }
        if (registry.scopeKind(ref) == null) return answer("not-found")
        val key = ScopeKey.resolve(ref, account) ?: return answer("not-found")
        val access = state.access(key, account, registry)
        if (access in listOf("not-found", "gone")) return answer(access)
        val record = state.scopes[key.text]; val seq = record?.seq ?: 0
        val rows = if (access == "absent") emptyList() else state.allFeedRows(key).sortedWith(compareBy<Row> { it.seq }.thenBy { it.key })
        val decoded = cursor?.let { try { WireCursor.decode(it) } catch (_: IllegalArgumentException) { return answer("reset") } }
        if (decoded != null && (decoded.epoch != state.epoch || decoded.seq > seq)) return answer("reset")
        val boot = access != "absent" && (decoded == null || decoded.mode == "boot")
        val asOf = if (boot) decoded?.at ?: seq else null
        val kept = if (boot) rows.filter { it.seq <= asOf!! && (it.lattice.life == null || it.isAlive || registry.type(it.key.type)?.identity == "derived") } else rows
        val remaining = kept.filter { row -> decoded?.let { after(row, it.seq, it.key) } ?: (boot || after(row, 0, null)) }
        val sent = mutableListOf<Row>(); var bytes = 0
        for (row in remaining) {
            val size = row.json.jcs.encodeToByteArray().size
            if (sent.isNotEmpty() && bytes + size > limits.pullPageBytes) break
            sent.add(row); bytes += size
        }
        val cut = sent.size < remaining.size; val last = sent.lastOrNull()
        val next = if (boot) {
            if (cut && last != null) WireCursor(state.epoch, "boot", last.seq, last.key, asOf) else WireCursor(state.epoch, "live", asOf!!)
        } else if (last == null) WireCursor(state.epoch, "live", decoded?.seq ?: 0)
        else WireCursor(state.epoch, "live", last.seq, if (cut && remaining[sent.size].seq == last.seq) last.key else null)
        return answer("rows").with("seq" to Json.of(seq), "digest" to Json.of((record?.digest ?: ScopeDigest.ZERO).hex), "rows" to Json.Arr(sent.map { it.json }), "cursor" to Json.of(next.text),
            "more" to Json.of(!(next.mode == "live" && next.key == null && next.seq == seq)), "total" to if (boot) Json.of(kept.size) else null,
            "header" to if (key.kind == "tree" && record != null) Json.objectOf("owner" to Json.objectOf("name" to Json.of(state.accounts[record.owner] ?: ""))) else null)
    }
    private fun after(row: Row, seq: Long, key: RecordKey?) = row.seq > seq || row.seq == seq && key != null && row.key > key
    fun holdsRecords(account: String, state: ServerState) = Json.Obj(registry.products.keys.map { product ->
        product to Json.of(state.rows["acct:$account/$product"].orEmpty().values.map(::Row).any { row ->
            val type = registry.type(row.key.type)!!
            type.json["primary"]?.bool() == true && visible(row, type)
        })
    })
    private fun visible(row: Row, type: TypeDef): Boolean = when {
        type.identity == "singleton" -> true; type.life -> row.isAlive
        type.json["visibleWhen"] == null -> row.lattice.fields.isNotEmpty() || row.texts.isNotEmpty()
        else -> type.json.member("visibleWhen").arr().any { name -> row.texts[name.str()]?.text?.isNotEmpty() ?: (row.lattice.fields[name.str()]?.value?.let { it !== Json.Null && it != Json.of("") } ?: false) }
    }
}
