package works.windmill.domain.testing

import java.io.File
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.api.*
import works.windmill.sync.testing.Vector
import works.windmill.sync.testing.Record

class ContractError(message: String) : IllegalArgumentException(message)

object Contract {
    fun root(from: File = File(System.getProperty("user.dir"))): File {
        System.getProperty("windmill.contract")?.let { return File(it) }
        var directory: File? = if (from.isFile) from.parentFile else from
        while (directory != null) {
            val found = File(directory, "packages/api-contract")
            if (found.isDirectory) return found
            directory = directory.parentFile
        }
        throw ContractError("no packages/api-contract above $from")
    }
    fun json(path: String): Json = Json.parse((File(path).takeIf { it.isAbsolute } ?: File(root(), path)).readBytes())
    fun vectors(path: String): List<Vector> {
        val names = mutableSetOf<String>()
        return json(path).arr().map {
            it.expectKeys(listOf("name", "input", "expect"))
            val name = it.member("name").str()
            require(names.add(name)) { "duplicate vector $path · $name" }
            Vector(path, name, it.member("input"), it.member("expect"))
        }
    }
    fun files(directory: String): List<String> {
        val base = File(root(), directory)
        require(base.isDirectory) { "no directory $directory" }
        return base.walkTopDown().filter { it.isFile && it.extension == "json" }
            .map { "$directory/${it.relativeTo(base).invariantSeparatorsPath}" }.toList().sorted()
    }
}

// Confirmed records listed by each view; the engine ER-17 factory performs visibility and text decoding.
data class VectorRecords(val drawn: List<works.windmill.sync.api.Record>, val stored: List<works.windmill.sync.api.Record>) {
    constructor(drawn: Json?, stored: Json?, registry: Registry) : this(records(drawn, registry), records(stored, registry))
    companion object {
        fun records(rows: Json?, registry: Registry): List<works.windmill.sync.api.Record> =
            (rows?.arr() ?: emptyList()).map { Record(confirmed = Row(it), registry = registry) }
    }
}

// A deterministic scope reader and finite ID source; it never modifies the vector's records.
class VectorReader(val records: VectorRecords, override val now: Long, ids: List<RecordID> = emptyList(),
    val pulled: Boolean = true, val scope: ScopeRef? = null, val registry: Registry? = null) : CommitContext {
    override val replica = "rp_00000000000000000000000000000001"
    override val actor get() = replica
    override val isAnonymous = false
    private val ids = ids.toMutableList()
    private fun lives(type: String): String {
        if (scope != null && registry?.type(type)?.scope != scope.registryScope) throw CommitFailure.malformed("$type is no type of $scope")
        return type
    }
    private fun find(records: List<works.windmill.sync.api.Record>, type: String, id: RecordID): works.windmill.sync.api.Record? {
        lives(type)
        return records.firstOrNull { it.type == type && it.id == id }
    }
    private fun visible(records: List<works.windmill.sync.api.Record>, type: String): List<works.windmill.sync.api.Record> {
        lives(type)
        return records.filter { it.type == type && it.isVisible }.sortedBy { it.id }
    }
    override fun drawn(type: String, id: RecordID) = find(records.drawn, type, id)
    override fun stored(type: String, id: RecordID) = find(records.stored, type, id)
    override fun drawn(type: String) = visible(records.drawn, type)
    override fun stored(type: String) = visible(records.stored, type)
    override fun drawn(type: String, field: String, id: RecordID) = drawn(type).filter { it.values[field] == id.json }
    override fun stored(type: String, field: String, id: RecordID) = stored(type).filter { it.values[field] == id.json }
    override fun confirmed(type: String, id: RecordID) = stored(type, id)
    override fun device(key: String): Json? = null
    override fun firstPullComplete() = pulled
    override fun checkpoint() = ScopeCheckpoint()
    override fun devices(prefix: String) = emptyMap<String, Json>()
    override fun commands() = emptyList<QueuedCommand>()
    override fun opaqueID(): String = throw CommitFailure.malformed("the vector lists no opaque identity")
    override fun mintID(type: String): RecordID {
        if (ids.isEmpty()) throw CommitFailure.malformed("the vector lists no id left to mint a $type")
        return ids.removeAt(0)
    }
}

// Commit test double with injected outcome and disk failure. It records a gesture only after a successful body.
class VectorReplica(records: VectorRecords, val now: Long, val registry: Registry,
    var answer: CommitOutcome? = null) : Replica {
    private val lock = Any()
    private var currentRecords = records
    private val committedGestures = mutableListOf<Gesture>()
    var records: VectorRecords
        get() = synchronized(lock) { currentRecords }
        set(value) { synchronized(lock) { currentRecords = value } }
    val gestures: List<Gesture> get() = synchronized(lock) { committedGestures.toList() }
    private var failNext = false
    fun failNextCommit() { synchronized(lock) { failNext = true } }
    override fun <T> commit(scope: ScopeRef, body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T> {
        val (gesture, value) = body(VectorReader(records, now, scope = scope, registry = registry))
        return synchronized(lock) {
            if (failNext) { failNext = false; throw CommitFailure(CommitFailure.Kind.storeFailure, "the disk is full") }
            if (gesture == null) null to value else {
                committedGestures.add(gesture)
                val id = "g${committedGestures.size}"
                (answer ?: CommitOutcome.Committed(CommitReceipt(id, Stamp.UNSET, listOf("$id/0"), emptyList(), null, emptyList()))) to value
            }
        }
    }
    override fun undo(gestureId: String) = false
    override fun <T> read(scope: ScopeRef, body: (ScopeReader) -> T) = body(VectorReader(records, now, scope = scope, registry = registry))
    override fun mintID(type: String): RecordID = throw CommitFailure.malformed("a vector mints no id")
    override fun physNow() = now
    override fun dismissNotice(id: String): Unit = throw ContractError("a vector's commit writes no notice, and $id was dismissed")
}

val RecordRef.form: Json get() = Json.objectOf("t" to Json.of(type), "id" to id.json)
val Change.form: Json get() {
    val op = when (operation) {
        is Change.Operation.Create -> "create"; is Change.Operation.Update -> "update"; is Change.Operation.Delete -> "delete"
        is Change.Operation.Revive -> "revive"; is Change.Operation.Put -> "put"; is Change.Operation.Write -> "write"; is Change.Operation.Move -> "move"
    }
    val fields = linkedMapOf("op" to Json.of(op), "t" to Json.of(type), "id" to (id?.json ?: Json.Null))
    if (values.isNotEmpty()) fields["f"] = Json.Obj(values.toList())
    if (texts.isNotEmpty()) fields["x"] = Json.Obj(texts.map { (name, edit) -> name to Json.objectOf("text" to Json.of(edit.text), "from" to (edit.editedFrom?.let(Json::of) ?: Json.Null)) })
    if (serials.isNotEmpty()) fields["v"] = Json.Obj(serials.toList())
    (operation as? Change.Operation.Put)?.let { fields["present"] = it.present?.let(Json::of) ?: Json.Null }
    anchor?.let { fields["anchor"] = Json.objectOf("field" to Json.of(it.field), "below" to (it.below?.json ?: Json.Null)) }
    return Json.Obj(fields.toList())
}
val Gesture.form: Json get() = Json.objectOf("changes" to Json.Arr(changes.map { it.form }), "atomic" to Json.of(atomic),
    "hold" to Json.of(hold), "guards" to Json.Arr(guards.map { Json.objectOf("t" to Json.of(it.type), "id" to it.id.json, "field" to Json.of(it.field)) }),
    "retire" to Json.Arr(retire.map { it.form }), "cmd" to (command?.json ?: Json.Null), "predict" to Json.Arr(predict.map { it.form }),
    "local" to Json.Arr(local.map { Json.objectOf("key" to Json.of(it.key), "value" to (it.value ?: Json.Null)) }))
val CommitReceipt.form: Json get() = Json.objectOf("gestureId" to Json.of(gestureId), "localIds" to Json.Arr(localIds.map(Json::of)),
    "releaseAt" to (releaseAt?.let(Json::of) ?: Json.Null), "retired" to Json.Arr(retired.map(Json::of)))

internal val ScopeRef.registryScope: String get() = when (val kind = kind) {
    is ScopeRef.Kind.Product -> "product:${kind.name}"
    is ScopeRef.Kind.Tree -> "tree"
    is ScopeRef.Kind.Overlay -> "overlay"
    is ScopeRef.Kind.Device -> "device:${kind.product}"
}
