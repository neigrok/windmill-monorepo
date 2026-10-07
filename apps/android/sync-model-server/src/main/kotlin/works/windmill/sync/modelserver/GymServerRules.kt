package works.windmill.sync.modelserver

import works.windmill.sync.core.*

class GymServerRules : ServerRules {
    override fun elsewhere(key: RecordKey, product: Json) = key.type == "exercise" && product["seeds"]?.get(key.id.toString()) != null
    override fun replays(command: CheckedCommand, context: RuleContext) = when (command.name) {
        "gym.start" -> context.entry("starts", command.string("id")) != null
        "gym.importSession" -> context.entry("imports", command.string("id")) != null
        "gym.correctSession" -> context.entry("corrections", command.string("requestId")) != null; else -> false
    }
    override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome = when (command.name) {
        "gym.start" -> start(command, context); "gym.importSession" -> importSession(command, context)
        "gym.correctSession" -> correctSession(command, context); "gym.finish" -> finish(command, context)
        "gym.applyProposal" -> applyProposal(command, context); "gym.dismissProposal" -> dismissProposal(command, context)
        "gym.closeStale" -> CommandOutcome(staleClose(context), product = context.product); else -> throw Refusal("invalid")
    }
    private fun start(cmd: CheckedCommand, c: RuleContext): CommandOutcome {
        val called = cmd.string("id"); val deltas = staleClose(c); c.ensure("starts")
        val own = c.idState(key("session", called)).row; val resolved = c.entry("starts", called)?.str() ?: own?.key?.id?.toString()
        if (resolved != null) {
            val session = c.idState(key("session", resolved)).row
            return CommandOutcome(deltas, if (session?.isAlive == true) listOf(claim(session, called.takeIf { it != resolved })) else emptyList(), product = c.product)
        }
        val closed = deltas.map { it.key }.toSet(); val open = c.storedRecords("session").firstOrNull { isOpen(it) && it.key !in closed }
        if (open != null) {
            if (cmd.args["joinOpenSession"] != Json.of(true)) throw Refusal("session-open")
            c.store("starts", called, open.key.id.json); return CommandOutcome(deltas, listOf(claim(open, called)), product = c.product)
        }
        val fields = sessionFields(cmd, c); c.store("starts", called, Json.of(called)); val session = key("session", called)
        return CommandOutcome(deltas + PlannedDelta.create(session, fields), listOf(WriteClaim(session, mintedBorn = true, fields = fields.keys.sorted())), product = c.product)
    }
    private fun sessionFields(cmd: CheckedCommand, c: RuleContext): Map<String, Json> {
        val fields = mutableMapOf("startedAt" to cmd.args.getValue("startedAt"))
        (cmd.args["routineId"] as? Json.Str)?.value?.let { id ->
            val routine = c.idState(key("routine", id)).row; val readable = routine?.isAlive == true
            fields["routineId"] = if (readable) Json.of(id) else Json.Null
            fields["plan"] = if (readable) Json.objectOf("routine" to (value(routine, "name") ?: Json.Null), "entries" to (value(routine, "entries") ?: Json.Null)) else Json.Null
            if (readable) fields["historyRoutineId"] = Json.of(id)
        }
        return fields
    }
    private fun importSession(cmd: CheckedCommand, c: RuleContext): CommandOutcome {
        val called = cmd.string("id"); val sets = cmd.args.getValue("sets").arr(); val deltas = staleClose(c); c.ensure("imports")
        c.entry("imports", called)?.let { receipt ->
            if (receipt != Json.Obj(cmd.args.toList())) throw Refusal("payload-conflict")
            return CommandOutcome(deltas, replayWrite(called, sets, c), product = c.product)
        }
        when (c.idState(key("session", called)).state) { "alive", "dead" -> throw Refusal("payload-conflict"); "foreign" -> throw Refusal("id-taken") }
        checkSets(sets, cmd, false, c)
        val fields = sessionFields(cmd, c) + mapOf("finishedAt" to cmd.args.getValue("finishedAt"), "closedBy" to Json.of("finish"))
        val session = key("session", called); val written = mutableListOf(PlannedDelta.create(session, fields)); val claims = mutableListOf(WriteClaim(session, mintedBorn = true, fields = fields.keys.sorted()))
        for (set in sets) {
            val setKey = key("set", set.member("id").str()); val sf = setFields(called, set)
            written.add(PlannedDelta.create(setKey, sf)); claims.add(WriteClaim(setKey, mintedBorn = true, fields = sf.keys.sorted()))
        }
        c.store("imports", called, Json.Obj(cmd.args.toList())); return CommandOutcome(deltas + written, claims, product = c.product)
    }
    private fun checkSets(sets: List<Json>, cmd: CheckedCommand, correction: Boolean, c: RuleContext) {
        if (sets.map { it.member("id") }.distinct().size != sets.size) throw Refusal("invalid")
        if (correction && (sets.isEmpty() || sets.map { Json.array(it.member("exerciseId"), it.member("setNumber")) }.distinct().size != sets.size || sets.any { it.member("setNumber").long() !in 1..2_147_483_647L })) throw Refusal("invalid")
        val start = cmd.args.getValue("startedAt").long(); val end = cmd.args.getValue("finishedAt").long()
        if (end < start || end > c.serverNow || sets.any { it.member("completedAt").long() !in start..end }) throw Refusal("bad-instant")
        val id = cmd.string(if (correction) "sessionId" else "id")
        val crossed = c.storedRecords("session").filter { row ->
            val finished = value(row, "finishedAt"); val otherStart = value(row, "startedAt")?.long() ?: 0
            row.isAlive && row.key.id.toString() != id && finished != null && finished !== Json.Null && otherStart < maxOf(end, start + 1) && start < maxOf(finished.long(), otherStart + 1)
        }.sortedWith(compareBy<Row> { value(it, "startedAt")!!.long() }.thenBy { it.key }).firstOrNull()
        if (crossed != null) throw Refusal("session-overlap", Json.objectOf("sessionId" to crossed.key.id.json))
    }
    private fun setFields(session: String, set: Json) = mapOf("sessionId" to Json.of(session), "exerciseId" to set.member("exerciseId"), "weightKg" to set.member("weightKg"), "reps" to set.member("reps"), "kind" to (set["kind"] ?: Json.of("working")), "note" to (set["note"] ?: Json.of("")), "completedAt" to set.member("completedAt")) + listOf("rpe").mapNotNull { name -> set[name]?.let { name to it } }.toMap()
    private fun replayWrite(session: String, sets: List<Json>, c: RuleContext) = (listOf(key("session", session)) + sets.map { key("set", it.member("id").str()) }).mapNotNull { k -> c.idState(k).row?.takeIf { it.isAlive }?.let { claim(it) } }
    private fun correctSession(cmd: CheckedCommand, c: RuleContext): CommandOutcome {
        val id = cmd.string("sessionId"); val session = alive(key("session", id), c); val request = cmd.string("requestId"); val sets = cmd.args.getValue("sets").arr(); c.ensure("corrections")
        c.entry("corrections", request)?.let { receipt ->
            if (receipt["sessionId"] != Json.of(id) || receipt["args"] != Json.Obj(cmd.args.toList())) throw Refusal("payload-conflict")
            return CommandOutcome(write = replayWrite(id, sets, c), product = c.product)
        }
        if (isOpen(session)) throw Refusal("session-open")
        checkSets(sets, cmd, true, c)
        val standing = c.storedRecords("set").filter { it.isAlive && value(it, "sessionId") == Json.of(id) }
        val named = sets.map { it.member("id") }.toSet()
        val preserve = cmd.args["preserveOtherSets"] == Json.of(true)
        if (preserve) for (prior in standing.filter { it.key.id.json !in named }) {
            if (value(prior, "completedAt")!!.long() !in cmd.args.getValue("startedAt").long()..cmd.args.getValue("finishedAt").long()) throw Refusal("bad-instant")
            if (sets.any { it["exerciseId"] == value(prior, "exerciseId") && it["setNumber"] == prior.serials["setNumber"] }) throw Refusal("invalid")
        }
        val fields = mapOf("startedAt" to cmd.args.getValue("startedAt"), "finishedAt" to cmd.args.getValue("finishedAt"), "closedBy" to Json.of("finish"), "displayName" to cmd.args.getValue("routineName"))
        val deltas = mutableListOf(PlannedDelta.update(session.key, session.lattice.born, fields)); val claims = mutableListOf(WriteClaim(session.key, fields = fields.keys.sorted()))
        for (set in sets) {
            val setKey = key("set", set.member("id").str()); val prior = standing.firstOrNull { it.key == setKey }
            if (prior != null) {
                if (value(prior, "exerciseId") != set["exerciseId"]) throw Refusal("invalid")
                val sf = listOf("weightKg", "reps", "completedAt", "rpe", "note").mapNotNull { name -> set[name]?.let { name to it } }.toMap()
                deltas.add(PlannedDelta.update(setKey, prior.lattice.born, sf).copy(serials = mapOf("setNumber" to set.member("setNumber"))))
                claims.add(WriteClaim(setKey, fields = sf.keys.sorted()))
            } else {
                val sf = setFields(id, set); deltas.add(PlannedDelta.create(setKey, sf).copy(serials = mapOf("setNumber" to set.member("setNumber"))))
                claims.add(WriteClaim(setKey, mintedBorn = true, fields = sf.keys.sorted()))
            }
        }
        if (!preserve) deltas.addAll(standing.filter { it.key.id.json !in named }.map { PlannedDelta.delete(it.key, it.lattice.born) })
        c.store("corrections", request, Json.objectOf("sessionId" to Json.of(id), "args" to Json.Obj(cmd.args.toList())))
        return CommandOutcome(deltas, claims, product = c.product)
    }
    private fun finish(cmd: CheckedCommand, c: RuleContext): CommandOutcome {
        val session = alive(key("session", cmd.string("sessionId")), c); val finished = cmd.args.getValue("finishedAt").long()
        if (finished <= 0 || finished < value(session, "startedAt")!!.long()) throw Refusal("bad-instant")
        val stored = value(session, "finishedAt")?.orNull()?.long()
        if (stored != null && value(session, "closedBy") != Json.of("stale")) return CommandOutcome(product = c.product)
        val at = stored?.let { if (finished > it + STALE_MS) it else maxOf(it, finished) } ?: finished
        return CommandOutcome(listOf(PlannedDelta.update(session.key, session.lattice.born, mapOf("finishedAt" to Json.of(at), "closedBy" to Json.of("finish")))), listOf(WriteClaim(session.key, fields = listOf("finishedAt", "closedBy"))), product = c.product)
    }
    private fun applyProposal(cmd: CheckedCommand, c: RuleContext): CommandOutcome {
        val proposal = alive(key("proposal", cmd.string("proposalId")), c)
        if (proposalState(proposal) == "applied") return CommandOutcome(product = c.product)
        unsettled(proposal, c)
        val routineId = value(proposal, "routineId")!!.str()
        if (value(c.idState(key("routine", routineId)).row, "revision") != value(proposal, "baseRevision")) throw superseded("routine-changed")
        val routine = alive(key("routine", routineId), c)
        val settle = PlannedDelta.update(proposal.key, proposal.lattice.born, mapOf("state" to Json.of("applied"), "settledAt" to Json.of(c.serverNow)))
        if (value(proposal, "intent") == Json.of("remove")) return CommandOutcome(listOf(settle, PlannedDelta.delete(routine.key, routine.lattice.born)), product = c.product)
        val entries = value(proposal, "changes")!!.arr().filter { it["kind"] != Json.of("removed") }.map { (it["after"] ?: Json.objectOf()).with("exerciseId" to it["exerciseId"]) }
        return CommandOutcome(listOf(settle, PlannedDelta.update(routine.key, routine.lattice.born, mapOf("name" to value(proposal, "proposedName")!!, "entries" to Json.Arr(entries)))), listOf(WriteClaim(proposal.key, fields = listOf("state", "settledAt")), WriteClaim(routine.key, fields = listOf("name", "entries"))), product = c.product)
    }
    private fun dismissProposal(cmd: CheckedCommand, c: RuleContext): CommandOutcome {
        val proposal = alive(key("proposal", cmd.string("proposalId")), c)
        if (proposalState(proposal) == "dismissed") return CommandOutcome(product = c.product)
        unsettled(proposal, c)
        return CommandOutcome(listOf(PlannedDelta.update(proposal.key, proposal.lattice.born, mapOf("state" to Json.of("dismissed"), "settledAt" to Json.of(c.serverNow)))), listOf(WriteClaim(proposal.key, fields = listOf("state", "settledAt"))), product = c.product)
    }
    private fun superseded(reason: String) = Refusal("proposal-superseded", Json.objectOf("reason" to Json.of(reason)))
    private fun unsettled(proposal: Row, c: RuleContext) {
        val state = proposalState(proposal)
        if (state in listOf("applied", "dismissed")) throw Refusal("proposal-settled", Json.objectOf("state" to Json.of(state)))
        if (state != "superseded") return
        if (value(proposal, "supersededBy")?.orNull() != null) throw superseded("replaced")
        if (value(c.idState(key("routine", value(proposal, "routineId")!!.str())).row, "revision") != value(proposal, "baseRevision")) throw superseded("routine-changed")
        throw superseded("superseded")
    }
    override fun check(changes: List<RecordChange>, context: RuleContext): List<PlannedDelta> {
        val c = context
        val metadata = mapOf("routine" to listOf("revision", "createdEntries"), "proposal" to listOf("baseRevision", "baseName", "changeCount"), "note" to listOf("updatedAt"))
        if (c.deltas.any { it.key.type == "routineCreation" || metadata[it.key.type].orEmpty().any(it.fields::containsKey) }) {
            throw Refusal("invalid")
        }
        val appended = mutableListOf<PlannedDelta>(); val numbered = c.storedRecords("set").toMutableList()
        val staged = listOf("set", "session", "routine", "routineCreation", "proposal", "exercise", "exerciseName", "note").flatMap(c::records).associateBy { it.key }.toMutableMap()
        val newly = changes.filter { it.createdHere }.map { it.key }.toSet(); val checked = mutableSetOf<RecordKey>()
        fun records(type: String) = staged.values.filter { it.key.type == type }.sortedBy { it.key }
        fun append(delta: PlannedDelta) {
            appended.add(delta); val row = staged[delta.key] ?: Row(delta.key, seq = 0)
            val life = delta.life?.let { Life(it.state, row.lattice.life?.stamp ?: Stamp.UNSET) } ?: row.lattice.life
            staged[delta.key] = row.copy(lattice = Lattice(life, row.lattice.born, row.lattice.fields + delta.fields.mapValues { (name, reg) -> Register(reg.value, row.lattice.fields[name]?.stamp ?: Stamp.UNSET) }))
        }
        fun known(id: Json?): Boolean = (id as? Json.Str)?.let { c.product["seeds"]?.get(it.value) != null || staged[key("exercise", it.value)]?.isAlive == true } ?: false
        for (change in changes.filter { it.key.type == "routine" && it.after.isAlive }) {
            val created = change.createdHere
            if (!created && !changed(change, "name") && !changed(change, "entries")) continue
            val revision = if (created) 1 else (value(change.before.row, "revision")?.long() ?: throw Refusal("invalid")) + 1
            if (revision > 2_147_483_647) throw Refusal("invalid")
            val fields = mutableMapOf("revision" to Json.of(revision))
            if (created) fields["createdEntries"] = Json.of(value(change.after, "entries")?.arr()?.size ?: 0)
            append(PlannedDelta.update(change.key, change.after.lattice.born, fields))
        }
        for (change in changes) {
            val row = change.after; val before = change.before.row; val created = change.createdHere
            when (row.key.type) {
                "set" -> {
                    if (row.isAlive && row.serials["setNumber"]?.long()?.let { it !in 1..2_147_483_647L } == true) throw Refusal("invalid")
                    if (!created) { if (before != null && c.deltas.any { it.key == row.key && "completedAt" in it.fields }) throw Refusal("invalid"); continue }
                    val session = (value(row, "sessionId") as? Json.Str)?.let { staged[key("session", it.value)] }
                    if (session?.isAlive == true && "command" !in change.createdBy) {
                        val finished = value(session, "finishedAt")?.orNull()?.long()
                        if (finished != null) {
                            val completed = value(row, "completedAt")?.long() ?: 0
                            if (value(session, "closedBy") != Json.of("stale") || completed > finished + STALE_MS) throw Refusal("session-finished")
                            if (completed > finished) append(PlannedDelta.update(session.key, session.lattice.born, mapOf("finishedAt" to Json.of(completed))))
                        }
                    }
                    if (!known(value(row, "exerciseId"))) throw Refusal("unknown-exercise")
                    if (change.before.state == "none") {
                        var set = row
                        if (set.serials["setNumber"] == null) {
                            val highest = numbered.filter { it.key != set.key && it.isAlive && value(it, "sessionId") == value(set, "sessionId") && value(it, "exerciseId") == value(set, "exerciseId") }.mapNotNull { it.serials["setNumber"]?.long() }.maxOrNull() ?: 0
                            if (highest >= 2_147_483_647) throw Refusal("invalid")
                            set = set.copy(serials = set.serials + ("setNumber" to Json.of(highest + 1)))
                        }
                        numbered.add(set)
                    }
                }
                "session" -> {
                    if (created) { if (change.createdBy.any { it != "command" }) throw Refusal("invalid"); continue }
                    if (!change.diesHere || before == null) continue
                    val last = records("set").filter { it.isAlive && value(it, "sessionId") == row.key.id.json }.mapNotNull { value(it, "completedAt")?.long() }.maxOrNull() ?: value(before, "startedAt")?.long() ?: 0
                    if (isOpen(before) && c.serverNow - last < STALE_MS) throw Refusal("session-open")
                    records("set").filter { it.isAlive && value(it, "sessionId") == row.key.id.json }.forEach { append(PlannedDelta.delete(it.key, it.lattice.born)) }
                }
                "routine" -> {
                    if (change.diesHere) {
                        records("proposal").filter { it.isAlive && value(it, "routineId") == row.key.id.json }.forEach { append(PlannedDelta.delete(it.key, it.lattice.born)) }
                        records("session").filter { it.isAlive && value(it, "routineId") == row.key.id.json }.forEach { append(PlannedDelta.update(it.key, it.lattice.born, mapOf("routineId" to Json.Null))) }; continue
                    }
                    if (!row.isAlive) continue
                    if (blankNamed(change, "name")) throw Refusal("invalid")
                    if (created || changed(change, "entries")) {
                        val entries = value(row, "entries")?.arr() ?: throw Refusal("invalid")
                        if (entries.isEmpty() || entries.any { it["sets"]?.arr()?.isEmpty() == true }) throw Refusal("invalid")
                        if (entries.any { !known(it["exerciseId"]) }) throw Refusal("unknown-exercise")
                    }
                    if (created && value(row, "createdDoor") == Json.of("ask")) {
                        if (staged[key("routineCreation", row.key.id.toString())] != null) throw Refusal("invalid")
                        val snapshot = Json.objectOf("id" to row.key.id.json, "name" to value(row, "name")!!,
                            "position" to (value(row, "position") ?: Json.of(0)), "revision" to Json.of(1),
                            "entries" to Json.Arr(value(row, "entries")!!.arr().mapIndexed { index, entry -> entry.with("position" to Json.of(index + 1)) }))
                        append(PlannedDelta.update(key("routineCreation", row.key.id.toString()), null, mapOf("snapshot" to snapshot)))
                    }
                    if (!created && (changed(change, "name") || changed(change, "entries"))) records("proposal").filter { it.isAlive && value(it, "routineId") == row.key.id.json && proposalState(it) == "pending" }.forEach { append(PlannedDelta.update(it.key, it.lattice.born, mapOf("state" to Json.of("superseded"), "settledAt" to Json.of(c.serverNow)))) }
                }
                "exercise" -> {
                    if (change.diesHere || created && value(row, "stepKg") == null) throw Refusal("invalid")
                    if (blankNamed(change, "name")) throw Refusal("invalid")
                    val bn = value(before, "name"); val an = value(row, "name")
                    if (changed(change, "name") && bn != null && an != null) append(PlannedDelta.update(row.key, row.lattice.born, mapOf("aliases" to renamed(value(row, "aliases"), bn, an))))
                }
                "exerciseName" -> {
                    val seed = c.product["seeds"]?.get(row.key.id.toString()) ?: throw Refusal("invalid")
                    if (blankNamed(change, "name")) throw Refusal("invalid")
                    val bn = value(before, "name") ?: seed.member("name"); val an = value(row, "name") ?: seed.member("name")
                    if (bn != an) append(PlannedDelta.update(row.key, null, mapOf("aliases" to renamed(value(row, "aliases"), bn, an))))
                }
                "weighin" -> if (row.isAlive && row.key.id.toString() > utcDay(c.serverNow + 86_400_000)) throw Refusal("bad-instant")
                "note" -> {
                    if (blankNamed(change, "title")) throw Refusal("invalid")
                    if (created || changed(change, "title") || changed(change, "body")) append(PlannedDelta.update(row.key, row.lattice.born, mapOf("updatedAt" to Json.of(c.serverNow))))
                }
                "proposal" -> {
                    if (!created) continue
                    if (c.origin.isReplica && (value(row, "door") != Json.of("ask") || (value(row, "connection") ?: Json.of("")) != Json.of("") || (value(row, "agent") ?: Json.of("")) != Json.of(""))) throw Refusal("invalid")
                    val routineId = value(row, "routineId")?.str() ?: throw Refusal("unknown-record"); val routine = staged[key("routine", routineId)]?.takeIf { it.isAlive } ?: throw Refusal("unknown-record")
                    if (c.origin.isReplica) for (field in listOf("entries", "name")) if (c.guards.none { it.key == routine.key && it.field == field && it.stamp == routine.lattice.fields[field]?.stamp }) throw Refusal("invalid")
                    checkProposal(row, routine, ::known)
                    append(PlannedDelta.update(row.key, row.lattice.born, mapOf("baseRevision" to value(routine, "revision")!!,
                        "baseName" to value(routine, "name")!!, "changeCount" to Json.of(proposalChangeCount(row, routine)))))
                    records("proposal").filter { (it.key !in newly || it.key in checked) && it.key != row.key && it.isAlive && proposalState(it) == "pending" && value(it, "routineId") == Json.of(routineId) && value(it, "door") == value(row, "door") && (value(it, "connection") ?: Json.of("")) == (value(row, "connection") ?: Json.of("")) }.forEach {
                        append(PlannedDelta.update(it.key, it.lattice.born, mapOf("state" to Json.of("superseded"), "supersededBy" to row.key.id.json, "settledAt" to Json.of(c.serverNow))))
                    }
                    checked.add(row.key)
                }
            }
        }
        return appended
    }
    private fun proposalChangeCount(proposal: Row, routine: Row): Int {
        val changes = value(proposal, "changes")!!.arr(); val base = value(routine, "entries")!!.arr()
        var count = changes.count { it["kind"] != Json.of("kept") } + if (value(routine, "name") == value(proposal, "proposedName")) 0 else 1
        val matched = mutableSetOf<Int>(); var highest = -1
        for (change in changes.filter { it["kind"] !in listOf(Json.of("added"), Json.of("removed")) }) {
            val index = base.indices.first { it !in matched && base[it]["exerciseId"] == change["exerciseId"] }
            matched.add(index)
            if (index < highest) { count++; break }
            highest = index
        }
        return count
    }
    private fun checkProposal(proposal: Row, routine: Row, known: (Json?) -> Boolean) {
        val changes = value(proposal, "changes")!!.arr(); val base = value(routine, "entries")!!.arr()
        val proposed = changes.filter { it["kind"] != Json.of("removed") }.map { (it["after"] ?: throw Refusal("invalid")).with("exerciseId" to it["exerciseId"]) }
        if (value(proposal, "intent") == Json.of("remove")) { if (proposed.isNotEmpty()) throw Refusal("invalid") }
        else if (proposed.isEmpty() || proposed.size > 50 || TextMerge.isBlank((value(proposal, "proposedName") as? Json.Str)?.value ?: "") || proposed.any { it["sets"]?.arr()?.isEmpty() == true }) throw Refusal("invalid")
        fun targets(entry: Json) = Json.objectOf().with("sets" to entry["sets"], "restSeconds" to entry["restSeconds"])
        val matched = mutableSetOf<Int>(); val expected = mutableListOf<Json>()
        for (entry in proposed) {
            val index = base.indices.firstOrNull { it !in matched && base[it]["exerciseId"] == entry["exerciseId"] }; val after = targets(entry)
            var change = Json.objectOf("exerciseId" to entry.member("exerciseId"), "after" to after)
            if (index != null) { matched.add(index); val before = targets(base[index]); change = change.with("before" to before, "kind" to Json.of(if (before == after) "kept" else "retargeted")) }
            else change = change.with("kind" to Json.of("added"))
            expected.add(change)
        }
        for (index in base.indices.filter { it !in matched }) expected.add(Json.objectOf("kind" to Json.of("removed"), "exerciseId" to base[index].member("exerciseId"), "before" to targets(base[index])))
        if (changes != expected) throw Refusal("invalid")
        if (proposed.any { !known(it["exerciseId"]) }) throw Refusal("unknown-exercise")
    }
    private fun changed(change: RecordChange, field: String) = change.after.isAlive && change.before.isAlive && value(change.before.row, field) != value(change.after, field)
    private fun blankNamed(change: RecordChange, field: String) = change.after.isAlive && (value(change.after, field) as? Json.Str)?.value?.let(TextMerge::isBlank) == true &&
        (change.createdHere || change.before.row?.lattice?.fields?.get(field) != change.after.lattice.fields[field])
    private fun renamed(aliases: Json?, before: Json, after: Json) = Json.Arr((listOf(before) + aliases?.arr().orEmpty().filter { it != before && it != after }).take(5))
    private fun staleClose(c: RuleContext): List<PlannedDelta> {
        val open = c.storedRecords("session").firstOrNull(::isOpen) ?: return emptyList(); val last = lastActivity(open, c)
        return if (c.serverNow - last >= STALE_MS) listOf(PlannedDelta.update(open.key, open.lattice.born, mapOf("finishedAt" to Json.of(last), "closedBy" to Json.of("stale")))) else emptyList()
    }
    private fun lastActivity(session: Row, c: RuleContext) = c.storedRecords("set").filter { it.isAlive && value(it, "sessionId") == session.key.id.json }.mapNotNull { value(it, "completedAt")?.long() }.maxOrNull() ?: value(session, "startedAt")?.long() ?: 0
    private fun isOpen(row: Row) = row.isAlive && (value(row, "finishedAt") ?: Json.Null) === Json.Null
    private fun proposalState(row: Row) = (value(row, "state") as? Json.Str)?.value ?: "pending"
    private fun value(row: Row?, field: String) = row?.lattice?.fields?.get(field)?.value
    private fun key(type: String, id: String) = RecordKey(type, RecordID(id))
    private fun alive(key: RecordKey, c: RuleContext): Row = c.idState(key).let { if (it.row == null) throw Refusal("unknown-record"); if (!it.isAlive) throw Refusal("record-dead"); it.row }
    private fun claim(row: Row, from: String? = null) = WriteClaim(row.key, from?.let(::RecordID), row.lattice.born)
    private fun utcDay(ms: Long): String {
        val day = java.time.Instant.ofEpochMilli(ms).atOffset(java.time.ZoneOffset.UTC).toLocalDate()
        val year = day.year
        val text = if (year in 0..9999) year.toString().padStart(4, '0') else (if (year < 0) "-" else "+") + kotlin.math.abs(year).toString().padStart(6, '0')
        return (text + "-" + day.monthValue.toString().padStart(2, '0') + "-" + day.dayOfMonth.toString().padStart(2, '0')).take(10)
    }
    companion object { const val STALE_MS = 14_400_000L }
}
