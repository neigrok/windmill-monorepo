package works.windmill.domain.kit

import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Registry
import works.windmill.sync.core.compareBytes

@ConsistentCopyVisibility
data class Rule private constructor(val name: String, val subject: String, val kind: Kind,
    val codes: List<RefusalCode>, val spec: Json?) {
    enum class Kind { local, serverDecided }
    val json: Json get() = Json.Obj(buildList {
        add("name" to Json.of(name)); add("subject" to Json.of(subject))
        add("kind" to Json.of(if (kind == Kind.local) "local" else "server"))
        spec?.let { add("spec" to it) }
        if (codes.isNotEmpty()) add("codes" to Json.Arr(codes.map { Json.of(it.text) }))
    })

    companion object {
        fun local(spec: ValueSpec): Rule = Rule(spec.path, spec.path.substringBefore('.'), Kind.local, emptyList(), spec.json)
        fun local(name: String, subject: String, backstop: List<RefusalCode> = emptyList()): Rule =
            Rule(name, subject, Kind.local, backstop.toList(), null)
        fun serverDecided(name: String, codes: List<RefusalCode>, subject: String): Rule =
            Rule(name, subject, Kind.serverDecided, codes.toList(), null)
    }
}

class RuleBook(val registry: Registry, entities: List<EntityType<*>>, rules: List<Rule>) {
    val entities: List<EntityType<*>> = entities.sortedWith { a, b -> compareBytes(a.type, b.type) }
    val rules: List<Rule> = (rules + this.entities.flatMap { standardRules(it, registry) })
        .sortedWith { a, b -> compareBytes(a.name, b.name) }
    fun entity(type: String): EntityType<*>? = entities.firstOrNull { it.type == type }
    val json: Json get() = Json.objectOf(
        "entities" to Json.Arr(entities.map { entity -> Json.Obj(buildList {
            add("type" to Json.of(entity.type)); add("removable" to Json.of(entity is RemovableType<*>))
            add("held" to Json.of((entity as? RemovableType<*>)?.heldRemoval == true))
            add("ordered" to Json.of(entity is OrderedType<*>))
            add("guarded" to Json.of((entity as? DraftableType<*>)?.savesGuarded == true))
            (entity as? TimestampedType<*>)?.timestampField?.let { add("timestamp" to Json.of(it)) }
        }) }),
        "rules" to Json.Arr(rules.map { it.json }),
    )

    companion object {
        fun standardRules(entity: EntityType<*>, registry: Registry): List<Rule> {
            val definition = registry.type(entity.type) ?: return emptyList()
            return buildList {
                fun addIf(applies: Boolean, name: String, codes: List<RefusalCode>) {
                    if (applies) add(Rule.serverDecided("${entity.type}.$name", codes, entity.type))
                }
                addIf(definition.life, "gone", listOf(RefusalCode.unknownRecord, RefusalCode.recordDead))
                addIf(definition.identity == "minted", "taken", listOf(RefusalCode.idTaken, RefusalCode.idSpent))
                addIf((entity as? DraftableType<*>)?.savesGuarded == true, "stale", listOf(RefusalCode.stale))
                addIf(definition.cap != null, "cap", listOf(RefusalCode.cap))
                addIf(definition.fields.values.any { it.kind == "text" }, "size", listOf(RefusalCode.tooLarge))
            }
        }
    }
}
