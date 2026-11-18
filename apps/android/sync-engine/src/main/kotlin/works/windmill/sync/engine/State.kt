package works.windmill.sync.engine

import works.windmill.sync.core.*

internal fun Json.items(key: String): List<Json> = get(key)?.arr() ?: emptyList()
internal fun Json.fields(key: String): Map<String, Json> = get(key)?.obj() ?: emptyMap()
internal fun Json.flag(key: String): Boolean = get(key)?.bool() ?: false
internal val Json.recordKey: RecordKey get() = RecordKey(member("t").str(), RecordID(member("id")))

// One scope's share of an opted command's prediction (§7.1 step 4). It draws over that scope's confirmed rows until
// the scope covers the command's accepted `resultSeq` (§7.5), and stays, covered, while the command's other scopes wait.
internal data class Projection(val scope: ScopeRef, val deltas: List<Delta>, val resultSeq: Long? = null, val covered: Boolean = false) {
    constructor(json: Json) : this(ScopeRef(json.member("scope")), json.member("d").arr().map(::Delta), json["resultSeq"]?.long(), json["covered"]?.bool() ?: false)
    val json: Json get() = Json.Obj(buildList {
        add("scope" to scope.json); add("d" to Json.Arr(deltas.map(Delta::json)))
        resultSeq?.let { add("resultSeq" to Json.of(it)) }
        if (covered) add("covered" to Json.of(true))
    })
}

// Every view reads the deltas of every entry, so an entry decodes its intent and predictions once:
// Json is immutable, and a value is decoded again only when the entry holds a different instance.
internal class Entry(var json: Json) {
    private class Decoded<T>(val source: Json, val value: T)
    private var decodedIntent: Decoded<Intent>? = null
    private var decodedPredict: Decoded<List<Delta>>? = null
    private var decodedPredictions: Decoded<List<Projection>>? = null
    private var decodedEffects: Decoded<List<ScopedDeltas>>? = null
    private var decodedActive: Decoded<List<ScopedDeltas>>? = null
    private fun <T> Decoded<T>?.of(source: Json, decode: (Json) -> T): Decoded<T> =
        this?.takeIf { it.source === source } ?: Decoded(source, decode(source))
    val id get() = json.member("localId").str()
    val gestureId get() = json.member("gestureId").str()
    val scope get() = ScopeRef(json.member("scope"))
    val stamp get() = Stamp(json.member("stamp").str())
    val order get() = json.member("commitOrder").long()
    var state: String
        get() = json.member("state").str()
        set(value) { json = json.with("state" to Json.of(value)) }
    var intent: Intent
        get() = decodedIntent.of(json.member("intent"), ::Intent).also { decodedIntent = it }.value
        set(value) { json = json.with("intent" to value.json) }
    var predict: List<Delta>
        get() = json["predict"]?.let { source -> decodedPredict.of(source) { it.arr().map(::Delta) }.also { decodedPredict = it }.value }.orEmpty()
        set(value) { json = json.with("predict" to value.takeIf { it.isNotEmpty() }?.let { Json.Arr(it.map(Delta::json)) }) }
    // An opted command's projections, its origin's first and always present; null for every other entry, which keeps `predict`.
    var predictions: List<Projection>?
        get() = json["predictions"]?.let { source -> decodedPredictions.of(source) { it.arr().map(::Projection) }.also { decodedPredictions = it }.value }
        set(value) { json = json.with("predictions" to value?.let { Json.Arr(it.map(Projection::json)) }) }
    // The versions an opted command's receipt accepted, kept for a replay to rebase on (§7.4).
    var acceptedEffects: List<EffectReceipt>
        get() = json.items("acceptedEffects").map(::EffectReceipt)
        set(value) { json = json.with("acceptedEffects" to value.takeIf { it.isNotEmpty() }?.let { Json.Arr(it.map(EffectReceipt::json)) }) }
    // What the entry predicts, by scope: an opted command's projections, or a command's legacy `predict` in its origin.
    val predicted: List<ScopedDeltas> get() = predictions?.map { ScopedDeltas(it.scope, it.deltas) } ?: listOf(ScopedDeltas(scope, predict))
    // Every delta the entry holds, by scope: its intent belongs to its origin. Dependency and identity recovery read them all.
    val effects: List<ScopedDeltas> get() = decodedEffects.of(json) { stored(active = false) }.also { decodedEffects = it }.value
    // The deltas views draw: an opted command's covered projections no longer do, its intent leaves with its origin's, and once its
    // receipt applies its intent draws at the versions the server accepted.
    val active: List<ScopedDeltas> get() = decodedActive.of(json) { stored(active = true) }.also { decodedActive = it }.value
    private fun stored(active: Boolean): List<ScopedDeltas> {
        val predictions = predictions ?: return listOf(ScopedDeltas(scope, intent.deltas + predict))
        val ordinary = if (active) acceptedOrdinary() else intent.deltas
        return predictions.filter { !active || !it.covered }.map { ScopedDeltas(it.scope, (if (it.scope == scope) ordinary else emptyList()) + it.deltas) }
    }
    // Copies of the numbered intent's deltas, each register its origin receipt versions at that version; the intent itself never changes.
    private fun acceptedOrdinary(): List<Delta> {
        val rows = acceptedEffects.firstOrNull { it.scope == scope }?.rows.orEmpty()
        return intent.deltas.map { delta ->
            rows.firstOrNull { it.key == delta.key }?.slots.orEmpty().fold(delta) { accepted, slot ->
                val stamp = slot.stamp ?: return@fold accepted
                val lattice = accepted.lattice
                val versioned = when (slot.kind) {
                    Slot.Kind.born -> Lattice(lattice.life, lattice.born?.let { stamp }, lattice.fields)
                    Slot.Kind.life -> Lattice(lattice.life?.copy(stamp = stamp), lattice.born, lattice.fields)
                    else -> Lattice(lattice.life, lattice.born, lattice.fields.mapValues { (name, register) -> if (name == slot.name) register.copy(stamp = stamp) else register })
                }
                accepted.copy(lattice = versioned)
            }
        }
    }
    val deltas: List<Delta> get() = effects.flatMap { it.deltas }
    fun activeDeltas(scope: ScopeRef): List<Delta> = active.filter { it.scope == scope }.flatMap { it.deltas }
    // One projection a scope after a remap gives two the same scope: their deltas join, and the scope is covered only when both were.
    fun mergePredictions() {
        val groups = predictions?.groupBy { it.scope } ?: return
        predictions = EffectReceipt.ordered(scope, groups.keys).map { target ->
            val values = groups[target].orEmpty()
            Projection(target, values.flatMap { it.deltas }, values.mapNotNull { it.resultSeq }.maxOrNull(), values.isNotEmpty() && values.all { it.covered })
        }
    }
}

internal data class OutboxDelta(val entry: Entry, val delta: Delta)

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
        texts[name.str()]?.let { return@any !TextWhitespace.isBlank(it.text) }
        val value = texts[name.str()]?.let { Json.of(it.text) } ?: lattice.fields[name.str()]?.value
        value != null && value !== Json.Null && value != Json.of("")
    }
}
internal data class TextValueState(val text: String, val merged: Boolean, val pending: Boolean)
