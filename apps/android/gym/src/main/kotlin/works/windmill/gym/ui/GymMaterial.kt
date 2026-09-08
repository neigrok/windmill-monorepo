package works.windmill.gym.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillPalette

// The room's own Material theme and its palette — the gym module's `Skin`. Every Material control
// inside gym reads THIS scheme, never the brand's, and the shell's chrome drawn under it (the
// account sheet, the door) reads `gymPalette`: WindmillMaterial paints gold on warm brown, and gold
// in this room means a personal record (`GymSkin.prInk`), so a control taking the brand's primary
// would say `record` on a Switch. Gold is therefore absent from both and stays painted by hand
// where a PR is.
//
// Dynamic colour is a refusal rather than an omission: colour here is a legend — verdigris says the agent
// proposed it, olive says logged, brick says this destroys something — and a wallpaper cannot
// recolour a legend.
@Composable
fun GymMaterial(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalWindmillPalette provides gymPalette) {
        MaterialTheme(colorScheme = gymColorScheme, typography = gymTypography, content = content)
    }
}

// The shell's slots in the room's colours. The refusal line's wash is the verdigris wash, its ink
// the room's ink.
val gymPalette: WindmillPalette = WindmillPalette(
    canvas = GymSkin.canvas,
    surface = GymSkin.surface,
    ink = GymSkin.ink,
    inkDim = GymSkin.inkDim,
    inkFaint = GymSkin.inkFaint,
    line = GymSkin.line,
    lineStrong = GymSkin.lineStrong,
    accent = GymSkin.accent,
    onAccent = GymSkin.onAccent,
    noticeWash = GymSkin.accentSoft,
    noticeInk = GymSkin.ink,
)

// One skin, and it is dark: Daylight is a design task of its own and this scheme does not pretend to
// have it. `secondaryContainer` is the rail's selected seat; `inverseSurface` is the snackbar's
// ground, so the undo transient lands in the room's ink rather than on a light slab.
val gymColorScheme: ColorScheme = darkColorScheme(
    primary = GymSkin.accent,
    onPrimary = GymSkin.onAccent,
    primaryContainer = GymSkin.accentSoft,
    onPrimaryContainer = GymSkin.accent,
    secondary = GymSkin.accent,
    onSecondary = GymSkin.onAccent,
    secondaryContainer = GymSkin.accentSoft,
    onSecondaryContainer = GymSkin.accent,
    tertiary = GymSkin.setDone,
    onTertiary = GymSkin.onAccent,
    background = GymSkin.canvas,
    onBackground = GymSkin.ink,
    surface = GymSkin.canvas,
    onSurface = GymSkin.ink,
    surfaceVariant = GymSkin.surface,
    onSurfaceVariant = GymSkin.inkFaint,
    surfaceContainerLowest = GymSkin.canvas,
    surfaceContainerLow = GymSkin.canvas,
    surfaceContainer = GymSkin.surface,
    surfaceContainerHigh = GymSkin.surface,
    surfaceContainerHighest = GymSkin.raised,
    surfaceTint = Color.Transparent,
    inverseSurface = GymSkin.raised,
    inverseOnSurface = GymSkin.ink,
    inversePrimary = GymSkin.accent,
    // Brick is the destroy hue and nothing else in this room wears it.
    error = GymSkin.alarmInk,
    onError = GymSkin.onAccent,
    errorContainer = GymSkin.raised,
    onErrorContainer = GymSkin.alarmInk,
    // Two hairlines, as the room draws them: border-default carries a control's edge, border-subtle
    // a divider.
    outline = GymSkin.lineStrong,
    outlineVariant = GymSkin.line,
    scrim = Color.Black,
)

// The room's faces, so a Material control does not come up in stock Roboto: prose and action labels
// take the body face, every title the display face. Tabular figures ride on every role, because a
// running clock and a changing weight jitter without them and the room's own rule is that every
// numeral in gym is tabular.
val gymTypography: Typography = Typography(
    displayLarge = display(44),
    displayMedium = display(38),
    displaySmall = display(32),
    headlineLarge = display(30),
    headlineMedium = display(26),
    headlineSmall = display(22),
    titleLarge = display(20),
    titleMedium = display(17),
    titleSmall = display(15),
    bodyLarge = body(16),
    bodyMedium = body(15),
    bodySmall = body(13),
    labelLarge = body(15, FontWeight.SemiBold),
    labelMedium = body(13, FontWeight.SemiBold),
    labelSmall = body(11, FontWeight.SemiBold),
)

private fun display(size: Int): TextStyle =
    WindmillFont.display(size).copy(fontFeatureSettings = tabular)

private fun body(size: Int, weight: FontWeight = FontWeight.Normal): TextStyle =
    WindmillFont.body(size, weight).copy(fontFeatureSettings = tabular)

private const val tabular = "tnum"
