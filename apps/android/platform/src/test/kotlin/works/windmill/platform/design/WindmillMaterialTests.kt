package works.windmill.platform.design

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WindmillMaterialTests {
    private val dark = windmillColorScheme(dark = true)
    private val light = windmillColorScheme(dark = false)

    @Test
    fun theDragHandleReadsTheFamilysQuietInk() {
        assertEquals(WindmillColor.textTertiary.dark, dark.onSurfaceVariant)
        assertEquals(WindmillColor.textTertiary.light, light.onSurfaceVariant)
    }

    @Test
    fun everySlotAMaterialSurfaceReadsIsAFamilyColour() {
        val family = WindmillColor.run {
            listOf(
                neutral0, neutral25, neutral50, neutral100, neutral200, neutral300,
                neutral400, neutral500, neutral600, neutral700, neutral800, neutral900,
            )
        }
        val ours = family.map { it.dark }.toSet() +
            family.map { it.light }.toSet() +
            setOf(WindmillColor.gold400, WindmillColor.olive400, WindmillColor.olive500,
                  WindmillColor.onAccent, Color.Black)

        for ((skin, scheme) in listOf("dark" to dark, "light" to light)) {
            val drawn = mapOf(
                "background" to scheme.background,
                "onBackground" to scheme.onBackground,
                "surface" to scheme.surface,
                "onSurface" to scheme.onSurface,
                "surfaceVariant" to scheme.surfaceVariant,
                "onSurfaceVariant" to scheme.onSurfaceVariant,
                "surfaceContainerLow" to scheme.surfaceContainerLow,
                "surfaceContainer" to scheme.surfaceContainer,
                "surfaceContainerHigh" to scheme.surfaceContainerHigh,
                "outline" to scheme.outline,
                "outlineVariant" to scheme.outlineVariant,
                "primary" to scheme.primary,
                "onPrimary" to scheme.onPrimary,
                "scrim" to scheme.scrim,
            )
            for ((slot, colour) in drawn) {
                assertTrue("$skin scheme's $slot is not a Windmill colour: $colour", colour in ours)
            }
        }
    }

    @Test
    fun theInkOnTheAccentIsFixedInBothSkins() {
        assertEquals(WindmillColor.gold400, dark.primary)
        assertEquals(WindmillColor.gold400, light.primary)
        assertEquals(WindmillColor.onAccent, dark.onPrimary)
        assertEquals(WindmillColor.onAccent, light.onPrimary)
    }

    @Test
    fun nothingInTheSchemeIsMaterialsBaselinePurple() {
        val baseline = setOf(
            Color(0xFF6750A4), // primary
            Color(0xFFD0BCFF), // primary, dark
            Color(0xFF49454F), // onSurfaceVariant
            Color(0xFFCAC4D0), // onSurfaceVariant, dark
            Color(0xFFEADDFF), // primaryContainer
        )
        for ((skin, scheme) in listOf("dark" to dark, "light" to light)) {
            for (slot in listOf(scheme.primary, scheme.onSurfaceVariant, scheme.surface,
                                scheme.background, scheme.outline)) {
                assertTrue("$skin scheme still carries a Material baseline colour: $slot",
                           slot !in baseline)
            }
        }
    }
}
