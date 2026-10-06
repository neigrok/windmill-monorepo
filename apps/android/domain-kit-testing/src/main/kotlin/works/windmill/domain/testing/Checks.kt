package works.windmill.domain.testing

import works.windmill.domain.kit.*
import works.windmill.sync.api.Record
import works.windmill.sync.api.TextValue
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.*

class CheckFailure(val check: String, val step: Int, val path: String, val reason: String) : IllegalArgumentException("$check step $step, $path: $reason")

// Declaration checks in normative step order, so a malformed product fails on its first declaration error.
object RegistryCheck {
    private fun failure(step: Int, path: String, reason: String): Nothing = throw CheckFailure("RegistryCheck", step, path, reason)
    fun entity(type: EntityType<*>, registry: Registry) { declaration(type, registry) }
    fun <E : Writable<E>> entity(type: WritableType<E>, sample: E, book: RuleBook, registry: Registry = book.registry) {
        val definition = declaration(type, registry)
        val written = sample.fields()
        for (name in written.keys.sorted()) {
            val field = definition.fields[name]
            if (field == null || field.writer != "client" || field.kind == "serial" || name == (type as? OrderedType<*>)?.orderField)
                failure(4, "${type.type}.$name", "the sample writes a field that is no client-written field")
        }
        for (check in type.checks) if (check.field != null && check.field !in written) failure(5, "${type.type}.${check.field}", "a check on a field the entity does not write")
        val specs = book.rules.mapNotNull { it.spec }
        for (spec in specs.filter { it.member("path").str().startsWith("${type.type}.") }) {
            val path = spec.member("path").str()
            if (type.checks.none { it.field == path.split('.')[1] }) failure(6, path, "a LOCAL spec on a field with no check")
            target(spec, definition)?.let { failure(6, path, it) }
        }
        if (type is DraftableType<*>) {
            val record = Record(type.type, sample.id.record, null, null,
                written.filterKeys { definition.fields[it]?.kind != "text" },
                written.filterKeys { definition.fields[it]?.kind == "text" }.mapValues { TextValue(it.value.str(), false, false) },
                emptyMap(), null, null, true, false, false)
            if (Json.Obj(type.decode(Fields(record)).fields().toList()) != Json.Obj(written.toList())) failure(7, type.type, "the sample does not round trip")
            if (type.savesGuarded && definition.fields.values.any { it.kind == "text" }) failure(8, type.type, "a type whose saves are guarded has a text field")
        }
        for (field in definition.fields.values) for ((path, domain) in field.domain?.leaves("${type.type}.${field.name}") ?: emptyList()) {
            val quantum = domain.quantum ?: continue
            if (specs.none { it.member("path").str() == path && it["quantum"]?.orNull()?.num()?.let(quantum::holds) == true })
                failure(9, path, "a number with a quantum has no number spec on it")
        }
        stringsSpecced(definition.fields.values.filter { it.name in written }.flatMap { field ->
            if (field.kind == "text") listOf("${type.type}.${field.name}") else field.domain?.stringPaths("${type.type}.${field.name}") ?: emptyList()
        }, specs)
        val whole = definition.json["wholePut"]?.bool() == true
        if (whole) {
            for (field in definition.fields.values) if (field.writer == "client" && field.isLattice && field.name !in written)
                failure(11, "${type.type}.${field.name}", "a field of a whole type the entity does not write")
            if ((type as? DraftableType<*>)?.savesGuarded == true) failure(11, type.type, "a whole type whose saves are guarded")
        }
        (type as? TimestampedType<*>)?.timestampField?.let { name ->
            if (!whole) failure(11, type.type, "a timestamped type that is not wholePut")
            val field = definition.fields[name]
            if (field?.writer != "client" || field.kind != "lww" || field.domain?.type != "number" || field.domain!!.json["integer"]?.bool() != true || name !in written)
                failure(11, "${type.type}.$name", "the timestamp field is no client lww integer the entity writes")
            if (type.checks.any { it.field == name }) failure(11, "${type.type}.$name", "a check on the timestamp field")
        }
    }
    private fun declaration(type: EntityType<*>, registry: Registry): TypeDef {
        val definition = registry.type(type.type) ?: failure(1, type.type, "the registry holds no type")
        if (!definition.scope.startsWith("product:") || type.scope != ScopeRef.product(definition.scope.drop(8))) failure(1, type.type, "the registry declares no type in the entity product scope")
        if (type is RemovableType<*> && !definition.life) failure(2, type.type, "a removable type without life")
        (type as? OrderedType<*>)?.orderField?.let { name ->
            val field = definition.fields[name]
            if (field?.writer != "client" || field.kind != "lww" || field.domain?.type != "fracKey") failure(3, "${type.type}.$name", "the order field is no client lww fracKey")
        }
        return definition
    }
    fun command(type: ServerCommand, book: RuleBook, registry: Registry = book.registry) {
        val definition = registry.command(type.name) ?: failure(0, type.name, "the registry holds no such command")
        val declared = type.specs.map { it.json }
        val paths = definition.args.values.flatMap { it.domain?.stringPaths("${type.name}.${it.name}") ?: emptyList() }
        stringsSpecced(paths, declared)
        stringsSpecced(paths, book.rules.mapNotNull { it.spec })
        for (spec in declared) {
            val path = spec.member("path").str()
            val names = path.removePrefix("${type.name}.").split('.')
            val argument = definition.args[names.first()] ?: failure(6, path, "the spec names no command argument")
            val domain = walk(argument.domain, names.drop(1), path)
            refusal(spec, domain, null, false, emptySet(), false)?.let { failure(6, path, it) }
            if (book.rules.none { it.spec == spec }) failure(6, path, "the command applies a spec the book does not pin")
        }
    }
    private fun stringsSpecced(paths: List<String>, specs: List<Json>) {
        for (path in paths) if (specs.none { it.member("path").str() == path && it.member("kind").str() in listOf("text", "choice") }) failure(10, path, "a string with no text or choice spec")
    }
    private fun target(spec: Json, definition: TypeDef): String? {
        val path = spec.member("path").str()
        val names = path.split('.')
        val field = definition.fields[names.getOrNull(1)] ?: failure(6, path, "the spec names no registry path")
        return refusal(spec, walk(field.domain, names.drop(2), path), field.bounds, names.size == 2 && field.kind == "text", if (names.size == 2) field.rank.keys else emptySet(), names.size == 2)
    }
    private fun walk(start: Domain?, names: List<String>, path: String): Domain? {
        var domain = start
        for (name in names) {
            while (domain?.type == "array") domain = domain.items
            domain = domain?.properties?.get(name) ?: failure(6, path, "the spec names no registry path")
        }
        return domain
    }
    private fun refusal(spec: Json, domain: Domain?, fieldBounds: Bounds?, isText: Boolean, rank: Set<String>, isField: Boolean): String? {
        var item = domain
        while (item?.type == "array") item = item.items
        val bounds = if (isField && domain?.type != "array" && fieldBounds != null) fieldBounds else item?.bounds
        val allowed = rank.takeIf { it.isNotEmpty() } ?: item?.json?.get("enum")?.arr()?.map { it.str() }?.toSet()
        val kind = spec.member("kind").str()
        if (kind in listOf("text", "choice") && !isText && rank.isEmpty() && item?.type != "string") return "$kind spec on a value that is no string"
        return when (kind) {
            "text" -> {
                if (allowed != null) return "a text spec on an enum; a choice spec states it"
                val unit = MeasureUnit.valueOf(spec.member("unit").str())
                val max = spec.member("max").long(); val min = spec.member("min").long()
                if (bounds?.max?.let { if (unit == MeasureUnit.chars && bounds.unit == MeasureUnit.bytes) 4 * max > it else max > it } == true) "admits text beyond registry bounds"
                else if (bounds?.min?.let { if (unit == MeasureUnit.bytes && bounds.unit == MeasureUnit.chars) min < 4 * it - 3 else min < it } == true) "admits text below registry bounds" else null
            }
            "choice" -> spec.member("values").arr().firstNotNullOfOrNull { value ->
                when { '\u0000' in value.str() -> "admits U+0000"; allowed != null && value.str() !in allowed -> "admits a value outside registry enum"; item?.pattern?.matches(value.str()) == false -> "admits a value outside registry pattern"; bounds?.admits(value) == false -> "admits a value outside registry bounds"; else -> null }
            }
            "number" -> {
                if (item?.type != "number") return "a number spec on a value that is no number"
                val min = spec.member("min").num(); val max = spec.member("max").num()
                val quantum = spec["quantum"]?.orNull()?.num()
                when { item.json["min"]?.num()?.let { min < it } == true -> "admits a value below registry minimum"; item.json["max"]?.num()?.let { max > it } == true -> "admits a value above registry maximum";
                    item.json["integer"]?.bool() == true && spec["integer"]?.bool() != true && (quantum == null || quantum != kotlin.math.floor(quantum)) -> "admits a fraction the registry refuses";
                    item.quantum?.let { quantum == null || !it.holds(quantum) } == true -> "admits a value off registry quantum"; else -> null }
            }
            "count" -> {
                if (domain?.type != "array") return "a count spec on a value that is no array"
                val max = spec.member("max").long()
                val size = domain.items?.largestEncoding()
                when { domain.json["maxItems"]?.long()?.let { max > it } == true -> "admits too many items";
                    size != null && fieldBounds?.max?.let { 2 + max * size + kotlin.math.max(max - 1, 0) > it } == true -> "items encode beyond field bound"; else -> null }
            }
            else -> "unknown spec kind $kind"
        }
    }
}

internal fun Domain.leaves(path: String): List<Pair<String, Domain>> = when (type) {
    "array" -> items!!.leaves(path)
    "object" -> properties.flatMap { (name, domain) -> domain.leaves("$path.$name") }
    else -> listOf(path to this)
}
internal fun Domain.stringPaths(path: String) = leaves(path).filter { it.second.type == "string" }.map { it.first }
internal fun Domain.largestEncoding(): Long? {
    val size = when (type) {
        "string" -> json["enum"]?.arr()?.maxOfOrNull { it.jcs.encodeToByteArray().size.toLong() } ?: bounds?.max?.let { 2 + 6 * it }
        "number" -> if (json["integer"]?.bool() == true && json["min"] != null && json["max"] != null) maxOf(json.member("min").jcs.length, json.member("max").jcs.length).toLong() else 24L
        "boolean" -> 5L
        "array" -> { val item = items!!.largestEncoding(); val count = json["maxItems"]?.long(); if (item == null || count == null) null else 2 + count * item + maxOf(count - 1, 0) }
        "object" -> { var total = 2L + maxOf(properties.size - 1, 0); for ((name, domain) in properties) { val part = domain.largestEncoding() ?: return null; total += Json.of(name).jcs.encodeToByteArray().size + 1 + part }; total }
        else -> null
    }
    return size?.let { if (nullable) maxOf(it, 4) else it }
}
object RuleBookParity {
    fun check(book: RuleBook, file: String) { if (Contract.json(file) != book.json) throw CheckFailure("RuleBookParity", 0, file, "the book differs from the pinned file") }
}
object RuleBookCheck {
    fun <R> check(book: RuleBook, refusals: Refusals<R>, vectors: String, actionVectors: List<String> = emptyList()) {
        val names = mutableSetOf<String>()
        fun failure(rule: String, reason: String): Nothing = throw CheckFailure("RuleBookCheck", 0, rule, reason)
        for (rule in book.rules) if (!names.add(rule.name)) failure(rule.name, "two rules share the name")
        val cases = Contract.vectors(vectors)
        val actions = actionVectors.flatMap(Contract::vectors)
        fun violation(json: Json, rule: String): Boolean = when (json) {
            is Json.Obj -> (json["rule"] == Json.of(rule) && json["path"] is Json.Str && json["reason"] is Json.Str) || json.members.values.any { violation(it, rule) }
            is Json.Arr -> json.values.any { violation(it, rule) }
            else -> false
        }
        for (rule in book.rules.filter { it.kind == Rule.Kind.local }) {
            if (rule.spec != null && cases.none { it.input["spec"]?.get("path") == rule.spec!!["path"] }) failure(rule.name, "a LOCAL spec with no spec case")
            if (rule.spec == null) {
                if ((cases + actions).none { violation(it.expect, rule.name) }) failure(rule.name, "a LOCAL rule with no value or action violation case")
            } else if (book.entities.any { rule.name.startsWith("${it.type}.") }) {
                if (cases.none { it.input["entity"] != null && it.expect["violation"]?.get("rule") == Json.of(rule.name) }) failure(rule.name, "a LOCAL rule bound to a field with no entity case")
            }
        }
        for (rule in book.rules) for (code in rule.codes) for (path in if (rule.kind == Rule.Kind.serverDecided) Refused.Path.entries else listOf(Refused.Path.notice)) {
            val detail = if (code == RefusalCode.cap) Json.objectOf("type" to Json.of(rule.subject), "cap" to Json.of(book.registry.type(rule.subject)?.cap ?: 0)) else null
            if (refusals.isGeneric(refusals.of(Refused(code, RecordRef(rule.subject, RecordID("subject")), detail, path)))) failure(rule.name, "$code on the $path path maps to generic refusal")
        }
    }
}
