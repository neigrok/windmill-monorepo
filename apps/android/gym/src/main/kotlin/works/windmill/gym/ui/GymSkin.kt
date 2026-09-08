package works.windmill.gym.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import works.windmill.platform.design.WindmillSpace

// The room palette, mirrored BY HAND from apps/ios GymSkin.swift and the web tokens. There is ONE
// skin and it is dark.
object GymSkin {
    val canvas = Color(0xFF0B1111)          // neutral-50
    val surface = Color(0xFF161C1D)         // neutral-100 · card, elevated over the canvas
    val raised = Color(0xFF202627)          // neutral-200
    val sunken = Color(0xFF060C0C)          // below the canvas
    val line = Color(0xFF202627)            // neutral-200 · border-subtle
    val lineStrong = Color(0xFF2A3133)      // neutral-300 · border-default
    val accent = Color(0xFF5FCDB4)          // verdigris-400
    val accentHover = Color(0xFF8FE0CD)     // verdigris-300
    val accentPressed = Color(0xFF3DAE95)   // verdigris-500
    val onAccent = Color(0xFF1B1408)        // ink on the accent fill — 9.46:1 on verdigris
    val accentSoft = Color(0x335FCDB4)      // verdigris at 20% — verdigris on the wash measures 6.63:1 over the canvas, 5.87:1 over the surface
    val ink = Color(0xFFF1F0EB)             // neutral-900
    val inkDim = Color(0xFFB6B5AF)          // neutral-600
    val inkFaint = Color(0xFF727771)        // neutral-500 — 4.17:1 on the canvas
    val weightInk = ink                     // neutral-900
    val targetInk = Color(0xFF5FCDB4)       // verdigris-400
    val setDone = Color(0xFF9AA859)         // olive-400
    val prInk = Color(0xFFD9B04C)           // gold-400
    val prSoft = Color(0x26D9B04C)          // gold-400 at 15%
    val warmupInk = inkFaint
    val unsyncedInk = inkFaint
    val alarmInk = Color(0xFFD08268)        // brick-300
}

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
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
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

// Material's open-in-new, in its own path data: one glyph is not worth the extended icon set.
object GymGlyph {
    val openInNew: ImageVector = ImageVector.Builder(
        name = "OpenInNew", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
        autoMirror = true,
    ).path(fill = SolidColor(Color.Black)) {
        moveTo(19f, 19f); horizontalLineTo(5f); verticalLineTo(5f); horizontalLineTo(12f); verticalLineTo(3f)
        horizontalLineTo(5f); curveToRelative(-1.11f, 0f, -2f, 0.9f, -2f, 2f); verticalLineToRelative(14f)
        curveToRelative(0f, 1.1f, 0.89f, 2f, 2f, 2f); horizontalLineToRelative(14f)
        curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f); verticalLineToRelative(-7f); horizontalLineToRelative(-2f)
        verticalLineToRelative(7f); close()
        moveTo(14f, 3f); verticalLineToRelative(2f); horizontalLineToRelative(3.59f); lineToRelative(-9.83f, 9.83f)
        lineToRelative(1.41f, 1.41f); lineTo(19f, 6.41f); verticalLineTo(10f); horizontalLineToRelative(2f)
        verticalLineTo(3f); horizontalLineToRelative(-7f); close()
    }.build()
}

// Nothing tappable under 46, and the primary action 64 and in the thumb zone.
object GymTap {
    val minimum = 46.dp
    val primary = 64.dp
    val row = 52.dp        // list rows, ladder pills, secondary buttons
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
