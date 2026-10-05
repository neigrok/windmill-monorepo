package works.windmill.sync.modelserver

import works.windmill.sync.core.*

// Swift §6.11 port. Strings compare by scalars; no normalization or locale operations.
object TextMerge {
    enum class Edit { keep, delete, insert }
    data class Result(val text: String, val conflict: Boolean)
    data class Merged(val text: String, val conflict: Boolean, val merged: Boolean, val baseText: String)
    fun isWhitespace(c: Int) = c in 9..13 || c in listOf(32, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF) || c in 0x2000..0x200A
    fun tokens(text: String): List<String> {
        val tokens = mutableListOf<String>(); var start = 0; var previous: Boolean? = null
        var at = 0
        while (at < text.length) {
            val cp = text.codePointAt(at); val whitespace = isWhitespace(cp)
            if (previous != null && previous != whitespace) { tokens.add(text.substring(start, at)); start = at }
            previous = whitespace; at += Character.charCount(cp)
        }
        if (start < text.length) tokens.add(text.substring(start))
        return tokens
    }
    fun script(a: List<String>, b: List<String>): List<Pair<Edit, String>> {
        val n = a.size; val m = b.size; val distance = Array(n + 1) { IntArray(m + 1) }
        for (i in n downTo 0) for (j in m downTo 0) distance[i][j] = when {
            i == n || j == m -> n - i + m - j
            a[i] == b[j] -> distance[i + 1][j + 1]
            else -> 1 + minOf(distance[i + 1][j], distance[i][j + 1])
        }
        var i = 0; var j = 0
        return buildList {
            while (i < n || j < m) when {
                i < n && j < m && a[i] == b[j] -> { add(Edit.keep to a[i]); i++; j++ }
                i < n && distance[i + 1][j] + 1 == distance[i][j] -> { add(Edit.delete to a[i]); i++ }
                else -> { add(Edit.insert to b[j]); j++ }
            }
        }
    }
    internal data class Hunk(val start: Int, val end: Int, val inserted: List<String>, val deleted: List<String>, val head: Boolean) {
        val whitespace get() = (inserted + deleted).all { it.codePoints().allMatch(::isWhitespace) }
    }
    internal fun hunks(base: List<String>, side: List<String>, head: Boolean): List<Hunk> {
        val result = mutableListOf<Hunk>(); var index = 0; var start: Int? = null
        val inserted = mutableListOf<String>(); val deleted = mutableListOf<String>()
        fun close() { start?.let { result.add(Hunk(it, index, inserted.toList(), deleted.toList(), head)) }; start = null; inserted.clear(); deleted.clear() }
        for ((edit, token) in script(base, side)) when (edit) {
            Edit.keep -> { close(); index++ }
            Edit.delete -> { if (start == null) start = index; deleted.add(token); index++ }
            Edit.insert -> { if (start == null) start = index; inserted.add(token) }
        }
        close(); return result
    }
    internal data class Region(val start: Int, var end: Int, val hunks: MutableList<Hunk>)
    internal fun regions(base: List<String>, head: List<String>, mine: List<String>): List<Region> {
        val all = (hunks(base, head, true) + hunks(base, mine, false)).sortedWith(compareBy<Hunk> { it.start }.thenBy { it.end }.thenBy { if (it.head) 0 else 1 })
        val regions = mutableListOf<Region>()
        for (hunk in all) {
            val last = regions.lastOrNull()
            if (last != null && hunk.start <= last.end) { last.end = maxOf(last.end, hunk.end); last.hunks.add(hunk) }
            else regions.add(Region(hunk.start, hunk.end, mutableListOf(hunk)))
        }
        return regions
    }
    internal fun side(hunks: List<Hunk>, start: Int, end: Int, base: List<String>): String = buildString {
        var position = start
        for (hunk in hunks) { append(base.subList(position, hunk.start).joinToString("")); append(hunk.inserted.joinToString("")); position = hunk.end }
        append(base.subList(position, end).joinToString(""))
    }
    internal fun emit(region: Region, base: List<String>): Result {
        val hh = region.hunks.filter { it.head }; val mh = region.hunks.filter { !it.head }
        val head = side(hh, region.start, region.end, base); val mine = side(mh, region.start, region.end, base)
        return when {
            mh.isEmpty() -> Result(head, false); hh.isEmpty() -> Result(mine, false)
            head == mine -> Result(head, false)
            hh.all { it.whitespace } && mh.all { it.whitespace } -> Result(head, false)
            hh.all { it.whitespace } -> Result(mine, false); mh.all { it.whitespace } -> Result(head, false)
            head.isEmpty() -> Result(mine, false); mine.isEmpty() -> Result(head, false)
            else -> Result(conflict(head, mine), true)
        }
    }
    fun diff3(base: String, head: String, mine: String, workCells: Int = Constants.MERGE_WORK_CELLS): Result {
        val bt = tokens(base); val ht = tokens(head); val mt = tokens(mine)
        if ((bt.size + 1L) * (ht.size + 1L) > workCells || (bt.size + 1L) * (mt.size + 1L) > workCells) return Result(conflict(head, mine), true)
        var position = 0; var conflict = false
        val text = buildString {
            for (region in regions(bt, ht, mt)) {
                append(bt.subList(position, region.start).joinToString("")); val emitted = emit(region, bt)
                append(emitted.text); conflict = conflict || emitted.conflict; position = region.end
            }
            append(bt.subList(position, bt.size).joinToString(""))
        }
        return Result(text, conflict)
    }
    fun trimmed(text: String, leading: Boolean): String {
        var start = 0; var end = text.length
        if (leading) while (start < end && isWhitespace(text.codePointAt(start))) start += Character.charCount(text.codePointAt(start))
        else while (end > start && isWhitespace(text.codePointBefore(end))) end -= Character.charCount(text.codePointBefore(end))
        return text.substring(start, end)
    }
    fun conflict(head: String, mine: String) = trimmed(head, false) + "\n\n" + trimmed(mine, true)
    private fun extends(x: String, y: String): Boolean = tokens(x).take(tokens(y).size) == tokens(y)
    fun merge(head: TextState, base: TextBase, mine: String, workCells: Int = Constants.MERGE_WORK_CELLS, revision: (Long) -> String?): Merged {
        val text = when (base) {
            is TextBase.Rev -> if (base.rev == head.rev) head.text else revision(base.rev) ?: throw Refusal("base-unknown")
            is TextBase.Text -> if (base.text.isEmpty()) when { extends(mine, head.text) -> head.text; extends(head.text, mine) -> mine; else -> "" } else base.text
        }
        val result = when { mine == head.text -> Result(head.text, false); text == head.text -> Result(mine, false); text == mine -> Result(head.text, false); else -> diff3(text, head.text, mine, workCells) }
        return Merged(result.text, result.conflict, result.conflict || head.merged && text != head.text, text)
    }
}
