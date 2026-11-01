package works.windmill.platform.design

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The values mirror web/src/styles/tokens/colors.css by hand; nothing checks one against the other.

val LocalWindmillDark = staticCompositionLocalOf { true }

@Immutable
class WindmillShade(light: Long, dark: Long) {
    val light: Color = Color(0xFF000000 or light)
    val dark: Color = Color(0xFF000000 or dark)

    val color: Color
        @Composable @ReadOnlyComposable get() = if (LocalWindmillDark.current) dark else light
}

// In both ramps low indices are deep warm surfaces, high indices warm off-whites for text.
object WindmillColor {
    val neutral0 = WindmillShade(0xFFFFFF, 0x17120B)
    val neutral25 = WindmillShade(0xFDFBF6, 0x14100A)
    val neutral50 = WindmillShade(0xF9F5EB, 0x0D0B07)
    val neutral100 = WindmillShade(0xF1EADA, 0x221B12)
    val neutral200 = WindmillShade(0xE5D9C0, 0x2E2618)
    val neutral300 = WindmillShade(0xD3C2A0, 0x3C3223)
    val neutral400 = WindmillShade(0xB29F7B, 0x574A35)
    val neutral500 = WindmillShade(0x92805F, 0x8A785A)
    val neutral600 = WindmillShade(0x6F5F45, 0xAE9A75)
    val neutral700 = WindmillShade(0x514431, 0xCDBC97)
    val neutral800 = WindmillShade(0x372E21, 0xE6DAC1)
    val neutral900 = WindmillShade(0x211B13, 0xF4EEDF)

    val gold400 = Color(0xFFD9B04C)
    val olive400 = Color(0xFF9AA859)
    val olive500 = Color(0xFF7D8C43)

    // Ink for text on a bright accent fill; fixed in both skins.
    val onAccent = Color(0xFF1B1408)

    val surfaceCanvas = neutral50
    val surfaceCard = neutral0
    val textPrimary = neutral900
    val textSecondary = neutral600
    val textTertiary = neutral500
    val borderSubtle = neutral200
    val borderDefault = neutral300
}

// The semantic slots the shell's own chrome (the account sheet, the door, the capsule) is painted
// in. Product-neutral: a room that wraps itself in its own scheme provides its own palette through
// `LocalWindmillPalette`, and the same door then takes the room's colours. `noticeWash`/`noticeInk`
// are the refusal line's ground and ink.
@Immutable
class WindmillPalette(
    val canvas: Color,
    val surface: Color,
    val ink: Color,
    val inkDim: Color,
    val line: Color,
    val lineStrong: Color,
    val accent: Color,
    val onAccent: Color,
    val noticeWash: Color,
    val noticeInk: Color,
)

val LocalWindmillPalette = staticCompositionLocalOf { brandPalette(dark = true) }

// The brand's own skin: gold on warm brown. `surface` is the canvas because the shell's sheet
// stands on the canvas shade, not the card one.
fun brandPalette(dark: Boolean): WindmillPalette {
    fun WindmillShade.pick() = if (dark) this.dark else this.light
    return WindmillPalette(
        canvas = WindmillColor.surfaceCanvas.pick(),
        surface = WindmillColor.surfaceCanvas.pick(),
        ink = WindmillColor.textPrimary.pick(),
        inkDim = WindmillColor.textSecondary.pick(),
        line = WindmillColor.borderSubtle.pick(),
        lineStrong = WindmillColor.borderDefault.pick(),
        accent = WindmillColor.gold400,
        onAccent = WindmillColor.onAccent,
        noticeWash = WindmillColor.gold400.copy(alpha = 0.14f),
        noticeInk = WindmillColor.neutral700.pick(),
    )
}

object WindmillFont {
    fun display(size: Int, weight: FontWeight = FontWeight.Bold) = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = weight,
        fontSize = size.sp,
    )

    fun body(size: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = weight,
        fontSize = size.sp,
    )

    fun mono(size: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = weight,
        fontSize = size.sp,
    )
}

// The brand's text roles in the system sans: the reading ramp every product's prose uses, and the shell's own titles.
// `WindmillFont` builds them; screens read these roles, never a size.
object WindmillType {
    val body = WindmillFont.body(16)
    val paragraph = WindmillFont.body(16).copy(lineHeight = 22.sp)
    val paragraphLoose = WindmillFont.body(16).copy(lineHeight = 24.sp)
    val paragraphSmall = WindmillFont.body(15).copy(lineHeight = 22.sp)
    val label = WindmillFont.body(16, FontWeight.Bold)
    val labelParagraph = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp)
    val rowLabel = WindmillFont.body(15, FontWeight.Bold).copy(lineHeight = 22.sp)
    val supporting = WindmillFont.body(14)
    val supportingParagraph = WindmillFont.body(14).copy(lineHeight = 20.sp)
    val kicker = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp)
    val detail = WindmillFont.body(13).copy(lineHeight = 18.sp)
    val detailCompact = WindmillFont.body(13)
    val detailLabel = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp)
    val caption = WindmillFont.body(12).copy(lineHeight = 16.sp)
    val captionCompact = WindmillFont.body(12)
    val headline = WindmillFont.body(22, FontWeight.Bold).copy(lineHeight = 28.sp)
    val outcomeTitle = WindmillFont.body(22, FontWeight.ExtraBold).copy(lineHeight = 28.sp)
    val sheetTitle = WindmillFont.body(26, FontWeight.ExtraBold).copy(lineHeight = 32.sp)
    val doorTitle = WindmillFont.body(26, FontWeight.Bold).copy(lineHeight = 36.sp)
}

object WindmillSpace {
    val x1 = 4.dp
    val x2 = 8.dp
    val x3 = 12.dp
    val x4 = 16.dp
    val x5 = 20.dp
    val x6 = 24.dp
    val x8 = 32.dp
    val x10 = 40.dp
    val x12 = 48.dp
    val x16 = 64.dp
}

object WindmillRadius {
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val full = 999.dp
}

object WindmillMotion {
    val easeSoft: Easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
    const val fastMs = 150
    const val baseMs = 280
    const val slowMs = 480
}
