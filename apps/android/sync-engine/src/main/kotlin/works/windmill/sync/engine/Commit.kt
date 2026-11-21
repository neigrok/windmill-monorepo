package works.windmill.sync.engine

import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.Command

internal class DeltaBuilder(private val engine: Engine, private val replica: ReplicaState, private val scope: ScopeRef,
    private val stamp: Stamp, private val now: Long, private val gone: Set<Delta>) {
    private val chosen = mutableMapOf<String, MutableSet<String>>()
    val baseTexts = mutableMapOf<String, Json>()
    val ids = mutableListOf<RecordID?>()
    private fun malformed(label: String): Nothing = throw CommitFailure.malformed(label)
    private fun current(key: RecordKey) = engine.view(replica, scope, key, ViewMode.drawn, gone)
    private fun taken(type: TypeDef): Set<String> = engine.keys(replica, scope, type.name).mapNotNull { it.id.string }.toSet() +
        replica.spent[scope.text]?.arr()?.filter { it.member("t").str() == type.name }?.mapNotNull { (it.member("id") as? Json.Str)?.value }.orEmpty() + chosen[type.name].orEmpty()
    private fun id(type: TypeDef, new: NewID): RecordID = when (new) {
        is NewID.Given -> new.id
        is NewID.Seeded -> RecordID(SeededId.make(new.seed, new.ordinal, type).id)
        is NewID.Derived -> {
            if (type.identity != "derived") malformed("not-derived")
            try {
                RecordID(DerivedId.from(new.label, type.json.member("derive").member("fallback").str(), taken(type), type.idMaxChars))
            } catch (_: IdentityError) {
                malformed("derived-id-bound")
            }
        }
        NewID.Minted -> {
            val mint = type.mint ?: malformed("not-minted")
            val taken = taken(type)
            var value: String
            do { value = mint.id(engine::draw) } while (value in taken)
            RecordID(value)
        }
    }
    private fun fields(type: TypeDef, values: Map<String, Json>, before: Record?, create: Boolean = false, server: Boolean = false): Map<String, Register> {
        val result = mutableMapOf<String, Register>()
        for ((name, raw) in values) {
            val field = type.fields[name]?.takeIf { it.isLattice } ?: malformed("not-lattice")
            if (!server && field.writer == "server") malformed("server-field")
            val value = field.domain?.rounded(raw) ?: raw
            if (before?.values?.get(name) != value) result[name] = Register(value, stamp)
        }
        if (create) for ((name, field) in type.fields) if (field.kind == "time" && field.writer == "client") result.putIfAbsent(name, Register(Json.of(now), stamp))
        return result
    }
    private fun texts(type: TypeDef, id: RecordID, values: Map<String, TextEdit>, before: Record?, server: Boolean = false): Map<String, TextWrite> = buildMap {
        for ((name, edit) in values) {
            val field = type.fields[name]?.takeIf { it.kind == "text" } ?: malformed("not-text")
            if (!server && field.writer == "server") malformed("server-field")
            val shown = before?.texts?.get(name)?.text ?: ""
            val from = edit.editedFrom ?: shown
            if (edit.text == shown) continue
            val confirmed = engine.store.row(replica.id, scope, RecordKey(type.name, id))?.texts?.get(name)
            put(name, TextWrite(edit.text, if (confirmed != null && confirmed.text == from) TextBase.Rev(confirmed.rev) else TextBase.Text(from)))
            baseTexts[Json.array(Json.of(type.name), id.json, Json.of(name)).jcs] = Json.of(from)
        }
    }
    private fun placed(type: TypeDef, id: RecordID, values: Map<String, Json>, anchor: OrderAnchor): Map<String, Json> {
        if (type.fields[anchor.field]?.domain?.type != "fracKey" || anchor.field in values) malformed("order-field")
        val outbox = engine.outboxDeltas(replica, scope)
        fun members(mode: ViewMode) = engine.keys(replica, scope, type.name).mapNotNull { key ->
            val record = engine.view(replica, scope, key, mode, gone, outbox[key].orEmpty()) ?: return@mapNotNull null
            if (!record.isVisible) return@mapNotNull null
            record.values[anchor.field]?.str()?.let { ListMember(record.id.json, FractionalKey(it)) }
        }
        val position = try { FractionalKey.dropping(id.json, anchor.below?.json, members(ViewMode.stored), members(ViewMode.drawn)).text }
            catch (_: FractionalKeyError) { malformed("anchor-missing") }
        return values + (anchor.field to Json.of(position))
    }
    fun build(change: Change, prediction: Boolean = false): Delta? {
        val type = engine.registry.type(change.type)?.takeIf { engine.registry.lives(it.name, scope) } ?: malformed("scope-type")
        val op = change.operation
        if (change.anchor != null && op !is Change.Operation.Create && op !is Change.Operation.Move) malformed("unexpected-anchor")
        val id = (op as? Change.Operation.Create)?.let { id(type, it.id) } ?: change.id ?: malformed("missing-id")
        if (!prediction) ids.add(id)
        val key = RecordKey(type.name, id)
        val before = current(key)
        if (prediction) {
            if (op !is Change.Operation.Create && op !is Change.Operation.Update && op !is Change.Operation.Delete &&
                op !is Change.Operation.Put && op !is Change.Operation.Write) malformed("prediction-operation")
            if (op is Change.Operation.Delete && !type.life) malformed("delete-life")
            val born = if (!type.hasBorn) null else if (op is Change.Operation.Create) stamp else before?.born ?: malformed("prediction-absent")
            for ((name, value) in change.serials) {
                if (type.fields[name]?.kind != "serial") malformed("not-serial")
                try { value.long(1) } catch (_: JsonError) { malformed("prediction-serial") }
            }
            if (op is Change.Operation.Delete) return Delta(key, Lattice(Life("dead", stamp), born))
            val life = if (!type.life) null else when {
                op is Change.Operation.Create -> Life("alive", stamp)
                op is Change.Operation.Put && type.identity == "keyed" -> {
                    if (op.present == null && before == null) malformed("prediction-absent")
                    val previous = before?.life?.isAlive == true
                    val present = op.present ?: previous
                    when {
                        present && (!previous || type.json.flag("wholePut")) -> Life("alive", stamp)
                        !present && previous -> Life("dead", stamp)
                        else -> before?.life
                    }
                }
                else -> null
            }
            return Delta(key, Lattice(life, born,
                fields(type, change.values, if (op is Change.Operation.Create) null else before, server = true)),
                texts(type, id, change.texts, before, server = true), change.serials)
        }
        if (op is Change.Operation.Create) {
            if (!type.hasBorn) malformed("not-creatable")
            chosen.getOrPut(type.name) { mutableSetOf() }.add(id.string ?: malformed("minted-id"))
            val values = change.anchor?.let { placed(type, id, change.values, it) } ?: change.values
            if (before != null) return null
            return Delta(key, Lattice(Life("alive", stamp), stamp, fields(type, values, null, create = true)), texts(type, id, change.texts, null))
        }
        if (op is Change.Operation.Delete && type.identity != "keyed") {
            if (!type.hasBorn || before == null) malformed("delete-absent")
            return Delta(key, Lattice(Life("dead", stamp), before.born))
        }
        if (op is Change.Operation.Revive) {
            if (!type.hasBorn) malformed("not-revivable")
            val born = before?.born ?: replica.spentBorn(scope, key) ?: malformed("revive-without-born")
            return Delta(key, Lattice(Life("alive", stamp), born, fields(type, change.values, before)))
        }
        var life: Life? = null
        var born: Stamp? = null
        var values = change.values
        if (op is Change.Operation.Update || op is Change.Operation.Move) {
            if (!type.hasBorn || before == null) malformed("update-absent")
            born = before.born
            if (op is Change.Operation.Move) values = placed(type, id, emptyMap(), change.anchor ?: malformed("move-anchor"))
        } else if (op is Change.Operation.Write) {
            if (type.life) malformed("write-life")
        } else if (op is Change.Operation.Put || op is Change.Operation.Delete) {
            if (type.identity != "keyed" || !type.life) malformed("not-keyed-life")
            val present = if (op is Change.Operation.Delete) false else (op as Change.Operation.Put).present ?: (before?.life?.isAlive == true)
            val previous = before?.life?.isAlive == true
            if (type.json.flag("wholePut") && present) {
                if (change.texts.isNotEmpty() || type.fields.any { (name, field) -> field.writer == "client" && field.isLattice && name !in values }) malformed("incomplete-whole-put")
                return Delta(key, Lattice(Life("alive", stamp), fields = fields(type, values, null)))
            }
            if (type.json.flag("wholePut") && (change.values.isNotEmpty() || change.texts.isNotEmpty())) malformed("whole-put-removal")
            life = if (present != previous) Life(if (present) "alive" else "dead", stamp) else before?.life
            if (life == null) return null
        } else malformed("operation")
        val f = fields(type, values, before)
        val x = texts(type, id, if (op is Change.Operation.Move) emptyMap() else change.texts, before)
        if (f.isEmpty() && x.isEmpty() && (life == null || life == before?.life)) return null
        return Delta(key, Lattice(life, born, f), x)
    }
}

// `capture`, for an act segment opted into Undo with no command of its own, is the scope kind's capture command: it carries the gesture's
// ordinary deltas when there are any (§7.3 Undo of an act).
internal fun Engine.commitGesture(replica: ReplicaState, scope: ScopeRef, gesture: Gesture, now: Long,
    actOffset: Int? = null, actFirstOrder: Long? = null, capture: String? = null): CommitOutcome {
    fun malformed(label: String): Nothing = throw CommitFailure.malformed(label)
    val product = registry.product(scope) ?: malformed("scope")
    if (actOffset == null && gesture.gestureId?.let { device.carriesGesture(it) } == true) malformed("gesture-id-taken")
    if (gesture.hold && gesture.holdMs < 0) malformed("hold-length")
    for (write in gesture.local) if (registry.products[product]?.get("device")?.obj()?.values?.none { Pattern(it.member("keyPattern").str()).matches(write.key) } != false) malformed("device-key")
    if (scopeIsDead(replica, scope)) return CommitOutcome.Refused(RefusalCode.scopeDead, null)
    val clock = Hlc(replica.meta.member("hlc"))
    clock.observe(Stamp(replica.meta.member("hlcHigh").str()))
    val stamp = clock.tick(now, actor)
    val gestures = replica.entries().groupBy { it.gestureId }
    val named = gesture.retire.map { it.key }.toSet()
    // A capture command is the ordinary deltas' own: it does not stop a retire from matching their removal.
    val commandFree = { entry: Entry -> entry.intent.command?.let { registry.command(it.name)?.engine == "capture" } ?: true }
    val retiring = gestures.values.filter { entries -> entries.all { entry -> (actOffset == null || entry.gestureId != gesture.gestureId) && entry.state == "held" && entry.scope == scope && commandFree(entry) &&
        entry.intent.deltas.isNotEmpty() && entry.intent.deltas.all { it.removes && it.key in named } } }.flatten()
    if (gesture.supersede.isNotEmpty() && (replica.state != "anon" || gesture.supersede.distinct().size != gesture.supersede.size)) malformed("supersede-anon")
    if (actOffset != null && gesture.gestureId in gesture.supersede) malformed("act-supersedes-itself")
    val superseding = gesture.supersede.flatMap { id ->
        val entries = gestures[id] ?: malformed("supersede-missing")
        if (entries.any { it.scope != scope || it.state !in setOf("held", "ready") || it.intent.n != null }) malformed("supersede-numbered")
        entries
    }.sortedBy { it.order }
    val ending = (retiring + superseding).distinct()
    val folded = silentFold(replica, ending, replaced = superseding.isNotEmpty())
    val gone = (ending.flatMap { it.deltas } + folded.flatMap { (entry, part) -> part.removed + if (part.commandGone) entry.predicted.flatMap { it.deltas } else emptyList() }).toSet()
    val builder = DeltaBuilder(this, replica, scope, stamp, now, gone)
    val built = gesture.changes.mapNotNull { change -> builder.build(change)?.let { change to it } }
    val deltas = mutableListOf<Delta>()
    val source = mutableMapOf<RecordKey, Change>()
    for ((change, delta) in built) {
        val at = deltas.indexOfFirst { it.key == delta.key }
        if (at < 0) { deltas.add(delta); source[delta.key] = change; continue }
        val earlier = source[delta.key] ?: malformed("duplicate-change")
        val move = listOf(earlier, change).firstOrNull { it.operation is Change.Operation.Move }
        val update = listOf(earlier, change).firstOrNull { it.operation is Change.Operation.Update }
        if (move == null || update == null || move.anchor?.field in update.values) malformed("duplicate-change")
        source.remove(delta.key)
        val first = deltas[at]
        deltas[at] = Delta(delta.key, Lattice(first.lattice.life, first.lattice.born, first.lattice.fields + delta.lattice.fields), first.texts + delta.texts)
    }
    val given = gesture.command ?: capture?.takeIf { deltas.isNotEmpty() }?.let { Command(it, Json.objectOf()) }
    val definition = given?.let { registry.command(it.name) }
    val scopedPredict = gesture.scopedPredict
    if (scopedPredict != null && definition?.scopedEffects != true) malformed("scoped-prediction-command")
    val predict = if (definition?.scopedEffects == true) emptyList() else gesture.predict.mapNotNull { builder.build(it, prediction = true) }
    val predictions = if (definition?.scopedEffects != true) null else {
        if (gesture.predict.isNotEmpty() && scopedPredict.orEmpty().isNotEmpty()) malformed("ambiguous-predictions")
        val groups = linkedMapOf(scope to gesture.predict.toMutableList())
        for (group in scopedPredict.orEmpty()) {
            val kind = registry.scopeKind(group.scope) ?: malformed("prediction-scope")
            if (kind in setOf("tree", "overlay") && registry.governingType?.let { registry.isId(Json.of(group.scope.tree!!), it) } != true) malformed("prediction-scope")
            if (scopeIsDead(replica, group.scope)) return CommitOutcome.Refused(RefusalCode.scopeDead, null)
            groups.getOrPut(group.scope) { mutableListOf() }.addAll(group.changes)
        }
        val projections = EffectReceipt.ordered(scope, groups.keys).map { target ->
            val changes = groups.getValue(target)
            if (changes.any { it.type !in definition.predicts }) malformed("prediction-type")
            val targetBuilder = if (target == scope) builder else DeltaBuilder(this, replica, target, stamp, now, gone)
            val deltas = changes.mapNotNull { targetBuilder.build(it, prediction = true) }
            if (deltas.map { it.key }.distinct().size != deltas.size) malformed("duplicate-prediction")
            Projection(target, deltas)
        }
        val written = Json.Arr(projections.map(Projection::json))
        if (written.holdsNul) malformed("nul")
        if (written.jcs.encodeToByteArray().size > effectMaxBytes) return CommitOutcome.Refused(RefusalCode.tooLarge, null)
        projections
    }
    val guards = gesture.guards.distinct().map { ref ->
        if (!registry.lives(ref.type, scope) || registry.type(ref.type)?.fields?.get(ref.field)?.isLattice != true) malformed("guard-field")
        Guard(ref.key, ref.field, latticeView(replica, scope, ref.key, ViewMode.stored, gone)?.fields?.get(ref.field)?.stamp)
    }
    val command = given?.let { cmd ->
        if (cmd.args !is Json.Obj) cmd else cmd.copy(args = Json.Obj(cmd.args.obj().map { (name, value) -> name to (registry.command(cmd.name)?.args?.get(name)?.domain?.rounded(value) ?: value) }))
    }
    // E-8: every typed leaf this commit writes holds an id of its type, in every delta, prediction and argument.
    val references = registry.references
    val leaves = (deltas + predict + predictions.orEmpty().flatMap { it.deltas }).all { delta -> delta.lattice.fields.all { (name, register) ->
        registry.type(delta.key.type)?.fields?.get(name)?.let { references.checkValue(it, register.value) } != false } }
    if (!leaves || definition != null && command != null && !references.checkArguments(definition, command.args)) malformed("typed-reference")
    val written = Intent(scope, deltas = deltas, guards = guards, command = command, gestureId = gesture.gestureId).json
    if (written.holdsNul) malformed("nul")
    // Opening the store parses every entry and notice under MAX_DEPTH. The deepest of them, a notice's dependent, holds a delta three levels deeper than its intent does.
    val deepest = maxOf(written.depth, Json.Arr(predict.map { it.json }).depth, Json.Arr(predictions.orEmpty().map(Projection::json)).depth)
    if (deepest + 3 > Json.MAX_DEPTH || gesture.local.any { (it.value?.depth ?: 0) > Json.MAX_DEPTH }) malformed("too-deep")
    for (type in deltas.mapNotNull { registry.type(it.key.type) }.distinct()) {
        val cap = type.cap ?: continue
        val keys = keys(replica, scope, type.name) + deltas.filter { it.key.type == type.name }.map { it.key }
        var before = 0; var after = 0
        val outbox = outboxDeltas(replica, scope)
        for (key in keys) {
            val shown = view(replica, scope, key, ViewMode.stored, gone, outbox[key].orEmpty())
            if (shown?.isVisible == true) before++
            var lattice = latticeView(replica, scope, key, ViewMode.stored, gone, outbox[key].orEmpty()) ?: Lattice()
            val texts = shown?.texts?.mapValues { TextValueState(it.value.text, it.value.merged, it.value.pending) }?.toMutableMap() ?: mutableMapOf()
            for (delta in deltas.filter { it.key == key }) {
                lattice = Join.record(type, lattice, delta.lattice)
                for ((name, text) in delta.texts) texts[name] = TextValueState(text.text, false, true)
            }
            if (isVisible(type, lattice, texts)) after++
        }
        if (after > cap && after > before) return CommitOutcome.Refused(RefusalCode.cap, Json.objectOf("type" to Json.of(type.name), "cap" to Json.of(cap)))
    }
    val gestureId = gesture.gestureId ?: opaqueID()
    val intents = if (gesture.atomic || gesture.hold || command != null) {
        if (deltas.isEmpty() && command == null) emptyList() else listOf(Intent(scope, deltas = deltas, guards = guards, command = command, gestureId = gestureId))
    } else deltas.mapIndexed { index, delta ->
        Intent(scope, deltas = listOf(delta), guards = guards.filter { it.key == delta.key || index == 0 && it.key !in deltas.map { d -> d.key } }, gestureId = gestureId)
    }
    if (intents.any { widestBytes(replica, it) > pushMaxBytes }) {
        val noticeId = "notice:$gestureId/0"
        replica.notices.add(Json.objectOf("id" to Json.of(noticeId), "scope" to scope.json, "code" to Json.of("too-large"),
            "content" to Json.Obj(buildList { if (deltas.isNotEmpty()) add("d" to Json.Arr(deltas.map { it.json })); command?.let { add("cmd" to it.json) } }), "at" to Json.of(now - replica.meta.member("serverOffsetMs").long())))
        return CommitOutcome.Refused(RefusalCode.tooLarge, null, noticeId)
    }
    retiring.forEach { replica.move(it, "retire", ended) }
    superseding.filter { it in replica.outbox }.forEach { replica.move(it, "silent-fold", ended) }
    applySilentFold(replica, folded)
    replica.settleEnded("undone")
    replica.meta = replica.meta.with("hlc" to clock.json, "hlcHigh" to stamp.json)
    val firstOrder = actFirstOrder?.plus(actOffset ?: 0) ?: replica.nextCommitOrder()
    val localIds = intents.mapIndexed { index, intent ->
        val localId = "$gestureId/${(actOffset ?: 0) + index}"
        val texts = intent.deltas.flatMap { d -> d.texts.keys.map { name -> Json.array(Json.of(d.key.type), d.key.id.json, Json.of(name)).jcs } }
        replica.outbox.add(Entry(Json.Obj(buildList {
            add("localId" to Json.of(localId)); add("gestureId" to Json.of(gestureId)); add("lineage" to Json.of(replica.account ?: "anon")); add("scope" to scope.json)
            add("state" to Json.of(if (gesture.hold) "held" else "ready")); add("commitOrder" to Json.of(firstOrder + index)); add("releaseAt" to Json.of(if (gesture.hold) now - replica.meta.member("serverOffsetMs").long() + gesture.holdMs else 0))
            add("stamp" to stamp.json); add("intent" to intent.json)
            if (predictions != null) add("predictions" to Json.Arr(predictions.map(Projection::json)))
            else if (command != null && predict.isNotEmpty()) add("predict" to Json.Arr(predict.map { it.json }))
            if (texts.isNotEmpty()) add("baseTexts" to Json.Obj(texts.map { it to builder.baseTexts.getValue(it) }))
        })))
        localId
    }
    if (gesture.local.isNotEmpty()) {
        val values = replica.device[product]?.obj()?.toMutableMap() ?: mutableMapOf()
        for (write in gesture.local) {
            val value = write.value
            if (value == null) values.remove(write.key) else values[write.key] = value
        }
        if (values.isEmpty()) replica.device.remove(product) else replica.device[product] = Json.Obj(values.toList())
    }
    return CommitOutcome.Committed(CommitReceipt(gestureId, stamp, localIds, builder.ids,
        if (gesture.hold && intents.isNotEmpty()) now - replica.meta.member("serverOffsetMs").long() + gesture.holdMs else null,
        retiring.map { it.gestureId }.distinct(), superseding.map { it.gestureId }.distinct()))
}

// §7.1 step 2: a tree or overlay scope its governing record's death ended, as the replica stores it.
internal fun Engine.scopeIsDead(replica: ReplicaState, scope: ScopeRef): Boolean {
    val (key, governingScope) = registry.governingRecord(scope) ?: return false
    return replica.known.containsKey(scope.text) || replica.known.containsKey("tree/${scope.tree}") ||
        latticeView(replica, governingScope, key, ViewMode.stored)?.life?.isAlive == false
}

internal fun widestBytes(replica: ReplicaState, intent: Intent): Int = Json.objectOf(
    "replica" to Json.of(replica.id), "account" to Json.of(replica.account ?: AccountID.widest), "ackThrough" to Json.of(Json.MAX_SAFE_INTEGER),
    "intents" to Json.array(intent.copy(n = Json.MAX_SAFE_INTEGER).json)).jcs.encodeToByteArray().size
