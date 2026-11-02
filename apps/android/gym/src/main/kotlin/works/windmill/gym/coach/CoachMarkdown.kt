package works.windmill.gym.coach

import java.net.URI
import java.net.URISyntaxException

@ConsistentCopyVisibility
data class CoachLink private constructor(val url: String) {
    companion object {
        fun parse(url: String): CoachLink? {
            if (url.any { it.isWhitespace() }) return null
            val uri = try {
                URI(url)
            } catch (_: URISyntaxException) {
                return null
            }
            if (!uri.scheme.equals("http", ignoreCase = true) && !uri.scheme.equals("https", ignoreCase = true)) return null
            if (uri.host.isNullOrEmpty()) return null
            return CoachLink(url)
        }
    }
}

data class CoachSpan(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val link: CoachLink? = null,
)

data class CoachTableRow(val cells: List<List<CoachSpan>>)

sealed interface CoachBlock {
    data class Paragraph(val spans: List<CoachSpan>) : CoachBlock
    data class Heading(val level: Int, val spans: List<CoachSpan>) : CoachBlock
    data class ListItem(val ordinal: Int?, val depth: Int, val spans: List<CoachSpan>) : CoachBlock
    data class Table(val header: CoachTableRow, val rows: List<CoachTableRow>) : CoachBlock
    data class Code(val text: String) : CoachBlock
    data object Rule : CoachBlock
}

// Coach Markdown is a subset parsed while streaming; pending end markers render as closed, never as raw asterisks.
object CoachMarkdown {
    fun parse(text: String): List<CoachBlock> = Source.read(text).mapNotNull { it.block }

    fun plain(text: String): String = Source.read(text).flatMap { it.lines { span -> span.text } }.joinToString("\n")

    fun copied(text: String): String = Source.read(text).flatMap { source ->
        source.lines { span ->
            val url = span.link?.url
            if (url == null || span.text == url) span.text else "${span.text} ($url)"
        }
    }.joinToString("\n")

    fun links(text: String): List<CoachLink> = parse(text).flatMap { block ->
        when (block) {
            is CoachBlock.Paragraph -> block.spans
            is CoachBlock.Heading -> block.spans
            is CoachBlock.ListItem -> block.spans
            is CoachBlock.Table -> (listOf(block.header) + block.rows).flatMap { it.cells.flatten() }
            is CoachBlock.Code, CoachBlock.Rule -> emptyList()
        }
    }.mapNotNull { it.link }.distinct()
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

private object TableLine {
    private val delimiter = Regex(":?-{3,}:?")
    fun cells(raw: String): List<String>? {
        if ('|' !in raw) return null
        val source = raw.trim()
        val cells = mutableListOf<String>()
        val cell = StringBuilder()
        var escaped = false
        var code = false
        source.forEach { char ->
            when {
                escaped -> { cell.append(char); escaped = false }
                char == '\\' -> { cell.append(char); escaped = true }
                char == '`' -> { cell.append(char); code = !code }
                char == '|' && !code -> { cells += cell.toString().trim(); cell.clear() }
                else -> cell.append(char)
            }
        }
        cells += cell.toString().trim()
        if (source.startsWith('|') && cells.firstOrNull().isNullOrEmpty()) cells.removeAt(0)
        if (source.endsWith('|') && cells.lastOrNull().isNullOrEmpty()) cells.removeAt(cells.lastIndex)
        return cells.takeIf { it.isNotEmpty() }
    }

    fun header(lines: List<String>, at: Int): List<String>? {
        val header = cells(lines[at])?.takeIf { it.size >= 2 } ?: return null
        val divider = lines.getOrNull(at + 1)?.let(::cells) ?: return null
        if (header.size != divider.size || divider.any { !delimiter.matches(it) }) return null
        return header
    }
}

// A stretch of consecutive lines that one block claims, with its rendered and its copied form.
private sealed interface Source {
    val block: CoachBlock?
    fun lines(render: (CoachSpan) -> String): List<String>

    data class AsWritten(val line: String, override val block: CoachBlock?) : Source {
        override fun lines(render: (CoachSpan) -> String): List<String> = listOf(line)
    }

    data class Heading(val level: Int, val text: String) : Source {
        override val block: CoachBlock? get() = Inline(text).spans.takeIf { it.isNotEmpty() }?.let { CoachBlock.Heading(level, it) }
        override fun lines(render: (CoachSpan) -> String): List<String> = listOf(Inline(text).text(render))
    }

    data class Paragraph(val lines: List<String>) : Source {
        private val text: String get() = lines.joinToString("\n")
        override val block: CoachBlock? get() = Inline(text).spans.takeIf { it.isNotEmpty() }?.let { CoachBlock.Paragraph(it) }
        override fun lines(render: (CoachSpan) -> String): List<String> = listOf(Inline(text).text(render))
    }

    data class Item(val prefix: String, val ordinal: Int?, val depth: Int, val lines: List<String>) : Source {
        private val text: String get() = lines.joinToString("\n")
        override val block: CoachBlock? get() = Inline(text).spans.takeIf { it.isNotEmpty() }?.let { CoachBlock.ListItem(ordinal, depth, it) }
        override fun lines(render: (CoachSpan) -> String): List<String> = listOf(prefix + Inline(text).text(render))
    }

    data class Table(val header: List<String>, val rows: List<List<String>>) : Source {
        override val block: CoachBlock get() = CoachBlock.Table(CoachTableRow(header.map { Inline(it).spans }),
            rows.map { CoachTableRow(it.map { cell -> Inline(cell).spans }) })
        override fun lines(render: (CoachSpan) -> String): List<String> = (listOf(header) + rows).map { row -> row.joinToString("\t") { Inline(it).text(render) } }
    }

    data class Code(val lines: List<String>, val closed: Boolean) : Source {
        private val shown: List<String>
            get() {
                if (closed || lines.isEmpty() || !Line.couldCloseFence(lines.last())) return lines
                return lines.dropLast(1)
            }
        override val block: CoachBlock get() = CoachBlock.Code(shown.joinToString("\n"))
        override fun lines(render: (CoachSpan) -> String): List<String> = lines
    }

    companion object {
        fun read(text: String): List<Source> {
            val lines = text.split('\n')
            val sources = mutableListOf<Source>()
            var at = 0
            while (at < lines.size) {
                val header = TableLine.header(lines, at)
                if (header != null) {
                    var end = at + 2
                    val rows = mutableListOf<List<String>>()
                    while (end < lines.size) {
                        val row = TableLine.cells(lines[end])?.takeIf { it.size <= header.size } ?: break
                        rows += row + List(header.size - row.size) { "" }
                        end++
                    }
                    sources += Table(header, rows)
                    at = end
                    continue
                }
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
            while (end < lines.size && TableLine.header(lines, end) == null && Line.read(lines[end], last = end == lines.lastIndex) is Line.Text) end += 1
            return end
        }
    }
}

// Inline emphasis, code, escapes and links become styled spans; open markers style the tail and empty markers are swallowed.
private class Inline(private val source: String) {
    private val out = mutableListOf<CoachSpan>()
    private val run = StringBuilder()
    private var bold: Char? = null
    private var italic: Char? = null

    val spans: List<CoachSpan>

    fun text(render: (CoachSpan) -> String): String = spans.joinToString("", transform = render)

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
        if (next == null || next !in "\\`*_#[]()|") {
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
        var end = close + 2
        var depth = 1
        while (end < source.length) {
            when (source[end]) {
                '(' -> depth++
                ')' -> depth--
            }
            if (depth == 0) break
            end++
        }
        val finished = depth == 0
        val text = source.substring(at + 1, close)
        val url = source.substring(close + 2, end)
        if ('\n' in text || url.any { it.isWhitespace() }) {
            run.append('[')
            return at + 1
        }
        val link = if (finished) CoachLink.parse(url) else null
        if (link == null) {
            run.append(text)
        } else {
            flush()
            emit(CoachSpan(text, bold != null, italic != null, link = link))
        }
        return if (finished) end + 1 else source.length
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
        if (last != null && last.copy(text = span.text) == span) {
            out[out.lastIndex] = last.copy(text = last.text + span.text)
            return
        }
        out += span
    }
}
