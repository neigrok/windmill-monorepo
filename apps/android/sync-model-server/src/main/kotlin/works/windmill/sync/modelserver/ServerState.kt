package works.windmill.sync.modelserver

import works.windmill.sync.core.*

// Tables are values: admission works on a copy and publishes it only after every check passes.
class ServerState(json: Json = Json.objectOf("epoch" to Json.of("ep-1"), "clock" to Hlc().json)) {
    var epoch = json.member("epoch").str()
    var clock = Hlc(json.member("clock"))
    val accounts = json["accounts"]?.obj()?.mapValues { it.value.member("name").str() }?.toMutableMap() ?: mutableMapOf()
    val scopes = json["scopes"]?.obj()?.mapValues { ScopeRecord(it.value) }?.toMutableMap() ?: mutableMapOf()
    val rows = table(json["rows"])
    val spent = table(json["spent"])
    val revisions = json["revisions"]?.obj()?.mapValues { it.value.arr().toMutableList() }?.toMutableMap() ?: mutableMapOf()
    val replicas = json["replicas"]?.obj()?.toMutableMap() ?: mutableMapOf()
    val results = json["results"]?.obj()?.mapValues { it.value.arr().associateBy { row -> row.member("n").long() }.toMutableMap() }?.toMutableMap() ?: mutableMapOf()
    val requests = json["requests"]?.obj()?.mapValues { it.value.arr().associateBy { row -> row.member("requestId").str() }.toMutableMap() }?.toMutableMap() ?: mutableMapOf()
    var product = json["product"] ?: Json.objectOf()
    init { json.expectKeys(listOf("epoch", "clock"), listOf("accounts", "scopes", "rows", "spent", "revisions", "replicas", "results", "requests", "product")) }
    val json: Json get() = Json.Obj(buildList {
        add("epoch" to Json.of(epoch)); add("clock" to clock.json)
        if (accounts.isNotEmpty()) add("accounts" to Json.Obj(accounts.map { it.key to Json.objectOf("name" to Json.of(it.value)) }))
        if (scopes.isNotEmpty()) add("scopes" to Json.Obj(scopes.map { it.key to it.value.json(ScopeKey(it.key).kind) }))
        fun table(name: String, value: Map<String, Map<RecordKey, Json>>) {
            val entries = value.filterValues { it.isNotEmpty() }.map { it.key to Json.Arr(it.value.toSortedMap().values.toList()) }
            if (entries.isNotEmpty()) add(name to Json.Obj(entries))
        }
        table("rows", rows); table("spent", spent)
        val revs = revisions.filterValues { it.isNotEmpty() }.map { it.key to Json.Arr(it.value.sortedWith(revisionOrder)) }
        if (revs.isNotEmpty()) add("revisions" to Json.Obj(revs))
        if (replicas.isNotEmpty()) add("replicas" to Json.Obj(replicas.toList()))
        val answers = results.filterValues { it.isNotEmpty() }.map { it.key to Json.Arr(it.value.toSortedMap().values.toList()) }
        if (answers.isNotEmpty()) add("results" to Json.Obj(answers))
        val calls = requests.filterValues { it.isNotEmpty() }.map { it.key to Json.Arr(it.value.toSortedMap(Comparator(::compareBytes)).values.toList()) }
        if (calls.isNotEmpty()) add("requests" to Json.Obj(calls))
        if (product.obj().isNotEmpty()) add("product" to product)
    })
    fun copy() = ServerState(json)
    fun idState(key: RecordKey, scope: ScopeKey, registry: Registry): IdState {
        rows[scope.text]?.get(key)?.let { val row = Row(it); return IdState(if (row.isAlive) "alive" else "dead", row) }
        spent[scope.text]?.get(key)?.let { return IdState("dead", Row(key, Lattice(Life("dead", Stamp(it.member("lifeStamp").str())), it["born"]?.str()?.let(::Stamp)), seq = it.member("seq").long())) }
        val type = registry.type(key.type) ?: return IdState("none")
        if (type.json["governs"]?.str() == "tree") {
            val tree = scopes["tree:${key.id}"]
            if (tree != null && tree.governedBy != governor(scope, key)) return IdState("foreign")
        }
        if (type.json["idSpace"]?.str() == "global" && (rows.keys + spent.keys).any { it != scope.text && (rows[it]?.containsKey(key) == true || spent[it]?.containsKey(key) == true) }) return IdState("foreign")
        return IdState("none")
    }
    fun access(scope: ScopeKey, account: String?, registry: Registry): String = when (scope.kind) {
        "product" -> if (scope.account != account) "not-found" else if (scopes[scope.text] == null) "absent" else "writable"
        "tree" -> scopes[scope.text]?.let { record ->
            if (record.state == "dead") { if (record.owner == account) "gone" else "not-found" }
            else if (record.owner == account) "writable" else if (isOpen(scope.tree!!, registry)) "readable" else "not-found"
        } ?: "not-found"
        else -> if (scope.account != account) "not-found" else when (access(ScopeKey("tree:${scope.tree}"), account, registry)) {
            "gone" -> "gone"; "readable", "writable" -> if (scopes[scope.text] == null) "absent" else "writable"; else -> "not-found"
        }
    }
    fun canRead(scope: ScopeKey, account: String?, registry: Registry) = access(scope, account, registry) in listOf("absent", "readable", "writable")
    private fun isOpen(tree: String, registry: Registry): Boolean = registry.types.filter { it.scope == "tree" && it.identity == "singleton" }.any { type ->
        val row = rows["tree:$tree"]?.get(RecordKey(type.name, RecordID(type.json.member("singletonId"))))?.let(::Row)
        type.fields.values.any { field -> field.json["opens"]?.arr()?.contains(row?.lattice?.fields?.get(field.name)?.value) == true }
    }
    // Spent rows need no registry lookup; keep feed decoding separate from identity lookup.
    fun allFeedRows(scope: ScopeKey): List<Row> = rows[scope.text].orEmpty().values.map { Row(it).pageForm } + spent[scope.text].orEmpty().map { (key, entry) ->
        Row(key, Lattice(Life("dead", Stamp(entry.member("lifeStamp").str())), entry["born"]?.str()?.let(::Stamp)), seq = entry.member("seq").long())
    }
    companion object {
        private fun table(json: Json?) = json?.obj()?.mapValues { it.value.arr().associateBy(Json::recordKey).toMutableMap() }?.toMutableMap() ?: mutableMapOf()
        val revisionOrder = Comparator<Json> { a, b -> a.recordKey.compareTo(b.recordKey).takeIf { it != 0 } ?: compareBytes(a.member("field").str(), b.member("field").str()).takeIf { it != 0 } ?: a.member("rev").long().compareTo(b.member("rev").long()) }
    }
}

val Json.recordKey: RecordKey get() = RecordKey(member("t").str(), RecordID(member("id")))
val Row.thin get() = Row(key, Lattice(lattice.life, lattice.born), seq = seq)
val Row.pageForm get() = if (isAlive) this else thin
val Row.content get() = copy(seq = 0, rc = null, ru = null)
fun governor(scope: ScopeKey, key: RecordKey) = "${scope.text}#${key.type}#${key.id}"

data class ScopeKey(val text: String) : Comparable<ScopeKey> {
    init { require(text.startsWith("tree:") || text.startsWith("acct:") && text.drop(5).split('/').let { it.size == 2 || it.size == 3 && it[1] == "overlay" }) }
    val kind get() = if (text.startsWith("tree:")) "tree" else if (text.drop(5).split('/').size == 3) "overlay" else "product"
    val account: String? get() = if (kind == "tree") null else text.drop(5).substringBefore('/')
    val tree: String? get() = when (kind) { "tree" -> text.drop(5); "overlay" -> text.substringAfterLast('/'); else -> null }
    val ref: ScopeRef get() = when (kind) { "tree" -> ScopeRef.tree(tree!!); "overlay" -> ScopeRef.overlay(tree!!); else -> ScopeRef.product(text.substringAfterLast('/')) }
    override fun compareTo(other: ScopeKey) = compareBytes(text, other.text)
    companion object {
        fun resolve(ref: ScopeRef, account: String?): ScopeKey? = when (val kind = ref.kind) {
            is ScopeRef.Kind.Tree -> ScopeKey("tree:${kind.id}")
            is ScopeRef.Kind.Product -> account?.let { ScopeKey("acct:$it/${kind.name}") }
            is ScopeRef.Kind.Overlay -> account?.let { ScopeKey("acct:$it/overlay/${kind.id}") }
            is ScopeRef.Kind.Device -> null
        }
    }
}
class ScopeRecord(var owner: String, var state: String = "alive", var seq: Long = 0,
    val counters: MutableMap<String, Long> = mutableMapOf(), var digest: ScopeDigest = ScopeDigest.ZERO, var governedBy: String? = null, var deadAt: Long? = null) {
    constructor(json: Json) : this(json.member("owner").str(), json.member("state").str(), json.member("seq").long(0),
        json.member("counters").obj().mapValues { it.value.long(0) }.toMutableMap(), ScopeDigest(json.member("digest").str()), json["governedBy"]?.str(), json["deadAt"]?.long())
    fun json(kind: String): Json = Json.Obj(buildList {
        add("kind" to Json.of(kind)); add("owner" to Json.of(owner)); add("state" to Json.of(state)); add("seq" to Json.of(seq))
        add("counters" to Json.Obj(counters.map { it.key to Json.of(it.value) })); add("digest" to Json.of(digest.hex))
        governedBy?.let { add("governedBy" to Json.of(it)) }; deadAt?.let { add("deadAt" to Json.of(it)) }
    })
}
data class IdState(val state: String, val row: Row? = null) { val isAlive get() = state == "alive" }
data class IntentOrigin(val account: String, val replica: String? = null, val n: Long? = null, val requestId: String? = null) {
    val isReplica get() = replica != null
    val kind get() = if (isReplica) "replica" else "server"
}
class Refusal(val code: String, val detail: Json? = null) : Exception(code)
class AdmissionFault(cause: Throwable? = null) : Exception("admission-fault", cause)
data class Admitted(val result: Json, val events: List<LiveEvent> = emptyList())
fun refused(code: String, detail: Json? = null): Json = Json.objectOf("s" to Json.of("refused"), "code" to Json.of(code)).with("detail" to detail)
class ServerLimits(json: Json? = null) {
    val maxRecordBytes = json?.get("MAX_RECORD_BYTES")?.long(1)?.toInt() ?: Constants.MAX_RECORD_BYTES
    val pushMaxIntents = json?.get("PUSH_MAX_INTENTS")?.long(1)?.toInt() ?: Constants.PUSH_MAX_INTENTS
    val pushMaxBytes = json?.get("PUSH_MAX_BYTES")?.long(1)?.toInt() ?: Constants.PUSH_MAX_BYTES
    val pullPageBytes = json?.get("PULL_PAGE_BYTES")?.long(1)?.toInt() ?: Constants.PULL_PAGE_BYTES
    val pullMaxBytes = json?.get("PULL_MAX_BYTES")?.long(1)?.toInt() ?: Constants.PULL_MAX_BYTES
    val pullMaxScopes = Constants.PULL_MAX_SCOPES
    val liveInlineBytes = Constants.LIVE_INLINE_BYTES
    val mergeWorkCells = Constants.MERGE_WORK_CELLS
}
