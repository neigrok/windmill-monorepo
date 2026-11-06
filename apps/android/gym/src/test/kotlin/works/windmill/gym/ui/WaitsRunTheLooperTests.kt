package works.windmill.gym.ui

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// On Robolectric the test holds the main thread and `waitUntil` only sleeps on it, so a condition that does not idle the main looper waits on work that can never run.
class WaitsRunTheLooperTests {
    private val trees = listOf("app/src/test", "gym/src/test", "platform/src/test")
    private val idlers = listOf("runOnIdle", "waitForIdle", ".idle()", "onNode", "onAllNodes", "onRoot")

    private fun root(): File {
        var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (directory != null) {
            if (trees.all { File(directory, it).isDirectory }) return directory
            directory = directory.parentFile
        }
        throw AssertionError("the android test trees were not found from ${System.getProperty("user.dir")}")
    }

    private fun closingBrace(text: String, opening: Int): Int {
        var depth = 0
        for (at in opening until text.length) {
            if (text[at] == '{') depth += 1
            if (text[at] == '}' && --depth == 0) return at
        }
        throw AssertionError("a wait's condition never closes")
    }

    private fun silentWaits(source: File): List<String> {
        val text = source.readText()
        return Regex("""waitUntil\([^{]*\)\s*\{""").findAll(text).filter { wait ->
            val condition = text.substring(wait.range.last, closingBrace(text, wait.range.last))
            idlers.none { it in condition }
        }.map { "${source.name}:${text.substring(0, it.range.first).count { char -> char == '\n' } + 1}" }.toList()
    }

    @Test fun everyWaitsConditionIdlesTheMainLooper() {
        val base = root()
        val sources = trees.flatMap { File(base, it).walkTopDown().filter { file -> file.extension == "kt" } }
        assertTrue("no Kotlin tests were scanned", sources.count() > 100)

        assertEquals(emptyList<String>(), sources.flatMap { silentWaits(it) }.sorted())
    }
}
