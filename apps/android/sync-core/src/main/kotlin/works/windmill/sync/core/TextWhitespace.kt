package works.windmill.sync.core

object TextWhitespace {
    fun contains(point: Int): Boolean = point in 9..13 || point in 0x2000..0x200A ||
        point in listOf(32, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)

    fun isBlank(text: String): Boolean = text.codePoints().allMatch(::contains)
}
