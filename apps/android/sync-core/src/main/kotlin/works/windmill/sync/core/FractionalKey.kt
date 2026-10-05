package works.windmill.sync.core

class FractionalKeyError(val code: String) : IllegalArgumentException(code)

data class FractionalKey(val text: String) : Comparable<FractionalKey> {
    init {
        val length = text.firstOrNull()?.let(::integerLength)
        if (length == null || length > text.length || text == smallest ||
            text.any { it !in alphabet } || (text.length > length && text.last() == '0')) {
            throw FractionalKeyError("invalid")
        }
    }
    override fun compareTo(other: FractionalKey): Int = text.compareTo(other.text)
    val integerPart: String get() = text.take(integerLength(text[0])!!)
    companion object {
        const val alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        val smallest = "A" + "0".repeat(26)
        fun integerLength(head: Char): Int? = when (head) {
            in 'a'..'z' -> head.code - 'a'.code + 2
            in 'A'..'Z' -> 'Z'.code - head.code + 2
            else -> null
        }
        fun between(a: FractionalKey?, b: FractionalKey?): FractionalKey {
            if (a == null && b == null) return FractionalKey("a0")
            if (a == null) {
                val integer = b!!.integerPart
                if (integer == smallest) return FractionalKey(integer + midpoint("", b.text.drop(integer.length)))
                if (integer.length < b.text.length) return FractionalKey(integer)
                return FractionalKey(step(integer, -1) ?: throw FractionalKeyError("exhausted"))
            }
            val integer = a.integerPart
            val fraction = a.text.drop(integer.length)
            if (b == null) return FractionalKey(step(integer, 1) ?: (integer + midpoint(fraction, null)))
            if (a >= b) throw FractionalKeyError("not-ascending")
            if (integer == b.integerPart) return FractionalKey(integer + midpoint(fraction, b.text.drop(integer.length)))
            val higher = step(integer, 1) ?: throw FractionalKeyError("exhausted")
            if (higher < b.text) return FractionalKey(higher)
            return FractionalKey(integer + midpoint(fraction, null))
        }
        fun dropping(moved: Json, above: Json?, stored: List<ListMember>, drawn: List<ListMember>): FractionalKey {
            val others = stored.filter { it.id != moved }.sorted()
            if (above == null) return between(null, others.firstOrNull()?.key)
            val anchor = drawn.firstOrNull { it.id == above } ?: others.firstOrNull { it.id == above }
                ?: throw FractionalKeyError("anchor-missing")
            return between(anchor.key, others.firstOrNull { it.key > anchor.key }?.key)
        }
        fun midpoint(lower: String, upper: String?): String {
            var a = lower
            var b = upper
            val result = StringBuilder()
            while (true) {
                if (b != null && a >= b) throw FractionalKeyError("not-ascending")
                if (a.lastOrNull() == '0' || b?.lastOrNull() == '0') throw FractionalKeyError("invalid")
                if (b != null) {
                    var shared = 0
                    while (shared < b.length && (a.getOrNull(shared) ?: '0') == b[shared]) shared++
                    if (shared > 0) {
                        result.append(b.take(shared)); a = a.drop(shared); b = b.drop(shared)
                        continue
                    }
                }
                val digitA = a.firstOrNull()?.let(alphabet::indexOf) ?: 0
                val digitB = b?.first()?.let(alphabet::indexOf) ?: alphabet.length
                if (digitB - digitA > 1) return result.append(alphabet[(digitA + digitB + 1) / 2]).toString()
                if (b != null && b.length > 1) return result.append(b.first()).toString()
                result.append(alphabet[digitA]); a = a.drop(1); b = null
            }
        }
        fun step(integer: String, direction: Int): String? {
            val head = integer[0]
            val digits = integer.drop(1).toMutableList()
            for (i in digits.indices.reversed()) {
                val next = alphabet.indexOf(digits[i]) + direction
                if (next in alphabet.indices) {
                    digits[i] = alphabet[next]
                    return head + digits.joinToString("")
                }
                digits[i] = if (direction > 0) '0' else 'z'
            }
            if (direction > 0) {
                if (head == 'Z') return "a0"
                if (head == 'z') return null
                if (head + 1 > 'a') digits.add('0') else digits.removeAt(digits.lastIndex)
            } else {
                if (head == 'a') return "Zz"
                if (head == 'A') return null
                if (head - 1 < 'Z') digits.add('z') else digits.removeAt(digits.lastIndex)
            }
            return (head + direction) + digits.joinToString("")
        }
    }
}

data class ListMember(val id: Json, val key: FractionalKey) : Comparable<ListMember> {
    override fun compareTo(other: ListMember): Int = if (key != other.key) key.compareTo(other.key)
        else compareBytes(id.jcs, other.id.jcs)
}
