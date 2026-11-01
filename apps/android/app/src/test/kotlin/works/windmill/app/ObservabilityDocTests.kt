package works.windmill.app

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.telemetry.GymActions
import works.windmill.gym.telemetry.GymEvents
import works.windmill.platform.telemetry.EventSchemas
import works.windmill.platform.telemetry.LabelSchema

// docs/ANDROID_OBSERVABILITY.md against the code: every operation and event the app names has a row, every row names
// something the code still sends, and the gym_action table is GymActions.
class ObservabilityDocTests {
    private val android = File(checkNotNull(System.getProperty("windmill.android")))
    private val doc = File(checkNotNull(System.getProperty("windmill.observabilityDoc"))).readLines()
    private val sources = listOf("app", "platform", "gym")
        .flatMap { module -> File(android, "$module/src/main/kotlin").walk().filter { it.extension == "kt" }.map { it.readText() }.toList() }

    // The rows of the table whose header starts with `header`: each row's cells, backticks and all.
    private fun table(header: String): List<List<String>> = doc
        .dropWhile { !it.startsWith("| $header |") }.drop(2)
        .takeWhile { it.startsWith("|") }
        .map { row -> row.trim('|').split(" | ").map(String::trim) }

    private fun named(cell: String) = cell.removeSurrounding("`")

    private fun ticked(cell: String) = Regex("`([^`]+)`").findAll(cell).map { it.groupValues[1] }.toSet()

    private fun literals(vararg patterns: String): Set<String> = sources.flatMap { text ->
        patterns.flatMap { pattern -> Regex(pattern).findAll(text).map { it.groupValues[1] }.toList() }
    }.map { it.replace(Regex("""\$\{[^}]+}"""), "<>") }.toSet()

    // A row's `<placeholder>` stands for a string template in the code.
    private fun inSources(name: String): Boolean {
        val literal = Regex("\"" + name.split(Regex("<[a-z]+>")).joinToString("""\$\{[^}]+}""") { Regex.escape(it) } + "\"")
        return sources.any { literal.containsMatchIn(it) }
    }

    @Test fun everyFailureOperationHasARowAndEveryRowIsStillReported() {
        val rows = table("Operation").map { named(it[0]) }
        val reported = literals(
            """\b(?:failure|reportFailure|unexpected|capture|tried|withKey)\(\s*"([^"]+)"""",
            """\breport\(\s*\w+,\s*"([^"]+)"""",
            """\boperation(?:: String)?\s*=\s*"([^"]+)"""",
        )
        assertEquals(emptySet<String>(), reported - rows.map { it.replace(Regex("<[a-z]+>"), "<>") }.toSet())
        assertEquals(emptyList<String>(), rows.filterNot(::inSources))
    }

    @Test fun everyEventHasARowAndEveryRowIsStillSent() {
        val rows = table("Event").map { named(it[0]) }
        val registered = (EventSchemas.platform + GymEvents.schemas).events.keys
        assertEquals(emptySet<String>(), literals("""\bevent\(\s*"([^"]+)"""") + registered - rows.toSet())
        assertEquals(emptyList<String>(), rows.filterNot(::inSources))
    }

    @Test fun everyRegisteredLabelIsListedInItsEventsRow() {
        val rows = table("Event").associate { named(it[0]) to ticked(it[2]) }
        val missing = (EventSchemas.platform + GymEvents.schemas).events.flatMap { (name, schema) ->
            (schema as? LabelSchema)?.values?.values?.flatten().orEmpty().filter { it !in rows[name].orEmpty() }.map { "$name: $it" }
        }
        assertEquals(emptyList<String>(), missing)
    }

    @Test fun theGymActionTableIsTheRegisteredSchema() {
        val documented = table("Screen").map { cells ->
            listOf(named(cells[0]), named(cells[1]), ticked(cells[2]).sorted().joinToString(","), cells.getOrElse(3) { "" })
        }.sortedBy { it.take(2).joinToString("/") }
        val registered = GymActions.screens.flatMap { (screen, actions) ->
            actions.map { (action, outcomes) ->
                listOf(screen, action, outcomes.sorted().joinToString(","), if (action in GymActions.asking[screen].orEmpty()) "yes" else "")
            }
        }.sortedBy { it.take(2).joinToString("/") }
        assertEquals(registered, documented)
    }
}
