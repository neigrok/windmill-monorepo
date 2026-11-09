package works.windmill.app

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

// Words a person reads come from string resources, and each message gets the arguments its resource asks for. Every
// rule reads `modules`' main Kotlin as code: comments dropped, each string template read as `0`, since a value is not copy.
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
    // TalkBack's page label formats its own digit, as it did before resources held it; the owner keeps it so.
    private val formatsItsNumber = listOf("onboarding_page")

    private val literal = """"(?:[^"\\\n]|\\.)*[A-Za-z](?:[^"\\\n]|\\.)*""""
    private val rules = mapOf(
        "Text" to Regex("""\bText\(\s*(?:text\s*=\s*)?$literal"""),
        "Text branch" to Regex("""\bText\(\s*if\s*\([^"]*\)\s*$literal"""),
        "Text fallback" to Regex("""\bText\([^"()]*\?:\s*$literal"""),
        "contentDescription" to Regex("""\bcontentDescription\s*=\s*$literal"""),
        "Icon description" to Regex("""\bIcon\((?:[^,()"]|\([^()]*\))+,\s*$literal"""),
        "copy argument" to Regex("""\b(?:label|title|placeholder|description|stateDescription|\w+Label)\s*=\s*$literal"""),
        "accessibility action" to Regex("""\bCustomAccessibilityAction\(\s*$literal"""),
        "toast" to Regex("""\bToast\.makeText\([^,]+,\s*$literal"""),
        "notification" to Regex("""\.set(?:ContentTitle|ContentText|SubText|Ticker)\(\s*$literal"""),
        "notification channel" to Regex("""\bNotificationChannel\([^,]+,\s*$literal"""),
        "Plain" to Regex("""\bPlain\(\s*$literal"""),
        "plural" to Regex("""\b(?:pluralStringResource|getQuantityString)\("""),
    )
    private val string = Regex(""""(?:[^"\\\n]|\\.)*"""")
    private val sentence = Regex("""\p{L}+[^\p{L}]*\s[^\p{L}]*\p{L}""")
    // An animation's label names it in the layout inspector; nobody reads it on screen.
    private val animation = Regex("""^(?:rememberInfiniteTransition|updateTransition|animate\w*|Crossfade|AnimatedContent)$""")
    // A literal handed to one of these, or a `toString`, is read by a developer, a test or a parser, never by the person holding the phone.
    private val unread = Regex("""^(?:check|checkNotNull|require|requireNotNull|error|testTag|Regex|ofPattern|failure|toString|Log\.\w+|\w*Exception|\w*Error)$""")
    // A file's previews, their state and their data close it, from its first private declaration named for a preview.
    private val previews = Regex("""^private (?:data )?(?:class|object|val|fun) \w*[Pp]review""", RegexOption.MULTILINE)

    // The source without its comments, each string template inside a literal read as `0`, each raw string read as a
    // plain one and each character literal as `' '`; every line break stays where it was.
    private fun code(source: String): String = buildString {
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

    // The call a position stands in: the name before the bracket that opens around it, or before a lambda's arguments;
    // `toString` for the text a `toString` returns.
    private fun caller(code: String, skeleton: String, at: Int): String {
        if (Regex("""\bfun toString\(\)""").containsMatchIn(code.substring(code.lastIndexOf('\n', at - 1) + 1, at))) return "toString"
        fun opener(from: Int): Int {
            var depth = 0
            var index = from
            while (index >= 0) {
                when (skeleton[index]) {
                    ')', ']', '}' -> depth++
                    '(', '[', '{' -> if (depth == 0) return index else depth--
                }
                index--
            }
            return -1
        }
        var open = opener(at - 1)
        if (open < 0) return ""
        if (skeleton[open] == '{') {
            val before = skeleton.substring(0, open).trimEnd()
            open = if (before.endsWith(')')) opener(before.length - 2) else before.length
            if (open < 0) return ""
        }
        return Regex("""[\w.]+$""").find(skeleton.substring(maxOf(0, open - 120), open).trimEnd())?.value?.removePrefix(".").orEmpty()
    }

    private fun offences(path: String, source: String): List<Pair<Int, String>> {
        val code = code(source)
        val skeleton = code.replace(string) { "\"" + " ".repeat(it.value.length - 2) + "\"" }
        fun line(at: Int) = code.substring(0, at).count { it == '\n' } + 1
        fun calledBy(at: Int, names: Regex) = caller(code, skeleton, at).let { names.matches(it.substringAfterLast('.')) || names.matches(it) }
        val previewsFrom = previews.find(code)?.range?.first ?: code.length
        val shaped = rules.flatMap { (name, rule) ->
            rule.findAll(code).filter { match ->
                match.range.first < previewsFrom && !(name == "copy argument" && calledBy(match.range.first, animation)) && !(name == "plural" && path == words)
            }.map { line(it.range.first) to name }.toList()
        }
        val said = string.findAll(code).filter { match ->
            val text = match.value.substring(1, match.value.length - 1)
            match.range.first < previewsFrom && sentence.containsMatchIn(text) && text !in allowed[path].orEmpty() &&
                !calledBy(match.range.first, unread) && !calledBy(match.range.first, animation)
        }.map { line(it.range.first) to "sentence" }.toList()
        return (shaped + said).distinct().sortedBy { it.first }
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

    // A message given fewer arguments than its resource takes throws as it is spelled, and one given none prints `%1$s`.
    // Read wherever the call names its resource; a resource id handed in through a variable is not read.
    @Test fun everyMessageGetsTheArgumentsItsResourceTakes() {
        val takes = valuesFiles().flatMap { file ->
            Regex("""<(string|plurals) name="([^"]+)"[^>]*>(.*?)</\1>""", RegexOption.DOT_MATCHES_ALL).findAll(file.readText()).map { resource ->
                val text = resource.groupValues[3]
                "${resource.groupValues[1]}.${resource.groupValues[2]}" to
                    (Regex("""%(\d+)\$""").findAll(text).maxOfOrNull { it.groupValues[1].toInt() } ?: Regex("""(?<!%)%[sd]""").findAll(text).count())
            }.toList()
        }.toMap()
        val calls = Regex("""\b(Words\.Message|Words\.Counted|stringResource|pluralString|getString|says)\(""")
        val mismatches = sources().flatMap { file ->
            val path = file.relativeTo(android).invariantSeparatorsPath
            val code = code(file.readText())
            val skeleton = code.replace(string) { "\"" + " ".repeat(it.value.length - 2) + "\"" }
            calls.findAll(code).flatMap { call ->
                val arguments = arguments(skeleton, call.range.last).map { code.substring(it).trim().removePrefix("args =").trim() }
                val named = Regex("""\b\w*R\.(string|plurals)\.(\w+)""").findAll(arguments.firstOrNull().orEmpty()).map { "${it.groupValues[1]}.${it.groupValues[2]}" }
                fun listed(argument: String?) = when {
                    argument == null -> 0
                    argument.startsWith("listOf(") -> arguments(argument.replace(string) { "\"" + " ".repeat(it.value.length - 2) + "\"" }, "listOf".length).size
                    else -> null
                }
                val given = when (call.groupValues[1]) {
                    "Words.Message" -> listed(arguments.getOrNull(1))
                    "Words.Counted" -> listed(arguments.getOrNull(2))
                    "pluralString" -> arguments.size - 2
                    else -> arguments.size - 1
                }
                named.filter { given != null && takes[it] != given }.map { "$path:${code.substring(0, call.range.first).count { it == '\n' } + 1} $it takes ${takes[it]}, given $given" }
            }.toList()
        }
        assertEquals(emptyList<String>(), mismatches)
    }

    // The ranges of a call's arguments, split where the bracket opened at `open` holds a comma of its own.
    private fun arguments(skeleton: String, open: Int): List<IntRange> {
        val ranges = mutableListOf<IntRange>()
        var depth = 0
        var start = open + 1
        for (index in open + 1 until skeleton.length) {
            when (skeleton[index]) {
                '(', '[', '{' -> depth++
                ')', ']', '}' -> if (depth == 0) {
                    if (skeleton.substring(start, index).isNotBlank()) ranges += start until index
                    return ranges
                } else depth--
                ',' -> if (depth == 0) { ranges += start until index; start = index + 1 }
            }
        }
        return ranges
    }

    @Test fun theRulesTellCopyFromCode() {
        val copy = listOf(
            "Text(\"Start workout\")" to listOf("Text", "sentence"),
            "Text(\"\${count} sets\")" to listOf("Text"),
            "Text(if (busy) \"Saving…\" else \"Save\")" to listOf("Text branch"),
            "Text(pending ?: \"Send code\", style = type)" to listOf("Text fallback", "sentence"),
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
            "transient.showSnackbar(message = \"Saved to your log\")" to listOf("sentence"),
            "ClipData.newPlainText(\"plain text\", link)" to listOf("sentence"),
            "check(ready) { if (late) \"The clock ran out\" else \"Not ready\" }.also { Text(\"Two words\") }" to listOf("Text", "sentence"),
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
        )
        assertEquals(
            copy.map { it.second } + code.map { emptyList<String>() },
            (copy.map { it.first } + code).map { snippet -> offences("snippet.kt", snippet).map { it.second } },
        )
    }
}
