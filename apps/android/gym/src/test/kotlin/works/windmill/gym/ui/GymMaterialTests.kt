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
            assertEquals(skin.inkDim, palette.inkFaint)
            assertEquals(skin.raised, scheme.secondaryContainer)
            assertEquals(skin.ink, scheme.onSecondaryContainer)
            assertEquals(skin.alarmInk, scheme.error)
            assertEquals(skin.scrim, scheme.scrim)
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
