package works.windmill.sync.modelserver

import works.windmill.sync.core.*

interface ServerRules {
    val localCheckTypes: Set<String>? get() = null
    fun elsewhere(key: RecordKey, product: Json): Boolean = false
    fun replays(command: CheckedCommand, context: RuleContext): Boolean = false
    fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?): Set<ScopeKey> = emptySet()
    fun effects(changes: List<RecordChange>, context: RuleContext): Effects {
        val types = localCheckTypes ?: context.registry.types.filter { type ->
            val product = if (type.scope.startsWith("product:")) type.scope.removePrefix("product:") else context.registry.governingType?.scope?.removePrefix("product:")
            product in context.ruleProducts
        }.map { it.name }.toSet()
        val scopes = changes.filter { it.key.type in types }.map { it.scope }.toMutableSet()
        if (context.deltas.any { it.key.type in types }) scopes.add(context.scope)
        if (scopes.size > 1) throw AdmissionFault()
        val local = context.rebound(scopes.firstOrNull() ?: context.scope)
        val deltas = check(changes, local)
        context.product = local.product
        return Effects(mapOf(local.scope to deltas))
    }
    fun run(command: CheckedCommand, context: RuleContext): CommandOutcome = throw Refusal("invalid")
    fun check(changes: List<RecordChange>, context: RuleContext): List<PlannedDelta> = emptyList()
    fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState): List<Json> = revisions
}
class NoServerRules : ServerRules
class RuleContext(val registry: Registry, val scope: ScopeKey, val origin: IntentOrigin, val deltas: List<PlannedDelta>, val guards: List<Guard>,
    val serverNow: Long, val state: ServerState, val rules: ServerRules, val joined: Map<RecordKey, Row> = emptyMap(),
    val declared: Set<ScopeKey> = setOf(scope), val scopedJoins: Map<ScopeKey, Map<RecordKey, Row>> = emptyMap(), var ruleProducts: Set<String> = registry.products.keys, val originScope: ScopeKey = scope) {
    var product: Json = state.product
    val account get() = origin.account
    fun rebound(scope: ScopeKey) = RuleContext(registry, scope, origin, deltas, guards, serverNow, state, rules, scopedJoins[scope].orEmpty(), declared, scopedJoins, ruleProducts, originScope).also { it.product = product }
    fun idState(key: RecordKey): IdState = state.idState(key, scope, registry).let { if (it.state == "none" && rules.elsewhere(key, product)) IdState("foreign") else it }
    fun storedRecords(type: String) = state.rows[scope.text].orEmpty().filterKeys { it.type == type }.toSortedMap().values.map(::Row)
    fun record(key: RecordKey): Row? = joined[key] ?: state.rows[scope.text]?.get(key)?.let(::Row)
    fun records(type: String): List<Row> = (storedRecords(type).associateBy { it.key } + joined.filterKeys { it.type == type }).toSortedMap().values.toList()
    fun scopedRecord(key: RecordKey, scope: ScopeKey): Row? {
        if (scope !in declared) throw AdmissionFault()
        return scopedJoins[scope]?.get(key) ?: state.rows[scope.text]?.get(key)?.let(::Row)
    }
    fun scopedRecords(type: String, scope: ScopeKey): List<Row> {
        if (scope !in declared) throw AdmissionFault()
        val stored = state.rows[scope.text].orEmpty().filterKeys { it.type == type }.mapValues { Row(it.value) }
        return (stored + scopedJoins[scope].orEmpty().filterKeys { it.type == type }).toSortedMap().values.toList()
    }
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
data class Effects(val byScope: Map<ScopeKey, List<PlannedDelta>> = emptyMap())
data class CommandOutcome(val deltas: List<PlannedDelta> = emptyList(), val write: List<WriteClaim> = emptyList(), val detail: Json? = null,
    val product: Json, val into: Map<ScopeKey, List<PlannedDelta>> = emptyMap())
data class WriteClaim(val key: RecordKey, val from: RecordID? = null, val born: Stamp? = null, val mintedBorn: Boolean = false, val fields: List<String> = emptyList()) {
    fun json(stamp: Stamp?, joinedBorn: Stamp?): Json = Json.objectOf("t" to Json.of(key.type), "id" to key.id.json).with(
        "from" to from?.json, "born" to (if (mintedBorn) joinedBorn ?: stamp else born)?.json,
        "f" to if (fields.isNotEmpty() && stamp != null) Json.Obj(fields.map { it to stamp.json }) else null)
}

class ProbeServerRules : ServerRules {
    override val localCheckTypes = setOf("run")
    override fun replays(command: CheckedCommand, context: RuleContext) = when (command.name) {
        "probe.start" -> context.entry("receipts", command.string("id")) != null
        "probe.copy" -> context.entry("copies", command.string("dst")) == Json.of(command.string("src"))
        "probe.branch" -> context.entry("branches", command.string("child")) == branchReceipt(command)
        "probe.sprout" -> aliveWhere(context, "board") { it.lattice.fields["parent"]?.value == step(command) } != null
        "probe.adopt" -> aliveWhere(context, "tag") { it.lattice.fields["label"]?.value == command.args["label"] } != null
        else -> false
    }
    // The alive record of type `type` that `holds` picks, the least id first: the subtree a step owns, or the tag a label names.
    private fun aliveWhere(context: RuleContext, type: String, holds: (Row) -> Boolean) = context.records(type).firstOrNull { it.isAlive && holds(it) }
    private fun step(command: CheckedCommand) = Json.objectOf("board" to Json.of(command.string("board")), "tag" to Json.of(command.string("tag")))
    private fun branchReceipt(command: CheckedCommand) = Json.objectOf("parent" to Json.of(command.string("parent")), "title" to command.args.getValue("title"))
    override fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?): Set<ScopeKey> {
        if (command?.name == "probe.branch") return setOf(ScopeKey("tree:${command.string("parent")}"), ScopeKey("tree:${command.string("child")}"))
        if (command?.name == "probe.unbranch") return command.args.getValue("input").let { setOf(ScopeKey("tree:${it.member("parent").str()}"), ScopeKey("tree:${it.member("child").str()}")) }
        if (command?.name != "probe.copy" || replays(command, context) || context.idState(RecordKey("board", RecordID(command.string("dst")))).state != "none") return emptySet()
        return setOf(ScopeKey("tree:${command.string("dst")}"))
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
                    CommandOutcome(listOf(PlannedDelta.create(board)), listOf(WriteClaim(board, mintedBorn = true)), product = putEntry(c.product, "copies", c.scope, board.id.toString(), Json.of(source)), into = mapOf(ScopeKey("tree:${board.id}") to copies))
                }
            }
            // Creates board `child` and titles both its tree and `parent`'s: one command's effects in three scopes. Its receipt
            // `child → {parent, title}` answers a replay, from any replica, with the board it created.
            "probe.branch" -> {
                val parent = command.string("parent"); val child = command.string("child"); val board = RecordKey("board", RecordID(child))
                if (replays(command, c)) {
                    val created = c.record(board)
                    CommandOutcome(write = if (created?.isAlive == true) listOf(WriteClaim(board, born = created.lattice.born)) else emptyList(),
                        detail = Json.objectOf("created" to Json.of(false)), product = c.product)
                } else {
                    if (parent == child) throw Refusal("invalid")
                    if (c.record(board) != null) throw Refusal("id-taken")
                    val title = PlannedDelta.update(RecordKey("meta", RecordID("meta")), null, mapOf("title" to command.args.getValue("title")))
                    CommandOutcome(listOf(PlannedDelta.create(board)), listOf(WriteClaim(board, mintedBorn = true)), Json.objectOf("created" to Json.of(true)),
                        putEntry(c.product, "branches", c.scope, child, branchReceipt(command)), listOf(parent, child).associate { ScopeKey("tree:$it") to listOf(title) })
                }
            }
            // K-3: the inverse of probe.branch, all or nothing. While the created board and its tree are unchanged since the branch, and
            // the parent's title is still the one the branch wrote where the evidence owns it, the board dies, killing its tree, and the
            // parent takes back its earlier title. Evidence that proves neither the board nor its tree is invalid.
            "probe.unbranch" -> {
                val input = command.args.getValue("input"); val parent = input.member("parent").str(); val child = input.member("child").str()
                val evidence = command.evidence!!; val board = RecordKey("board", RecordID(child))
                if (evidence.unchangedCreatedRecords.none { it.record == RecordAddress(c.scope.ref, board) } || evidence.unchangedCreatedScopes.none { it.scope == ScopeRef.tree(child) } ||
                    parent == child) throw Refusal("invalid")
                val skip = evidence.skip({ record -> c.scopedRecord(record.key, ScopeKey.resolve(record.scope, c.account)!!) },
                    { scope -> c.state.scopes[ScopeKey.resolve(scope, c.account)!!.text]?.seq }, c.state.epoch)
                if (skip != null) CommandOutcome(detail = InverseOutcome.detail(listOf(InverseOutcome(0, skip))), product = c.product)
                else CommandOutcome(listOf(PlannedDelta.delete(board, c.record(board)?.lattice?.born)), detail = InverseOutcome.detail(listOf(InverseOutcome(0))), product = c.product,
                    into = if (evidence.ownedFields.none { it.target.scope == ScopeRef.tree(parent) && it.target.key.type == "meta" && it.target.slot.name == "title" }) emptyMap()
                        else mapOf(ScopeKey("tree:$parent") to listOf(PlannedDelta.update(RecordKey("meta", RecordID("meta")), null, mapOf("title" to input.member("title"))))))
            }
            // Creates board `child` owned by the step `{board, tag}`, its `parent`; a step that already owns an alive board answers
            // that board, so a retry, or another device's sprout of the same step, resolves to the subtree the step owns (E-8).
            "probe.sprout" -> {
                val board = RecordKey("board", RecordID(command.string("child")))
                aliveWhere(c, "board") { it.lattice.fields["parent"]?.value == step(command) }?.let { owned -> CommandOutcome(write = listOf(joined(owned, command.string("child"))), product = c.product) }
                    ?: run {
                        if (c.idState(board).state != "none") throw Refusal("id-taken")
                        CommandOutcome(listOf(PlannedDelta.create(board, mapOf("parent" to step(command)))), listOf(WriteClaim(board, mintedBorn = true, fields = listOf("parent"))), product = c.product)
                    }
            }
            // Answers the tree's alive tag labelled `label`, else creates tag `tag` with that label: a command whose write map renames a scope-local id.
            "probe.adopt" -> {
                val tag = RecordKey("tag", RecordID(command.string("tag"))); val label = command.args.getValue("label")
                aliveWhere(c, "tag") { it.lattice.fields["label"]?.value == label }?.let { named -> CommandOutcome(write = listOf(joined(named, command.string("tag"))), product = c.product) }
                    ?: run {
                        if (c.idState(tag).state != "none") throw Refusal("id-taken")
                        CommandOutcome(listOf(PlannedDelta.create(tag, mapOf("label" to label))), listOf(WriteClaim(tag, mintedBorn = true, fields = listOf("label"))), product = c.product)
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
    override fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?) = rules(context).discoverEffectScopes(context, command)
    override fun effects(changes: List<RecordChange>, context: RuleContext): Effects {
        val names = changes.mapNotNull { registry.product(it.scope.ref) }.toMutableSet()
        if (names.isEmpty() || context.deltas.isNotEmpty()) names.add(registry.product(context.originScope.ref)!!)
        val combined = mutableMapOf<ScopeKey, List<PlannedDelta>>()
        for (name in names.sorted()) {
            val product = context.rebound(context.scope).also { it.ruleProducts = setOf(name) }
            val effects = products.getValue(name).effects(changes, product)
            context.product = product.product
            for ((scope, deltas) in effects.byScope) combined[scope] = combined[scope].orEmpty() + deltas
        }
        return Effects(combined)
    }
    override fun run(command: CheckedCommand, context: RuleContext) = rules(context).run(command, context)
    override fun check(changes: List<RecordChange>, context: RuleContext) = rules(context).check(changes, context)
    override fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState) = products.getValue(registry.product(scope.ref)!!).pruneRevisions(revisions, archived, now, scope, context)
}
