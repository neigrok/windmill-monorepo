package works.windmill.platform.design

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// THE REGRESSION THIS FILE EXISTS FOR, said plainly because a colour bug is invisible to a suite:
// the app shipped with no MaterialTheme at all. Every surface painted from WindmillColor by hand,
// so it looked right, and the one thing nobody paints by hand — a bottom sheet's drag handle —
// came out of Material's BASELINE scheme, which is purple. It reached a released APK.
//
// A JVM test cannot look at a handset. What it can do is hold the mapping, which is why the scheme
// is a pure function: every slot asserted below is one a Material component actually reads, so a
// mapping that goes missing or points at the wrong role fails here rather than on someone's phone.

class WindmillMaterialTests {
    private val dark = windmillColorScheme(dark = true)
    private val light = windmillColorScheme(dark = false)

    // The exact slot the defect came through. BottomSheetDefaults.DragHandle reads
    // onSurfaceVariant, and Material's baseline answer for it is a purple-grey.
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

    // The one pair in the scheme that is deliberately NOT adaptive: the fill is the same gold in
    // both skins, so the ink on it must be too — the adaptive ramp would reach for its dark end and
    // read 1.77:1 against gold.
    @Test
    fun theInkOnTheAccentIsFixedInBothSkins() {
        assertEquals(WindmillColor.gold400, dark.primary)
        assertEquals(WindmillColor.gold400, light.primary)
        assertEquals(WindmillColor.onAccent, dark.onPrimary)
        assertEquals(WindmillColor.onAccent, light.onPrimary)
    }

    // Material's baseline purple, named, so this test says what it is defending against rather
    // than only that something changed.
    @Test
    fun nothingInTheSchemeIsMaterialsBaselinePurple() {
        val baseline = setOf(
            Color(0xFF6750A4), // primary
            Color(0xFFD0BCFF), // primary, dark
            Color(0xFF49454F), // onSurfaceVariant — the drag handle that shipped
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
