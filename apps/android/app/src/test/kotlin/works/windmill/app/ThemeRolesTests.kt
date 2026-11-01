package works.windmill.app

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

// Screens read type and colour through the theme's roles. A type size or a hex colour is written only where the roles
// are defined, and the other rooms' hues only in the onboarding's glimpse palette.
class ThemeRolesTests {
    private val android = File(checkNotNull(System.getProperty("windmill.android")))
    private val sources = listOf("app/src/main", "app/src/debug", "platform/src/main", "gym/src/main", "gym/src/debug")
        .flatMap { root -> File(android, "$root/kotlin").walk().filter { it.extension == "kt" }.toList() }

    private fun offenders(pattern: Regex, allowed: (File, Int) -> Boolean): List<String> = sources.flatMap { file ->
        file.readLines().mapIndexedNotNull { index, line ->
            "${file.name}:${index + 1}".takeIf { pattern.containsMatchIn(line) && !allowed(file, index) }
        }
    }

    // The lines of the glimpse palette class, from its header to its closing brace.
    private fun glimpsePalette(file: File): IntRange {
        val lines = file.readLines()
        val start = lines.indexOfFirst { it.startsWith("internal class GlimpsePalette(") }
        return start..(start + lines.drop(start).indexOfFirst { it == "}" })
    }

    @Test fun noScreenWritesATypeSizeOrBuildsAFace() {
        val typeRoles = setOf("Tokens.kt", "GymType.kt")
        val size = Regex("""(?<![\w.])(\d+(\.\d+)?|\.\d+)\.sp\b|WindmillFont\.""")
        assertEquals(emptyList<String>(), offenders(size) { file, _ -> file.name in typeRoles })
    }

    @Test fun noScreenWritesAHexColour() {
        val colourRoles = setOf("Tokens.kt", "WindmillMaterial.kt", "GymSkin.kt")
        val glimpses = sources.single { it.name == "OnboardingGlimpses.kt" }
        val palette = glimpsePalette(glimpses)
        assertEquals(emptyList<String>(), offenders(Regex("""Color\(0x""")) { file, line ->
            file.name in colourRoles || file == glimpses && line in palette
        })
    }
}
