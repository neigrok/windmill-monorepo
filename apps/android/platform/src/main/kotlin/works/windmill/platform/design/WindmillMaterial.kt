package works.windmill.platform.design

import androidx.activity.OnBackPressedDispatcherOwner
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.ui.graphics.Color

// The brand's Material scheme and its palette together: the shell's chrome reads the palette, a
// Material control reads the scheme, and a room wrapping itself in its own Skin replaces both.
@Composable
fun WindmillMaterial(content: @Composable () -> Unit) {
    val dark = LocalWindmillDark.current
    CompositionLocalProvider(LocalWindmillPalette provides brandPalette(dark)) {
        MaterialTheme(colorScheme = windmillColorScheme(dark), content = content)
    }
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

@Composable
fun WindmillSheetWindow() {
    val view = LocalView.current
    val dark = LocalWindmillDark.current
    val window = generateSequence(view.parent) { it.parent }
        .filterIsInstance<DialogWindowProvider>().firstOrNull()?.window ?: return
    SideEffect {
        view.post {
            val bars = WindowInsetsControllerCompat(window, view)
            bars.isAppearanceLightStatusBars = !dark
            bars.isAppearanceLightNavigationBars = !dark
        }
    }
}

// Nested sheet routes handle Back before their modal closes. The IME keeps native priority.
@Composable
fun WindmillSheetBack(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val view = LocalView.current
    val window = generateSequence(view.parent) { it.parent }
        .filterIsInstance<DialogWindowProvider>().firstOrNull()?.window
    val owner = checkNotNull(window?.callback as? OnBackPressedDispatcherOwner) {
        "The sheet window must own its Back dispatcher."
    }
    CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner) {
        BackHandler(onBack = onDismiss)
        content()
    }
}
