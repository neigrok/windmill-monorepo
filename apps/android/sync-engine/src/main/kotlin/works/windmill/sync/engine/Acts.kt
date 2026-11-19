package works.windmill.sync.engine

import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID

internal class ActRefusal(val refusal: ActCommitOutcome.Refused) : RuntimeException()
internal class ActBodyError(val error: Throwable) : RuntimeException()

internal fun <T> Engine.commitActTransaction(prepare: (ActContext) -> Pair<ActRequest?, T>,
    segment: (T, Int, CommitContext) -> Gesture): Pair<ActCommitOutcome?, T> {
    var prepared: Pair<ActRequest?, T>? = null
    try {
        return write { replica ->
            if (replica.state !in setOf("anon", "bound")) throw CommitFailure(CommitFailure.Kind.notWritable, replica.state)
            val at = now(replica)
            val context = ActReadContext(this, replica, at)
            prepared = try { prepare(context).also { context.finishLoad() } }
                catch (failure: Throwable) { if (failure is StoreFailure) throw failure; throw ActBodyError(failure) } finally { context.end() }
            val (request, value) = prepared!!
            if (request == null || request.scopes.isEmpty()) return@write null to value
            if (request.holdMs < 0) throw CommitFailure.malformed("hold-length")
            if (request.gestureId?.let { device.carriesGesture(it) } == true) throw CommitFailure.malformed("gesture-id-taken")
            val undo = planUndo(replica, request)
            val gestureId = request.gestureId ?: freshGestureId()
            val firstOrder = replica.nextCommitOrder()
            val receipts = mutableListOf<ActSegmentReceipt>()
            val retired = mutableSetOf<String>()
            val superseded = mutableSetOf<String>()
            var localCount = 0
            var wrote = false
            for ((index, scope) in request.scopes.withIndex()) {
                if (scope in context.newMints) {
                    val (key, governingScope) = registry.governingRecord(scope)!!
                    if (latticeView(replica, governingScope, key, ViewMode.drawn)?.life?.isAlive != true)
                        throw CommitFailure.malformed("act-new-scope-governing-create")
                }
                val reader = Reader(replica, scope, at)
                val given = try { segment(value, index, reader).also { reader.finish() } }
                    catch (failure: Throwable) { if (failure is StoreFailure) throw failure; throw ActBodyError(failure) } finally { reader.end() }
                if (given.gestureId != null && given.gestureId != gestureId || given.hold && !request.hold)
                    throw CommitFailure.malformed("act-segment-identity-or-hold")
                val gesture = given.copy(gestureId = gestureId, hold = request.hold, holdMs = request.holdMs)
                // An opted segment runs as one scoped intent: under its own scopedEffects command, or else its scope kind's one capture command.
                val opted = index in undo.orEmpty()
                if (opted && gesture.command?.let { registry.command(it.name)?.scopedEffects != true } == true) throw CommitFailure.malformed("undo-command-scoped-effects")
                val capture = if (opted && gesture.command == null) registry.commands.map(::CommandDef)
                    .singleOrNull { it.engine == "capture" && it.scope == registry.scopeKind(scope) }?.name ?: throw CommitFailure.malformed("undo-capture-command") else null
                val before = replica.meta
                val outcome = try { commitGesture(replica, scope, gesture, at, localCount, firstOrder, capture) }
                    catch (_: IllegalArgumentException) { throw CommitFailure.malformed("invalid-value") }
                when (outcome) {
                    is CommitOutcome.Refused -> throw ActRefusal(ActCommitOutcome.Refused(index, outcome.code, outcome.detail))
                    is CommitOutcome.Committed -> {
                        val receipt = outcome.receipt
                        val changed = receipt.localIds.isNotEmpty() || receipt.retired.isNotEmpty() || receipt.superseded.isNotEmpty() || gesture.local.isNotEmpty()
                        receipts.add(ActSegmentReceipt(scope, if (changed) receipt.stamp else null, receipt.localIds, receipt.ids))
                        if (changed) wrote = true else replica.meta = before
                        localCount += receipt.localIds.size
                        retired.addAll(receipt.retired); superseded.addAll(receipt.superseded)
                    }
                }
            }
            if (wrote && undo != null) recordAct(replica, gestureId, undo, receipts)
            val receipt = ActReceipt(gestureId, receipts, retired.toList(), superseded.toList(),
                if (request.hold && localCount > 0) at - replica.meta.member("serverOffsetMs").long() + request.holdMs else null)
            (if (wrote) ActCommitOutcome.Committed(receipt) else null) to value
        }
    } catch (refusal: ActRefusal) {
        report(EngineOperation.commit, EngineOutcome.refused, refusal.refusal.code.text)
        return refusal.refusal to prepared!!.second
    } catch (body: ActBodyError) { throw body.error }
}

// One act segment opted into Undo: its recipes and the first local preimages its field targets read before the act.
private class UndoPlan(val scope: ScopeRef, val recipes: List<UndoRecipe>, val preimages: List<Preimage>)

// ActRequest.undo, checked against its scopes, with each segment's first local preimages read from the act's initial snapshot (§7.3 Undo of
// an act), each with the seq of the row it was read over, the confirmed row or else the dead row the record's spent id keeps (null where
// neither holds one), and the epoch that seq counts in; a life's also keeps the record as read, which a revival draws. A slot unset there takes the target's explicit default; with none, the act fails before anything changes.
// A segment named with no recipes is journaled for its receipts alone, as evidence, and an act names at least one recipe. By segment index.
private fun Engine.planUndo(replica: ReplicaState, request: ActRequest): Map<Int, UndoPlan>? {
    val segments = request.undo ?: return null
    val plan = linkedMapOf<Int, UndoPlan>()
    for (segment in segments) {
        if (segment.index !in request.scopes.indices || segment.index in plan) throw CommitFailure.malformed("undo-segment")
        val scope = request.scopes[segment.index]
        val view = drawn(replica, scope)
        for (recipe in segment.recipes) {
            try { recipe.check(registry, scope) } catch (_: IllegalArgumentException) { throw CommitFailure.malformed("undo-recipe") }
            if (recipe is UndoRecipe.CreatedRecord && recipe.record.key in view) throw CommitFailure.malformed("undo-created-record-exists")
        }
        val preimages = segment.recipes.filterIsInstance<UndoRecipe.Fields>().flatMap { it.targets }.map { (target, defaultValue) ->
            val read = view[target.key]
            Preimage(target, read?.drawnValue(target.slot) ?: defaultValue ?: throw CommitFailure.malformed("undo-default"),
                store.row(replica.id, target.scope, target.key)?.seq ?: replica.spentId(target.scope, target.key)?.get("seq")?.long(),
                replica.meta["serverEpoch"]?.orNull()?.str(),
                read?.takeIf { target.slot.kind == Slot.Kind.life }?.drawnRecord())
        }
        plan[segment.index] = UndoPlan(scope, segment.recipes, preimages)
    }
    if (segments.all { it.recipes.isEmpty() }) throw CommitFailure.malformed("undo-recipes")
    return plan
}

// The act's journal record, from the segments that left an entry: one source entry each, in commit order, with the value the act left in
// each target, which a Redo writes back. An act that left none records nothing.
private fun Engine.recordAct(replica: ReplicaState, actId: String, plan: Map<Int, UndoPlan>, receipts: List<ActSegmentReceipt>) {
    val sources = plan.toSortedMap().mapNotNull { (index, segment) ->
        val localIds = receipts[index].localIds
        if (localIds.size > 1) throw CommitFailure.malformed("undo-segment-intents")
        val view = drawn(replica, segment.scope)
        val written = segment.preimages.mapNotNull { (target) -> view[target.key]?.drawnValue(target.slot)?.let { Written(target, it) } }
        localIds.singleOrNull()?.let { SourceEntry(it, segment.scope, segment.recipes, segment.preimages, written) }
    }
    if (sources.isNotEmpty()) replica.journal.add(ReversibleAct(actId, true, sources))
}

// An act's prepare context (§7.1). A composed act stages its parts' segments on a tentative copy of the replica, which each later load reads
// through and each later identity avoids; the copy is thrown away with the queue endings its commits traced. A staged refusal reports as the
// act's refusal would.
internal class ActReadContext(private val engine: Engine, private val state: ReplicaState, override val now: Long) : ActContext {
    private var open = true
    private var loading = true
    private var staged: ReplicaState? = null
    private var stagedIntents = 0
    private val reserved = mutableMapOf<ScopeRef, MutableSet<RecordID>>()
    private val borrowed = mutableSetOf<ScopeRef>()
    private val loans = mutableListOf<Engine.Reader>()
    val newMints = mutableSetOf<ScopeRef>()
    private var failure: Throwable? = null
    override val replica get() = state.id
    override val actor get() = engine.actor
    override val isAnonymous get() = state.state == "anon"
    override fun finishLoad() {
        if (!open) throw CommitFailure.malformed("ended-reader")
        failure?.let { throw it }
        loans.forEach { it.finish() }
        loading = false
    }
    override fun <T> inScope(scope: ScopeRef, body: (ScopeReader) -> T): T {
        if (!open || !loading) {
            val error = CommitFailure.malformed("ended-reader")
            failure = failure ?: error
            throw error
        }
        val reader = try { engine.Reader(staged ?: state, scope, now) }
            catch (error: Throwable) { failure = failure ?: error; throw error }
        borrowed.add(scope)
        loans.add(reader)
        return try { body(reader).also { reader.finish() } }
        catch (error: Throwable) { failure = failure ?: reader.failure; throw error }
        finally { reader.end() }
    }
    override fun mintID(type: String, scope: ScopeRef): RecordID {
        finishLoad()
        try {
            if (scope !in borrowed) {
                val governing = engine.registry.governingRecord(scope)
                val exists = engine.store.holdsScope(state.id, scope) || scope.text in state.cursors || scope.text in state.staging ||
                    scope.text in state.spent || scope.text in state.known || state.outbox.any { it.scope == scope } ||
                    governing?.let { (key, product) -> engine.latticeView(state, product, key, ViewMode.drawn) != null } == true
                if (governing == null || exists) {
                    val error = CommitFailure.malformed("load-must-borrow-mint-scope")
                    failure = failure ?: error
                    throw error
                }
                newMints.add(scope)
            }
            return engine.Reader(staged ?: state, scope, now, reserved.getOrPut(scope) { mutableSetOf() }).mintID(type)
        } catch (error: Throwable) { failure = failure ?: error; throw error }
    }
    override fun opaqueID(): String {
        finishLoad()
        return engine.opaqueID()
    }
    override fun stage(scope: ScopeRef, segment: (CommitContext) -> Gesture): CommitOutcome.Refused? {
        finishLoad()
        val tentative = staged ?: state.copy().also { staged = it }
        val reader = engine.Reader(tentative, scope, now)
        val gesture = try { segment(reader).also { reader.finish() } } finally { reader.end() }
        val traced = engine.ended.size
        val outcome = try { engine.commitGesture(tentative, scope, gesture.copy(gestureId = STAGED), now, stagedIntents, state.nextCommitOrder()) }
            catch (_: IllegalArgumentException) { throw CommitFailure.malformed("invalid-value") }
            finally { engine.ended.subList(traced, engine.ended.size).clear() }
        return when (outcome) {
            is CommitOutcome.Refused -> outcome.copy(notice = null).also { engine.report(EngineOperation.commit, EngineOutcome.refused, it.code.text) }
            is CommitOutcome.Committed -> { stagedIntents += outcome.receipt.localIds.size; null }
        }
    }
    override fun beginPart() {
        finishLoad()
        loading = true
    }
    fun end() { open = false }
}

// The gesture id a staged segment's entries carry in the tentative copy.
private const val STAGED = "staged"
