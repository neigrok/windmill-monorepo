package works.windmill.platform.design

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

@Composable
fun WindmillMaterial(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = windmillColorScheme(LocalWindmillDark.current), content = content)
}

fun windmillColorScheme(dark: Boolean): ColorScheme {
    val canvas = if (dark) WindmillColor.surfaceCanvas.dark else WindmillColor.surfaceCanvas.light
    val card = if (dark) WindmillColor.surfaceCard.dark else WindmillColor.surfaceCard.light
    val raised = if (dark) WindmillColor.neutral100.dark else WindmillColor.neutral100.light
    val ink = if (dark) WindmillColor.textPrimary.dark else WindmillColor.textPrimary.light
    val inkQuiet = if (dark) WindmillColor.textTertiary.dark else WindmillColor.textTertiary.light
    val line = if (dark) WindmillColor.borderSubtle.dark else WindmillColor.borderSubtle.light
    val lineStrong = if (dark) WindmillColor.borderDefault.dark else WindmillColor.borderDefault.light

    return if (dark) {
        darkColorScheme(
            primary = WindmillColor.gold400,
            onPrimary = WindmillColor.onAccent,
            secondary = WindmillColor.olive400,
            onSecondary = WindmillColor.onAccent,
            tertiary = WindmillColor.olive500,
            onTertiary = WindmillColor.onAccent,
            background = canvas,
            onBackground = ink,
            surface = card,
            onSurface = ink,
            onSurfaceVariant = inkQuiet,
            surfaceVariant = raised,
            surfaceContainerLowest = canvas,
            surfaceContainerLow = canvas,
            surfaceContainer = card,
            surfaceContainerHigh = raised,
            surfaceContainerHighest = raised,
            outline = lineStrong,
            outlineVariant = line,
            scrim = Color.Black,
        )
    } else {
        lightColorScheme(
            primary = WindmillColor.gold400,
            onPrimary = WindmillColor.onAccent,
            secondary = WindmillColor.olive500,
            onSecondary = WindmillColor.onAccent,
            tertiary = WindmillColor.olive500,
            onTertiary = WindmillColor.onAccent,
            background = canvas,
            onBackground = ink,
            surface = card,
            onSurface = ink,
            onSurfaceVariant = inkQuiet,
            surfaceVariant = raised,
            surfaceContainerLowest = canvas,
            surfaceContainerLow = canvas,
            surfaceContainer = card,
            surfaceContainerHigh = raised,
            surfaceContainerHighest = raised,
            outline = lineStrong,
            outlineVariant = line,
            scrim = Color.Black,
        )
    }
}
