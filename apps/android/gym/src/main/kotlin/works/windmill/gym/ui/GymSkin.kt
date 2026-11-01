package works.windmill.gym.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import works.windmill.platform.design.WindmillSpace

@Immutable
data class GymColors(
    val canvas: Color,
    val surface: Color,
    val raised: Color,
    val sunken: Color,
    val line: Color,
    val lineStrong: Color,
    val accent: Color,
    val onAccent: Color,
    val ink: Color,
    val inkDim: Color,
    val inkFaint: Color,
    val setDone: Color,
    val accentSoft: Color,
    val prInk: Color,
    val prSoft: Color,
    val alarmInk: Color,
    val error: Color,
    val onError: Color,
    val scrim: Color,
) {
    val weightInk = ink
    val targetInk = accent
    val unsyncedInk = inkFaint
}

object GymSkin {
    val Instrument = GymColors(
        canvas = Color(0xFF0B1111), surface = Color(0xFF161C1D), raised = Color(0xFF202627),
        sunken = Color(0xFF060C0C), line = Color(0xFF202627), lineStrong = Color(0xFF2A3133),
        accent = Color(0xFF5FCDB4),
        onAccent = Color(0xFF1B1408), ink = Color(0xFFF1F0EB), inkDim = Color(0xFFB6B5AF),
        inkFaint = Color(0xFF727771), setDone = Color(0xFF9AA859),
        accentSoft = Color(0x335FCDB4), prInk = Color(0xFFD9B04C), prSoft = Color(0x26D9B04C),
        alarmInk = Color(0xFFD08268), error = Color(0xFFE46962), onError = Color(0xFF410E0B), scrim = Color(0xB8030606),
    )
    val Daylight = GymColors(
        canvas = Color(0xFFEBE7E3), surface = Color(0xFFF8F6F4), raised = Color(0xFFDFDAD5),
        sunken = Color(0xFFDFDAD5), line = Color(0xFFD0CAC5), lineStrong = Color(0xFFB6AFA9),
        accent = Color(0xFF137A6C),
        onAccent = Color.White, ink = Color(0xFF1A1918), inkDim = Color(0xFF4C4744),
        inkFaint = Color(0xFF625C58), setDone = Color(0xFF7D8C43),
        accentSoft = Color(0x1F137A6C), prInk = Color(0xFF6E5217), prSoft = Color(0x24A17822),
        alarmInk = Color(0xFFA84E35), error = Color(0xFFB3261E), onError = Color.White, scrim = Color(0x731A1918),
    )
}

val LocalGymColors = staticCompositionLocalOf { GymSkin.Instrument }

// Every numeral in gym is TABULAR, or a column of sets shimmers. The weight is the exception to mono.
object GymType {
    val weight = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.ExtraBold,
        fontSize = 104.sp,
        lineHeight = 92.sp,
        letterSpacing = (-0.04).em,
        fontFeatureSettings = "tnum",
    )

    // The logger's reps numeral and its one primary — sans, tabular, like every role in
    // `gymTypography`.
    val reps = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.ExtraBold,
        fontSize = 56.sp,
        lineHeight = 60.sp,
        fontFeatureSettings = "tnum",
    )

    val primary = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 16.sp,
        fontFeatureSettings = "tnum",
    )

    fun numeral(size: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = weight,
        fontSize = size.sp,
        fontFeatureSettings = "tnum",
    )

    val readout = numeral(15)
}

// Where the room's layouts reflow for the system text size: past its 130 % step a layout opens up (the receipt fills
// its sheet, a set row stacks its readout), and from 150 % side-by-side parts stack.
object GymTextScale {
    val large: Boolean @Composable @ReadOnlyComposable get() = LocalDensity.current.fontScale > 1.3f
    val stacked: Boolean @Composable @ReadOnlyComposable get() = LocalDensity.current.fontScale >= 1.5f
}

// Native action sizes; the rack keeps its larger logging target.
object GymTap {
    val minimum = 48.dp
    val primary = 56.dp
    val logSet = 64.dp
    val row = 52.dp        // list rows, ladder pills
    val secondary = 56.dp  // dashed add slots, Apply, Sign in, text fields
}

// The room's layout scale: every edge, gap and inset is one of these, so a screen reads like its
// siblings.
object GymLayout {
    val gutter = WindmillSpace.x5          // every screen's horizontal edge, every sheet's
    val cardInset = WindmillSpace.x4       // inner padding of a content card
    val rowInset = WindmillSpace.x3        // horizontal inner padding of a single-line row
    val cardGap = WindmillSpace.x2         // between sibling cards / rows in a list
    val blockGap = WindmillSpace.x3        // between blocks inside one card
    val sectionGap = WindmillSpace.x4      // between sections of a scroll body
    val pair = WindmillSpace.x1            // title ↔ caption inside one row
    val scrollTail = WindmillSpace.x8      // bottom of a scroll body with nothing pinned under it
    val scrollTailBand = WindmillSpace.x4  // bottom of a scroll body with a band pinned under it
    val sheetBottom = WindmillSpace.x6     // bottom of every sheet, under its last control
    val contentTop = WindmillSpace.x2      // first content under the top bar
}

// Compose has no dashed border modifier, so it is drawn rather than declared.
fun Modifier.dashedEdge(color: Color, radius: Dp, width: Dp = 1.dp): Modifier = drawBehind {
    drawRoundRect(
        color = color,
        cornerRadius = CornerRadius(radius.toPx()),
        style = Stroke(width = width.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(9f, 7f))),
    )
}
