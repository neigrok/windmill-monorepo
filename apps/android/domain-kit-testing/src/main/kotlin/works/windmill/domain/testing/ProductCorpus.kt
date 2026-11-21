package works.windmill.domain.testing

import works.windmill.domain.kit.*
import works.windmill.sync.api.ActContext
import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.ScopeReader
import works.windmill.sync.core.*
import works.windmill.sync.testing.Vector

fun <R> saved(result: SaveResult<R>): Boolean = result is SaveResult.Saved
fun <R> refused(result: SaveResult<R>): R? = (result as? SaveResult.Refused<R>)?.refusal
fun <R> failed(result: SaveResult<R>): Exception? = (result as? SaveResult.Failed)?.error
fun <T, R> committed(outcome: Outcome<T, R>): T? = (outcome as? Outcome.Committed<T>)?.result
fun <T, R> unchanged(outcome: Outcome<T, R>): T? = (outcome as? Outcome.Unchanged<T>)?.result

fun moment(input: Json): Moment = Moment(Instant(input["now"]?.long() ?: Probe.start), FixedZone(input["offsetSeconds"]?.long()?.toInt() ?: 0))
fun <E : Entity<E>> EntityType<E>.fromForm(form: Json): E = decode(Fields(type, RecordID(form.member("id")), form.member("fields").obj()))
val Saved.form: Json get() = Json.objectOf("values" to Json.Obj(values.toList()), "exists" to Json.of(exists))
val Placement.form: Json get() = when (this) { Placement.Top -> Json.of("top"); Placement.Bottom -> Json.of("bottom"); is Placement.Below -> Json.objectOf("below" to id.json) }
val <E : Writable<E>> Draft<E>.form: Json get() = Json.objectOf("id" to id.json, "base" to Json.Obj(base.fields().toList()), "current" to Json.Obj(current.fields().toList()), "isNew" to Json.of(isNew), "placement" to (placement?.form ?: Json.Null))
fun <T, R> Decision<T, R>.form(scope: ScopeRef, registry: Registry, result: (T) -> Json, refusal: (R) -> Json): Json = when (this) {
    is Decision.Write -> Json.objectOf("write" to Json.objectOf("gesture" to plan.gesture(scope, registry).form, "result" to result(this.result))
        .with("undo" to plan.undoSegment(0, scope)?.let { segment -> Json.Arr(segment.recipes.map { it.json }) }))
    is Decision.Unchanged -> Json.objectOf("unchanged" to Json.objectOf("result" to result(this.result)))
    is Decision.Refuse -> Json.objectOf("refuse" to refusal(this.refusal))
}
fun <T, R> Outcome<T, R>.form(result: (T) -> Json, refusal: (R) -> Json): Json = when (this) {
    is Outcome.Committed -> Json.objectOf("committed" to Json.objectOf("result" to result(this.result), "receipt" to receipt.form))
    is Outcome.Unchanged -> Json.objectOf("unchanged" to Json.objectOf("result" to result(this.result)))
    is Outcome.Refused -> Json.objectOf("refused" to refusal(this.refusal))
}

// Executes product vectors against the declarations and rule book they pin.
class ProductCorpus(val book: RuleBook) {
    fun value(vector: Vector): Json {
        val input = vector.input
        input["spec"]?.let { spec ->
            require(book.rules.any { it.spec == spec }) { "$vector runs a spec the book does not hold" }
            return KitCorpus.valueVector(input)
        }
        val type = book.entity(input.member("entity").str()) as? WritableType<*> ?: throw ContractError("no writable entity for $vector")
        @Suppress("UNCHECKED_CAST")
        return validated(type as WritableType<UntypedEntity>, input)
    }
    private fun <E : Writable<E>> validated(type: WritableType<E>, input: Json): Json = try {
        Json.objectOf("fields" to Json.Obj(Valid(type.fromForm(input), type, at = moment(input)).value.fields().toList()))
    } catch (violation: Violation) { Json.objectOf("violation" to violation.json) }
    fun <L, T, R> decision(decider: Decider<L, T, R>, vector: Vector, result: (T) -> Json, refusal: (R) -> Json): Json {
        val source = scene(vector, decider.scope)
        val read = Reader(source, decider.scope, moment(vector.input), book.registry)
        return Json.objectOf("decision" to decider.decision(decider.load(read), IDSource(source)).form(decider.scope, book.registry, result, refusal))
    }
    fun <E : Writable<E>, R> save(type: DraftableType<E>, refusals: Refusals<R>, vector: Vector, blank: E,
        edit: (E) -> E, result: (Saved) -> Json, refusal: (R) -> Json): Json =
        save(type, refusals, vector, blank, type.boundScope(), edit, result, refusal)

    fun <E : Writable<E>, R> save(type: DraftableType<E>, refusals: Refusals<R>, vector: Vector, blank: E, scope: ScopeRef,
        edit: (E) -> E, result: (Saved) -> Json, refusal: (R) -> Json): Json {
        val source = scene(vector, type.boundScope(scope))
        val read = Reader(source, scope, moment(vector.input), book.registry)
        val existing = read.repository(type).find(blank.id, works.windmill.sync.api.ViewMode.drawn)
        val draft = (existing?.let { Draft.opening(it, scope) } ?: Draft.new(blank, scope = scope)).edit(edit)
        return decision(SaveDraft.fromDraft(draft, type, refusals), vector, result, refusal)
    }
    fun read(vector: Vector, scope: ScopeRef, body: (Reader) -> Json): Json = Json.objectOf("result" to body(Reader(scene(vector, scope), scope, moment(vector.input), book.registry)))
    // An act's case (§9.5): its load through an act reader over each scope's records, one decision, and each segment translated
    // in its scope: `{write: {segments: [{scope, gesture}], result}}`, `{unchanged: {result}}` or `{refuse}`.
    fun <L, T, R> act(action: ActAction<L, T, R>, vector: Vector, result: (T) -> Json, refusal: (R) -> Json): Json {
        val moment = moment(vector.input)
        val ids = (vector.input["ids"]?.arr()?.map(::RecordID) ?: emptyList()).toMutableList()
        val context = object : ActContext {
            override val now = moment.now.ms
            override val replica = "rp_00000000000000000000000000000001"
            override val actor = replica
            override val isAnonymous = false
            override fun finishLoad() {}
            override fun <X> inScope(scope: ScopeRef, body: (ScopeReader) -> X): X =
                body(VectorReader(records(vector, scope), now, pulled = vector.input["firstPullComplete"]?.bool() ?: true, scope = scope, registry = book.registry))
            override fun mintID(type: String, scope: ScopeRef): RecordID = if (ids.isEmpty()) throw ContractError("no vector id left for $type") else ids.removeAt(0)
            override fun opaqueID(): String = throw ContractError("an act case mints no opaque id")
            override fun stage(scope: ScopeRef, segment: (CommitContext) -> Gesture): CommitOutcome.Refused? = throw ContractError("an act case decides one act, and stages nothing")
            override fun beginPart() = throw ContractError("an act case decides one act, and has no second part")
        }
        return Json.objectOf("decision" to when (val decided = action.decision(context, book.registry, moment)) {
            is ActDecision.Write -> Json.objectOf("write" to Json.objectOf("segments" to Json.Arr(decided.plan.segments.map {
                Json.objectOf("scope" to it.scope.json, "gesture" to it.plan.gesture(it.scope, book.registry).form) }), "result" to result(decided.result)))
            is ActDecision.Unchanged -> Json.objectOf("unchanged" to Json.objectOf("result" to result(decided.result)))
            is ActDecision.Refuse -> Json.objectOf("refuse" to refusal(decided.refusal))
        })
    }
    private fun scene(vector: Vector, scope: ScopeRef): VectorReader = VectorReader(records(vector, scope), moment(vector.input).now.ms,
        vector.input["ids"]?.arr()?.map(::RecordID) ?: emptyList(), vector.input["firstPullComplete"]?.bool() ?: true, scope, book.registry)
    // A case's records in one scope: its `records`, or, in a scene of several scopes, `scopes[scope]`, with the scene's device rows.
    private fun records(vector: Vector, scope: ScopeRef): VectorRecords {
        val input = vector.input
        val rows = input["scopes"]?.let { it[scope.text] ?: Json.objectOf("drawn" to Json.array()) } ?: input.member("records")
        return VectorRecords(rows["drawn"], rows["stored"] ?: rows["drawn"], book.registry, rows["device"] ?: input["device"])
    }
}

// Erasure is confined to opening a declaration from the heterogeneous book; the type's decoder supplies the value.
private interface UntypedEntity : Writable<UntypedEntity>
