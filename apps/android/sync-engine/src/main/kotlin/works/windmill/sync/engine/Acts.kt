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
            prepared = try { prepare(context).also { context.finish() } }
                catch (failure: Throwable) { if (failure is StoreFailure) throw failure; throw ActBodyError(failure) } finally { context.end() }
            val (request, value) = prepared!!
            if (request == null || request.scopes.isEmpty()) return@write null to value
            if (request.holdMs < 0) throw CommitFailure.malformed("hold-length")
            if (request.gestureId?.let { device.carriesGesture(it) } == true) throw CommitFailure.malformed("gesture-id-taken")
            var gestureId = request.gestureId ?: opaqueID()
            while (request.gestureId == null && device.carriesGesture(gestureId)) gestureId = opaqueID()
            val firstOrder = (replica.outbox.maxOfOrNull { it.order } ?: 0) + 1
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
                val before = replica.meta
                val outcome = try { commitGesture(replica, scope, gesture, at, localCount, firstOrder) }
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
            val receipt = ActReceipt(gestureId, receipts, retired.toList(), superseded.toList(),
                if (request.hold && localCount > 0) at - replica.meta.member("serverOffsetMs").long() + request.holdMs else null)
            (if (wrote) ActCommitOutcome.Committed(receipt) else null) to value
        }
    } catch (refusal: ActRefusal) {
        report(EngineOperation.commit, EngineOutcome.refused, refusal.refusal.code.text)
        return refusal.refusal to prepared!!.second
    } catch (body: ActBodyError) { throw body.error }
}

internal class ActReadContext(private val engine: Engine, private val state: ReplicaState, override val now: Long) : ActContext {
    private var open = true
    private var loading = true
    private val minted = mutableMapOf<ScopeRef, Engine.Reader>()
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
        val reader = try { engine.Reader(state, scope, now) }
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
            return minted.getOrPut(scope) { engine.Reader(state, scope, now) }.mintID(type)
        } catch (error: Throwable) { failure = failure ?: error; throw error }
    }
    override fun opaqueID(): String {
        finishLoad()
        return engine.opaqueID()
    }
    fun finish() { finishLoad(); minted.values.forEach { it.finish() } }
    fun end() { open = false; minted.values.forEach { it.end() } }
}
