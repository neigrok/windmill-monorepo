package works.windmill.gym.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillPalette

// Both product content and the account sheet resolve one palette for the current system mode.
@Composable
fun GymMaterial(content: @Composable () -> Unit) {
    val dark = LocalWindmillDark.current
    val skin = if (dark) GymSkin.Instrument else GymSkin.Daylight
    CompositionLocalProvider(LocalGymColors provides skin, LocalWindmillPalette provides gymPalette(skin)) {
        MaterialTheme(colorScheme = gymColorScheme(skin, dark), typography = gymTypography, content = content)
    }
}

fun gymPalette(skin: GymColors): WindmillPalette = WindmillPalette(
    canvas = skin.canvas, surface = skin.surface, ink = skin.ink, inkDim = skin.inkDim,
    inkFaint = skin.inkDim, line = skin.line, lineStrong = skin.lineStrong,
    accent = skin.accent, onAccent = skin.onAccent, noticeWash = skin.accentSoft, noticeInk = skin.ink,
)

fun gymColorScheme(skin: GymColors, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = skin.accent, onPrimary = skin.onAccent,
        primaryContainer = skin.accentSoft, onPrimaryContainer = skin.accent,
        secondary = skin.accent, onSecondary = skin.onAccent,
        secondaryContainer = skin.raised, onSecondaryContainer = skin.ink,
        tertiary = skin.setDone, onTertiary = skin.onAccent,
        tertiaryContainer = skin.raised, onTertiaryContainer = skin.ink,
        background = skin.canvas, onBackground = skin.ink,
        surface = skin.canvas, onSurface = skin.ink,
        surfaceVariant = skin.surface, onSurfaceVariant = skin.inkDim,
        surfaceContainerLowest = skin.canvas, surfaceContainerLow = skin.canvas,
        surfaceContainer = skin.surface, surfaceContainerHigh = skin.surface,
        surfaceContainerHighest = skin.raised, surfaceTint = Color.Transparent,
        inverseSurface = skin.raised, inverseOnSurface = skin.ink, inversePrimary = skin.accent,
        error = skin.alarmInk, onError = skin.onAlarm,
        errorContainer = skin.raised, onErrorContainer = skin.alarmInk,
        outline = skin.lineStrong, outlineVariant = skin.line, scrim = skin.scrim,
    )
}

// Native system faces with tabular figures keep changing weights and clocks steady.
val gymTypography: Typography = Typography(
    displayLarge = display(44),
    displayMedium = display(38),
    displaySmall = display(32),
    headlineLarge = display(30),
    headlineMedium = display(26),
    headlineSmall = display(22),
    titleLarge = display(24),
    titleMedium = display(17),
    titleSmall = display(15),
    bodyLarge = body(16),
    bodyMedium = body(15),
    bodySmall = body(13),
    labelLarge = body(16, FontWeight.Bold),
    labelMedium = body(14, FontWeight.Bold),
    labelSmall = body(12, FontWeight.Bold),
)

private fun display(size: Int): TextStyle =
    WindmillFont.display(size).copy(fontFeatureSettings = tabular)

private fun body(size: Int, weight: FontWeight = FontWeight.Normal): TextStyle =
    WindmillFont.body(size, weight).copy(fontFeatureSettings = tabular)

private const val tabular = "tnum"
