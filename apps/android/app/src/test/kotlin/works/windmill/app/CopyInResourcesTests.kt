package works.windmill.app

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

// Words a person reads come from string resources. A literal with a letter where a screen, a manifest or a notification
// takes its copy fails here; `sources` lists the roots the rule reads.
class CopyInResourcesTests {
    private val android = File(checkNotNull(System.getProperty("windmill.android")))
    private val sources = listOf(
        "app/src/main/kotlin",
        "platform/src/main/kotlin",
        "gym/src/main/kotlin",
    )
    private val manifests = listOf("app/src/main/AndroidManifest.xml", "gym/src/main/AndroidManifest.xml")

    // "Crown breath" names an animation whose call starts on the line above.
    private val allowed = mapOf(
        "gym/src/main/kotlin/works/windmill/gym/ui/onboarding/OnboardingGlimpses.kt" to listOf("label = \"Crown breath\""),
    )

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
    )
    // An animation's label names it in the layout inspector; nobody reads it on screen.
    private val animation = Regex("""\b(?:rememberInfiniteTransition|updateTransition|animate\w*|Crossfade|AnimatedContent)\(""")

    // The line without its comment, each string template inside a literal read as `0`: a value is not copy.
    private fun code(line: String): String = buildString {
        var quoted = false
        var index = 0
        while (index < line.length) {
            val char = line[index]
            if (quoted && char == '\\') { append(line, index, minOf(index + 2, line.length)); index += 2; continue }
            if (quoted && char == '$' && line.getOrNull(index + 1) == '{') {
                var depth = 0
                index++
                do {
                    if (line[index] == '{') depth++
                    if (line[index] == '}') depth--
                    index++
                } while (index < line.length && depth > 0)
                append('0'); continue
            }
            if (quoted && char == '$' && line.getOrNull(index + 1)?.let { it.isLetter() || it == '_' } == true) {
                index++
                while (index < line.length && (line[index].isLetterOrDigit() || line[index] == '_')) index++
                append('0'); continue
            }
            if (char == '"') quoted = !quoted
            if (!quoted && line.startsWith("//", index)) return@buildString
            append(char)
            index++
        }
    }

    private fun offences(line: String): List<String> = code(line).let { code ->
        rules.filter { (name, rule) -> rule.containsMatchIn(code) && !(name == "copy argument" && animation.containsMatchIn(code)) }.keys.toList()
    }

    @Test fun noScreenWritesItsCopyInKotlin() {
        val files = sources.flatMap { root -> File(android, root).walk().filter { it.extension == "kt" }.toList() }.sorted()
        val offenders = files.flatMap { file ->
            val path = file.relativeTo(android).invariantSeparatorsPath
            file.readLines().flatMapIndexed { index, line ->
                if (allowed[path].orEmpty().any { it in line }) emptyList()
                else offences(line).map { rule -> "$path:${index + 1} $rule" }
            }
        }
        assertEquals(emptyList<String>(), offenders)
    }

    @Test fun everyAllowedLineIsStillThere() {
        val missing = allowed.flatMap { (path, lines) ->
            val text = File(android, path).readText()
            lines.filter { it !in text }.map { "$path: $it" }
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

    @Test fun theRulesTellCopyFromCode() {
        val copy = listOf(
            "Text(\"Start workout\")" to "Text",
            "Text(\"\${count} sets\")" to "Text",
            "Text(if (busy) \"Saving…\" else \"Save\")" to "Text branch",
            "Text(pending ?: \"Send code\", style = type)" to "Text fallback",
            "Icon(Icons.Filled.Close, contentDescription = \"Close\")" to "contentDescription",
            "Icon(painterResource(R.drawable.back), \"Back\", Modifier.size(24.dp))" to "Icon description",
            "GymScreen(title = \"Routines\")" to "copy argument",
            "DeleteSwipeRow(actionLabel = \"Delete \${routine.name}\")" to "copy argument",
            "CustomAccessibilityAction(\"Dismiss\") { true }" to "accessibility action",
            "Toast.makeText(context, \"Copied\", Toast.LENGTH_SHORT)" to "toast",
            "builder.setContentTitle(\"Workout\")" to "notification",
            "NotificationChannel(id, \"Workout\", importance)" to "notification channel",
        )
        val code = listOf(
            "Text(stringResource(R.string.gym_routines_start))",
            "Text(\"\${index + 1}\", style = GymType.numeral)",
            "Text(\"\$name · \${Readout.date(at)}\")",
            "Modifier.testTag(\"routine-sheet\")",
            "val scale by animateFloatAsState(1f, label = \"Delete threshold\")",
            "Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.testTag(\"close\"))",
            "telemetry.event(\"gym_set_logged\", mapOf(\"door\" to \"rack\"))",
            "Text(it, style = type) // Text(\"Start workout\")",
        )
        assertEquals(copy.map { listOf(it.second) } + code.map { emptyList<String>() }, (copy.map { it.first } + code).map(::offences))
    }
}
