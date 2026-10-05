package works.windmill.sync.engine

import works.windmill.sync.core.*

internal fun Json.with(vararg pairs: Pair<String, Json?>): Json = Json.Obj(obj().toMutableMap().apply {
    for ((key, value) in pairs) if (value == null) remove(key) else put(key, value)
}.toList())
internal fun Json.items(key: String): List<Json> = get(key)?.arr() ?: emptyList()
internal fun Json.fields(key: String): Map<String, Json> = get(key)?.obj() ?: emptyMap()
internal fun Json.flag(key: String): Boolean = get(key)?.bool() ?: false
internal val Json.recordKey: RecordKey get() = RecordKey(member("t").str(), RecordID(member("id")))

internal class Entry(var json: Json) {
    val id get() = json.member("localId").str()
    val gestureId get() = json.member("gestureId").str()
    val scope get() = ScopeRef(json.member("scope"))
    val stamp get() = Stamp(json.member("stamp").str())
    val order get() = json.member("commitOrder").long()
    var state: String
        get() = json.member("state").str()
        set(value) { json = json.with("state" to Json.of(value)) }
    var intent: Intent
        get() = Intent(json.member("intent"))
        set(value) { json = json.with("intent" to value.json) }
    var predict: List<Delta>
        get() = json.items("predict").map(::Delta)
        set(value) { json = json.with("predict" to value.takeIf { it.isNotEmpty() }?.let { Json.Arr(it.map(Delta::json)) }) }
    val deltas get() = intent.deltas + predict
}

internal class ReplicaState(input: Json) {
    var meta = input.member("meta")
    val id get() = meta.member("replica").str()
    val state get() = meta.member("state").str()
    val account get() = meta["account"]?.str()
    val outbox = input.items("outbox").map(::Entry).toMutableList()
    val notices = input.items("notices").toMutableList()
    val cursors = input.fields("cursors").toMutableMap()
    val known = input.fields("known").toMutableMap()
    val spent = input.fields("spentIds").toMutableMap()
    val staging = input.fields("staging").toMutableMap()
    val device = input.fields("device").toMutableMap()
    fun entries() = outbox.sortedBy { it.order }
    fun copy() = ReplicaState(json())
    fun json(): Json = Json.Obj(buildList {
        add("meta" to meta)
        if (outbox.isNotEmpty()) add("outbox" to Json.Arr(entries().map { it.json }))
        if (notices.isNotEmpty()) add("notices" to Json.Arr(notices))
        for ((key, values) in listOf("cursors" to cursors, "known" to known, "spentIds" to spent, "staging" to staging, "device" to device)) {
            if (values.isNotEmpty()) add(key to Json.Obj(values.toList()))
        }
    })
    fun move(entry: Entry, event: String, ended: MutableList<Json>, orphan: String? = null) {
        val next = Machines.intent.transition(entry.state, event)
        if (next in setOf("undone", "resolved", "refused", "discarded")) {
            outbox.remove(entry)
            ended.add(Json.Obj(buildList {
                add("localId" to Json.of(entry.id)); add("outcome" to Json.of(next)); add("event" to Json.of(event))
                (orphan ?: entry.json["orphanOf"]?.str())?.let { add("orphanOf" to Json.of(it)) }
            }))
        } else {
            entry.state = next
            if (next == "ready") {
                entry.json = entry.json.with("n" to null, "digest" to null, "resultSeq" to null, "resultEpoch" to null)
                entry.intent = entry.intent.copy(n = null)
            }
        }
    }
}

internal class DeviceState(input: Json) {
    var meta = input["meta"] ?: Json.objectOf()
    var active = input.member("active").orNull()?.str()
    val replicas = input.items("replicas").map(::ReplicaState).toMutableList()
    fun current(): ReplicaState = replicas.firstOrNull { it.id == active }
        ?: throw IllegalStateException("no-active-replica")
    fun copy() = DeviceState(json())
    fun json(): Json = Json.Obj(buildList {
        if (meta.obj().isNotEmpty()) add("meta" to meta)
        add("active" to (active?.let(Json::of) ?: Json.Null))
        add("replicas" to Json.Arr(replicas.sortedWith { a, b -> compareBytes(a.id, b.id) }.map { it.json() }))
    })
    fun carriesGesture(id: String) = replicas.any { replica -> replica.outbox.any { it.gestureId == id } ||
        replica.notices.any { notice -> notice.member("id").str().removePrefix("notice:").substringBeforeLast('/') == id } }
}

internal fun freshReplica(id: String, account: String? = null) = ReplicaState(Json.objectOf("meta" to Json.Obj(buildList {
    add("replica" to Json.of(id)); add("state" to Json.of(if (account == null) "anon" else "bound"))
    add("nextN" to Json.of(1)); add("hlc" to Hlc().json); add("hlcHigh" to Stamp.UNSET.json); add("admittedHigh" to Stamp.UNSET.json)
    add("serverOffsetMs" to Json.of(0)); add("offsetSamples" to Json.array()); add("serverEpoch" to Json.Null)
    add("ackThrough" to Json.of(0)); add("authPaused" to Json.of(false)); account?.let { add("account" to Json.of(it)) }
})))

internal fun isVisible(type: TypeDef?, lattice: Lattice, texts: Map<String, TextValueState>): Boolean = when {
    type == null -> false
    type.identity == "singleton" -> true
    type.life -> lattice.life?.isAlive == true
    type.json["visibleWhen"] == null -> lattice.fields.isNotEmpty() || texts.isNotEmpty()
    else -> type.json.member("visibleWhen").arr().any { name ->
        val value = texts[name.str()]?.let { Json.of(it.text) } ?: lattice.fields[name.str()]?.value
        value != null && value !== Json.Null && value != Json.of("")
    }
}
internal data class TextValueState(val text: String, val merged: Boolean, val pending: Boolean)
