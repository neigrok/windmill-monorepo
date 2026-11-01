package works.windmill.gym.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymMaterialTests {
    @Test
    fun nativeControlsAndSharedAccountChromeUseTheSamePaletteInBothModes() {
        listOf(true to GymSkin.Instrument, false to GymSkin.Daylight).forEach { (dark, skin) ->
            val scheme = gymColorScheme(skin, dark)
            val palette = gymPalette(skin)
            assertEquals(listOf(skin.accent, skin.onAccent, skin.canvas, skin.ink, skin.inkDim),
                listOf(scheme.primary, scheme.onPrimary, scheme.background, scheme.onSurface,
                    scheme.onSurfaceVariant))
            assertEquals(listOf(palette.accent, palette.onAccent, palette.canvas, palette.ink, palette.inkDim),
                listOf(scheme.primary, scheme.onPrimary, scheme.background, scheme.onSurface,
                    scheme.onSurfaceVariant))
            val extended = GymExtendedColors(skin)
            assertEquals(listOf(skin.inkFaint, skin.prInk, skin.prSoft, skin.alarmInk),
                listOf(extended.inkFaint, extended.prInk, extended.prSoft, extended.alarmInk))
            assertEquals(skin.raised, scheme.secondaryContainer)
            assertEquals(skin.ink, scheme.onSecondaryContainer)
            assertEquals(skin.error, scheme.error)
            assertEquals(skin.onError, scheme.onError)
            assertEquals(skin.error, scheme.onErrorContainer)
            assertEquals(skin.scrim, scheme.scrim)
        }
    }

    @Test
    fun colourRolesMatchTheApprovedDarkAndDaylightSpecimen() {
        val expected = listOf(
            GymSkin.Instrument to mapOf(
                "canvas" to 0xFF0B1111, "surface" to 0xFF161C1D, "raised" to 0xFF202627,
                "line" to 0xFF202627, "lineStrong" to 0xFF2A3133,
                "accent" to 0xFF5FCDB4, "accentSoft" to 0x335FCDB4, "onAccent" to 0xFF1B1408,
                "ink" to 0xFFF1F0EB, "inkDim" to 0xFFB6B5AF, "inkFaint" to 0xFF727771,
                "setDone" to 0xFF9AA859, "prInk" to 0xFFD9B04C, "prSoft" to 0x26D9B04C,
                "error" to 0xFFE46962, "onError" to 0xFF410E0B,
            ),
            GymSkin.Daylight to mapOf(
                "canvas" to 0xFFEBE7E3, "surface" to 0xFFF8F6F4, "raised" to 0xFFDFDAD5,
                "line" to 0xFFD0CAC5, "lineStrong" to 0xFFB6AFA9,
                "accent" to 0xFF137A6C, "accentSoft" to 0x1F137A6C, "onAccent" to 0xFFFFFFFF,
                "ink" to 0xFF1A1918, "inkDim" to 0xFF4C4744, "inkFaint" to 0xFF625C58,
                "setDone" to 0xFF7D8C43, "prInk" to 0xFF6E5217, "prSoft" to 0x24A17822,
                "error" to 0xFFB3261E, "onError" to 0xFFFFFFFF,
            ),
        )
        for ((skin, roles) in expected) {
            val actual = with(skin) {
                mapOf("canvas" to canvas, "surface" to surface, "raised" to raised,
                    "line" to line, "lineStrong" to lineStrong,
                    "accent" to accent, "accentSoft" to accentSoft, "onAccent" to onAccent,
                    "ink" to ink, "inkDim" to inkDim, "inkFaint" to inkFaint,
                    "setDone" to setDone, "prInk" to prInk, "prSoft" to prSoft,
                    "error" to error, "onError" to onError)
            }
            assertEquals(roles.mapValues { Color(it.value) }, actual)
        }
    }

    @Test
    fun personalRecordGoldNeverBecomesANativeControlColor() {
        listOf(true to GymSkin.Instrument, false to GymSkin.Daylight).forEach { (dark, skin) ->
            val scheme = gymColorScheme(skin, dark)
            val colors = with(scheme) {
                listOf(primary, onPrimary, primaryContainer, onPrimaryContainer,
                    secondary, onSecondary, secondaryContainer, onSecondaryContainer,
                    tertiary, onTertiary, tertiaryContainer, onTertiaryContainer,
                    background, onBackground, surface, onSurface, surfaceVariant, onSurfaceVariant,
                    surfaceContainerLowest, surfaceContainerLow, surfaceContainer,
                    surfaceContainerHigh, surfaceContainerHighest, surfaceTint,
                    inverseSurface, inverseOnSurface, inversePrimary, outline, outlineVariant,
                    error, onError, errorContainer, onErrorContainer, scrim)
            }
            assertEquals(emptyList<Color>(), colors.filter { it == skin.prInk || it == skin.prSoft })
        }
    }

    @Test
    fun everyNativeTypeRoleKeepsTabularFiguresAndTheSharedTextBudgets() {
        val roles = with(gymTypography) {
            listOf(displayLarge, displayMedium, displaySmall, headlineLarge, headlineMedium,
                headlineSmall, titleLarge, titleMedium, titleSmall, bodyLarge, bodyMedium,
                bodySmall, labelLarge, labelMedium, labelSmall)
        }
        assertTrue(roles.all { it.fontFeatureSettings == "tnum" && it.fontSize.value > 0f })
        assertEquals(24f, gymTypography.titleLarge.fontSize.value)
        assertEquals(16f, gymTypography.labelLarge.fontSize.value)
    }
}
