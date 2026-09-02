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

// The room palette, mirrored BY HAND from apps/ios GymSkin.swift and the web tokens. There is ONE
// skin and it is dark.
object GymSkin {
    val canvas = Color(0xFF1C1A1E)          // neutral-50
    val surface = Color(0xFF262329)         // neutral-0, elevated over the canvas
    val raised = Color(0xFF2E2B32)          // neutral-100
    val line = Color(0xFF39363E)            // neutral-200 · border-subtle
    val lineStrong = Color(0xFF48444D)      // neutral-300 · border-default
    val accent = Color(0xFF9A90BE)          // iris-300
    val onAccent = Color(0xFF1B1408)        // ink on the accent fill — 6.18:1 on iris-300
    // Iris at its darkest step at 22%: iris-300 on an iris-300 wash measures only 3.66:1.
    val accentSoft = Color(0x383A3358)
    val ink = Color(0xFFEDEBF0)
    val inkDim = Color(0xFFB0ABB8)          // neutral-600
    val inkFaint = Color(0xFF8D8896)        // neutral-500 — 5.01:1 on the canvas
    val weightInk = Color(0xFFEDEBF0)       // neutral-900
    val targetInk = Color(0xFF9A90BE)       // iris-300
    val setDone = Color(0xFF9AA859)         // olive-400
    val prInk = Color(0xFFD9B04C)           // gold-400
    val prSoft = Color(0x26D9B04C)          // gold-400 at 15%
    val warmupInk = Color(0xFF8D8896)
    val unsyncedInk = Color(0xFF8D8896)
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
}

// Compose has no dashed border modifier, so it is drawn rather than declared.
fun Modifier.dashedEdge(color: Color, radius: Dp, width: Dp = 1.dp): Modifier = drawBehind {
    drawRoundRect(
        color = color,
        cornerRadius = CornerRadius(radius.toPx()),
        style = Stroke(width = width.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(9f, 7f))),
    )
}
