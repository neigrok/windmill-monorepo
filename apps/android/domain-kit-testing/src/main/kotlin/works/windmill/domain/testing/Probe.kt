package works.windmill.domain.testing

import works.windmill.domain.kit.*
import works.windmill.sync.core.*

// Test-only entity declarations for the normative probe registry.
internal data class ProbeEntity(override val id: Id<ProbeEntity>, val values: Map<String, Json>) : Writable<ProbeEntity> {
    override fun fields() = values
}
internal open class ProbeType(override val type: String, override val scope: ScopeRef,
    val defaults: Map<String, Json>, val specs: List<ValueSpec>) : WritableType<ProbeEntity> {
    override fun decode(f: Fields): ProbeEntity = ProbeEntity(Id(f.id, this), defaults.mapValues { (name, fallback) ->
        if (type == "mark" && name == "memo") Json.of(f.text(name)) else f.json(name) ?: fallback
    })
    override val checks: List<Check<ProbeEntity>> get() = buildList {
        if (type == "day") add(Check.key { entity, moment ->
            if (entity.id.day?.let { it > moment.today } == true) throw Violation("day.notFuture", Path("id"), Violation.Reason.Custom("future"))
        })
        for (spec in specs) {
            val field = spec.path.substringAfterLast('.')
            add(Check(field) { entity, _ -> entity.copy(values = entity.values + (field to KitCorpus.apply(spec.json, entity.values.getValue(field), Path(field)))) })
        }
    }
    fun entity(id: RecordID, fields: Map<String, Json> = emptyMap()): ProbeEntity = decode(Fields(type, id, fields))
}
internal object Probe {
    val scope = ScopeRef.product("probe")
    val tree = ScopeRef.tree("b_00000001")
    val overlay = ScopeRef.overlay("b_00000001")
    val start = 1_800_000_000_000L
    val card: ProbeType = object : ProbeType("card", scope, mapOf("title" to Json.of(""), "body" to Json.of(""), "size" to Json.Null, "claim" to Json.Null, "tier" to Json.of("draft")),
        listOf(TextSpec("card.title", MeasureUnit.chars, 1, 12, true, true), TextSpec("card.body", MeasureUnit.bytes, 0, 24, true, true), NumberSpec("card.size", -500.0, 500.0, quantum = .01), TextSpec("card.claim", MeasureUnit.chars, 0, 12, true, true), ChoiceSpec("card.tier", listOf("draft", "review", "done", "dropped")))), DraftableType<ProbeEntity>, RemovableType<ProbeEntity>, OrderedType<ProbeEntity> {
        override val savesGuarded = true; override val heldRemoval = true; override val orderField = "ord"
    }
    val day: ProbeType = object : ProbeType("day", scope, mapOf("score" to Json.Null), listOf(NumberSpec("day.score", 0.0, 10.0, integer = true))), DraftableType<ProbeEntity>, RemovableType<ProbeEntity> {
        override val savesGuarded = false; override val heldRemoval = true
    }
    val fact: ProbeType = object : ProbeType("fact", scope, mapOf("value" to Json.Null, "at" to Json.Null), listOf(NumberSpec("fact.value", 0.0, 500.0, quantum = .1))), TimestampedType<ProbeEntity>, RemovableType<ProbeEntity> {
        override val savesGuarded = false; override val heldRemoval = true; override val timestampField = "at"
    }
    val mark: ProbeType = object : ProbeType("mark", overlay, mapOf("done" to Json.Null, "memo" to Json.of("")), listOf(TextSpec("mark.memo", MeasureUnit.bytes, 0, 40, false, false))), DraftableType<ProbeEntity> { override val savesGuarded = false }
    val meta: ProbeType = object : ProbeType("meta", tree, mapOf("title" to Json.of("")), listOf(TextSpec("meta.title", MeasureUnit.chars, 0, 12, true, true))), DraftableType<ProbeEntity> { override val savesGuarded = false }
    val lap: ProbeType = object : ProbeType("lap", scope, mapOf("runId" to Json.of(""), "at" to Json.Null, "weight" to Json.Null), listOf(NumberSpec("lap.weight", -500.0, 500.0, quantum = .01))), RemovableType<ProbeEntity> { override val heldRemoval = false }
    val run: ProbeType = object : ProbeType("run", scope, mapOf("startedAt" to Json.Null, "label" to Json.Null), listOf(TextSpec("run.label", MeasureUnit.chars, 0, 12, true, true))), RemovableType<ProbeEntity> { override val heldRemoval = false }
    val link: ProbeType = object : ProbeType("link", tree, mapOf("strength" to Json.Null), listOf(NumberSpec("link.strength", 0.0, 9.0, integer = true))), RemovableType<ProbeEntity> { override val heldRemoval = true }
    val tag = ProbeType("tag", tree, mapOf("label" to Json.of("")), emptyList())
    fun entity(type: String): ProbeType = listOf(card, day, fact, mark, meta, lap, run, link, tag).firstOrNull { it.type == type } ?: throw ContractError("no probe entity $type")
}
internal sealed interface ProbeRefusal {
    data class Invalid(val violation: Violation) : ProbeRefusal
    data class Rejected(val refused: Refused) : ProbeRefusal
    val form: Json get() = when (this) {
        is Invalid -> Json.objectOf("violation" to violation.json)
        is Rejected -> Json.objectOf("refused" to refused.form)
    }
}
internal object ProbeRefusals : Refusals<ProbeRefusal> {
    override fun of(violation: Violation) = ProbeRefusal.Invalid(violation)
    override fun of(refused: Refused) = ProbeRefusal.Rejected(refused)
    override fun isGeneric(refusal: ProbeRefusal) = refusal is ProbeRefusal.Rejected
}
val Refused.form: Json get() = Json.objectOf("code" to Json.of(code.text), "subject" to (subject?.form ?: Json.Null), "detail" to (detail ?: Json.Null), "path" to Json.of(path.name))
