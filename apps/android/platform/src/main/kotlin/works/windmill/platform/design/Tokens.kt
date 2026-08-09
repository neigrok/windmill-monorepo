package works.windmill.platform.design

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The brand's scales for native, plus the one treatment where two of them must be chosen together.
// The values are the ones web/src/styles/tokens/colors.css holds, mirrored BY HAND: nothing checks
// the surfaces against each other (packages/design-tokens, which would, is still only a README),
// so a hue that moves on one surface has to be carried to the others. Product-neutral by
// construction: a product that needs its own surface (gym's basalt, journal's night) overrides
// these inside its own scope, exactly as the web products override role tokens inside their class.

// One token, two skins, resolved by this local rather than by a branch at the call site — so a
// view never has to ask which appearance it is in. It defaults to dark because the v1 app IS dark
// (one room, and it pins basalt); the pair keeps the future, for a shell whose hub provides false.
val LocalWindmillDark = staticCompositionLocalOf { true }

@Immutable
class WindmillShade(light: Long, dark: Long) {
    val light: Color = Color(0xFF000000 or light)
    val dark: Color = Color(0xFF000000 or dark)

    val color: Color
        @Composable @ReadOnlyComposable get() = if (LocalWindmillDark.current) dark else light
}

// The ramp is ADAPTIVE and the roles below are aliases onto it — the same structure
// web/src/styles/tokens/colors.css uses, where `[data-theme="dark"]` re-authors the ramp and every
// role token that references it follows for free. The dark ramp is re-authored, never a linear
// inversion: low indices stay deep warm surfaces and high indices become warm off-whites for text,
// so a role that meant "canvas" still means canvas.
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

    // Ink for text that sits ON a bright accent fill. Fixed in both skins: the fill is the same
    // gold either way, so the ink on it must be too — 8.92:1 on gold400, where the adaptive ramp
    // reaches for its dark end and reads 1.77:1.
    val onAccent = Color(0xFF1B1408)

    val surfaceCanvas = neutral50
    val surfaceCard = neutral0
    val textPrimary = neutral900
    val textSecondary = neutral600
    val textTertiary = neutral500
    val borderSubtle = neutral200
    val borderDefault = neutral300
}

// tokens/fonts.css names the brand faces and then the native fallback for each: ui-rounded for
// display and body, ui-monospace for numerals. On iOS those are SF Rounded and SF Mono; Android
// has no system rounded face, so v1 keeps the token's weights on the default sans rather than
// bundling a face the design has not chosen (design.md: do NOT bundle fonts in v1).
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

// Keep animation restrained — this is an instrument, not a toy.
object WindmillMotion {
    val easeSoft: Easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
    const val fastMs = 150
    const val baseMs = 280
    const val slowMs = 480
}

// The weight of an action, and with it BOTH of the colours that say so. Fill and ink were two
// separate decisions at every call site on iOS, and every gold capsule in the app picked the
// adaptive ramp for its label — warm near-white on gold, 1.77:1. Pairing them in one composable is
// what stops that being writable again, rather than merely fixed once.
enum class ActionWeight { Primary, Quiet }

@Composable
fun ActionCapsule(
    label: String,
    weight: ActionWeight,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WindmillRadius.full)
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = 46.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(shape)
            .then(
                when (weight) {
                    ActionWeight.Primary -> Modifier.background(WindmillColor.gold400)
                    ActionWeight.Quiet -> Modifier.border(1.dp, WindmillColor.borderDefault.color, shape)
                }
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = WindmillSpace.x3),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = WindmillFont.body(16, FontWeight.SemiBold),
            color = when (weight) {
                ActionWeight.Primary -> WindmillColor.onAccent
                ActionWeight.Quiet -> WindmillColor.textPrimary.color
            },
        )
    }
}
