package works.windmill.sync.core

class DigestError : IllegalArgumentException("digest")

class ScopeDigest private constructor(private val octets: List<Int>) {
    constructor(hex: String) : this(parseHex(hex))
    val hex: String get() = octets.joinToString("") { it.toString(16).padStart(2, '0') }
    val bytes: ByteArray get() = ByteArray(32) { octets[it].toByte() }
    operator fun plus(other: ScopeDigest): ScopeDigest = combine(other, 1)
    operator fun minus(other: ScopeDigest): ScopeDigest = combine(other, -1)
    fun combine(other: ScopeDigest, sign: Int): ScopeDigest {
        val result = MutableList(32) { 0 }
        var carry = 0
        for (i in 31 downTo 0) {
            val sum = octets[i] + sign * other.octets[i] + carry
            result[i] = sum and 255
            carry = sum shr 8
        }
        return ScopeDigest(result)
    }
    fun replacing(before: Json?, after: Json?): ScopeDigest = this - row(before) + row(after)
    override fun equals(other: Any?): Boolean = other is ScopeDigest && octets == other.octets
    override fun hashCode(): Int = octets.hashCode()
    override fun toString(): String = hex
    companion object {
        val ZERO = ScopeDigest(List(32) { 0 })
        fun parseHex(hex: String): List<Int> {
            if (hex.length != 64 || hex.any { it !in "0123456789abcdef" }) throw DigestError()
            return (0 until 32).map { hex.substring(it * 2, it * 2 + 2).toInt(16) }
        }
        fun fromBytes(bytes: ByteArray): ScopeDigest {
            if (bytes.size != 32) throw DigestError()
            return ScopeDigest(bytes.map { it.toInt() and 255 })
        }
        fun row(row: Json?): ScopeDigest {
            if (row == null || row["life"]?.arr()?.firstOrNull()?.str()?.let { it != "alive" } == true) return ZERO
            return fromBytes(Sha256.bytes(row.jcs.encodeToByteArray()))
        }
        fun rows(rows: Collection<Json>): ScopeDigest = rows.fold(ZERO) { sum, row -> sum + row(row) }
    }
}

// SHA-256 stays in the core so its only dependencies are the Kotlin/JVM value owners allowed by the kit contract.
object Sha256 {
    private val constants = intArrayOf(
        0x428a2f98, 0x71374491, 0xb5c0fbcf.toInt(), 0xe9b5dba5.toInt(), 0x3956c25b, 0x59f111f1, 0x923f82a4.toInt(), 0xab1c5ed5.toInt(),
        0xd807aa98.toInt(), 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe.toInt(), 0x9bdc06a7.toInt(), 0xc19bf174.toInt(),
        0xe49b69c1.toInt(), 0xefbe4786.toInt(), 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152.toInt(), 0xa831c66d.toInt(), 0xb00327c8.toInt(), 0xbf597fc7.toInt(), 0xc6e00bf3.toInt(), 0xd5a79147.toInt(), 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e.toInt(), 0x92722c85.toInt(),
        0xa2bfe8a1.toInt(), 0xa81a664b.toInt(), 0xc24b8b70.toInt(), 0xc76c51a3.toInt(), 0xd192e819.toInt(), 0xd6990624.toInt(), 0xf40e3585.toInt(), 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814.toInt(), 0x8cc70208.toInt(), 0x90befffa.toInt(), 0xa4506ceb.toInt(), 0xbef9a3f7.toInt(), 0xc67178f2.toInt(),
    )
    fun rotate(value: Int, bits: Int): Int = (value ushr bits) or (value shl (32 - bits))
    fun bytes(input: ByteArray): ByteArray {
        val state = intArrayOf(0x6a09e667, 0xbb67ae85.toInt(), 0x3c6ef372, 0xa54ff53a.toInt(), 0x510e527f, 0x9b05688c.toInt(), 0x1f83d9ab, 0x5be0cd19)
        val blocks = (input.size.toLong() + 9 + 63) / 64
        val length = input.size.toLong() * 8
        val words = IntArray(64)
        for (block in 0 until blocks) {
            for (i in 0 until 16) {
                var word = 0
                for (j in 0 until 4) {
                    val at = block * 64 + i * 4 + j
                    val byte = when {
                        at < input.size -> input[at.toInt()].toInt() and 255
                        at == input.size.toLong() -> 128
                        at >= blocks * 64 - 8 -> (length ushr ((blocks * 64 - 1 - at).toInt() * 8)).toInt() and 255
                        else -> 0
                    }
                    word = (word shl 8) or byte
                }
                words[i] = word
            }
            for (i in 16 until 64) {
                val a = words[i - 15]
                val b = words[i - 2]
                val s0 = rotate(a, 7) xor rotate(a, 18) xor (a ushr 3)
                val s1 = rotate(b, 17) xor rotate(b, 19) xor (b ushr 10)
                words[i] = words[i - 16] + s0 + words[i - 7] + s1
            }
            var a = state[0]; var b = state[1]; var c = state[2]; var d = state[3]
            var e = state[4]; var f = state[5]; var g = state[6]; var h = state[7]
            for (i in 0 until 64) {
                val t1 = h + (rotate(e, 6) xor rotate(e, 11) xor rotate(e, 25)) + ((e and f) xor (e.inv() and g)) + constants[i] + words[i]
                val t2 = (rotate(a, 2) xor rotate(a, 13) xor rotate(a, 22)) + ((a and b) xor (a and c) xor (b and c))
                h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2
            }
            state[0] += a; state[1] += b; state[2] += c; state[3] += d
            state[4] += e; state[5] += f; state[6] += g; state[7] += h
        }
        return ByteArray(32) { i -> (state[i / 4] ushr (24 - i % 4 * 8)).toByte() }
    }
    fun hex(input: ByteArray): String = bytes(input).joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
}
