package works.windmill.sync.core

class IdentityError : IllegalArgumentException("identity")

class Mint(val json: Json) {
    val prefix = json.member("prefix").str()
    val alphabet = json.member("alphabet").str()
    val length = json.member("length").long(1).let { require(it <= Int.MAX_VALUE); it.toInt() }
    init { json.expectKeys(listOf("prefix", "alphabet", "length")); require(alphabet.length >= 2) }
    fun id(draw: (Int) -> Int): String = prefix + buildString {
        repeat(this@Mint.length) {
            val i = draw(alphabet.length)
            if (i !in alphabet.indices) throw IdentityError()
            append(alphabet[i])
        }
    }
}

object DerivedId {
    fun from(label: String, fallback: String, taken: Collection<String>): String {
        val stem = buildString {
            for (byte in label.encodeToByteArray()) {
                if (length == 40) break
                val c = (byte.toInt() and 255).toChar()
                when (c) {
                    in 'a'..'z', in '0'..'9' -> append(c)
                    in 'A'..'Z' -> append(c + 32)
                    else -> if (isNotEmpty() && last() != '-') append('-')
                }
            }
        }.trimEnd('-').ifEmpty { fallback }
        var id = stem
        var suffix = 2
        while (id in taken) id = "$stem-${suffix++}"
        return id
    }
}

data class SeededId(val seed: String, val ordinal: Long) {
    val id: String get() = "$seed-$ordinal"
    companion object {
        fun make(seed: String, ordinal: Long, type: TypeDef): SeededId {
            val bounds = type.seeded ?: throw IdentityError()
            val pattern = type.idPattern ?: throw IdentityError()
            val result = SeededId(seed, ordinal)
            if (MeasureUnit.chars.length(seed) > bounds.member("seedMax").long() || !pattern.matches(seed) ||
                ordinal < 1 || ordinal > bounds.member("ordinalMax").long() || !pattern.matches(result.id)) throw IdentityError()
            return result
        }
        fun parse(id: String): SeededId? {
            val at = id.lastIndexOf('-')
            if (at <= 0) return null
            val digits = id.drop(at + 1)
            if (digits.isEmpty() || digits.first() == '0' || digits.any { it !in '0'..'9' }) return null
            val number = digits.toLongOrNull() ?: return null
            return SeededId(id.take(at), number)
        }
    }
}
