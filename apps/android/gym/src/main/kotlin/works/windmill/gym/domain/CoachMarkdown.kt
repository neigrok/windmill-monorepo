package works.windmill.gym.domain

data class CoachSpan(val text: String, val bold: Boolean = false, val italic: Boolean = false, val code: Boolean = false)

sealed interface CoachBlock {
    data class Paragraph(val spans: List<CoachSpan>) : CoachBlock
    data class Heading(val level: Int, val spans: List<CoachSpan>) : CoachBlock
    data class ListItem(val ordinal: Int?, val depth: Int, val spans: List<CoachSpan>) : CoachBlock
    data class Code(val text: String) : CoachBlock
    data object Rule : CoachBlock
}

// The subset of Markdown a coach answer carries, parsed from the text the model streams so far.
// Pending markers at the very end of a live answer render as if closed, never as raw asterisks.
object CoachMarkdown {
    fun parse(text: String): List<CoachBlock> = Source.read(text).mapNotNull { it.block }

    fun plain(text: String): String = Source.read(text).flatMap { it.plainLines }.joinToString("\n")
}

// What one line of the answer says on its own; the last line may still be waiting for its next token.
private sealed interface Line {
    data object Blank : Line
    data object Fence : Line
    data object Rule : Line
    data object Held : Line
    data class Heading(val level: Int, val text: String) : Line
    data class Item(val prefix: String, val ordinal: Int?, val depth: Int, val text: String) : Line
    data class Text(val raw: String) : Line

    companion object {
        private val heading = Regex("""(#{1,3}) (.*)""", RegexOption.DOT_MATCHES_ALL)
        private val item = Regex("""([ \t]*)(?:[-*+]|(\d{1,9})[.)]) (.*)""", RegexOption.DOT_MATCHES_ALL)
        private val held = Regex("""[ \t]*(?:[*+]|-{1,2}|\d{1,9}[.)]?)|#{1,3}""")
        private val rules = setOf("---", "***", "___")

        fun read(raw: String, last: Boolean): Line {
            if (raw.isBlank()) return Blank
            if (raw.trimStart().startsWith("```")) return Fence
            if (raw.trimEnd() in rules) return Rule
            val asHeading = heading.matchEntire(raw)
            if (asHeading != null) return Heading(asHeading.groupValues[1].length, asHeading.groupValues[2])
            val asItem = item.matchEntire(raw)
            if (asItem != null) {
                val (indent, number, text) = asItem.destructured
                val width = indent.count { it == ' ' } + indent.count { it == '\t' } * 4
                return Item(
                    prefix = raw.substring(0, raw.length - text.length),
                    ordinal = number.toIntOrNull(),
                    depth = if (width >= 4) 1 else 0,
                    text = text,
                )
            }
            if (last && held.matches(raw)) return Held
            return Text(raw)
        }

        fun closesFence(raw: String): Boolean = raw.trim() == "```"

        fun couldCloseFence(raw: String): Boolean = "```".startsWith(raw.trim())
    }
}

// A stretch of consecutive lines that one block claims, with its rendered and its copied form.
private sealed interface Source {
    val block: CoachBlock?
    val plainLines: List<String>

    data class AsWritten(val line: String, override val block: CoachBlock?) : Source {
        override val plainLines: List<String> get() = listOf(line)
    }

    data class Heading(val level: Int, val text: String) : Source {
        override val block: CoachBlock? get() = Inline(text).spans.takeIf { it.isNotEmpty() }?.let { CoachBlock.Heading(level, it) }
        override val plainLines: List<String> get() = listOf(Inline(text).plain)
    }

    data class Paragraph(val lines: List<String>) : Source {
        private val text: String get() = lines.joinToString("\n")
        override val block: CoachBlock? get() = Inline(text).spans.takeIf { it.isNotEmpty() }?.let { CoachBlock.Paragraph(it) }
        override val plainLines: List<String> get() = listOf(Inline(text).plain)
    }

    data class Item(val prefix: String, val ordinal: Int?, val depth: Int, val lines: List<String>) : Source {
        private val text: String get() = lines.joinToString("\n")
        override val block: CoachBlock? get() = Inline(text).spans.takeIf { it.isNotEmpty() }?.let { CoachBlock.ListItem(ordinal, depth, it) }
        override val plainLines: List<String> get() = listOf(prefix + Inline(text).plain)
    }

    data class Code(val lines: List<String>, val closed: Boolean) : Source {
        private val shown: List<String>
            get() {
                if (closed || lines.isEmpty() || !Line.couldCloseFence(lines.last())) return lines
                return lines.dropLast(1)
            }
        override val block: CoachBlock get() = CoachBlock.Code(shown.joinToString("\n"))
        override val plainLines: List<String> get() = lines
    }

    companion object {
        fun read(text: String): List<Source> {
            val lines = text.split('\n')
            val sources = mutableListOf<Source>()
            var at = 0
            while (at < lines.size) {
                val raw = lines[at]
                when (val line = Line.read(raw, last = at == lines.lastIndex)) {
                    Line.Blank, Line.Held -> {
                        sources += AsWritten(raw, block = null)
                        at += 1
                    }
                    Line.Rule -> {
                        sources += AsWritten(raw, CoachBlock.Rule)
                        at += 1
                    }
                    is Line.Heading -> {
                        sources += Heading(line.level, line.text)
                        at += 1
                    }
                    Line.Fence -> {
                        val close = (at + 1 until lines.size).firstOrNull { Line.closesFence(lines[it]) }
                        sources += Code(lines.subList(at + 1, close ?: lines.size), closed = close != null)
                        at = (close ?: lines.lastIndex) + 1
                    }
                    is Line.Item -> {
                        val end = continuationEnd(lines, at + 1)
                        sources += Item(line.prefix, line.ordinal, line.depth, listOf(line.text) + lines.subList(at + 1, end).map { it.trimStart() })
                        at = end
                    }
                    is Line.Text -> {
                        val end = continuationEnd(lines, at + 1)
                        sources += Paragraph(lines.subList(at, end))
                        at = end
                    }
                }
            }
            return sources
        }

        private fun continuationEnd(lines: List<String>, from: Int): Int {
            var end = from
            while (end < lines.size && Line.read(lines[end], last = end == lines.lastIndex) is Line.Text) end += 1
            return end
        }
    }
}

// The inline pass over one block's text: emphasis, code spans, escapes and links become styled spans.
// A marker still open at the end of the block styles everything after it; a marker with nothing after it is swallowed.
private class Inline(private val source: String) {
    private val out = mutableListOf<CoachSpan>()
    private val run = StringBuilder()
    private var bold: Char? = null
    private var italic: Char? = null

    val spans: List<CoachSpan>
    val plain: String get() = spans.joinToString("") { it.text }

    init {
        var at = 0
        while (at < source.length) {
            at = when (val c = source[at]) {
                '\\' -> escape(at)
                '`' -> code(at)
                '[' -> link(at)
                '*', '_' -> emphasis(at, c)
                else -> {
                    run.append(c)
                    at + 1
                }
            }
        }
        flush()
        spans = out
    }

    private fun escape(at: Int): Int {
        val next = source.getOrNull(at + 1)
        if (next == null || next !in "\\`*_#[]()") {
            run.append('\\')
            return at + 1
        }
        run.append(next)
        return at + 2
    }

    private fun code(at: Int): Int {
        val close = source.indexOf('`', at + 1)
        val end = if (close < 0) source.length else close
        flush()
        emit(CoachSpan(source.substring(at + 1, end), bold != null, italic != null, code = true))
        return if (close < 0) source.length else close + 1
    }

    private fun link(at: Int): Int {
        val close = source.indexOf(']', at + 1)
        if (close < 0 || source.getOrNull(close + 1) != '(') {
            run.append('[')
            return at + 1
        }
        val end = source.indexOf(')', close + 2)
        val text = source.substring(at + 1, close)
        val url = source.substring(close + 2, if (end < 0) source.length else end)
        if ('\n' in text || url.any { it.isWhitespace() }) {
            run.append('[')
            return at + 1
        }
        run.append(text)
        return if (end < 0) source.length else end + 1
    }

    private fun emphasis(at: Int, c: Char): Int {
        var end = at
        while (end < source.length && source[end] == c) end += 1
        val prev = source.getOrNull(at - 1)
        val next = source.getOrNull(end)
        val opens = next != null && !next.isWhitespace() && (prev == null || !prev.isLetterOrDigit())
        val closes = c == '*' || next == null || !next.isLetterOrDigit()
        val ending = next == null || next == '\n'
        var left = end - at
        while (left > 0) {
            val double = left >= 2
            val openedBy = if (double) bold else italic
            when {
                openedBy == c && closes -> {
                    flush()
                    if (double) bold = null else italic = null
                }
                openedBy == null && opens -> {
                    flush()
                    if (double) bold = c else italic = c
                }
                ending -> {}
                else -> run.append(if (double) "$c$c" else "$c")
            }
            left -= if (double) 2 else 1
        }
        return end
    }

    private fun flush() {
        emit(CoachSpan(run.toString(), bold != null, italic != null))
        run.clear()
    }

    private fun emit(span: CoachSpan) {
        if (span.text.isEmpty()) return
        val last = out.lastOrNull()
        if (last != null && last.bold == span.bold && last.italic == span.italic && last.code == span.code) {
            out[out.lastIndex] = last.copy(text = last.text + span.text)
            return
        }
        out += span
    }
}
