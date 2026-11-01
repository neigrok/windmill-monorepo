package works.windmill.app

import androidx.compose.ui.graphics.Color
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.ui.GymSkin

// Screens read type and colour through the theme's roles. A type size or a hex colour is written only where the roles
// are defined, and the other rooms' hues only in the onboarding's glimpse palette.
class ThemeRolesTests {
    private val android = File(checkNotNull(System.getProperty("windmill.android")))
    private val sources = listOf("app/src/main", "app/src/debug", "platform/src/main", "gym/src/main", "gym/src/debug")
        .flatMap { root -> File(android, "$root/kotlin").walk().filter { it.extension == "kt" }.toList() }
    private val typeRoles = setOf(
        "platform/src/main/kotlin/works/windmill/platform/design/Tokens.kt",
        "gym/src/main/kotlin/works/windmill/gym/ui/GymType.kt",
    )
    private val colourRoles = setOf(
        "platform/src/main/kotlin/works/windmill/platform/design/Tokens.kt",
        "platform/src/main/kotlin/works/windmill/platform/design/WindmillMaterial.kt",
        "gym/src/main/kotlin/works/windmill/gym/ui/GymSkin.kt",
    )
    private val glimpses = "gym/src/main/kotlin/works/windmill/gym/ui/onboarding/OnboardingGlimpses.kt"

    private fun path(file: File) = file.relativeTo(android).invariantSeparatorsPath

    private fun offenders(pattern: Regex, allowed: (String, Int) -> Boolean): List<String> = sources.flatMap { file ->
        file.readLines().mapIndexedNotNull { index, line ->
            "${path(file)}:${index + 1}".takeIf {
                !line.startsWith("import ") && pattern.containsMatchIn(line) && !allowed(path(file), index)
            }
        }
    }

    // The lines of the glimpse palette class, from its header to its closing brace.
    private fun glimpsePalette(): IntRange {
        val lines = File(android, glimpses).readLines()
        val start = lines.indexOfFirst { it.startsWith("internal class GlimpsePalette(") }
        return start..(start + lines.drop(start).indexOfFirst { it == "}" })
    }

    @Test fun noScreenWritesATypeSizeOrBuildsAFace() {
        val literal = Regex("""(?<![\w.])(\d+(\.\d+)?|\.\d+)\.(sp|em)\b|WindmillFont\.""")
        assertEquals(emptyList<String>(), offenders(literal) { file, _ -> file in typeRoles })
    }

    // A size computed from a role stays in the type files. The glimpses draw their specimens at their own fixed scale,
    // so their text helper turns its integer sizes into sp.
    @Test fun noScreenTurnsANumberIntoASize() {
        val computed = Regex("""[\w)\]]\.(sp|em)\b""")
        assertEquals(emptyList<String>(), offenders(computed) { file, _ -> file in typeRoles || file == glimpses })
    }

    @Test fun noScreenWritesAHexColour() {
        val palette = glimpsePalette()
        assertEquals(emptyList<String>(), offenders(Regex("""Color\(0x""")) { file, line ->
            file in colourRoles || file == glimpses && line in palette
        })
    }

    // The window behind the first frame is the gym canvas, written again in resources for the system to draw before
    // Compose does; the two must not drift.
    @Test fun theWindowGroundIsTheCanvasInBothModes() {
        fun ground(values: String): Color {
            val xml = File(android, "app/src/main/res/$values/colors.xml").readText()
            val hex = checkNotNull(Regex("""name="window_ground">#([0-9A-Fa-f]{6})<""").find(xml)).groupValues[1]
            return Color(0xFF000000 or hex.toLong(16))
        }
        assertEquals(listOf(GymSkin.Daylight.canvas, GymSkin.Instrument.canvas), listOf(ground("values"), ground("values-night")))
    }
}
