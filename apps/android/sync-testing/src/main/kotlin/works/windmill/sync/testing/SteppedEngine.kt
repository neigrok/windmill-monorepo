package works.windmill.sync.testing

import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.Command
import works.windmill.sync.engine.*

// Step mode uses the engine's public API and memory store; no loop or background scheduler starts.
class SteppedEngine private constructor(private val registry: Registry, snapshot: Json?, private val draws: List<Int>, pushMaxBytes: Int,
    val clock: SimClock, private val seed: Long, private val account: String?, shared: Fleet?, rules: works.windmill.sync.modelserver.ServerRules, private val legacyDraws: Boolean) : AutoCloseable {
    private class Fleet(val clock: SimClock, val server: ModelServerHandle, val seed: Long) {
        val devices = mutableListOf<SteppedEngine>()
        var joined = 0
    }
    constructor(registry: Registry, snapshot: Json? = null, draws: List<Int> = emptyList(), pushMaxBytes: Int = Constants.PUSH_MAX_BYTES) :
        this(registry, snapshot, draws, pushMaxBytes, SimClock(), 117, "acct-1", null, works.windmill.sync.modelserver.NoServerRules(), true)
    constructor(registry: Registry, startMs: Long, seed: Long = 1, account: String? = "acct-1", rules: works.windmill.sync.modelserver.ServerRules = works.windmill.sync.modelserver.NoServerRules()) :
        this(registry, null, emptyList(), Constants.PUSH_MAX_BYTES, SimClock(startMs), seed, account,
            null, rules, false)
    private val fleet = shared ?: Fleet(clock, ModelServerHandle(works.windmill.sync.modelserver.ModelServer(registry, rules), SimClock(clock.now())), seed)
    var now: Long get() = clock.now(); set(value) { clock.jump(value - clock.now()) }
    var gestures = 0
    var drawIndex = 0
    private var closed = false
    private val random = java.util.Random(seed)
    val engine = Engine.memory(registry, snapshot, clock, object : IdentitySource {
        override fun opaqueID() = if (legacyDraws) "g${++gestures}" else "seed-$seed-g${++gestures}"
        override fun draw(bound: Int): Int {
            val index = drawIndex++
            val value = if (draws.isEmpty()) { if (legacyDraws) java.util.Random(seed + index).nextInt(bound) else random.nextInt(bound) }
                else draws.getOrNull(index) ?: error("draw-queue-exhausted")
            return value.also { require(it in 0 until bound) }
        }
    }, if (legacyDraws) "r_aaaaaaaaaaaa" else "r_${java.lang.Long.toUnsignedString(seed, 16).padStart(16, '0')}", pushMaxBytes)
    val replica: Replica get() = engine
    val server: ModelServerHandle get() = fleet.server
    val transport = InMemoryTransport(fleet.server, clock)
    private var steps: EngineSteps? = null
    init {
        fleet.joined++; fleet.devices.add(this)
        if (!legacyDraws) steps = EngineIntegration.factory.create(engine, transport, clock).also { it.start(account) }
    }
    fun device(): SteppedEngine {
        check(!closed)
        return SteppedEngine(registry, null, emptyList(), Constants.PUSH_MAX_BYTES, clock, fleet.seed + fleet.joined, account, fleet, works.windmill.sync.modelserver.NoServerRules(), false)
    }
    fun senderStep(): Boolean = (steps ?: error(EngineIntegration.waitsFor)).senderStep()
    fun pullerStep(): Boolean = (steps ?: error(EngineIntegration.waitsFor)).pullerStep()
    fun sync() {
        check(!closed)
        val active = fleet.devices.filter { !it.closed }
        check(active.all { it.steps != null }) { EngineIntegration.waitsFor }
        repeat(10_000) {
            var moved = false
            for (device in active) {
                moved = device.steps!!.senderStep() || moved
                moved = device.steps!!.pullerStep() || moved
            }
            if (!moved) return
        }
        error("step-mode-did-not-quiesce")
    }
    fun advance(ms: Long) { check(!closed); clock.advance(ms); if (fleet.server.clock !== clock) fleet.server.clock.advance(ms); fleet.devices.filter { !it.closed }.forEach { it.engine.releaseHeld() } }
    fun leave() { check(!closed); (steps ?: error(EngineIntegration.waitsFor)).leave() }
    fun failNextCommit() = engine.failNextCommit()
    fun drawn(scope: ScopeRef, type: String) = engine.read(scope) { it.drawn(type) }
    fun stored(scope: ScopeRef, type: String) = engine.read(scope) { it.stored(type) }
    fun drawn(scope: ScopeRef, type: String, field: String, id: RecordID) = engine.read(scope) { it.drawn(type, field, id) }
    fun stored(scope: ScopeRef, type: String, field: String, id: RecordID) = engine.read(scope) { it.stored(type, field, id) }
    fun notices(product: String): List<Notice> {
        val snapshot = engine.snapshot()
        val active = snapshot.member("active")
        val replica = snapshot.member("replicas").arr().single { it.member("meta").member("replica") == active }
        fun content(json: Json): NoticeContent = NoticeContent(json["d"]?.arr()?.map(::Delta).orEmpty(), json["cmd"]?.let(::Command), json["dependents"]?.arr()?.map(::content).orEmpty())
        return replica["notices"]?.arr().orEmpty().map { json ->
            val scope = ScopeRef(json.member("scope"))
            Notice(json.member("id").str(), registry.product(scope)!!, scope, RefusalCode(json.member("code").str()), json["detail"], content(json.member("content")), json.member("at").long(), json["dismissed"]?.bool() ?: false)
        }.filter { it.product == product && !it.isDismissed }
    }
    fun undoOffers() = engine.undoOffers()
    fun skewRefusals() = (steps ?: error(EngineIntegration.waitsFor)).skewRefusals()
    override fun close() {
        if (closed) return
        closed = true
        try { steps?.close() } finally {
            transport.close(); engine.close()
            if (fleet.devices.all { it.closed }) { clock.close(); fleet.server.clock.close() }
        }
    }
}

object ClientCorpus {
    fun handlers(probe: Registry): Map<String, Handler> {
        val paths = listOf("commit/deltas.json", "commit/ids.json", "commit/guards.json", "commit/supersede.json")
        return paths.associateWith { { input: Json -> steps(probe, input) } } + mapOf(
            "view/drawn.json" to { input: Json -> view(probe, input, ViewMode.drawn) },
            "view/stored.json" to { input: Json -> view(probe, input, ViewMode.stored) })
    }
    fun change(json: Json): Change {
        val type = json.member("t").str()
        val op = json.member("op").str()
        val values = json["f"]?.obj().orEmpty()
        val texts = json["x"]?.obj()?.mapValues { (_, value) ->
            if (value is Json.Str) TextEdit(value.value) else TextEdit(value.member("text").str(), value["from"]?.str())
        }.orEmpty()
        val anchor = json["anchor"]?.let { OrderAnchor(it.member("field").str(), it.member("below").orNull()?.let(::RecordID)) }
        if (op == "create") return Change.create(type, json["id"]?.let { NewID.Given(RecordID(it)) } ?: json["label"]?.let { NewID.Derived(it.str()) } ?: NewID.Minted, values, texts, anchor)
        val id = RecordID(json.member("id"))
        val operation = when (op) {
            "update" -> Change.Operation.Update(id); "delete" -> Change.Operation.Delete(id); "revive" -> Change.Operation.Revive(id)
            "put" -> Change.Operation.Put(id, json["present"]?.bool() ?: true); "write" -> Change.Operation.Write(id); "move" -> Change.Operation.Move(id)
            else -> throw CommitFailure.malformed("operation")
        }
        return Change(type, operation, values, texts, anchor)
    }
    fun gesture(changes: Json, opts: Json = Json.objectOf()): Gesture = Gesture(changes.arr().map(::change),
        opts["atomic"]?.bool() ?: false, opts["hold"]?.bool() ?: false,
        opts["guard"]?.arr()?.map { RegisterRef(it.member("t").str(), RecordID(it.member("id")), it.member("field").str()) }.orEmpty(),
        opts["retire"]?.arr()?.map { RecordRef(it.member("t").str(), RecordID(it.member("id"))) }.orEmpty(),
        opts["supersede"]?.arr()?.map { it.str() }.orEmpty(), opts["cmd"]?.let(::Command),
        opts["predict"]?.arr()?.map(::change).orEmpty(), opts["local"]?.obj()?.map { DeviceWrite(it.key, it.value.orNull()) }.orEmpty(), opts["gestureId"]?.str())
    fun outcome(result: CommitOutcome): Json = when (result) {
        is CommitOutcome.Committed -> Json.Obj(buildList {
            add("localIds" to Json.Arr(result.receipt.localIds.map(Json::of))); add("retired" to Json.Arr(result.receipt.retired.map(Json::of))); add("stamp" to result.receipt.stamp.json)
            if (result.receipt.superseded.isNotEmpty()) add("superseded" to Json.Arr(result.receipt.superseded.map(Json::of)))
        })
        is CommitOutcome.Refused -> Json.Obj(buildList { add("refused" to Json.of(result.code.text)); result.detail?.let { add("detail" to it) } })
    }
    fun steps(registry: Registry, input: Json): Json {
        SteppedEngine(registry, input.member("device"), input["draws"]?.arr()?.map { it.long().toInt() }.orEmpty(), input["limits"]?.get("PUSH_MAX_BYTES")?.long()?.toInt() ?: Constants.PUSH_MAX_BYTES).use { stepped ->
            val results = input.member("steps").arr().map { step ->
                stepped.now = step["deviceNow"]?.long() ?: 0
                val beforeGesture = stepped.gestures; val beforeDraw = stepped.drawIndex
                try {
                    when (step.member("op").str()) {
                        "commit" -> if (step["changes"] === Json.Null) {
                            stepped.engine.commit(ScopeRef(step.member("scope"))) { null to Unit }; Json.Null
                        } else outcome(stepped.engine.commit(ScopeRef(step.member("scope")), gesture(step["changes"] ?: Json.array(), step["opts"] ?: Json.objectOf())))
                        "undo" -> Json.of(stepped.engine.undo(step.member("gestureId").str()))
                        "releaseAll" -> { stepped.engine.releaseHeld(true); Json.Null }
                        "releaseDue" -> { stepped.engine.releaseHeld(); Json.Null }
                        "release" -> Json.of(stepped.engine.release(step.member("localId").str()))
                        "dismiss" -> { stepped.engine.dismissNotice(step.member("id").str()); Json.Null }
                        "view" -> {
                            val scope = ScopeRef(step.member("scope"))
                            val shown = stepped.engine.materialized(scope, if (step.member("withHeld").bool()) ViewMode.drawn else ViewMode.stored)
                            val caps = registry.types.filter { registry.lives(it.name, scope) && it.cap != null }.map { type ->
                                type.name to Json.of(stepped.engine.read(scope) { it.stored(type.name).size })
                            }
                            Json.objectOf("records" to shown.member("records"), "capCount" to Json.Obj(caps))
                        }
                        else -> error("unimplemented client step: ${step.member("op").str()}")
                    }
                } catch (_: CommitFailure) {
                    stepped.gestures = beforeGesture; stepped.drawIndex = beforeDraw
                    Json.objectOf("throws" to Json.of(true))
                } catch (_: TransitionError) {
                    stepped.gestures = beforeGesture; stepped.drawIndex = beforeDraw
                    Json.objectOf("throws" to Json.of(true))
                }
            }
            return Json.objectOf("returns" to Json.Arr(results), "device" to stepped.engine.snapshot(), "ended" to Json.Arr(stepped.engine.ended()))
        }
    }
    fun view(registry: Registry, input: Json, mode: ViewMode): Json {
        val replica = input.member("replica")
        val device = Json.objectOf("active" to replica.member("meta").member("replica"), "replicas" to Json.array(replica))
        SteppedEngine(registry, device).use { stepped ->
            val scope = ScopeRef(input.member("scope"))
            val view = stepped.engine.materialized(scope, mode)
            if (mode == ViewMode.drawn) return view
            val caps = registry.types.filter { registry.lives(it.name, scope) && it.cap != null }.map { type ->
                type.name to Json.of(stepped.engine.read(scope) { it.stored(type.name).count { row -> row.isVisible } })
            }
            return Json.Obj(view.obj().toList() + ("capCount" to Json.Obj(caps)))
        }
    }
}
