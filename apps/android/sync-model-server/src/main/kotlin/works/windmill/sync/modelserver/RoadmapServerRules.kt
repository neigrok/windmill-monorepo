package works.windmill.sync.modelserver

import works.windmill.sync.core.*

// Roadmap's server rules (engine.md Appendix A.1): its commands and their inverses, the life a change to a step or a kind carries, a root's
// visibility and the reach of its branch, the end of a roadmap with Coach's records about it, the owner's workspace and Coach's records.
// corpus/README.md states the same rules. They read and write records in their JSON form, where a null stamp is the one the server mints.
class RoadmapServerRules : ServerRules {
    override fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?): Set<ScopeKey> {
        val account = context.ownerScope
        val roadmaps = Roadmaps(context.storedRows(account, "tree"))
        val keys = linkedSetOf<ScopeKey>()
        fun declare(tree: String) { ScopeKey("tree:$tree").let { if (context.state.scopes[it.text]?.state == "alive") keys.add(it) } }
        fun branch(tree: String, step: String) = roadmaps.branchOf(tree, step).forEach(::declare)
        val tree = context.scope.takeIf { it.kind == "tree" }?.tree
        if (tree != null) {
            val operations = command?.restore?.operations.orEmpty()
            val visible = context.deltas.any { it.key.type == "meta" && "visibility" in it.fields } ||
                operations.any { it.key.type == "meta" && (it as? RestoreOperation.Field)?.slot?.name == "visibility" }
            if (visible) { keys.add(account); roadmaps.under(tree).forEach(::declare) }
            val restored = operations.filter { it.key.type == "node" && (it !is RestoreOperation.Field || it.slot.kind == Slot.Kind.life) }.map { it.key }
            val touched = context.deltas.filter { it.key.type == "node" && it.life != null }.map { it.key } + restored
            if (touched.isNotEmpty()) keys.add(account)
            for (key in touched) branch(tree, key.id.string!!)
            return keys
        }
        if (context.scope != account) return emptySet()
        val input = command?.args?.get("input")
        when (command?.name) {
            "roadmap.createSubtree" -> {
                keys.addAll(listOf(ScopeKey("tree:${command.string("tree")}"), ScopeKey("tree:${command.string("subtree")}"), context.overlayOf(command.string("tree"))))
                branch(command.string("tree"), command.string("step"))
                return keys
            }
            "roadmap.redoCreateSubtree" -> {
                declare(input!!.text("tree")); keys.add(ScopeKey("tree:${input.text("subtree")}"))
                branch(input.text("tree"), input.text("step"))
                return keys
            }
            "roadmap.undoCreateSubtree" -> { declare(input!!.text("tree")); declare(input.text("subtree")); return keys }
        }
        val deaths = if (command?.name == "roadmap.undoCreateRoadmap") listOf(input!!.text("tree"))
            else context.deltas.filter { it.key.type == "tree" && it.life?.state == "dead" }.map { it.key.id.string!! }
        val roots = deaths.filter { roadmaps.isAlive(it) && roadmaps.placeOf(it) == null }
        val lost = roots.flatMap { listOf(it) + roadmaps.under(it) }.toSet()
        for (standing in roadmaps.rows.keys.filter { roadmaps.isAlive(it) && it !in lost }.sortedWith(::compareBytes)) {
            val overlay = context.overlayOf(standing)
            val opening = context.storedRows(overlay, "pointer").filter { present(it) && valueOf(it, "opens")?.str() in roots }
            if (opening.isEmpty()) continue
            keys.add(overlay); declare(standing)
            for (pointer in opening) branch(standing, pointer.member("id").str())
        }
        return keys
    }

    override fun replays(command: CheckedCommand, context: RuleContext): Boolean = command.name == "roadmap.createSubtree" &&
        Roadmaps(context.storedRows(context.scope, "tree")).ownedBy(command.string("tree"), command.string("step")).isNotEmpty()

    override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome = when (command.name) {
        "roadmap.createSubtree" -> createSubtree(context, command.string("tree"), command.string("root"), command.string("step"), command.string("subtree"))
        "roadmap.recolourKind" -> recolourKind(context, command.string("kind"), command.args.getValue("hue"))
        "roadmap.undoCreateRoadmap" -> undoCreateRoadmap(context, command.args.getValue("input").text("tree"), command.evidence!!)
        "roadmap.undoCreateSubtree" -> command.args.getValue("input").let { undoCreateSubtree(context, it.text("tree"), it.text("step"), it.text("subtree"), command.evidence!!) }
        "roadmap.redoCreateSubtree" -> command.args.getValue("input").let { redoCreateSubtree(context, it.text("tree"), it.text("root"), it.text("step"), it.text("subtree"), command.evidence!!) }
        else -> throw Refusal("invalid")
    }

    // §4 a subtree under a step: its `tree` record with its place, its meta and genesis kinds, and the step's `branch`. A step that already
    // owns a subtree answers it. A step deleted elsewhere is revived, as any change to a step is.
    private fun createSubtree(context: RuleContext, tree: String, root: String, step: String, subtree: String): CommandOutcome {
        val node = context.storedIn(ScopeKey("tree:$tree"), "node", step)
        Roadmaps(context.storedRows(context.scope, "tree")).ownedBy(tree, step).firstOrNull()?.let { owned ->
            val revival = node?.takeIf { !present(it) }?.let { listOf(planned(ScopeKey("tree:$tree"), Json.objectOf("t" to Json.of("node"), "id" to Json.of(step), "born" to it.member("born"),
                "life" to Json.array(Json.of("alive"), Json.Null)), "command", context)) }
            return CommandOutcome(write = listOf(WriteClaim(RecordKey("tree", RecordID(owned)), RecordID(subtree).takeIf { owned != subtree },
                Stamp(context.storedIn(context.scope, "tree", owned)!!.member("born").str()))), product = context.product,
                into = revival?.let { mapOf(ScopeKey("tree:$tree") to it) }.orEmpty())
        }
        if (node == null) throw Refusal("unknown-record")
        val pointer = context.storedIn(context.overlayOf(tree), "pointer", step)
        if (present(pointer) && valueOf(pointer, "opens") != null) throw Refusal("step-opens-a-tree")
        if (depthUnder(context, tree) > MAX_DEPTH) throw Refusal("depth-limit")
        return plant(context, tree, root, step, subtree, node)
    }

    private fun depthUnder(context: RuleContext, tree: String): Long = (valueOf(context.storedIn(ScopeKey("tree:$tree"), "meta", "meta"), "depth")?.long() ?: 0) + 1

    private fun plant(context: RuleContext, tree: String, root: String, step: String, subtree: String, node: Json?): CommandOutcome {
        val holder = context.storedIn(ScopeKey("tree:$tree"), "meta", "meta")
        if (root != (valueOf(holder, "root")?.str() ?: tree)) throw Refusal("invalid")
        if (context.idState(RecordKey("tree", RecordID(subtree))).state != "none") throw Refusal("id-taken")
        val place = Json.objectOf("tree" to Json.of(tree), "step" to Json.of(step))
        val planted = ScopeKey("tree:$subtree")
        val kinds = GENESIS_KINDS.map { kind -> Json.objectOf("t" to Json.of("kind"), "id" to Json.of(kind.id), "born" to Json.Null, "life" to serverStamped(Json.of("alive")),
            "f" to Json.Obj(kind.values.map { (name, value) -> name to serverStamped(Json.of(value)) })) }
        val meta = Json.objectOf("t" to Json.of("meta"), "id" to Json.of("meta"), "f" to Json.objectOf("root" to serverStamped(Json.of(root)), "parent" to serverStamped(place),
            "depth" to serverStamped(Json.of(depthUnder(context, tree))), "reach" to serverStamped(valueOf(holder, "reach") ?: Json.of("private"))))
        val stepBranch = Json.objectOf("t" to Json.of("node"), "id" to Json.of(step), "born" to node!!.member("born"), "f" to Json.objectOf("branch" to serverStamped(Json.of(subtree))))
            .with("life" to serverStamped(Json.of("alive")).takeIf { !present(node) })
        val record = Json.objectOf("t" to Json.of("tree"), "id" to Json.of(subtree), "born" to Json.Null, "life" to serverStamped(Json.of("alive")),
            "f" to Json.objectOf("parent" to serverStamped(place)))
        return CommandOutcome(listOf(planned(context.scope, record, "command", context)), listOf(WriteClaim(RecordKey("tree", RecordID(subtree)), mintedBorn = true, fields = listOf("parent"))),
            product = context.product, into = mapOf(ScopeKey("tree:$tree") to listOf(planned(ScopeKey("tree:$tree"), stepBranch, "command", context)),
                planted to (listOf(meta) + kinds).map { planned(planted, it, "command", context) }))
    }

    // §4 a kind's hue and the colour of every step that wears it, present or not. A kind deleted elsewhere is revived; no step is.
    private fun recolourKind(context: RuleContext, kind: String, hue: Json): CommandOutcome {
        val record = context.storedIn(context.scope, "kind", kind) ?: throw Refusal("unknown-record")
        val before = valueOf(record, "hue") ?: Json.of("terracotta")
        if (before == hue) return CommandOutcome(product = context.product)
        val wearers = context.storedRows(context.scope, "node").filter { (valueOf(it, "color") ?: Json.of("terracotta")) == before }.sortedWith { a, b -> compareBytes(a.member("id").str(), b.member("id").str()) }
        val recoloured = Json.objectOf("t" to Json.of("kind"), "id" to Json.of(kind), "born" to record.member("born"), "f" to Json.objectOf("hue" to serverStamped(hue)))
            .with("life" to serverStamped(Json.of("alive")).takeIf { !present(record) })
        return CommandOutcome((listOf(recoloured) + wearers.map { written(it, Json.objectOf("color" to serverStamped(hue))) }).map { planned(context.scope, it, "command", context) },
            product = context.product)
    }

    // A product inverse's evidence against the declared scopes as stored: a row of a scope not declared or not alive reads absent, so evidence
    // there no longer holds.
    private fun evidenceSkip(context: RuleContext, evidence: Evidence): String? {
        fun readable(key: ScopeKey?) = key != null && key in context.declared && context.state.scopes[key.text]?.state == "alive"
        return evidence.skip({ address -> ScopeKey.resolve(address.scope, context.account).takeIf(::readable)?.let { context.storedIn(it, address.key.type, address.key.id.string!!) }?.let(::Row) },
            { scope -> ScopeKey.resolve(scope, context.account)?.let { context.state.scopes[it.text]?.seq } }, context.state.epoch)
    }

    // K-3: Undo of creating a roadmap. While its record, its tree scope and its owner's overlay of it are as the creation left them, the
    // roadmap dies as any root dies (§4's consequences).
    private fun undoCreateRoadmap(context: RuleContext, tree: String, evidence: Evidence): CommandOutcome {
        if (evidence.unchangedCreatedRecords.none { it.record == RecordAddress(ScopeRef.product("roadmap"), RecordKey("tree", RecordID(tree))) } ||
            evidence.unchangedCreatedScopes.none { it.scope == ScopeRef.tree(tree) }) throw Refusal("invalid")
        evidenceSkip(context, evidence)?.let { return skipped(context, it) }
        val record = context.storedIn(context.scope, "tree", tree)!!
        if (valueOf(record, "parent") != null) throw Refusal("not-a-root")
        if ((context.state.scopes[context.overlayOf(tree).text]?.seq ?: 0) > 0) return skipped(context, "scope-changed")
        return CommandOutcome(listOf(planned(context.scope, killed(record), "command", context)), detail = InverseOutcome.detail(listOf(InverseOutcome(0))), product = context.product)
    }

    // R-8 Undo of creating a subtree: while the step's `branch` is the act's, and the subtree's record, its tree scope and its owner's overlay
    // are as the creation left them, the subtree dies and the step's `branch` clears, together.
    private fun undoCreateSubtree(context: RuleContext, tree: String, step: String, subtree: String, evidence: Evidence): CommandOutcome {
        if (evidence.ownedFields.none { it.target == branchOf(tree, step) } ||
            evidence.unchangedCreatedRecords.none { it.record == RecordAddress(ScopeRef.product("roadmap"), RecordKey("tree", RecordID(subtree))) } ||
            evidence.unchangedCreatedScopes.none { it.scope == ScopeRef.tree(subtree) }) throw Refusal("invalid")
        evidenceSkip(context, evidence)?.let { return skipped(context, it) }
        val record = context.storedIn(context.scope, "tree", subtree)
        if (valueOf(record, "parent") != Json.objectOf("tree" to Json.of(tree), "step" to Json.of(step))) throw Refusal("invalid")
        if ((context.state.scopes[context.overlayOf(subtree).text]?.seq ?: 0) > 0) return skipped(context, "scope-changed")
        val cleared = written(context.storedIn(ScopeKey("tree:$tree"), "node", step)!!, Json.objectOf("branch" to Json.array(Json.Null, Json.Null)))
        return CommandOutcome(listOf(planned(context.scope, killed(record!!), "command", context)), detail = InverseOutcome.detail(listOf(InverseOutcome(0))), product = context.product,
            into = mapOf(ScopeKey("tree:$tree") to listOf(planned(ScopeKey("tree:$tree"), cleared, "command", context))))
    }

    // R-8 Redo: while the step's `branch` is still the one the Undo wrote, a new subtree under a fresh id, planted as createSubtree plants it.
    private fun redoCreateSubtree(context: RuleContext, tree: String, root: String, step: String, subtree: String, evidence: Evidence): CommandOutcome {
        if (evidence.ownedFields.none { it.target == branchOf(tree, step) }) throw Refusal("invalid")
        evidenceSkip(context, evidence)?.let { return skipped(context, it) }
        return plant(context, tree, root, step, subtree, context.storedIn(ScopeKey("tree:$tree"), "node", step)).copy(detail = InverseOutcome.detail(listOf(InverseOutcome(0))))
    }

    // §6.1 step 10 on the joined records: each type's rule, then §5's revival, then §4's consequences.
    override fun effects(changes: List<RecordChange>, context: RuleContext): Effects {
        val outcome = Outcome(context, changes)
        for (change in changes) rule(context, change, outcome)
        revive(context, outcome)
        if (context.originScope == context.ownerScope) endBranches(context, changes, outcome)
        settleVisibility(context, changes, outcome)
        settleReach(context, changes, outcome)
        return Effects(outcome.byScope.mapValues { (scope, deltas) -> deltas.map { planned(scope, it, "check", context) } })
    }

    // One rule a type, on a joined record of this intent.
    private fun rule(context: RuleContext, change: RecordChange, outcome: Outcome) {
        val original = change.before.row?.json
        val after = change.after.json
        val id = change.key.id.string
        when (change.key.type) {
            // Only a root is deleted by a person: a subtree goes with the step that owns it.
            "tree" -> if (context.origin.isReplica && died(original, after) && valueOf(original, "parent") != null &&
                context.deltas.any { it.key == change.key && it.life?.state == "dead" }) throw Refusal("not-a-root")
            // Only a root has a visibility; the owner's guide replaces one a fork inherited, unless the same intent says it is inherited.
            "meta" -> {
                val visible = change.scope == context.originScope && context.deltas.any { it.key.type == "meta" && "visibility" in it.fields }
                if (visible && valueOf(context.storedIn(context.ownerScope, "tree", change.scope.tree!!), "parent") != null) throw Refusal("not-a-root")
                if (original?.get("f")?.get("guide") == after["f"]?.get("guide") || valueOf(after, "guideInherited") != Json.of(true)) return
                if (context.deltas.any { it.key.type == "meta" && "guideInherited" in it.fields }) return
                outcome.append(change.scope, Json.objectOf("t" to Json.of("meta"), "id" to Json.of("meta"), "f" to Json.objectOf("guideInherited" to serverStamped(Json.of(false)))))
            }
            // R-3: a pointer and the workspace are admitted only in the overlay of the roadmap's owner.
            in OWNER_ONLY -> {
                val overlay = context.state.scopes[change.scope.text]!!
                if (overlay.governedBy?.let { context.state.scopes[it] }?.owner != overlay.owner) throw Refusal("forbidden")
            }
            // Coach's conversation (Roadmap Coach §9): its death kills its messages, with their write fates, and its proposals.
            "coachThread" -> if (died(original, after)) endConversation(change.scope, change.key.id.json, outcome)
            // A message's death kills its write fates; once its writer has ended the turn, its state, text, calls and receipts are final.
            "coachMessage" -> {
                if (died(original, after)) return endFates(change.scope, id!!, outcome)
                val ended = present(original) && valueOf(original, "state")?.str() in WRITER_TERMINAL
                val writes = context.deltas.filter { it.key == change.key }.flatMap { it.fields.keys }
                if (ended && writes.any { it in FINAL_REGISTERS }) throw Refusal("turn-final")
            }
        }
    }

    private fun endConversation(scope: ScopeKey, thread: Json, outcome: Outcome) {
        for (message in outcome.rows(scope, "coachMessage").filter { valueOf(it, "threadId") == thread }) {
            outcome.kill(scope, message)
            endFates(scope, message.member("id").str(), outcome)
        }
        for (proposal in outcome.rows(scope, "coachProposal").filter { valueOf(it, "threadId") == thread }) outcome.kill(scope, proposal)
    }

    // Roadmap Coach §9: the conversations about the roadmaps `ended`, each as its own death ends it, and the proposals about them, whatever
    // conversation holds them. A conversation about all roadmaps names none and stays.
    private fun endCoachRecordsAbout(scope: ScopeKey, ended: List<String>, outcome: Outcome) {
        fun about(row: Json) = present(row) && (valueOf(row, "treeId") as? Json.Str)?.value in ended
        val byId = Comparator<Json> { a, b -> compareBytes(a.member("id").str(), b.member("id").str()) }
        for (thread in outcome.rows(scope, "coachThread").filter(::about).sortedWith(byId)) {
            outcome.kill(scope, thread)
            endConversation(scope, thread.member("id"), outcome)
        }
        for (proposal in outcome.rows(scope, "coachProposal").filter(::about).sortedWith(byId)) outcome.kill(scope, proposal)
    }

    private fun endFates(scope: ScopeKey, message: String, outcome: Outcome) {
        for (fate in outcome.rows(scope, "coachWriteFate").filter { valueOf(it, "messageId") == Json.of(message) }) outcome.kill(scope, fate)
    }

    // §5: a change to a step or a kind carries its life as alive; one that is still dead once it has joined, the delete being newer, the server
    // revives.
    private fun revive(context: RuleContext, outcome: Outcome) {
        for (delta in context.deltas.filter { it.key.type in REVIVED_BY_A_CHANGE && it.life?.state == "alive" }) {
            val row = outcome.row(context.originScope, delta.key.type, delta.key.id.string!!)
            if (!present(row)) outcome.append(context.originScope, Json.objectOf("t" to Json.of(delta.key.type), "id" to delta.key.id.json, "life" to serverStamped(Json.of("alive")))
                .with("born" to row?.get("born")))
        }
    }

    // §4: a roadmap's death kills every subtree under it, and a root's deletes each step of the owner's other roadmaps whose pointer opens it.
    // Roadmap Coach §9: each roadmap that dies so takes the conversations and proposals about it.
    private fun endBranches(context: RuleContext, changes: List<RecordChange>, outcome: Outcome) {
        val account = context.ownerScope
        val roadmaps = Roadmaps(outcome.rows(account, "tree"))
        val deaths = changes.filter { it.scope == account && it.key.type == "tree" && died(it.before.row?.json, it.after.json) }
        val ended = mutableListOf<String>()
        for (death in deaths) {
            ended.add(death.key.id.string!!)
            for (id in roadmaps.under(death.key.id.string!!)) {
                outcome.kill(account, roadmaps.rows.getValue(id))
                ended.add(id)
            }
        }
        endCoachRecordsAbout(account, ended, outcome)
        val roots = deaths.filter { valueOf(it.before.row?.json, "parent") == null }.map { it.key.id.string!! }
        if (roots.isEmpty()) return
        for (tree in outcome.rows(account, "tree").filter(::present).map { it.member("id").str() }.sortedWith(::compareBytes)) {
            val overlay = context.overlayOf(tree)
            if (overlay !in context.declared) continue
            val opening = context.storedRows(overlay, "pointer").filter { present(it) && valueOf(it, "opens")?.str() in roots }
            for (pointer in opening.sortedWith { a, b -> compareBytes(a.member("id").str(), b.member("id").str()) }) {
                outcome.row(ScopeKey("tree:$tree"), "node", pointer.member("id").str())?.let { outcome.kill(ScopeKey("tree:$tree"), it) }
            }
        }
    }

    // §4: a root's reach is its visibility, so a change of the visibility, by the owner's write or an Undo's restore, writes the root's reach
    // and the reach of every subtree under it, standing ones taking the visibility.
    private fun settleVisibility(context: RuleContext, changes: List<RecordChange>, outcome: Outcome) {
        val tree = context.originScope.takeIf { it.kind == "tree" }?.tree ?: return
        val record = changes.firstOrNull { it.scope == context.originScope && it.key.type == "meta" } ?: return
        val visibility = valueOf(record.after.json, "visibility") ?: Json.of("private")
        if (visibility == (valueOf(record.before.row?.json, "visibility") ?: Json.of("private"))) return
        if ((valueOf(record.after.json, "reach") ?: Json.of("private")) != visibility) outcome.append(record.scope, metaReach(visibility))
        val roadmaps = Roadmaps(outcome.rows(context.ownerScope, "tree"))
        for ((id, reach) in reaches(roadmaps, roadmaps.under(tree), outcome)) outcome.append(ScopeKey("tree:$id"), metaReach(reach))
    }

    // §4: a step's death that ends a subtree's standing writes `reach` private on every subtree under it, and its revival writes the reach of
    // the roadmap above back.
    private fun settleReach(context: RuleContext, changes: List<RecordChange>, outcome: Outcome) {
        val steps = changes.filter { it.key.type == "node" }.map { it.scope to it.key.id.string!! } +
            outcome.appended.filter { (_, delta) -> delta.member("t").str() == "node" }.map { (scope, delta) -> scope to delta.member("id").str() }
        val flipped = steps.filter { (scope, id) -> present(context.storedIn(scope, "node", id)) != present(outcome.row(scope, "node", id)) }
        if (flipped.isEmpty()) return
        val roadmaps = Roadmaps(outcome.rows(context.ownerScope, "tree"))
        val subtrees = flipped.flatMap { (scope, id) -> roadmaps.branchOf(scope.tree!!, id) }
        for ((tree, reach) in reaches(roadmaps, subtrees, outcome)) outcome.append(ScopeKey("tree:$tree"), metaReach(reach))
    }

    // §4 reach over the subtrees given, parents first: a subtree's is its parent's while it and the step that owns it are present, and private
    // otherwise. Answers the reach each subtree takes where it changes.
    private fun reaches(roadmaps: Roadmaps, subtrees: List<String>, outcome: Outcome): List<Pair<String, Json>> {
        fun reachOf(tree: String) = valueOf(outcome.row(ScopeKey("tree:$tree"), "meta", "meta"), "reach") ?: Json.of("private")
        val settled = mutableMapOf<String, Json>()
        return subtrees.distinct().sortedWith(compareBy<String> { roadmaps.depthOf(it) }.thenComparator { a, b -> compareBytes(a, b) }).mapNotNull { id ->
            val place = roadmaps.placeOf(id)
            val stands = roadmaps.isAlive(id) && place != null && present(outcome.row(ScopeKey("tree:${place.text("tree")}"), "node", place.text("step")))
            val reach = if (stands) settled[place!!.text("tree")] ?: reachOf(place.text("tree")) else Json.of("private")
            settled[id] = reach
            (id to reach).takeIf { reach != reachOf(id) }
        }
    }

    override fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState) =
        revisions.sortedWith(ServerState.revisionOrder).groupBy { it.recordKey to it.member("field").str() }.values.map { it.last() }

    // The owner's roadmaps as their `tree` records hold them: where a subtree sits, which subtrees a step owns, and what lies under a roadmap.
    private class Roadmaps(rows: List<Json>) {
        val rows: Map<String, Json> = rows.associateBy { it.member("id").str() }
        fun placeOf(id: String): Json? = valueOf(rows[id], "parent")
        fun isAlive(id: String) = present(rows[id])
        // The alive subtrees `step` of `tree` owns, the least id first.
        fun ownedBy(tree: String, step: String): List<String> = rows.values.filter { present(it) && valueOf(it, "parent") == Json.objectOf("tree" to Json.of(tree), "step" to Json.of(step)) }
            .map { it.member("id").str() }.sortedWith(::compareBytes)
        // Every alive subtree under `tree`, each after the roadmap that holds its step.
        fun under(tree: String): List<String> {
            val found = mutableListOf<String>()
            val holders = ArrayDeque(listOf(tree))
            while (holders.isNotEmpty()) {
                val holder = holders.removeFirst()
                val children = rows.values.filter { present(it) && valueOf(it, "parent")?.get("tree") == Json.of(holder) && it.member("id").str() != tree && it.member("id").str() !in found }
                for (id in children.map { it.member("id").str() }.sortedWith(::compareBytes)) { found.add(id); holders.add(id) }
            }
            return found
        }
        // The subtrees a step owns and every subtree under them: the branch its presence decides.
        fun branchOf(tree: String, step: String): List<String> = ownedBy(tree, step).flatMap { listOf(it) + under(it) }
        fun depthOf(id: String): Int {
            var depth = 0
            var place = placeOf(id)
            while (place != null && depth <= MAX_DEPTH + 1) { depth++; place = placeOf(place.text("tree")) }
            return depth
        }
    }

    // The rows of the declared scopes as this intent leaves them: stored, then joined, then what the rules append.
    private class Outcome(private val context: RuleContext, changes: List<RecordChange>) {
        private val joined = linkedMapOf<Pair<ScopeKey, RecordKey>, Json>().apply { for (change in changes) put(change.scope to change.key, change.after.json) }
        val byScope = linkedMapOf<ScopeKey, MutableList<Json>>()
        val appended = mutableListOf<Pair<ScopeKey, Json>>()
        fun row(scope: ScopeKey, type: String, id: String): Json? = joined[scope to RecordKey(type, RecordID(id))] ?: context.storedIn(scope, type, id)
        fun rows(scope: ScopeKey, type: String): List<Json> = (context.storedRows(scope, type).associateBy { it.recordKey } +
            joined.filterKeys { (at, key) -> at == scope && key.type == type }.mapKeys { it.key.second }).values.toList()
        fun append(scope: ScopeKey, delta: Json) {
            byScope.getOrPut(scope) { mutableListOf() }.add(delta)
            appended.add(scope to delta)
            val key = delta.recordKey
            val row = row(scope, key.type, key.id.string!!) ?: Json.objectOf("t" to Json.of(key.type), "id" to key.id.json)
            val fields = delta["f"]?.let { written -> Json.Obj(((row["f"]?.obj() ?: emptyMap()) + written.obj()).toList()) } ?: row["f"]
            joined[scope to key] = row.with("life" to (delta["life"] ?: row["life"]), "f" to fields)
        }
        fun kill(scope: ScopeKey, row: Json) {
            val key = row.recordKey
            if (present(row(scope, key.type, key.id.string!!))) append(scope, Json.objectOf("t" to Json.of(key.type), "id" to key.id.json, "life" to serverStamped(Json.of("dead"))).with("born" to row["born"]))
        }
    }

    private class GenesisKind(val id: String, val values: List<Pair<String, String>>)

    private companion object {
        const val MAX_DEPTH = 8
        val OWNER_ONLY = listOf("pointer", "subtask", "stepLink", "stepNote")
        val WRITER_TERMINAL = listOf("completed", "declined", "failed", "stopped")
        val FINAL_REGISTERS = listOf("state", "text", "calls", "receipts")
        val REVIVED_BY_A_CHANGE = listOf("node", "kind")
        // The genesis legend (packages/api-contract/genesis.js), each kind ordered by its place in it.
        val GENESIS_KINDS = listOf(
            GenesisKind("build", listOf("hue" to "terracotta", "label" to "Build", "description" to "Things you make", "ord" to "a0")),
            GenesisKind("learn", listOf("hue" to "olive", "label" to "Learn", "description" to "Things you figure out", "ord" to "a1")),
            GenesisKind("milestone", listOf("hue" to "gold", "label" to "Milestone", "description" to "Moments that matter", "ord" to "a2")),
        )

        fun valueOf(row: Json?, field: String): Json? = row?.get("f")?.get(field)?.arr()?.first()?.orNull()
        fun present(row: Json?) = row?.get("life")?.arr()?.first() == Json.of("alive")
        fun died(original: Json?, after: Json?) = present(original) && !present(after)
        fun serverStamped(value: Json) = Json.array(value, Json.Null)
        fun metaReach(reach: Json) = Json.objectOf("t" to Json.of("meta"), "id" to Json.of("meta"), "f" to Json.objectOf("reach" to serverStamped(reach)))
        fun branchOf(tree: String, step: String) = RecordSlot(RecordAddress(ScopeRef.tree(tree), RecordKey("node", RecordID(step))), Slot(Slot.Kind.field, "branch"))
        fun Json.text(name: String): String = member(name).str()
        // A record written whatever its life: a dead one keeps its stored life, so the write revives nothing.
        fun written(record: Json, fields: Json): Json = Json.objectOf("t" to record.member("t"), "id" to record.member("id"), "f" to fields)
            .with("born" to record["born"], "life" to record["life"].takeIf { !present(record) })
        fun killed(record: Json): Json = Json.objectOf("t" to record.member("t"), "id" to record.member("id"), "life" to serverStamped(Json.of("dead"))).with("born" to record["born"])
        fun skipped(context: RuleContext, code: String) = CommandOutcome(detail = InverseOutcome.detail(listOf(InverseOutcome(0, code))), product = context.product)
        // A delta of the rules in its JSON form, as admission reads it in `scope`.
        fun planned(scope: ScopeKey, delta: Json, source: String, context: RuleContext): PlannedDelta = IntentShape.effect(delta, scope, source, context.registry)
    }
}

private val RuleContext.ownerScope: ScopeKey get() = ScopeKey("acct:$account/roadmap")
private fun RuleContext.overlayOf(tree: String) = ScopeKey("acct:$account/overlay/$tree")
// A scope's stored rows of a type, in their JSON form, by key.
private fun RuleContext.storedRows(scope: ScopeKey, type: String): List<Json> = state.rows[scope.text].orEmpty().filterKeys { it.type == type }.toSortedMap().values.toList()
private fun RuleContext.storedIn(scope: ScopeKey, type: String, id: String): Json? = state.rows[scope.text]?.get(RecordKey(type, RecordID(id)))
