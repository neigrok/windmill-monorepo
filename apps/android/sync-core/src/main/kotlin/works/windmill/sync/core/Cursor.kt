package works.windmill.sync.core

data class WireCursor(val epoch: String, val mode: String, val seq: Long, val key: RecordKey? = null, val at: Long? = null) {
    init {
        require(mode in listOf("live", "boot") && seq in 0..Json.MAX_SAFE_INTEGER)
        require((mode == "boot") == (at != null))
        require(at == null || at in seq..Json.MAX_SAFE_INTEGER)
    }
    val json: Json get() = Json.Obj(buildList {
        add("e" to Json.of(epoch)); add("m" to Json.of(mode)); add("s" to Json.of(seq))
        key?.let { add("k" to it.json) }; at?.let { add("a" to Json.of(it)) }
    })
    val text: String get() = encode(json.jcs.encodeToByteArray())
    companion object {
        private const val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        fun decode(text: String): WireCursor {
            require(text.length % 4 != 1 && text.all { it in alphabet })
            var buffer = 0; var bits = 0
            val bytes = mutableListOf<Byte>()
            for (char in text) {
                buffer = (buffer shl 6) or alphabet.indexOf(char); bits += 6
                if (bits >= 8) { bits -= 8; bytes.add((buffer ushr bits).toByte()) }
            }
            require(bits == 0 || buffer and ((1 shl bits) - 1) == 0)
            val json = Json.parse(bytes.toByteArray())
            json.expectKeys(listOf("e", "m", "s"), listOf("k", "a"))
            val key = json["k"]?.arr()?.also { require(it.size == 2) }?.let { RecordKey(it[0].str(), RecordID(it[1])) }
            val cursor = WireCursor(json.member("e").str(), json.member("m").str(), json.member("s").long(0), key, json["a"]?.long(0))
            require(cursor.text == text)
            return cursor
        }
        fun encode(bytes: ByteArray): String = buildString {
            var buffer = 0; var bits = 0
            for (byte in bytes) {
                buffer = (buffer shl 8) or (byte.toInt() and 255); bits += 8
                while (bits >= 6) { bits -= 6; append(alphabet[(buffer ushr bits) and 63]) }
            }
            if (bits > 0) append(alphabet[(buffer shl (6 - bits)) and 63])
        }
    }
}
