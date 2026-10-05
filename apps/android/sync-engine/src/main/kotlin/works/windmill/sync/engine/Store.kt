package works.windmill.sync.engine

import works.windmill.sync.core.*

internal interface EngineStore : AutoCloseable {
    fun metadata(): Json
    fun metadata(value: Json)
    fun row(replica: String, scope: ScopeRef, key: RecordKey): Row?
    fun rows(replica: String, scope: ScopeRef, type: String? = null): List<Row>
    fun matching(replica: String, scope: ScopeRef, type: String, field: String, value: RecordID): List<Row>
    fun scopes(replica: String): Set<ScopeRef>
    fun hasRows(replica: String, scope: ScopeRef): Boolean
    fun put(replica: String, scope: ScopeRef, row: Row)
    fun remove(replica: String, scope: ScopeRef, key: RecordKey)
    fun reidentify(oldId: String, newId: String)
    fun forgetScope(replica: String, scope: ScopeRef)
    fun purgeReplica(replica: String)
    fun beginStaging(replica: String, scope: ScopeRef)
    fun putStaging(replica: String, scope: ScopeRef, row: Row)
    fun removeStaging(replica: String, scope: ScopeRef, key: RecordKey)
    fun stagingRows(replica: String, scope: ScopeRef): List<Row>
    fun stagingRow(replica: String, scope: ScopeRef, key: RecordKey): Row?
    fun swapStaging(replica: String, scope: ScopeRef)
    fun dropStaging(replica: String, scope: ScopeRef)
    fun sweepReleased(limit: Int = 128): Boolean
    fun releasedRows(): Int
    fun <T> transaction(body: () -> T): T
    fun <T> read(body: () -> T): T = body()
}

internal class MemoryStore(private val registry: Registry, input: Json) : EngineStore {
    private data class SetKey(val replica: String, val scope: ScopeRef, val staging: Boolean)
    private class Rows {
        val records = mutableMapOf<RecordKey, Row>()
        val refs = mutableMapOf<Pair<String, RecordID>, MutableSet<RecordKey>>()
        val types = mutableMapOf<String, MutableSet<RecordKey>>()
    }
    private var metadata = input.with("replicas" to Json.Arr(input.items("replicas").map { replica -> replica.with("confirmed" to null,
        "staging" to replica["staging"]?.let { Json.Obj(it.obj().map { stage -> stage.key to stage.value.with("rows" to null) }) }) }))
    private val roles = mutableMapOf<SetKey, Rows>()
    private val released = mutableListOf<Rows>()
    private var journal: MutableMap<Pair<Rows, RecordKey>, Row?>? = null
    private var closed = false
    var failNextCommit = false
    @Volatile var failNextRead = false
    var rowsRead = 0; private set
    init {
        for (replica in input.items("replicas")) {
            val id = replica.member("meta").member("replica").str()
            for ((scope, rows) in replica.fields("confirmed")) for (row in rows.arr()) put(id, ScopeRef(scope), Row(row))
            for ((scope, staging) in replica.fields("staging")) {
                beginStaging(id, ScopeRef(scope))
                for (row in staging.items("rows")) putStaging(id, ScopeRef(scope), Row(row))
            }
        }
    }
    override fun metadata(): Json { check(!closed); return metadata }
    override fun metadata(value: Json) { check(!closed); metadata = value }
    private fun set(replica: String, scope: ScopeRef, staging: Boolean = false, create: Boolean = false): Rows? {
        check(!closed)
        val key = SetKey(replica, scope, staging)
        return if (create) roles.getOrPut(key) { Rows() } else roles[key]
    }
    override fun row(replica: String, scope: ScopeRef, key: RecordKey): Row? {
        check(!closed); rowsRead++; return set(replica, scope)?.records?.get(key)
    }
    private fun rows(set: Rows?, type: String? = null): List<Row> {
        val keys = if (type != null) set?.types?.get(type).orEmpty() else set?.records?.keys.orEmpty()
        return keys.sorted().mapNotNull { rowsRead++; set?.records?.get(it) }
    }
    override fun rows(replica: String, scope: ScopeRef, type: String?) = rows(set(replica, scope), type)
    override fun matching(replica: String, scope: ScopeRef, type: String, field: String, value: RecordID): List<Row> {
        val set = set(replica, scope) ?: return emptyList()
        return set.refs[field to value].orEmpty().filter { it.type == type }.sorted().mapNotNull { rowsRead++; set.records[it] }
    }
    override fun scopes(replica: String) = roles.filter { it.key.replica == replica && !it.key.staging && it.value.records.isNotEmpty() }.keys.map { it.scope }.toSet()
    override fun hasRows(replica: String, scope: ScopeRef) = set(replica, scope)?.records?.isNotEmpty() == true
    override fun put(replica: String, scope: ScopeRef, row: Row) = put(set(replica, scope, create = true)!!, row.key, row)
    override fun remove(replica: String, scope: ScopeRef, key: RecordKey) { set(replica, scope)?.let { put(it, key, null) } }
    private fun put(set: Rows, key: RecordKey, row: Row?) {
        val mark = set to key
        journal?.let { if (!it.containsKey(mark)) it[mark] = set.records[key] }
        replace(set, key, row)
    }
    private fun replace(set: Rows, key: RecordKey, row: Row?) {
        val old = set.records.remove(key)
        set.types[key.type]?.remove(key)
        fun index(row: Row, add: Boolean) {
            for ((name, field) in registry.type(row.key.type)?.fields.orEmpty()) {
                if (field.ref == null) continue
                val ref = row.lattice.fields[name]?.value as? Json.Str ?: continue
                val index = name to RecordID(ref)
                if (add) set.refs.getOrPut(index) { mutableSetOf() }.add(key) else set.refs[index]?.remove(key)
            }
        }
        if (old != null) index(old, false)
        if (row != null) { set.records[key] = row; set.types.getOrPut(key.type) { mutableSetOf() }.add(key); index(row, true) }
    }
    override fun reidentify(oldId: String, newId: String) {
        require(oldId == newId || roles.keys.none { it.replica == newId })
        for (key in roles.keys.filter { it.replica == oldId }) roles[SetKey(newId, key.scope, key.staging)] = roles.remove(key)!!
    }
    override fun forgetScope(replica: String, scope: ScopeRef) {
        roles.remove(SetKey(replica, scope, false))?.let(released::add)
        dropStaging(replica, scope)
    }
    override fun purgeReplica(replica: String) {
        for (key in roles.keys.filter { it.replica == replica }) roles.remove(key)?.let(released::add)
    }
    override fun beginStaging(replica: String, scope: ScopeRef) {
        dropStaging(replica, scope); roles[SetKey(replica, scope, true)] = Rows()
    }
    override fun putStaging(replica: String, scope: ScopeRef, row: Row) = put(set(replica, scope, staging = true) ?: throw StoreFailure(), row.key, row)
    override fun removeStaging(replica: String, scope: ScopeRef, key: RecordKey) = put(set(replica, scope, staging = true) ?: throw StoreFailure(), key, null)
    override fun stagingRows(replica: String, scope: ScopeRef) = rows(set(replica, scope, staging = true))
    override fun stagingRow(replica: String, scope: ScopeRef, key: RecordKey): Row? { rowsRead++; return set(replica, scope, staging = true)?.records?.get(key) }
    override fun swapStaging(replica: String, scope: ScopeRef) {
        val next = roles.remove(SetKey(replica, scope, true)) ?: throw StoreFailure()
        roles.put(SetKey(replica, scope, false), next)?.let(released::add)
    }
    override fun dropStaging(replica: String, scope: ScopeRef) { roles.remove(SetKey(replica, scope, true))?.let(released::add) }
    override fun sweepReleased(limit: Int): Boolean {
        require(limit > 0)
        var left = limit
        var setsLeft = limit
        while (released.isNotEmpty() && left > 0 && setsLeft-- > 0) {
            val set = released.first()
            for (key in set.records.keys.sorted().take(left)) { put(set, key, null); left-- }
            if (set.records.isEmpty()) released.removeAt(0)
        }
        return released.isNotEmpty()
    }
    override fun releasedRows() = released.sumOf { it.records.size }
    override fun <T> read(body: () -> T): T {
        check(!closed)
        if (failNextRead) { failNextRead = false; throw StoreFailure() }
        return body()
    }
    override fun <T> transaction(body: () -> T): T {
        check(!closed); check(journal == null) { "nested-store-transaction" }
        val old = metadata
        val oldRoles = roles.toMap()
        val oldReleased = released.toList()
        val changes = mutableMapOf<Pair<Rows, RecordKey>, Row?>()
        journal = changes
        try {
            val result = body()
            if (failNextCommit) { failNextCommit = false; throw StoreFailure() }
            return result
        } catch (failure: Throwable) {
            metadata = old
            roles.clear(); roles.putAll(oldRoles)
            released.clear(); released.addAll(oldReleased)
            for ((key, row) in changes) replace(key.first, key.second, row)
            throw failure
        } finally { journal = null }
    }
    override fun close() { closed = true }
}

internal class StoreFailure(cause: Throwable? = null) : RuntimeException("store-failure", cause)
