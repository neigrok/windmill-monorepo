package works.windmill.sync.core

class JsonError(val code: String) : IllegalArgumentException(code)

// Values and object keys retain their spelling; equality is equality of JCS bytes.
sealed class Json {
    data object Null : Json()
    data class Bool(val value: Boolean) : Json()
    class Num(value: Double) : Json() {
        val value = if (value == 0.0) 0.0 else value
        init { if (!value.isFinite()) throw JsonError("non-finite") }
    }
    class Str(val value: String) : Json() {
        init { validateUnicode(value) }
    }
    class Arr(values: List<Json>) : Json() { val values: List<Json> = values.toList() }
    class Obj(pairs: List<Pair<String, Json>>) : Json() {
        val members: Map<String, Json>
        init {
            val sorted = pairs.sortedBy { it.first }
            val result = linkedMapOf<String, Json>()
            for ((key, value) in sorted) {
                validateUnicode(key)
                if (result.containsKey(key)) throw JsonError("duplicate-key")
                result[key] = value
            }
            members = result.toMap()
        }
    }

    operator fun get(key: String): Json? = (this as? Obj)?.members?.get(key)
    fun member(key: String): Json = obj()[key] ?: throw JsonError("missing-key")
    fun str(): String = (this as? Str)?.value ?: throw JsonError("string")
    fun bool(): Boolean = (this as? Bool)?.value ?: throw JsonError("boolean")
    fun num(): Double = (this as? Num)?.value ?: throw JsonError("number")
    fun long(min: Long = -MAX_SAFE_INTEGER): Long {
        val number = num()
        if (number < min || kotlin.math.abs(number) > MAX_SAFE_INTEGER || number != number.toLong().toDouble()) {
            throw JsonError("safe-integer")
        }
        return number.toLong()
    }
    fun arr(): List<Json> = (this as? Arr)?.values ?: throw JsonError("array")
    fun obj(): Map<String, Json> = (this as? Obj)?.members ?: throw JsonError("object")
    fun expectKeys(required: List<String>, optional: List<String> = emptyList()) {
        val keys = obj().keys
        if (!keys.containsAll(required) || keys.any { it !in required && it !in optional }) throw JsonError("keys")
    }
    fun orNull(): Json? = if (this === Null) null else this

    val jcs: String get() = when (this) {
        is Null -> "null"
        is Bool -> value.toString()
        is Num -> Decimal.text(value)
        is Str -> quote(value)
        is Arr -> values.joinToString(",", "[", "]") { it.jcs }
        is Obj -> members.entries.joinToString(",", "{", "}") { quote(it.key) + ":" + it.value.jcs }
    }
    fun precedes(other: Json): Boolean = compareBytes(jcs, other.jcs) < 0
    final override fun toString(): String = jcs
    final override fun equals(other: Any?): Boolean = other is Json && jcs == other.jcs
    final override fun hashCode(): Int = jcs.hashCode()

    companion object {
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        const val MAX_DEPTH = 128
        fun parse(text: String): Json = Parser(text).document()
        fun parse(bytes: ByteArray): Json {
            val text = try { bytes.decodeToString(throwOnInvalidSequence = true) }
                catch (_: Exception) { throw JsonError("utf8") }
            return parse(text)
        }
        fun of(value: String): Json = Str(value)
        fun of(value: Boolean): Json = Bool(value)
        fun of(value: Number): Json = Num(value.toDouble())
        fun array(vararg values: Json): Json = Arr(values.toList())
        fun objectOf(vararg pairs: Pair<String, Json>): Json = Obj(pairs.toList())

        fun validateUnicode(text: String) {
            var i = 0
            while (i < text.length) {
                val c = text[i++].code
                if (c in 0xDC00..0xDFFF) throw JsonError("surrogate")
                if (c in 0xD800..0xDBFF && (i == text.length || text[i++].code !in 0xDC00..0xDFFF)) {
                    throw JsonError("surrogate")
                }
            }
        }

        fun quote(text: String): String = buildString {
            append('"')
            for (c in text) when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\t' -> append("\\t")
                '\n' -> append("\\n")
                '\u000C' -> append("\\f")
                '\r' -> append("\\r")
                else -> if (c.code < 32) append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
            }
            append('"')
        }
    }
}

fun compareBytes(a: String, b: String): Int {
    val left = a.encodeToByteArray()
    val right = b.encodeToByteArray()
    for (i in 0 until minOf(left.size, right.size)) {
        val order = (left[i].toInt() and 255).compareTo(right[i].toInt() and 255)
        if (order != 0) return order
    }
    return left.size.compareTo(right.size)
}

// Exact decimal expansion followed by nearest, even-tie, shortest round-trip selection (ECMAScript 7.1.12.1).
internal object Decimal {
    fun text(value: Double): String {
        if (value == 0.0) return "0"
        val magnitude = kotlin.math.abs(value)
        // Exact safe integers use plain decimal in ECMAScript; no round-trip search is needed.
        if (magnitude <= Json.MAX_SAFE_INTEGER && value == value.toLong().toDouble()) return value.toLong().toString()
        val bits = magnitude.toBits()
        val exponent = ((bits ushr 52) and 2047).toInt()
        val significand = (bits and 0xFFFFFFFFFFFFFL) + if (exponent == 0) 0 else 0x10000000000000L
        val power = if (exponent == 0) -1074 else exponent - 1075
        val limbs = mutableListOf((significand % 1_000_000_000).toInt(), (significand / 1_000_000_000).toInt())
        repeat(kotlin.math.abs(power)) {
            var carry = 0L
            for (i in limbs.indices) {
                val product = limbs[i].toLong() * if (power < 0) 5 else 2
                val sum = product + carry
                limbs[i] = (sum % 1_000_000_000).toInt()
                carry = sum / 1_000_000_000
            }
            if (carry > 0) limbs.add(carry.toInt())
        }
        while (limbs.size > 1 && limbs.last() == 0) limbs.removeAt(limbs.lastIndex)
        val exact = limbs.last().toString() + limbs.dropLast(1).asReversed().joinToString("") { it.toString().padStart(9, '0') }
        val point = exact.length + minOf(power, 0)
        for (count in 1..minOf(17, exact.length)) {
            var digits = exact.take(count)
            if (exact.length > count) {
                val next = exact[count]
                val tailNonzero = exact.drop(count + 1).any { it != '0' }
                if (next > '5' || (next == '5' && (tailNonzero || (digits.last().code - 48) % 2 != 0))) {
                    digits = (digits.toLong() + 1).toString()
                }
            }
            val decimalPower = point - count
            if ((digits + "e" + decimalPower).toDouble() != magnitude) continue
            val n = digits.length + decimalPower
            digits = digits.trimEnd('0')
            val k = digits.length
            val sign = if (value < 0) "-" else ""
            if (k <= n && n <= 21) return sign + digits + "0".repeat(n - k)
            if (n in 1..21) return sign + digits.take(n) + "." + digits.drop(n)
            if (n > -6 && n <= 0) return sign + "0." + "0".repeat(-n) + digits
            val exp = n - 1
            val mantissa = if (k == 1) digits else digits.take(1) + "." + digits.drop(1)
            return sign + mantissa + "e" + (if (exp >= 0) "+" else "") + exp
        }
        throw JsonError("decimal")
    }
}

internal class Parser(val text: String) {
    var index = 0
    var depth = 0
    fun document(): Json {
        val result = value()
        whitespace()
        if (index != text.length) throw JsonError("trailing")
        return result
    }
    fun peek(): Char? = text.getOrNull(index)
    fun whitespace() { while (peek() in listOf(' ', '\t', '\r', '\n')) index++ }
    fun expect(c: Char) { if (peek() != c) throw JsonError("syntax"); index++ }
    fun value(): Json {
        whitespace()
        return when (peek()) {
            '{', '[' -> container()
            '"' -> Json.Str(string())
            't' -> literal("true", Json.Bool(true))
            'f' -> literal("false", Json.Bool(false))
            'n' -> literal("null", Json.Null)
            '-', in '0'..'9' -> number()
            else -> throw JsonError("syntax")
        }
    }
    fun literal(word: String, value: Json): Json {
        if (!text.startsWith(word, index)) throw JsonError("syntax")
        index += word.length
        return value
    }
    fun container(): Json {
        if (++depth > Json.MAX_DEPTH) throw JsonError("too-deep")
        val objectMode = text[index++] == '{'
        val end = if (objectMode) '}' else ']'
        val members = mutableListOf<Pair<String, Json>>()
        val items = mutableListOf<Json>()
        whitespace()
        if (peek() != end) while (true) {
            whitespace()
            if (objectMode) {
                if (peek() != '"') throw JsonError("syntax")
                val key = string()
                whitespace(); expect(':')
                members.add(key to value())
            } else items.add(value())
            whitespace()
            if (peek() != ',') break
            index++
        }
        expect(end)
        depth--
        return if (objectMode) Json.Obj(members) else Json.Arr(items)
    }
    fun string(): String {
        expect('"')
        val result = buildString {
            while (true) {
                val c = peek() ?: throw JsonError("unterminated-string")
                index++
                if (c == '"') break
                if (c.code < 32) throw JsonError("control")
                if (c != '\\') { append(c); continue }
                val escape = peek() ?: throw JsonError("escape")
                index++
                append(when (escape) {
                    '"', '\\', '/' -> escape
                    'b' -> '\b'
                    'f' -> '\u000C'
                    'n' -> '\n'
                    'r' -> '\r'
                    't' -> '\t'
                    'u' -> {
                        val digits = text.substring(index, minOf(index + 4, text.length))
                        if (digits.length != 4 || digits.any { it !in "0123456789abcdefABCDEF" }) throw JsonError("escape")
                        index += 4
                        digits.toInt(16).toChar()
                    }
                    else -> throw JsonError("escape")
                })
            }
        }
        Json.validateUnicode(result)
        return result
    }
    fun digits() { val start = index; while (peek() in '0'..'9') index++; if (start == index) throw JsonError("number") }
    fun number(): Json {
        val start = index
        if (peek() == '-') index++
        if (peek() == '0') index++ else digits()
        if (peek() == '.') { index++; digits() }
        val mantissa = text.substring(start, index)
        if (peek() == 'e' || peek() == 'E') {
            index++
            if (peek() == '+' || peek() == '-') index++
            digits()
        }
        val number = text.substring(start, index).toDoubleOrNull() ?: throw JsonError("number")
        if (!number.isFinite() || (number == 0.0 && mantissa.any { it in '1'..'9' })) throw JsonError("number-range")
        return Json.Num(number)
    }
}
