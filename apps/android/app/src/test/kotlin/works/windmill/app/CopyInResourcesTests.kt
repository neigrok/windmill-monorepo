package works.windmill.app

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

// Copy a person reads lives in string resources, and each message gets the arguments its resource takes.
class CopyInResourcesTests {
    private val android = File(checkNotNull(System.getProperty("windmill.android")))
    private val modules = listOf("app", "platform", "gym")
    private val manifests = listOf("app/src/main/AndroidManifest.xml", "gym/src/main/AndroidManifest.xml")
    private val words = "platform/src/main/kotlin/works/windmill/platform/i18n/Words.kt"

    // Literals that read like copy and are not the app's to translate.
    private val allowed = mapOf(
        // The seed's movement names are the person's own data once saved, byte for byte the backend's seed.
        "gym/src/main/kotlin/works/windmill/gym/presentation/Training.kt" to listOf("Back Squat", "Bench Press", "Overhead Press", "Barbell Row", "Chin Up"),
        // OkHttp's own message for a stream the server dropped.
        "platform/src/main/kotlin/works/windmill/platform/telemetry/Telemetry.kt" to listOf("unexpected end of stream"),
    )
    // TalkBack's page label formats its own digit, by the owner's call.
    private val formatsItsNumber = listOf("onboarding_page")

    // Where a screen, a notification, a shortcut or a share sheet takes its copy: a call and the argument it reads, or a property.
    private val sites = listOf(
        Site("Text", Regex("""\bText\("""), 0, "text"),
        Site("Icon description", Regex("""\bIcon\("""), 1),
        Site("accessibility action", Regex("""\bCustomAccessibilityAction\("""), 0, "label"),
        Site("toast", Regex("""\bToast\.makeText\("""), 1, "text"),
        Site("notification", Regex("""\.set(?:ContentTitle|ContentText|SubText|Ticker)\("""), 0),
        Site("notification channel", Regex("""\bNotificationChannel\("""), 1, "name"),
        Site("shortcut", Regex("""\.set(?:ShortLabel|LongLabel)\("""), 0),
        Site("snackbar", Regex("""\bshowSnackbar\("""), 0, "message"),
        Site("drawText", Regex("""\bdrawText\("""), 1, "text"),
        Site("share sheet", Regex("""\bIntent\.createChooser\("""), 1, "title"),
        Site("share sheet", Regex("""\bputExtra\((?=\s*Intent\.EXTRA_(?:TEXT|SUBJECT|TITLE)\b)"""), 1),
        Site("Plain", Regex("""\bPlain\("""), 0, "text"),
        Site("contentDescription", Regex("""\bcontentDescription\s*=(?!=)|\bContentDescription\s+to\b""")),
        Site("copy argument", Regex("""\b(?:label|title|subtitle|placeholder|description|stateDescription|\w+Label)\s*=(?!=)""")),
    )
    // A call or a property where copy goes, and for a call the argument that carries it.
    private class Site(val rule: String, val at: Regex, val position: Int? = null, val named: String? = null)
    private val plural = Regex("""\b(?:pluralStringResource|getQuantityString)\(""")
    // The lists, sets and maps a table of words is written in.
    private val collection = Regex("""^(?:listOf|listOfNotNull|mutableListOf|setOf|arrayOf|mapOf)$""")
    private val string = Regex(""""(?:[^"\\\n]|\\.)*"""")
    private val sentence = Regex("""\p{L}+[^\p{L}]*\s[^\p{L}]*\p{L}""")
    // A capitalised word, as a table of words writes it: "Sun", "Mon".
    private val word = Regex(""""\p{Lu}\p{Ll}+"""")
    // An animation's label names it in the layout inspector; nobody reads it on screen.
    private val animation = Regex("""^(?:rememberInfiniteTransition|updateTransition|animate\w*|Crossfade|AnimatedContent)$""")
    // A literal handed to one of these is read by a developer, a test or a parser, never by the person holding the phone.
    private val unread = Regex("""^(?:check|checkNotNull|require|requireNotNull|error|testTag|Regex|ofPattern|toString|Log\.\w+|\w*Exception)$""")
    // A file's previews, their state and their data close it, from its first private declaration named for a preview.
    private val previews = Regex("""^private (?:data )?(?:class|object|val|fun) \w*[Pp]review""", RegexOption.MULTILINE)
    private val messageCall = Regex("""\b(Words\.Message|Words\.Counted|stringResource|pluralString|getString|says)\(""")
    private val resource = Regex("""\b\w*R\.(string|plurals)\.(\w+)""")

    // A Kotlin source read as code: comments dropped, a template read as `0` since a value is not copy, raw strings plain, line breaks kept.
    private inner class Code(source: String) {
        val text = read(source)
        private val skeleton = text.replace(string) { "\"" + " ".repeat(it.value.length - 2) + "\"" }

        fun line(at: Int) = text.substring(0, at).count { it == '\n' } + 1

        // The call a position stands in, past a lambda's arguments, and where its name starts; `toString` for what a `toString` returns.
        fun caller(at: Int): Pair<String, Int> {
            val line = text.lastIndexOf('\n', at - 1) + 1
            if (Regex("""\bfun toString\(\)""").containsMatchIn(text.substring(line, at))) return "toString" to line
            var open = opener(at - 1)
            if (open < 0) return "" to 0
            if (skeleton[open] == '{') {
                val before = skeleton.substring(0, open).trimEnd()
                open = if (before.endsWith(')')) opener(before.length - 2) else before.length
                if (open < 0) return "" to 0
            }
            return name(open)
        }

        fun calledBy(at: Int, names: Regex) = caller(at).first.let { names.matches(it.substringAfterLast('.')) || names.matches(it) }

        // Read, not shown: handed to an `unread` call, thrown, a `toString` printing its class, a date pattern quoting no words.
        fun unread(at: Int, literal: String): Boolean {
            val (name, start) = caller(at)
            val last = name.substringAfterLast('.')
            if (Regex("""\bthrow\s+$""").containsMatchIn(skeleton.substring(maxOf(0, start - 16), start))) return true
            if (last == "toString") return Regex("""^"[A-Z]\w*\(""").containsMatchIn(literal)
            if (last == "ofPattern") return !Regex("""'[^']*\p{L}[^']*'""").containsMatchIn(literal)
            return unread.matches(last) || unread.matches(name)
        }

        // Where a site's copy goes: the argument its call reads, or the value its property is set to, to the end of the statement.
        fun extents(site: Site, at: MatchResult): List<IntRange> {
            if (site.position == null) return listOf(at.range.last + 1 until statementEnd(at.range.last + 1))
            val named = Regex("""^\s*(\w+)\s*=(?!=)""")
            return arguments(at.range.last).withIndex().mapNotNull { (index, range) ->
                val name = named.find(text.substring(range))
                when {
                    name == null -> range.takeIf { index == site.position }
                    name.groupValues[1] == site.named -> range.first + name.range.last + 1..range.last
                    else -> null
                }
            }
        }

        // The literals with a letter standing as the value in `range`, through braces, bare brackets and tables, never another call.
        fun values(range: IntRange): List<MatchResult> = string.findAll(text, range.first).takeWhile { it.range.first <= range.last }.filter { literal ->
            Regex("""\p{L}""").containsMatchIn(literal.value) &&
                generateSequence(opener(literal.range.first - 1)) { opener(it - 1) }.takeWhile { it >= range.first }.all { open ->
                    skeleton[open] == '{' || skeleton[open] == '(' && name(open).first.let { it.isEmpty() || collection.matches(it) }
                }
        }.toList()

        // A literal written straight into a list, a set or a map.
        fun tabled(at: Int): Boolean = opener(at - 1).let { open -> open >= 0 && skeleton[open] == '(' && collection.matches(name(open).first) }

        // The name before the bracket at `open` and where it starts; "" for a bare bracket.
        private fun name(open: Int): Pair<String, Int> {
            val window = maxOf(0, open - 120)
            val found = Regex("""[\w.]+$""").find(skeleton.substring(window, open).trimEnd()) ?: return "" to open
            return found.value.removePrefix(".") to window + found.range.first
        }

        private fun statementEnd(from: Int): Int {
            var depth = 0
            var index = from
            while (index < skeleton.length && skeleton[index].isWhitespace()) index++
            while (index < skeleton.length) {
                when (skeleton[index]) {
                    '(', '[', '{' -> depth++
                    ')', ']', '}' -> if (depth == 0) return index else depth--
                    '\n', ',', ';' -> if (depth == 0) return index
                }
                index++
            }
            return index
        }

        // The ranges of the arguments inside the bracket that opens at `open`.
        fun arguments(open: Int): List<IntRange> {
            val ranges = mutableListOf<IntRange>()
            var depth = 0
            var start = open + 1
            for (index in open + 1 until skeleton.length) {
                when (skeleton[index]) {
                    '(', '[', '{' -> depth++
                    ')', ']', '}' -> if (depth > 0) depth-- else {
                        if (skeleton.substring(start, index).isNotBlank()) ranges += start until index
                        return ranges
                    }
                    ',' -> if (depth == 0) { ranges += start until index; start = index + 1 }
                }
            }
            return ranges
        }

        private fun opener(from: Int): Int {
            var depth = 0
            for (index in from downTo 0) {
                when (skeleton[index]) {
                    ')', ']', '}' -> depth++
                    '(', '[', '{' -> if (depth == 0) return index else depth--
                }
            }
            return -1
        }

        private fun read(source: String): String = buildString {
            var index = 0
            fun template() {
                index++
                if (source[index] == '{') {
                    var depth = 0
                    do {
                        if (source[index] == '{') depth++
                        if (source[index] == '}') depth--
                        index++
                    } while (index < source.length && depth > 0)
                } else {
                    while (index < source.length && (source[index].isLetterOrDigit() || source[index] == '_')) index++
                }
                append('0')
            }
            fun isTemplate() = source[index] == '$' && source.getOrNull(index + 1)?.let { it == '{' || it.isLetter() || it == '_' } == true
            while (index < source.length) {
                when {
                    source.startsWith("//", index) -> while (index < source.length && source[index] != '\n') index++
                    source.startsWith("/*", index) -> {
                        val end = source.indexOf("*/", index + 2).let { if (it < 0) source.length else it + 2 }
                        repeat(source.substring(index, end).count { it == '\n' }) { append('\n') }
                        index = end
                    }
                    source.startsWith("\"\"\"", index) -> {
                        index += 3
                        var breaks = 0
                        append('"')
                        while (index < source.length && !source.startsWith("\"\"\"", index)) {
                            if (isTemplate()) { template(); continue }
                            val char = source[index++]
                            if (char == '\n') breaks++
                            append(if (char == '"' || char == '\\' || char == '\n') ' ' else char)
                        }
                        index += 3
                        append('"')
                        repeat(breaks) { append('\n') }
                    }
                    source[index] == '"' -> {
                        append(source[index++])
                        while (index < source.length && source[index] != '"' && source[index] != '\n') {
                            if (source[index] == '\\') { append(source, index, minOf(index + 2, source.length)); index += 2; continue }
                            if (isTemplate()) { template(); continue }
                            append(source[index++])
                        }
                        if (index < source.length && source[index] == '"') append(source[index++])
                    }
                    source[index] == '\'' -> {
                        val end = source.indexOf('\'', index + if (source.getOrNull(index + 1) == '\\') 3 else 2)
                        append("' '")
                        index = if (end < 0) source.length else end + 1
                    }
                    else -> append(source[index++])
                }
            }
        }
    }

    private fun offences(path: String, source: String): List<Pair<Int, String>> {
        val code = Code(source)
        val previewsFrom = previews.find(code.text)?.range?.first ?: code.text.length
        val allowedHere = allowed[path].orEmpty().map { "\"$it\"" }
        val copied = sites.flatMap { site ->
            site.at.findAll(code.text).filter { it.range.first < previewsFrom && !(site.rule == "copy argument" && code.calledBy(it.range.first, animation)) }
                .flatMap { at -> code.extents(site, at).flatMap(code::values) }
                .filter { it.value !in allowedHere }.map { code.line(it.range.first) to site.rule }.toList()
        }
        val literals = string.findAll(code.text).filter { it.range.first < previewsFrom && it.value !in allowedHere }.toList()
        val tables = literals.filter { word.matches(it.value) && code.tabled(it.range.first) }.map { code.line(it.range.first) to "word table" }
        val said = literals.filter { sentence.containsMatchIn(it.value) && !code.unread(it.range.first, it.value) && !code.calledBy(it.range.first, animation) }
            .map { code.line(it.range.first) to "sentence" }
        val plurals = if (path == words) emptyList() else plural.findAll(code.text).filter { it.range.first < previewsFrom }.map { code.line(it.range.first) to "plural" }.toList()
        return (copied + tables + said + plurals).distinct().sortedBy { it.first }
    }

    private fun sources() = modules.flatMap { module -> File(android, "$module/src/main/kotlin").walk().filter { it.extension == "kt" }.toList() }.sorted()

    private fun valuesFiles() = modules.flatMap { module ->
        File(android, "$module/src/main/res").listFiles { file -> file.name.startsWith("values") }.orEmpty().flatMap { it.walk().filter { file -> file.extension == "xml" }.toList() }
    }.sorted()

    @Test fun noScreenWritesItsCopyInKotlin() {
        val offenders = sources().flatMap { file ->
            val path = file.relativeTo(android).invariantSeparatorsPath
            offences(path, file.readText()).map { (line, rule) -> "$path:$line $rule" }
        }
        assertEquals(emptyList<String>(), offenders)
    }

    @Test fun everyAllowedLiteralIsStillThere() {
        val missing = allowed.flatMap { (path, literals) ->
            val text = File(android, path).readText()
            literals.filter { "\"$it\"" !in text }.map { "$path: $it" }
        }
        assertEquals(emptyList<String>(), missing)
    }

    @Test fun noManifestWritesALabelInXml() {
        val offenders = manifests.flatMap { manifest ->
            File(android, manifest).readLines().mapIndexedNotNull { index, line ->
                "$manifest:${index + 1}".takeIf { Regex("""android:(?:label|description)="[^@"]""").containsMatchIn(line) }
            }
        }
        assertEquals(emptyList<String>(), offenders)
    }

    // `%d` and `%f` format in the system's locale; a resource takes a number its own formatter already wrote, as `%1$s`.
    @Test fun noResourceFormatsANumber() {
        val numeric = Regex("""%(?:\d+\$)?[dfeg]""")
        val offenders = valuesFiles().flatMap { file ->
            Regex("""<(?:string|plurals) name="([^"]+)"[^>]*>(.*?)</(?:string|plurals)>""", RegexOption.DOT_MATCHES_ALL).findAll(file.readText())
                .filter { numeric.containsMatchIn(it.groupValues[2]) }.map { it.groupValues[1] }.toList()
        }
        assertEquals(formatsItsNumber, offenders)
    }

    // Each call that names the resource it says: its line, the resources it may say, and how many arguments it gives.
    private fun messages(code: Code): List<Triple<Int, List<String>, Int>> = messageCall.findAll(code.text).mapNotNull { call ->
        val arguments = code.arguments(call.range.last)
        fun listed(at: Int): Int? {
            val argument = arguments.getOrNull(at) ?: return 0
            val list = Regex("""^\s*(?:args\s*=\s*)?listOf\(""").find(code.text.substring(argument)) ?: return null
            return code.arguments(argument.first + list.range.last).size
        }
        val given = when (call.groupValues[1]) {
            "Words.Message" -> listed(1)
            "Words.Counted" -> listed(2)
            "pluralString" -> arguments.size - 2
            else -> arguments.size - 1
        } ?: return@mapNotNull null
        val named = arguments.firstOrNull()?.let { resource.findAll(code.text.substring(it)) }.orEmpty().map { "${it.groupValues[1]}.${it.groupValues[2]}" }.toList()
        Triple(code.line(call.range.first), named, given).takeIf { named.isNotEmpty() }
    }.toList()

    // Too few arguments throw as a message is spelled and none prints `%1$s`; an id held in a variable goes unread.
    @Test fun everyMessageGetsTheArgumentsItsResourceTakes() {
        val takes = valuesFiles().flatMap { file ->
            Regex("""<(string|plurals) name="([^"]+)"[^>]*>(.*?)</\1>""", RegexOption.DOT_MATCHES_ALL).findAll(file.readText()).map { found ->
                val text = found.groupValues[3]
                "${found.groupValues[1]}.${found.groupValues[2]}" to
                    (Regex("""%(\d+)\$""").findAll(text).maxOfOrNull { it.groupValues[1].toInt() } ?: Regex("""(?<!%)%[sd]""").findAll(text).count())
            }.toList()
        }.toMap()
        val mismatches = sources().flatMap { file ->
            val path = file.relativeTo(android).invariantSeparatorsPath
            messages(Code(file.readText())).flatMap { (line, named, given) ->
                named.filter { takes[it] != given }.map { "$path:$line $it takes ${takes[it]}, given $given" }
            }
        }
        assertEquals(emptyList<String>(), mismatches)
    }

    @Test fun theArgumentsAreCountedAsEachCallGivesThem() {
        val calls = listOf(
            "Words.Message(R.string.gym_x, listOf(name, Readout.sets(count)))" to listOf("string.gym_x") to 2,
            "Words.Message(R.string.gym_x, args = listOf(\"a, b\"))" to listOf("string.gym_x") to 1,
            "Words.Counted(R.plurals.gym_y, count, listOf(count.toString()))" to listOf("plurals.gym_y") to 1,
            "Words.Message(if (one) R.string.gym_a else PlatformR.string.platform_b)" to listOf("string.gym_a", "string.platform_b") to 0,
            "stringResource(R.string.gym_x, a, f(b, c))" to listOf("string.gym_x") to 2,
            "pluralString(R.plurals.gym_y, count, count.toString())" to listOf("plurals.gym_y") to 1,
            "failure.says(R.string.gym_x, draft.name)" to listOf("string.gym_x") to 1,
        )
        assertEquals(calls.map { (call, given) -> Triple(1, call.second, given) }, calls.map { messages(Code(it.first.first)).single() })
        assertEquals(emptyList<Triple<Int, List<String>, Int>>(), messages(Code("Words.Message(said, words)\ncontext.getString(key, null)")))
    }

    @Test fun theRulesTellCopyFromCode() {
        val copy = listOf(
            "Text(\"Start workout\")" to listOf("Text", "sentence"),
            "Text(\"\${count} sets\")" to listOf("Text"),
            "Text(if (busy) \"Saving…\" else \"Save\")" to listOf("Text"),
            "Text(pending ?: \"Send code\", style = type)" to listOf("Text", "sentence"),
            "Text(\n    \"Start workout\",\n)" to listOf("Text", "sentence"),
            "Icon(Icons.Filled.Close, contentDescription = \"Close\")" to listOf("contentDescription"),
            "Icon(painterResource(R.drawable.back), \"Back\", Modifier.size(24.dp))" to listOf("Icon description"),
            "GymScreen(title = \"Routines\")" to listOf("copy argument"),
            "DeleteSwipeRow(actionLabel = \"Delete \${routine.name}\")" to listOf("copy argument"),
            "CustomAccessibilityAction(\"Dismiss\") { true }" to listOf("accessibility action"),
            "Toast.makeText(context, \"Copied\", Toast.LENGTH_SHORT)" to listOf("toast"),
            "builder.setContentTitle(\"Workout\")" to listOf("notification"),
            "NotificationChannel(id, \"Workout\", importance)" to listOf("notification channel"),
            "Words.Plain(\"Training notebook\")" to listOf("Plain", "sentence"),
            "pluralStringResource(R.plurals.gym_readout_sets, count, count)" to listOf("plural"),
            "resources.getQuantityString(R.plurals.gym_readout_sets, count)" to listOf("plural"),
            "const val full = \"10 of 10 notes\"" to listOf("sentence"),
            "\"replaced\" -> \"A newer suggestion took its place\"" to listOf("sentence"),
            "transient.showSnackbar(message = \"Saved to your log\")" to listOf("snackbar", "sentence"),
            "ClipData.newPlainText(\"plain text\", link)" to listOf("sentence"),
            "check(ready) { if (late) \"The clock ran out\" else \"Not ready\" }.also { Text(\"Two words\") }" to listOf("Text", "sentence"),
            "val label = \"Saved to log\"" to listOf("copy argument", "sentence"),
            "const val title = \"Saved\"" to listOf("copy argument"),
            "fun pick(x: Int) = when (x) { 1 -> \"Done\"; else -> \"Not yet\" }" to listOf("sentence"),
            "val e = showError(\"Could not save your workout\")" to listOf("sentence"),
            "Text(fieldError(\"Too long for a name\"))" to listOf("sentence"),
            "override fun toString() = \"Your workout\"" to listOf("sentence"),
            "override fun toString(): String {\n    return \"Your workout\"\n}" to listOf("sentence"),
            "val heading = DateTimeFormatter.ofPattern(\"'Today at' HH:mm\")" to listOf("sentence"),
            "Text(stringResource(R.string.x) + \" more words\")" to listOf("Text", "sentence"),
            "Text(if (busy) stringResource(R.string.x) else \"Saving\")" to listOf("Text"),
            "Text(if (busy) \"Saving\" else stringResource(R.string.x))" to listOf("Text"),
            "Text(text = \"Saving\")" to listOf("Text"),
            "Text(\"Saving\")" to listOf("Text"),
            "Text(\"Saving\", style = s)" to listOf("Text"),
            "Text(\n    if (busy) \"Saving\" else \"Saved\"\n)" to listOf("Text"),
            "Words.Plain(\"Saving\")" to listOf("Plain"),
            "Plain(\"Saving\")" to listOf("Plain"),
            "Text(name.ifBlank { \"Untitled\" })" to listOf("Text"),
            "Text(name.ifEmpty { \"Untitled workout\" })" to listOf("Text", "sentence"),
            "val t = rememberInfiniteTransition(label = \"Workout timer\"); Text(\"Rest is over\")" to listOf("Text", "sentence"),
            "Button(onClick = {}) { Text(\"Start\") }" to listOf("Text"),
            "Text(\"\"\"Start workout\"\"\")" to listOf("Text", "sentence"),
            "Text(\"\"\"\n    Start workout\n\"\"\".trimIndent())" to listOf("Text", "sentence"),
            "AlertDialog(title = { Text(\"Delete?\") })" to listOf("Text"),
            "snackbar.showSnackbar(\"Saved\")" to listOf("snackbar"),
            "snackbar.showSnackbar(\"Set saved\")" to listOf("snackbar", "sentence"),
            "SemanticsProperties.ContentDescription to listOf(\"Close\")" to listOf("contentDescription", "word table"),
            "Modifier.semantics { contentDescription = \"Close\" }" to listOf("contentDescription"),
            "Modifier.semantics { stateDescription = \"Selected\" }" to listOf("copy argument"),
            "Modifier.semantics { onClick(label = \"Open\") { true } }" to listOf("copy argument"),
            "Modifier.clickable(onClickLabel = \"Open\") {}" to listOf("copy argument"),
            "Modifier.clearAndSetSemantics { contentDescription = \"Set 1 of 3\" }" to listOf("contentDescription", "sentence"),
            "drawText(measurer, \"Sun\")" to listOf("drawText"),
            "drawText(measurer, \"Sun 3 Nov\")" to listOf("drawText", "sentence"),
            "val days = listOf(\"Sun\", \"Mon\")" to listOf("word table"),
            "telemetry.failure(\"op\", IOException(\"x\")); Text(\"Two words\")" to listOf("Text", "sentence"),
            "failure(\"Could not save your workout\")" to listOf("sentence"),
            "Text(error ?: \"Could not save\")" to listOf("Text", "sentence"),
            "Text(problem?.text() ?: \"Could not save\")" to listOf("Text", "sentence"),
            "Text(\"\${name} saved\")" to listOf("Text"),
            "Text(\"\$name saved\")" to listOf("Text"),
            "Text(\"Saved \$name\")" to listOf("Text"),
            "Icon(Icons.Default.Close, null); Text(\"Close it\")" to listOf("Text", "sentence"),
            "Icon(Icons.Default.Close, if (x) \"Close\" else \"Back\")" to listOf("Icon description"),
            "IconButton(onClick = {}) { Icon(Icons.Default.Close, contentDescription = if (open) \"Close\" else \"Open\") }" to listOf("contentDescription"),
            "ListItem(headlineContent = { Text(\"Workout\") })" to listOf("Text"),
            "TextField(value, {}, placeholder = { Text(\"Name it\") })" to listOf("Text", "sentence"),
            "TextField(value, {}, label = { Text(\"Name\") })" to listOf("Text"),
            "Tab(text = { Text(\"Log\") })" to listOf("Text"),
            "NotificationCompat.Builder(c, id).setContentTitle(if (x) \"Workout\" else \"Rest\")" to listOf("notification"),
            "AppWidgetText(\"Workout running\")" to listOf("sentence"),
            "tile.label = \"Workout\"" to listOf("copy argument"),
            "tile.subtitle = \"Running\"" to listOf("copy argument"),
            "shortcut.setShortLabel(\"Start\")" to listOf("shortcut"),
            "ShortcutInfo.Builder(c, id).setShortLabel(\"Start workout\")" to listOf("shortcut", "sentence"),
            "Intent.createChooser(intent, \"Share workout\")" to listOf("share sheet", "sentence"),
            "Intent.createChooser(intent, \"Share\")" to listOf("share sheet"),
            "putExtra(Intent.EXTRA_TEXT, \"Look at my workout\")" to listOf("share sheet", "sentence"),
            "putExtra(Intent.EXTRA_SUBJECT, \"Workout\")" to listOf("share sheet"),
        )
        val code = listOf(
            "Text(stringResource(R.string.gym_routines_start))",
            "Text(\"\${index + 1}\", style = GymType.numeral)",
            "Text(\"\$name · \${Readout.date(at)}\")",
            "Modifier.testTag(\"routine sheet\")",
            "val scale by animateFloatAsState(1f, label = \"Delete threshold\")",
            "val breath by transition.animateFloat(0f,\n    1f, label = \"Crown breath\")",
            "Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.testTag(\"close\"))",
            "telemetry.event(\"gym_set_logged\", mapOf(\"door\" to \"rack\"))",
            "telemetry.failure(\"onboarding_storage\", IOException(\"Onboarding storage unavailable\"))",
            "check(user.id == account) {\n    \"The account changed.\"\n}",
            "require(bytes.size > 4) { \"Sealed session is incomplete\" }",
            "Log.e(\"WindmillTelemetry\", \"Crash reporting unavailable\")",
            "DateTimeFormatter.ofPattern(if (sameYear) \"d MMM\" else \"d MMM yy\", Locale.getDefault())",
            "private val heading = Regex(\"\"\"(#{1,3}) (.*)\"\"\")",
            "Text(it, style = type) // Text(\"Start workout\")",
            "val quote = '\"'; Text(stringResource(R.string.gym_quote))",
            "private data class LogPreviewState(val name: String = \"Push Day\")",
            // An exception's message is a diagnostic, built or thrown; it never reaches a screen.
            "val failed = IllegalStateException(\"Could not save\")",
            "throw DecodeError(type, \"role\", \"not a role\")",
            "override fun toString() = \"StatsProgress(asOf=\$asOf, sessions=\$sessions)\"",
            "val choices = listOf(\"barbell\", \"dumbbell\", \"other\")",
            "contentDescription = if (title == \"close\") closing else opening",
        )
        assertEquals(copy.map { it.second } + code.map { emptyList<String>() }, (copy.map { it.first } + code).map { snippet -> offences("snippet.kt", snippet).map { it.second } })
    }
}
