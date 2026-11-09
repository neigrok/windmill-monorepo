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

    private val literal = """"(?:[^"\\\n]|\\.)*[A-Za-z](?:[^"\\\n]|\\.)*""""
    private val rules = mapOf(
        "Text" to Regex("""\bText\(\s*(?:text\s*=\s*)?$literal"""),
        "Text branch" to Regex("""\bText\(\s*if\s*\([^"\n]*\)\s*$literal"""),
        "Text fallback" to Regex("""\bText\([^"()\n]*\?:\s*$literal"""),
        "contentDescription" to Regex("""\bcontentDescription\s*=\s*$literal"""),
        "Icon description" to Regex("""\bIcon\((?:[^,()"\n]|\([^()\n]*\))+,\s*$literal"""),
        "copy argument" to Regex("""\b(?:label|title|placeholder|description|stateDescription|\w+Label)\s*=\s*$literal"""),
        "accessibility action" to Regex("""\bCustomAccessibilityAction\(\s*$literal"""),
        "toast" to Regex("""\bToast\.makeText\([^,\n]+,\s*$literal"""),
        "notification" to Regex("""\.set(?:ContentTitle|ContentText|SubText|Ticker)\(\s*$literal"""),
        "notification channel" to Regex("""\bNotificationChannel\([^,\n]+,\s*$literal"""),
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
    private val messageCall = Regex("""\b(Words\.Message|Words\.Counted|stringResource|pluralString|getString|says)\(""")
    private val resource = Regex("""\b\w*R\.(string|plurals)\.(\w+)""")

    // A Kotlin source read as code: comments dropped, a template read as `0` since a value is not copy, raw strings plain, line breaks kept.
    private inner class Code(source: String) {
        val text = read(source)
        private val skeleton = text.replace(string) { "\"" + " ".repeat(it.value.length - 2) + "\"" }

        fun line(at: Int) = text.substring(0, at).count { it == '\n' } + 1

        // The call a position stands in, past a lambda's arguments; `toString` for what a `toString` returns.
        fun caller(at: Int): String {
            if (Regex("""\bfun toString\(\)""").containsMatchIn(text.substring(text.lastIndexOf('\n', at - 1) + 1, at))) return "toString"
            var open = opener(at - 1)
            if (open < 0) return ""
            if (skeleton[open] == '{') {
                val before = skeleton.substring(0, open).trimEnd()
                open = if (before.endsWith(')')) opener(before.length - 2) else before.length
                if (open < 0) return ""
            }
            return Regex("""[\w.]+$""").find(skeleton.substring(maxOf(0, open - 120), open).trimEnd())?.value?.removePrefix(".").orEmpty()
        }

        fun calledBy(at: Int, names: Regex) = caller(at).let { names.matches(it.substringAfterLast('.')) || names.matches(it) }

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
        val shaped = rules.flatMap { (name, rule) ->
            rule.findAll(code.text).filter { match ->
                match.range.first < previewsFrom && !(name == "copy argument" && code.calledBy(match.range.first, animation)) && !(name == "plural" && path == words)
            }.map { code.line(it.range.first) to name }.toList()
        }
        val said = string.findAll(code.text).filter { match ->
            val text = match.value.substring(1, match.value.length - 1)
            match.range.first < previewsFrom && sentence.containsMatchIn(text) && text !in allowed[path].orEmpty() &&
                !code.calledBy(match.range.first, unread) && !code.calledBy(match.range.first, animation)
        }.map { code.line(it.range.first) to "sentence" }.toList()
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
