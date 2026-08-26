package works.windmill.gym.ui

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// TalkBack announces a `clickable` with no `Role` as text with an activate hint, never as a button,
// so the rule is every one of them carries a role. It is a source rule and this is the grep that
// keeps it: the guarded form `clickable(enabled = …) { … }` is the one that got past a narrower one.
class ClickableRoleTests {
    private val trees = listOf("gym/src/main", "platform/src/main")

    private fun root(): File {
        var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (directory != null) {
            if (File(directory, "gym/src/main").isDirectory && File(directory, "platform/src/main").isDirectory) {
                return directory
            }
            directory = directory.parentFile
        }
        throw AssertionError("the android source trees were not found from ${System.getProperty("user.dir")}")
    }

    // `.clickable(` opens the argument list; a role may be on that line or on one of the few that
    // follow, before the list closes.
    private fun rolelessSites(source: File): List<String> {
        val lines = source.readLines()
        return lines.indices.filter { at ->
            lines[at].contains(".clickable(") &&
                lines.subList(at, minOf(at + 8, lines.size)).none { it.contains("role = Role.") }
        }.map { "${source.name}:${it + 1}" }
    }

    @Test
    fun testEveryClickableInTheRoomDeclaresItsRole() {
        val base = root()
        val sources = trees.flatMap { File(base, it).walkTopDown().filter { file -> file.extension == "kt" } }
        assertTrue("no Kotlin sources were scanned", sources.count() > 20)

        assertEquals(emptyList<String>(), sources.flatMap { rolelessSites(it) }.sorted())
    }
}
