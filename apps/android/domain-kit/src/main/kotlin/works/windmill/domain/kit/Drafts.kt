package works.windmill.domain.kit

import works.windmill.sync.api.CommitReceipt
import works.windmill.sync.api.RecordID
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.CommandDef
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.recreatable
import works.windmill.sync.core.revivable
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.TypeDef
import works.windmill.sync.core.compareBytes

class Draft<E : Writable<E>> private constructor(val id: Id<E>, val base: E, val current: E,
    val isNew: Boolean, val placement: Placement?, val scope: ScopeRef, owner: Thread? = null) {
    private val owner = owner ?: Thread.currentThread()
    val touched: List<String> get() = (base.fields().keys + current.fields().keys)
        .filter { base.fields()[it] != current.fields()[it] }.sortedWith(::compareBytes)
    val isDirty: Boolean get() = touched.isNotEmpty()

    fun edit(change: (E) -> E): Draft<E> {
        val edited = change(current)
        check(edited.id == id) { "a draft edits its own record" }
        return Draft(id, base, edited, isNew, placement, scope, owner)
    }

    fun rebased(onto: E): Draft<E> {
        val type = id.entity as? DraftableType<E> ?: error("a draft requires a draftable type")
        check(type.savesGuarded) { "an unguarded draft cannot be rebased" }
        check(onto.id == id) { "a draft rebases onto its own record" }
        val kept = touched.associateWith { current.fields()[it] ?: Json.Null }
        return Draft(id, onto, type.decoding(id, onto.fields() + kept), isNew, placement, scope, owner)
    }

    internal fun checkOwner() {
        check(owner === Thread.currentThread()) { "a draft saves on its opening thread" }
    }

    internal fun take(saved: Saved, type: DraftableType<E>): Draft<E> = Draft(id,
        type.decoding(id, base.fields() + saved.values), type.decoding(id, current.fields() + saved.values),
        if (saved.exists) false else isNew, placement, scope, owner)

    companion object {
        fun <E : Writable<E>> new(blank: E, placed: Placement? = null, scope: ScopeRef = blank.id.entity.boundScope()): Draft<E> {
            check(blank.id.entity is DraftableType<*>) { "a draft requires a draftable type" }
            check(placed == null || blank.id.entity is OrderedType<*>) { "only an ordered draft has placement" }
            return Draft(blank.id, blank, blank, true, placed, blank.id.entity.boundScope(scope))
        }

        fun <E : Writable<E>> opening(value: E, scope: ScopeRef = value.id.entity.boundScope()): Draft<E> {
            check(value.id.entity is DraftableType<*>) { "a draft requires a draftable type" }
            return Draft(value.id, value, value, false, null, value.id.entity.boundScope(scope))
        }
    }
}

sealed interface SaveResult<out R> {
    data class Saved(val receipt: CommitReceipt?) : SaveResult<Nothing>
    data class Refused<R>(val refusal: R) : SaveResult<R>
    data class Failed(val error: Exception) : SaveResult<Nothing>
}

@ConsistentCopyVisibility
data class Saved internal constructor(val values: Map<String, Json>, val exists: Boolean)

fun <E : Writable<E>> ActionRunner.open(type: DraftableType<E>, id: Id<E>, scope: ScopeRef = type.boundScope()): Draft<E>? =
    read(type.boundScope(scope)) { it.repository(type).find(id, ViewMode.drawn) }?.let { Draft.opening(it, scope) }

fun <E : Writable<E>> ActionRunner.open(type: DraftableType<E>, id: Id<E>, orNew: E, scope: ScopeRef = type.boundScope()): Draft<E> {
    check(orNew.id == id) { "the blank must name the opened record" }
    return read(type.boundScope(scope)) { read ->
        check(read.registry.type(type.type)?.identity in listOf("keyed", "singleton")) {
            "open with a blank requires keyed or singleton identity"
        }
        read.repository(type).find(id, ViewMode.drawn)?.let { Draft.opening(it, scope) } ?: Draft.new(orNew, scope = scope)
    }
}

fun <E : Writable<E>, R> ActionRunner.save(draft: Draft<E>, type: DraftableType<E>, refusals: Refusals<R>,
    writeBack: (Draft<E>) -> Unit): SaveResult<R> = save(draft, type, refusals, draft.scope, writeBack)

fun <E : Writable<E>, R> ActionRunner.save(draft: Draft<E>, type: DraftableType<E>, refusals: Refusals<R>,
    scope: ScopeRef, writeBack: (Draft<E>) -> Unit): SaveResult<R> {
    check(scope == draft.scope) { "a draft saves in its bound scope" }
    draft.checkOwner()
    check(draft.id.entity == type) { "a draft saves its own entity type" }
    val outcome = try { perform(SaveDraft.fromDraft(draft, type, refusals)) }
    catch (fault: PlanError) { throw IllegalStateException("a draft save made a malformed plan", fault) }
    catch (fault: DecodeError) { throw IllegalStateException("a draft record does not decode", fault) }
    catch (fault: IllegalStateException) { throw fault }
    catch (failure: Exception) {
        writeBack(draft)
        return SaveResult.Failed(failure)
    }
    return when (outcome) {
        is Outcome.Committed -> { writeBack(draft.take(outcome.result, type)); SaveResult.Saved(outcome.receipt) }
        is Outcome.Unchanged -> { writeBack(draft.take(outcome.result, type)); SaveResult.Saved(null) }
        is Outcome.Refused -> { writeBack(draft); SaveResult.Refused(outcome.refusal) }
    }
}

class SaveDraft<E : Writable<E>, R> private constructor(val type: DraftableType<E>, override val refusals: Refusals<R>,
    val id: Id<E>, private val base: E, private val current: E, private val isNew: Boolean,
    private val placement: Placement?, private val touched: List<String>, private val creating: Boolean, override val scope: ScopeRef)
    : Decider<SaveDraftLoaded<E>, Saved, R> {
    // §10.2: a save of a type that saves reversibly opts into Undo of an act, so the runner runs it as one.
    override val reversible: Boolean get() = type.savesReversibly

    constructor(creating: E, type: DraftableType<E>, refusals: Refusals<R>, placed: Placement? = null, scope: ScopeRef = type.boundScope()) : this(
        type, refusals, creating.id, creating, creating, true, placed,
        creating.fields().keys.sortedWith(::compareBytes), true, type.boundScope(scope)) {
        check(placed == null || type is OrderedType<*>) { "only an ordered create has placement" }
    }

    override fun load(read: Reader): SaveDraftLoaded<E> {
        check(read.scope == scope) { "a decider loads its bound scope" }
        val definition = read.registry.type(type.type) ?: error("the registry lacks the saved entity")
        val restore = read.registry.commands.map(::CommandDef).firstOrNull { it.engine == "restore" && it.scope == definition.scope && type.type in it.predicts }
        check(!reversible || restore != null) { "${type.type}: a reversible save needs its scope kind's restore command" }
        val repository = read.repository(type)
        val folded = repository.record(id.record, ViewMode.stored)?.let { type.decode(Fields(it)) }
        val order = (type as? OrderedType<*>)?.orderField
        val anchor = if (isNew && order != null) repository.anchor(placement ?: Placement.Bottom, order) else null
        return SaveDraftLoaded(repository.find(id, ViewMode.drawn), repository.find(id, ViewMode.stored),
            folded, anchor, read.moment, definition, restore?.name?.takeIf { reversible })
    }

    override fun decide(loaded: SaveDraftLoaded<E>, ids: IDSource): Decision<Saved, R> {
        if (creating && (loaded.drawn != null || loaded.stored != null)) return refused(RefusalCode.idTaken)
        if (loaded.definition.json["wholePut"]?.bool() == true) {
            check(!reversible) { "${type.type}: a whole-put save is not reversible" }
            val valid = Valid(current, type, at = loaded.moment)
            return Decision.Write(Plan().apply { create(valid) }, Saved(valid.value.fields(), true))
        }
        val minted = loaded.definition.identity == "minted"
        if (touched.isEmpty() && !(isNew && minted)) return Decision.Unchanged(Saved(emptyMap(), loaded.stored != null))
        val gone = when (loaded.definition.identity) {
            "minted" -> !isNew || loaded.stored != null
            "keyed" -> loaded.definition.life && !isNew && loaded.stored == null
            else -> false
        }
        if (loaded.drawn == null && gone) return refused(RefusalCode.unknownRecord)
        if (minted && loaded.stored == null) {
            val valid = Valid(current, type, at = loaded.moment)
            val plan = Plan().apply { if (type is OrderedType<*>) insert(valid, loaded.anchor) else create(valid) }
            optInto(plan, loaded, valid.value.fields().keys.toList())
            val stamped = valid.value.fields().mapValues { (name, value) ->
                if (value == Json.Null && loaded.definition.fields[name]?.kind == "time") Json.of(loaded.moment.now.ms) else value
            }
            return Decision.Write(plan, Saved(stamped, true))
        }
        if (!minted && loaded.drawn == null) {
            val valid = Valid(current, type, fields = if (isNew) null else touched, at = loaded.moment)
            val plan = Plan().apply { create(valid, fields = touched, from = base) }
            optInto(plan, loaded, touched)
            val written = touched.associateWith { valid.value.fields()[it] ?: Json.Null }
            return Decision.Write(plan, Saved((loaded.folded ?: base).fields() + written, true))
        }
        val valid = Valid(current, type, fields = touched, at = loaded.moment)
        val stored = loaded.stored?.fields() ?: emptyMap()
        val settled = touched.associateWith { valid.value.fields()[it] ?: Json.Null }
        val changed = touched.filter { stored[it] != valid.value.fields()[it] }
        if (changed.isEmpty()) return Decision.Unchanged(Saved(settled, loaded.stored != null))
        if (type.savesGuarded && changed.any { loaded.definition.fields[it]?.isLattice == true && stored[it] != base.fields()[it] }) {
            return refused(RefusalCode.stale)
        }
        return Decision.Write(Plan().apply { update(valid, fields = changed, from = base, guarded = type.savesGuarded); optInto(this, loaded, changed) }, Saved(settled, true))
    }

    // A reversible save's Undo recipe, named on its plan. A record the save creates where no record was, and a delete can take it back, goes
    // again while its own writes are all that changed it. Otherwise each written field or text takes back its earlier value, an unset one
    // the draft base's, and a record the save brings back to life (present again) takes back its life, dead when unset.
    private fun optInto(plan: Plan, loaded: SaveDraftLoaded<E>, written: List<String>) {
        val restoreCommand = loaded.restoreCommand ?: return
        val definition = loaded.definition
        if (loaded.drawn == null && loaded.folded == null && definition.recreatable) return plan.undoBy(UndoRecipe.createdRecord(restoreCommand, id))
        val revives = loaded.drawn == null && definition.life && (definition.identity == "keyed" || definition.revivable)
        val defaults = base.fields()
        plan.undoBy(UndoRecipe.Fields(restoreCommand, listOfNotNull(UndoField(UndoTarget.life(id), Json.of("dead")).takeIf { revives }) + written.map { name ->
            val field = definition.fields[name]
            check(field?.writer == "client" && field.kind in listOf("lww", "text")) { "${type.type}.$name: a reversible save writes client fields and texts" }
            UndoField(if (field!!.kind == "text") UndoTarget.text(id, name) else UndoTarget.field(id, name), defaults[name] ?: Json.Null)
        }))
    }

    private fun refused(code: RefusalCode): Decision<Saved, R> =
        Decision.Refuse(refusals.of(Refused(code, id.ref, path = Refused.Path.predicted)))

    companion object {
        fun <E : Writable<E>, R> fromDraft(draft: Draft<E>, type: DraftableType<E>, refusals: Refusals<R>): SaveDraft<E, R> {
            check(draft.current.id == draft.id) { "a draft saves its own record" }
            check(draft.id.entity == type) { "a draft saves its own entity type" }
            return SaveDraft(type, refusals, draft.id, draft.base, draft.current, draft.isNew,
                draft.placement, draft.touched, false, draft.scope)
        }
    }
}

// What a save loads: the record as `drawn` and `stored` show it, the stored record folded whether visible or not, a new ordered draft's
// anchor, and, for a type that saves reversibly, the restore command of its scope kind.
data class SaveDraftLoaded<E : Writable<E>>(val drawn: E?, val stored: E?, val folded: E?,
    val anchor: RecordID?, val moment: Moment, val definition: TypeDef, val restoreCommand: String? = null)

class Remove<E : Entity<E>, R>(val type: RemovableType<E>, val id: Id<E>, override val refusals: Refusals<R>, scope: ScopeRef = type.boundScope()) : Action<E?, Unit, R> {
    override val scope = type.boundScope(scope)
    override fun load(read: Reader): E? {
        check(read.scope == scope) { "a decider loads its bound scope" }
        return read.repository(type).find(id, ViewMode.drawn)
    }
    override fun decide(loaded: E?, ids: IDSource): Decision<Unit, R> =
        if (loaded == null) Decision.Unchanged(Unit) else Decision.Write(Plan().apply { remove(id) }, Unit)
}

data class MoveLoaded<E : Entity<E>>(val moving: E?, val above: Id<E>?)

class Move<E : Entity<E>, R>(val type: OrderedType<E>, val id: Id<E>, val below: Id<E>?,
    override val refusals: Refusals<R>, scope: ScopeRef = type.boundScope()) : Action<MoveLoaded<E>, Unit, R> {
    override val scope = type.boundScope(scope)
    override fun load(read: Reader): MoveLoaded<E> {
        check(read.scope == scope) { "a decider loads its bound scope" }
        val members = read.repository(type).all(ViewMode.drawn)
        val index = members.indexOfFirst { it.id == id }
        return if (index < 0) MoveLoaded(null, null) else MoveLoaded(members[index], members.getOrNull(index - 1)?.id)
    }
    override fun decide(loaded: MoveLoaded<E>, ids: IDSource): Decision<Unit, R> {
        if (loaded.moving == null) return Decision.Refuse(refusals.of(Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted)))
        if (below == id || below == loaded.above) return Decision.Unchanged(Unit)
        return Decision.Write(Plan().apply { move(id, below) }, Unit)
    }
}
