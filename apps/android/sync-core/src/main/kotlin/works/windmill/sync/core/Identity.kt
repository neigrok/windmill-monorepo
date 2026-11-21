package works.windmill.sync.core

class IdentityError : IllegalArgumentException("identity")

class Mint(val json: Json) {
    val prefix = json.member("prefix").str()
    val alphabet = json.member("alphabet").str()
    val length = json.member("length").long(1).let { require(it <= Int.MAX_VALUE); it.toInt() }
    val symbols: List<String> = buildList {
        var at = 0
        while (at < alphabet.length) {
            val count = if (alphabet[at].isHighSurrogate()) 2 else 1
            add(alphabet.substring(at, at + count))
            at += count
        }
    }
    init { json.expectKeys(listOf("prefix", "alphabet", "length")); require(symbols.size >= 2) }
    fun id(draw: (Int) -> Int): String = prefix + buildString {
        repeat(this@Mint.length) {
            val i = draw(symbols.size)
            if (i !in symbols.indices) throw IdentityError()
            append(symbols[i])
        }
    }
}

object DerivedId {
    fun from(label: String, fallback: String, taken: Collection<String>, maxChars: Long? = null): String {
        var stem = buildString {
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
        fun prefix(text: String, limit: Long): String {
            if (limit < 1) throw IdentityError()
            var end = 0
            var count = 0L
            while (end < text.length && count < limit) {
                end += if (text[end].isHighSurrogate()) 2 else 1
                count++
            }
            return text.substring(0, end).trimEnd('-').also { if (it.isEmpty()) throw IdentityError() }
        }
        if (maxChars != null) stem = prefix(stem, maxChars)
        var id = stem
        var ordinal = 2
        while (id in taken) {
            val suffix = "-${ordinal++}"
            if (maxChars == null) { id = stem + suffix; continue }
            id = prefix(stem, maxChars - suffix.length) + suffix
        }
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
