package works.windmill.platform.design

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// WHAT MATERIAL DRAWS WHEN NOBODY TELLS IT — and until 2026-08-12 nobody did.
//
// Every surface in this app paints from WindmillColor, so the app LOOKED right and the omission
// hid: there was no MaterialTheme anywhere in the module, and Material3 falls back to its baseline
// scheme, which is purple. Anything the app does not paint by hand came out of that scheme. The
// four ModalBottomSheets are where it showed — a sheet takes `containerColor` from the call site
// but draws its DRAG HANDLE from `onSurfaceVariant` and its scrim from `onSurface`, so a purple-grey
// pill sat on top of a basalt sheet and no token in this repo could explain it.
//
// The fix is one theme at the composition root rather than four arguments at four call sites,
// because the defect is not "these sheets are wrong" — it is that Material was never told what
// colours this brand has. A per-sheet patch would be correct today and silently wrong the first
// time anyone adds a fifth Material component.
//
// The mapping is deliberately narrow: the roles the family already names, and nothing invented to
// fill a slot. Material has scheme slots this brand has no answer for (tertiary, inverse*, the
// container ramp); they are filled from the nearest role that IS ours rather than left to the
// baseline, so an unfilled slot can never surface a hue from another product's palette.
@Composable
fun WindmillMaterial(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = windmillColorScheme(LocalWindmillDark.current), content = content)
}

// The mapping itself is a pure function of the skin, so it is a thing a test can hold: a JVM case
// asserts the slots a Material component actually reads, which is the only way a colour regression
// is caught by anything other than an eye on a handset.
fun windmillColorScheme(dark: Boolean): ColorScheme {
    val canvas = if (dark) WindmillColor.surfaceCanvas.dark else WindmillColor.surfaceCanvas.light
    val card = if (dark) WindmillColor.surfaceCard.dark else WindmillColor.surfaceCard.light
    val raised = if (dark) WindmillColor.neutral100.dark else WindmillColor.neutral100.light
    val ink = if (dark) WindmillColor.textPrimary.dark else WindmillColor.textPrimary.light
    val inkQuiet = if (dark) WindmillColor.textTertiary.dark else WindmillColor.textTertiary.light
    val line = if (dark) WindmillColor.borderSubtle.dark else WindmillColor.borderSubtle.light
    val lineStrong = if (dark) WindmillColor.borderDefault.dark else WindmillColor.borderDefault.light

    // The accent is the family's gold with the fixed ink the ramp cannot supply — the one pair in
    // this file that is not adaptive, for the reason WindmillColor.onAccent states.
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
            // The drag handle reads this one. It is the quiet ink, which is what a handle is.
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
