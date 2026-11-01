package works.windmill.gym.ui

import android.content.res.Configuration
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillPalette

// Both product content and the account sheet resolve one palette for the current system mode: the standard roles
// in the Material scheme, the room's own beside it, and the shell's palette from the same skin.
@Composable
fun GymMaterial(content: @Composable () -> Unit) {
    val dark = LocalWindmillDark.current
    val skin = if (dark) GymSkin.Instrument else GymSkin.Daylight
    val extended = remember(skin) { GymExtendedColors(skin) }
    val palette = remember(skin) { gymPalette(skin) }
    val scheme = remember(skin, dark) { gymColorScheme(skin, dark) }
    CompositionLocalProvider(LocalGymExtendedColors provides extended, LocalWindmillPalette provides palette) {
        MaterialTheme(colorScheme = scheme, typography = gymTypography, content = content)
    }
}

// The room's colour roles Material has no slot for.
@Immutable
data class GymExtendedColors(val inkFaint: Color, val prInk: Color, val prSoft: Color, val alarmInk: Color) {
    constructor(skin: GymColors) : this(inkFaint = skin.inkFaint, prInk = skin.prInk, prSoft = skin.prSoft, alarmInk = skin.alarmInk)
}

private val LocalGymExtendedColors = staticCompositionLocalOf { GymExtendedColors(GymSkin.Instrument) }

val MaterialTheme.gymColors: GymExtendedColors
    @Composable @ReadOnlyComposable get() = LocalGymExtendedColors.current

@Preview(name = "Dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Daylight", uiMode = Configuration.UI_MODE_NIGHT_NO)
internal annotation class DarkAndDaylight

// Previews theme from the system appearance as the app does, so the rig captures Dark and Daylight by switching it.
@Composable
internal fun GymPreview(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalWindmillDark provides isSystemInDarkTheme()) { GymMaterial(content) }
}

fun gymPalette(skin: GymColors): WindmillPalette = WindmillPalette(
    canvas = skin.canvas, surface = skin.surface, ink = skin.ink, inkDim = skin.inkDim,
    line = skin.line, lineStrong = skin.lineStrong,
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
        error = skin.error, onError = skin.onError,
        errorContainer = skin.raised, onErrorContainer = skin.error,
        outline = skin.lineStrong, outlineVariant = skin.line, scrim = skin.scrim,
    )
}
