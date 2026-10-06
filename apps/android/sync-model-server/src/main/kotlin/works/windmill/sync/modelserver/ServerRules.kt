package works.windmill.sync.modelserver

import works.windmill.sync.core.*

interface ServerRules {
    fun elsewhere(key: RecordKey, product: Json): Boolean = false
    fun replays(command: CheckedCommand, context: RuleContext): Boolean = false
    fun run(command: CheckedCommand, context: RuleContext): CommandOutcome = throw Refusal("invalid")
    fun check(changes: List<RecordChange>, context: RuleContext): List<PlannedDelta> = emptyList()
    fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState): List<Json> = revisions
}
class NoServerRules : ServerRules
class RuleContext(val registry: Registry, val scope: ScopeKey, val origin: IntentOrigin, val deltas: List<PlannedDelta>, val guards: List<Guard>,
    val serverNow: Long, val state: ServerState, val rules: ServerRules, val joined: Map<RecordKey, Row> = emptyMap()) {
    var product: Json = state.product
    val account get() = origin.account
    fun idState(key: RecordKey): IdState = state.idState(key, scope, registry).let { if (it.state == "none" && rules.elsewhere(key, product)) IdState("foreign") else it }
    fun storedRecords(type: String) = state.rows[scope.text].orEmpty().filterKeys { it.type == type }.toSortedMap().values.map(::Row)
    fun record(key: RecordKey): Row? = joined[key] ?: state.rows[scope.text]?.get(key)?.let(::Row)
    fun records(type: String): List<Row> = (storedRecords(type).associateBy { it.key } + joined.filterKeys { it.type == type }).toSortedMap().values.toList()
    fun canRead(tree: String) = state.access(ScopeKey("tree:$tree"), account, registry) in listOf("readable", "writable")
    fun rows(tree: String) = if (canRead(tree)) state.rows["tree:$tree"].orEmpty().toSortedMap().values.map(::Row) else emptyList()
    fun entry(table: String, id: String): Json? = product[table]?.get(scope.text)?.get(id)
    fun store(table: String, id: String, value: Json?) { product = putEntry(product, table, scope, id, value) }
    fun ensure(table: String) { product = product.with(table to (product[table] ?: Json.objectOf()).with(scope.text to (product[table]?.get(scope.text) ?: Json.objectOf()))) }
}
fun putEntry(product: Json, table: String, scope: ScopeKey, id: String, value: Json?) = product.with(table to (product[table] ?: Json.objectOf()).with(scope.text to (product[table]?.get(scope.text) ?: Json.objectOf()).with(id to value)))
data class RecordChange(val scope: ScopeKey, val key: RecordKey, val before: IdState, val after: Row, val createdBy: List<String>) {
    val createdHere get() = !before.isAlive && after.isAlive
    val diesHere get() = before.isAlive && !after.isAlive
}
data class CommandOutcome(val deltas: List<PlannedDelta> = emptyList(), val write: List<WriteClaim> = emptyList(), val detail: Json? = null,
    val product: Json, val created: Map<ScopeKey, List<PlannedDelta>> = emptyMap())
data class WriteClaim(val key: RecordKey, val from: RecordID? = null, val born: Stamp? = null, val mintedBorn: Boolean = false, val fields: List<String> = emptyList()) {
    fun json(stamp: Stamp?, joinedBorn: Stamp?): Json = Json.objectOf("t" to Json.of(key.type), "id" to key.id.json).with(
        "from" to from?.json, "born" to (if (mintedBorn) joinedBorn ?: stamp else born)?.json,
        "f" to if (fields.isNotEmpty() && stamp != null) Json.Obj(fields.map { it to stamp.json }) else null)
}

class ProbeServerRules : ServerRules {
    override fun replays(command: CheckedCommand, context: RuleContext) = when (command.name) {
        "probe.start" -> context.entry("receipts", command.string("id")) != null
        "probe.copy" -> context.entry("copies", command.string("dst")) == Json.of(command.string("src")); else -> false
    }
    override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome {
        val c = context
        return when (command.name) {
            "probe.start" -> {
                val called = command.string("id"); val receipt = c.entry("receipts", called)
                if (receipt != null) {
                    val run = c.idState(RecordKey("run", RecordID(receipt))).row
                    CommandOutcome(write = if (run?.isAlive == true) listOf(joined(run, called)) else emptyList(), product = c.product)
                } else {
                    val open = c.records("run").firstOrNull(::isOpen)
                    if (open != null) {
                        if (command.args["join"] != Json.of(true)) throw Refusal("invalid")
                        CommandOutcome(write = listOf(joined(open, called)), product = putEntry(c.product, "receipts", c.scope, called, open.key.id.json))
                    } else {
                        val fields = mutableMapOf("startedAt" to (command.args["startedAt"] ?: Json.Null)); command.args["label"]?.let { fields["label"] = it }
                        val key = RecordKey("run", RecordID(called))
                        CommandOutcome(listOf(PlannedDelta.create(key, fields)), listOf(WriteClaim(key, mintedBorn = true, fields = fields.keys.sorted())), product = putEntry(c.product, "receipts", c.scope, called, Json.of(called)))
                    }
                }
            }
            "probe.end" -> {
                val key = RecordKey("run", RecordID(command.string("runId"))); val state = c.idState(key)
                if (state.row == null) throw Refusal("unknown-record"); if (!state.isAlive) throw Refusal("record-dead")
                val run = state.row; val ended = command.args.getValue("endedAt").long()
                if (ended < (run.lattice.fields["startedAt"]?.value?.long() ?: 0)) throw Refusal("invalid")
                if (!isOpen(run)) CommandOutcome(product = c.product) else CommandOutcome(listOf(PlannedDelta.update(key, run.lattice.born, mapOf("endedAt" to Json.of(ended)))), listOf(WriteClaim(key, fields = listOf("endedAt"))), product = c.product)
            }
            "probe.copy" -> {
                val source = command.string("src"); val board = RecordKey("board", RecordID(command.string("dst")))
                if (replays(command, c)) {
                    val state = c.idState(board); val born = state.row?.lattice?.born
                    CommandOutcome(write = if (state.isAlive && born != null) listOf(WriteClaim(board, born = born)) else emptyList(), product = c.product)
                } else {
                    if (!c.canRead(source)) throw Refusal("not-found"); if (c.idState(board).state != "none") throw Refusal("id-taken")
                    val copies = c.rows(source).mapNotNull { row -> when (row.key.type) {
                        "meta" -> row.lattice.fields["title"]?.let { PlannedDelta.copy(row.copy(lattice = Lattice(row.lattice.life, row.lattice.born, mapOf("title" to it)))) }
                        "tag", "link" -> if (row.isAlive) PlannedDelta.copy(row) else null; else -> null
                    } }
                    CommandOutcome(listOf(PlannedDelta.create(board)), listOf(WriteClaim(board, mintedBorn = true)), product = putEntry(c.product, "copies", c.scope, board.id.toString(), Json.of(source)), created = mapOf(ScopeKey("tree:${board.id}") to copies))
                }
            }
            "probe.tick" -> CommandOutcome(c.records("run").filter { isOpen(it) && (it.lattice.fields["startedAt"]?.value?.long() ?: Long.MAX_VALUE) <= c.serverNow - 600_000 }.map { PlannedDelta.update(it.key, it.lattice.born, mapOf("endedAt" to Json.of(c.serverNow))) }, product = c.product)
            else -> throw Refusal("invalid")
        }
    }
    private fun isOpen(row: Row) = row.isAlive && (row.lattice.fields["endedAt"]?.value ?: Json.Null) === Json.Null
    private fun joined(row: Row, called: String) = WriteClaim(row.key, if (row.key.id.string == called) null else RecordID(called), row.lattice.born)
    override fun check(changes: List<RecordChange>, context: RuleContext): List<PlannedDelta> {
        if (changes.any { it.key.type == "run" && it.createdBy.any { source -> source != "command" } }) throw Refusal("invalid")
        val dying = changes.filter { it.key.type == "run" && it.diesHere }.map { it.key.id.json }
        if (dying.isEmpty()) return emptyList()
        val laps = context.records("lap").filter { it.isAlive }.associateBy { it.key }.toMutableMap()
        changes.filter { it.key.type == "lap" && it.before.isAlive }.forEach { laps[it.key] = it.before.row!! }
        return laps.toSortedMap().values.filter { it.lattice.fields["runId"]?.value in dying }.map { PlannedDelta.delete(it.key, it.lattice.born) }
    }
    override fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState) = revisions.sortedWith(ServerState.revisionOrder).groupBy { it.recordKey to it.member("field").str() }.values.map { it.last() }
}

class ComposedServerRules(private val registry: Registry, private val products: Map<String, ServerRules>) : ServerRules {
    init { require(registry.products.keys == products.keys) }
    private fun rules(c: RuleContext) = products.getValue(registry.product(c.scope.ref)!!)
    override fun elsewhere(key: RecordKey, product: Json) = products.values.any { it.elsewhere(key, product) }
    override fun replays(command: CheckedCommand, context: RuleContext) = rules(context).replays(command, context)
    override fun run(command: CheckedCommand, context: RuleContext) = rules(context).run(command, context)
    override fun check(changes: List<RecordChange>, context: RuleContext) = rules(context).check(changes, context)
    override fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState) = products.getValue(registry.product(scope.ref)!!).pruneRevisions(revisions, archived, now, scope, context)
}
