package works.windmill.domain.kit

import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.Quantum

data class Path(val text: String) {
    operator fun plus(key: String): Path = Path(if (text.isEmpty()) key else "$text.$key")
    operator fun plus(index: Int): Path = this + index.toString()
}

class Violation(val rule: String, val path: Path, val reason: Reason) : IllegalArgumentException("violation") {
    sealed class Reason(val name: String) {
        data object Blank : Reason("blank")
        data object Nul : Reason("nul")
        data object NotANumber : Reason("notANumber")
        data object NotInteger : Reason("notInteger")
        data object NotOneOf : Reason("notOneOf")
        data class TooShort(val min: Int, val unit: MeasureUnit) : Reason("tooShort")
        data class TooLong(val max: Int, val unit: MeasureUnit, val measured: Int) : Reason("tooLong")
        data class Below(val min: Double) : Reason("below")
        data class Above(val max: Double) : Reason("above")
        data class TooFew(val min: Int) : Reason("tooFew")
        data class TooMany(val max: Int) : Reason("tooMany")
        data class Custom(val label: String) : Reason("custom")
    }
    val json: Json get() = Json.Obj(buildList {
        add("rule" to Json.of(rule)); add("path" to Json.of(path.text)); add("reason" to Json.of(reason.name))
        when (val reason = reason) {
            is Reason.TooShort -> { add("min" to Json.of(reason.min)); add("unit" to Json.of(reason.unit.name)) }
            is Reason.TooLong -> { add("max" to Json.of(reason.max)); add("unit" to Json.of(reason.unit.name)); add("measured" to Json.of(reason.measured)) }
            is Reason.Below -> add("min" to Json.of(reason.min))
            is Reason.Above -> add("max" to Json.of(reason.max))
            is Reason.TooFew -> add("min" to Json.of(reason.min))
            is Reason.TooMany -> add("max" to Json.of(reason.max))
            is Reason.Custom -> add("custom" to Json.of(reason.label))
            else -> Unit
        }
    })
}

interface ValueSpec { val path: String; val json: Json }
interface ValueObject<V> { val json: Json; fun validated(at: Path): V }

data class TextSpec(override val path: String, val unit: MeasureUnit, val min: Int, val max: Int, val trim: Boolean, val nfc: Boolean) : ValueSpec {
    override val json: Json get() = Json.objectOf(
        "path" to Json.of(path), "kind" to Json.of("text"), "unit" to Json.of(unit.name),
        "min" to Json.of(min), "max" to Json.of(max), "trim" to Json.of(trim), "nfc" to Json.of(nfc),
    )
    fun normalised(value: String): String {
        val composed = if (nfc) Nfc.normalise(value) else value
        return if (trim) composed.trim { isWhitespace(it.code) } else composed
    }
    fun measure(value: String): Int = unit.length(normalised(value))
    fun apply(value: String, at: Path): String {
        val result = normalised(value)
        if ('\u0000' in result) throw Violation(path, at, Violation.Reason.Nul)
        val measured = unit.length(result)
        if (measured == 0 && min >= 1) throw Violation(path, at, Violation.Reason.Blank)
        if (measured < min) throw Violation(path, at, Violation.Reason.TooShort(min, unit))
        if (measured > max) throw Violation(path, at, Violation.Reason.TooLong(max, unit, measured))
        return result
    }
    fun applyOptional(value: String?, at: Path): String? = value?.let { apply(it, at) }
    companion object {
        fun isWhitespace(code: Int): Boolean = code in 0x09..0x0D || code in 0x2000..0x200A ||
            code in listOf(0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
        fun isBlank(value: String): Boolean = value.all { isWhitespace(it.code) }
    }
}

class NumberSpec(override val path: String, val min: Double, val max: Double, val integer: Boolean = false, quantum: Double? = null) : ValueSpec {
    val quantum = quantum?.let(::Quantum)
    init { require(!integer || quantum == null) }
    override val json: Json get() = Json.Obj(buildList {
        add("path" to Json.of(path)); add("kind" to Json.of("number")); add("min" to Json.of(min)); add("max" to Json.of(max))
        add("integer" to Json.of(integer)); quantum?.let { add("quantum" to Json.of(it.step)) }
    })
    fun apply(value: Double, at: Path): Double {
        if (!value.isFinite()) throw Violation(path, at, Violation.Reason.NotANumber)
        if (integer && kotlin.math.floor(value) != value) throw Violation(path, at, Violation.Reason.NotInteger)
        val rounded = quantum?.rounded(value) ?: value
        if (rounded < min) throw Violation(path, at, Violation.Reason.Below(min))
        if (rounded > max) throw Violation(path, at, Violation.Reason.Above(max))
        return rounded
    }
    fun applyOptional(value: Double?, at: Path): Double? = value?.let { apply(it, at) }
    fun apply(value: Int, at: Path): Int = apply(value.toDouble(), at).toInt()
    fun applyOptional(value: Int?, at: Path): Int? = value?.let { apply(it, at) }
}

class ChoiceSpec(override val path: String, values: List<String>) : ValueSpec {
    val values: List<String> = values.toList()
    override val json: Json get() = Json.objectOf("path" to Json.of(path), "kind" to Json.of("choice"), "values" to Json.Arr(values.map { Json.of(it) }))
    fun apply(value: String, at: Path): String {
        if (value !in values) throw Violation(path, at, Violation.Reason.NotOneOf)
        return value
    }
    fun applyOptional(value: String?, at: Path): String? = value?.let { apply(it, at) }
}

data class CountSpec(override val path: String, val min: Int, val max: Int) : ValueSpec {
    override val json: Json get() = Json.objectOf("path" to Json.of(path), "kind" to Json.of("count"), "min" to Json.of(min), "max" to Json.of(max))
    fun <V> apply(items: List<V>, at: Path, validate: (V, Path) -> V): List<V> {
        if (items.size < min) throw Violation(path, at, Violation.Reason.TooFew(min))
        if (items.size > max) throw Violation(path, at, Violation.Reason.TooMany(max))
        return items.mapIndexed { index, item -> validate(item, at + index) }
    }
    fun <V : ValueObject<V>> apply(items: List<V>, at: Path): List<V> = apply(items, at) { item, path -> item.validated(path) }
    fun <V : ValueObject<V>> applyOptional(items: List<V>?, at: Path): List<V>? = items?.let { apply(it, at) }
}

fun Json.firstNul(at: Path): Path? = when (this) {
    is Json.Str -> if ('\u0000' in value) at else null
    is Json.Arr -> values.withIndex().firstNotNullOfOrNull { it.value.firstNul(at + it.index) }
    is Json.Obj -> members.entries.firstNotNullOfOrNull { it.value.firstNul(at + it.key) }
    else -> null
}
