package works.windmill.gym.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GymMaterialTests {
    private val scheme = gymColorScheme

    @Test
    fun theAccentIsTheSchemesPrimaryAndTheInkOnItIsTheRoomsOwn() {
        assertEquals(GymSkin.accent, scheme.primary)
        assertEquals(GymSkin.onAccent, scheme.onPrimary)
        // A tonal container Material fills for itself — the rail names its own indicator, because
        // this wash measures 1.06:1 on the bar and carries no signal (ledger `1v`).
        assertEquals(GymSkin.accentSoft, scheme.secondaryContainer)
        assertEquals(GymSkin.accent, scheme.onSecondaryContainer)
    }

    @Test
    fun goldIsNowhereInTheScheme() {
        val everySlot = listOf(
            "primary" to scheme.primary, "onPrimary" to scheme.onPrimary,
            "primaryContainer" to scheme.primaryContainer,
            "onPrimaryContainer" to scheme.onPrimaryContainer,
            "secondary" to scheme.secondary, "onSecondary" to scheme.onSecondary,
            "secondaryContainer" to scheme.secondaryContainer,
            "onSecondaryContainer" to scheme.onSecondaryContainer,
            "tertiary" to scheme.tertiary, "onTertiary" to scheme.onTertiary,
            "background" to scheme.background, "onBackground" to scheme.onBackground,
            "surface" to scheme.surface, "onSurface" to scheme.onSurface,
            "surfaceVariant" to scheme.surfaceVariant, "onSurfaceVariant" to scheme.onSurfaceVariant,
            "surfaceContainer" to scheme.surfaceContainer,
            "surfaceContainerHigh" to scheme.surfaceContainerHigh,
            "surfaceContainerHighest" to scheme.surfaceContainerHighest,
            "surfaceTint" to scheme.surfaceTint,
            "inverseSurface" to scheme.inverseSurface, "inverseOnSurface" to scheme.inverseOnSurface,
            "inversePrimary" to scheme.inversePrimary,
            "outline" to scheme.outline, "outlineVariant" to scheme.outlineVariant,
            "error" to scheme.error, "onError" to scheme.onError,
        )
        // Gold means a personal record in this room and is painted by hand where a PR is; a Material
        // control taking it from the scheme would say `record` on a switch.
        val wearingGold = everySlot.filter { (_, colour) ->
            colour == GymSkin.prInk || colour == GymSkin.prSoft
        }
        assertEquals(emptyList<Pair<String, Color>>(), wearingGold)

        val ours = setOf(
            GymSkin.canvas, GymSkin.surface, GymSkin.raised, GymSkin.line, GymSkin.lineStrong,
            GymSkin.accent, GymSkin.onAccent, GymSkin.accentSoft, GymSkin.ink, GymSkin.inkDim,
            GymSkin.inkFaint, GymSkin.setDone, GymSkin.alarmInk, Color.Transparent, Color.Black,
        )
        val strangers = everySlot.filterNot { (_, colour) -> colour in ours }.map { it.first }
        assertEquals("every slot a Material control reads is a colour this room already draws",
                     emptyList<String>(), strangers)
    }

    @Test
    fun theDestroyHueIsBrickAndTheGroundIsTheCanvas() {
        assertEquals(GymSkin.alarmInk, scheme.error)
        assertEquals(GymSkin.canvas, scheme.surface)
        assertEquals(GymSkin.canvas, scheme.background)
        assertEquals(GymSkin.surface, scheme.surfaceVariant)
        assertEquals(GymSkin.ink, scheme.onSurface)
        assertEquals(GymSkin.inkFaint, scheme.onSurfaceVariant)
        assertEquals(GymSkin.lineStrong, scheme.outline)
        assertEquals(GymSkin.line, scheme.outlineVariant)
    }

    @Test
    fun everyRoleIsTabularAndTakesTheRoomsOwnFaces() {
        val roles: List<Pair<String, TextStyle>> = with(gymTypography) {
            listOf(
                "displayLarge" to displayLarge, "displayMedium" to displayMedium,
                "displaySmall" to displaySmall, "headlineLarge" to headlineLarge,
                "headlineMedium" to headlineMedium, "headlineSmall" to headlineSmall,
                "titleLarge" to titleLarge, "titleMedium" to titleMedium, "titleSmall" to titleSmall,
                "bodyLarge" to bodyLarge, "bodyMedium" to bodyMedium, "bodySmall" to bodySmall,
                "labelLarge" to labelLarge, "labelMedium" to labelMedium, "labelSmall" to labelSmall,
            )
        }
        val untabular = roles.filterNot { it.second.fontFeatureSettings == "tnum" }.map { it.first }
        assertEquals("a running clock and a changing weight jitter without tabular figures",
                     emptyList<String>(), untabular)
        assertTrue("nothing falls back to a stock Material size",
                   roles.all { it.second.fontSize.value > 0f })
        assertFalse("the top bar's title is the display face, not the body one",
                    gymTypography.titleLarge.fontWeight == gymTypography.bodyLarge.fontWeight)
    }
}
