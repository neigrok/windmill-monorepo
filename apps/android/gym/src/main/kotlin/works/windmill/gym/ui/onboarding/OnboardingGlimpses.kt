package works.windmill.gym.ui.onboarding

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import works.windmill.gym.R
import works.windmill.gym.ui.GymColors
import works.windmill.gym.ui.LocalGymColors
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.WindmillColor
import works.windmill.platform.design.WindmillMotion

val OnboardingNunito = FontFamily(
    Font(R.font.onboarding_nunito_regular, FontWeight.Normal),
    Font(R.font.onboarding_nunito_bold, FontWeight.Bold),
    Font(R.font.onboarding_nunito_extrabold, FontWeight.ExtraBold),
)
val OnboardingInter = FontFamily(
    Font(R.font.onboarding_inter_regular, FontWeight.Normal),
    Font(R.font.onboarding_inter_medium, FontWeight.Medium),
    Font(R.font.onboarding_inter_semibold, FontWeight.SemiBold),
)
val OnboardingMono = FontFamily(
    Font(R.font.onboarding_mono_regular, FontWeight.Normal),
    Font(R.font.onboarding_mono_medium, FontWeight.Medium),
)

private val easeStandard = CubicBezierEasing(0.4f, 0f, 0.2f, 1f)
private val easeGlow = CubicBezierEasing(0.45f, 0f, 0.15f, 1f)

@Composable
fun OnboardingGlimpse(page: Int, active: Boolean, reducedMotion: Boolean, modifier: Modifier = Modifier) {
    val dark = LocalWindmillDark.current
    val gym = LocalGymColors.current
    val beat = remember(page) { Animatable(1f) }
    val breath = if (page == 1 && active && !reducedMotion) {
        val transition = rememberInfiniteTransition(label = "Root crown")
        val phase by transition.animateFloat(0.5f, 0.5f, infiniteRepeatable(keyframes {
            durationMillis = 2400
            0.5f at 0 using easeGlow
            1f at 600 using easeGlow
            0f at 1800 using easeGlow
            0.5f at 2400
        }), label = "Crown breath")
        phase
    } else 0.5f
    var caret by remember(page) { mutableStateOf(true) }
    val duration = if (reducedMotion) 150 else when (page) {
        0 -> 920
        1 -> 637
        2 -> 480
        else -> 870
    }

    LaunchedEffect(page, active, reducedMotion) {
        if (!active) {
            beat.animateTo(1f, tween(150))
            return@LaunchedEffect
        }
        withFrameNanos { }
        beat.snapTo(0f)
        beat.animateTo(1f, tween(duration, easing = LinearEasing))
    }
    LaunchedEffect(page, active, reducedMotion) {
        caret = true
        if (page != 2 || !active || reducedMotion) return@LaunchedEffect
        while (true) {
            delay(530)
            caret = !caret
        }
    }

    // The picture owns its type size; accessibility scale applies to the surrounding words.
    CompositionLocalProvider(LocalDensity provides Density(1f, 1f)) {
        val textMeasurer = rememberTextMeasurer(cacheSize = 48)
        Canvas(modifier.clearAndSetSemantics { }) {
            val naturalHeight = if (page == 0) 320f else 340f
            val fit = minOf(size.width / 354f, size.height / naturalHeight)
            translate((size.width - 354f * fit) / 2f, (size.height - naturalHeight * fit) / 2f) {
                scale(fit, fit, Offset.Zero) {
                    val painter = GlimpsePainter(this, textMeasurer, dark, gym)
                    when (page) {
                        0 -> painter.rooms(beat.value, reducedMotion)
                        1 -> painter.roadmap(beat.value, breath, reducedMotion)
                        2 -> painter.journal(beat.value, caret, reducedMotion)
                        3 -> painter.gym(beat.value, reducedMotion)
                    }
                }
            }
        }
    }
}

private data class GlimpsePalette(
    val canvas: Color,
    val card: Color,
    val line: Color,
    val ink: Color,
    val dim: Color,
    val faint: Color,
)

private class GlimpsePainter(
    val draw: DrawScope,
    val measurer: TextMeasurer,
    val dark: Boolean,
    val gymColors: GymColors,
) {
    val roadmap = if (dark) GlimpsePalette(
        Color(0xFF0B0B0C), Color(0xFF171719), Color(0xFF222224), Color(0xFFF2F0EB),
        Color(0xFFB4B2AC), Color(0xFF7E7C77),
    ) else GlimpsePalette(
        WindmillColor.neutral50.light, WindmillColor.neutral0.light, WindmillColor.neutral200.light,
        WindmillColor.neutral900.light, WindmillColor.neutral600.light, WindmillColor.neutral500.light,
    )
    val journal = if (dark) GlimpsePalette(
        Color(0xFF0B0E16), Color(0xFF161921), Color(0xFF20232B), Color(0xFFF1F0EC),
        Color(0xFFB6B5B0), Color(0xFF737476),
    ) else GlimpsePalette(
        Color(0xFFF7F7F5), Color.White, Color(0xFFE3E0DA), Color(0xFF2A2118),
        Color(0xFF74654F), Color(0xFF8E8272),
    )
    val lamp = if (dark) Color(0xFFE0B972) else Color(0xFF986B1E)
    val terracotta = if (dark) Color(0xFFD98B5F) else Color(0xFFBC6C42)
    val olive = if (dark) Color(0xFF9DAF5C) else WindmillColor.olive500
    val sky = if (dark) Color(0xFF9CBCCA) else Color(0xFF5F8494)
    val gold = if (dark) Color(0xFFE2C274) else Color(0xFFC4972F)
    val accent = if (dark) gymColors.accent else Color(0xFF137A6C)
    val onAccent = if (dark) gymColors.onAccent else Color.White

    fun text(
        content: String, x: Float, y: Float, size: Int, color: Color,
        family: FontFamily = OnboardingInter, weight: FontWeight = FontWeight.Normal,
        width: Int = 354, lineHeight: Int = size + 4, tracking: Float = 0f,
        centered: Boolean = false, right: Boolean = false,
    ) {
        val layout = measurer.measure(
            AnnotatedString(content),
            TextStyle(
                fontFamily = family, fontWeight = weight, fontSize = size.sp, lineHeight = lineHeight.sp,
                letterSpacing = tracking.sp, platformStyle = PlatformTextStyle(includeFontPadding = false),
            ),
            constraints = Constraints(maxWidth = width),
        )
        val left = when {
            centered -> x - layout.size.width / 2f
            right -> x - layout.size.width
            else -> x
        }
        val monoInset = if (family == OnboardingMono) maxOf(0f, (size * 1.32f - lineHeight) / 2f) else 0f
        draw.drawText(layout, color = color, topLeft = Offset(left, y - monoInset))
    }

    fun card(height: Float, color: Color, line: Color, radius: Float = 24f, content: () -> Unit) {
        val path = Path().apply { addRoundRect(RoundRect(Rect(0f, 0f, 354f, height), radius, radius)) }
        draw.clipPath(path) {
            draw.drawRect(color, size = Size(354f, height))
            content()
        }
        draw.drawRoundRect(
            line, Offset(0.5f, 0.5f), Size(353f, height - 1f), CornerRadius(radius, radius), style = Stroke(1f),
        )
    }

    fun edge(from: Offset, to: Offset, color: Color, width: Float = 2f) {
        val bend = (to.x - from.x) * 0.5f
        val path = Path().apply {
            moveTo(from.x, from.y)
            cubicTo(from.x + bend, from.y, to.x - bend, to.y, to.x, to.y)
        }
        draw.drawPath(path, color, style = Stroke(width, cap = StrokeCap.Round))
    }

    fun node(center: Offset, radius: Float, fill: Color, ring: Color, width: Float = 2f) {
        draw.drawCircle(fill, radius, center)
        draw.drawCircle(ring, radius - width / 2f, center, style = Stroke(width))
    }

    fun glow(center: Offset, radius: Float, strength: Float) {
        draw.drawCircle(
            Brush.radialGradient(
                0f to lamp.copy(alpha = strength),
                0.5f to lamp.copy(alpha = strength),
                0.72f to lamp.copy(alpha = strength * 0.5f),
                0.9f to lamp.copy(alpha = strength * 0.05f),
                1f to Color.Transparent,
                center = center, radius = radius,
            ),
            radius = radius, center = center,
        )
    }

    fun caption(color: Color) {
        text("EXAMPLE", 338f, 14f, 10, color, OnboardingMono, FontWeight.Medium, tracking = 1.2f, right = true)
    }

    fun roadmap(progress: Float, breath: Float, reduced: Boolean) {
        val travel = if (reduced) progress else easeStandard.transform((progress * 637f / 420f).coerceIn(0f, 1f))
        val ignite = if (reduced) progress else easeStandard.transform(((progress * 637f - 240f) / 280f).coerceIn(0f, 1f))
        card(340f, roadmap.canvas, roadmap.line) {
            val root = Offset(72f, 172f)
            val open = listOf(Offset(176f, 88f), Offset(176f, 172f), Offset(176f, 256f))
            val locked = listOf(Offset(282f, 64f), Offset(282f, 148f), Offset(282f, 232f))
            val dormant = if (dark) Color(0xFF2E2E32) else WindmillColor.neutral300.light
            val lit = if (dark) Color(0xFF7E7C77) else Color(0xFF9C6B44)
            open.zip(locked).forEach { (from, to) -> edge(from, to, dormant, 1.5f) }
            edge(root, open[0], lit)
            edge(root, open[2], lit)
            edge(root, open[1], dormant)
            draw.drawLine(lit.copy(alpha = if (reduced) travel else 1f), root,
                Offset(root.x + 104f * (if (reduced) 1f else travel), root.y), strokeWidth = 2f)
            if (!reduced && progress > 0f && progress * 637f < 420f) {
                val head = Offset(root.x + 104f * travel, root.y)
                draw.drawLine(Brush.horizontalGradient(listOf(Color.Transparent, roadmap.ink),
                    head.x - 24f, head.x), Offset(head.x - 24f, head.y), head, strokeWidth = 2f)
                draw.drawCircle(roadmap.ink, 3.5f, head)
            }
            draw.drawCircle(olive.copy(alpha = if (reduced) 0.28f else 0.22f + 0.12f * breath),
                if (reduced) 26f else 24f + 4f * breath, root)
            node(root, 15f, olive, if (dark) Color(0xFFB6C385) else olive)
            node(open[0], 13f, terracotta, if (dark) Color(0xFFE2A887) else terracotta)
            node(open[1], 13f, roadmap.card, sky.copy(alpha = 0.35f + 0.65f * ignite))
            node(open[2], 13f, roadmap.card, gold)
            listOf(terracotta, sky, gold).zip(locked).forEach { (kind, center) ->
                node(center, 11f, kind.copy(alpha = 0.22f).compositeOver(roadmap.canvas), kind.copy(alpha = 0.35f), 1.5f)
            }
            text("Learn to sail", 72f, 192f, 12, roadmap.ink, weight = FontWeight.SemiBold, centered = true, lineHeight = 16)
            listOf("Knots & lines", "Rig the mast", "Points of sail").forEachIndexed { index, label ->
                text(label, 176f, 106f + index * 84f, 12, roadmap.ink, weight = FontWeight.Medium, centered = true, lineHeight = 16)
            }
            listOf("Capsize drill", "Reefing", "Read the wind").forEachIndexed { index, label ->
                text(label, 282f, 80f + index * 84f, 12, roadmap.faint, weight = FontWeight.Medium, centered = true, lineHeight = 16)
            }
            caption(roadmap.faint)
        }
    }

    fun journal(progress: Float, caret: Boolean, reduced: Boolean) {
        card(340f, journal.canvas, journal.line) {
            glow(Offset(177f, 371f), 220f, (if (dark) 0.18f else 0.12f) *
                if (reduced) progress else easeGlow.transform(progress))
            text("YESTERDAY", 24f, 22f, 10, journal.faint, OnboardingMono, FontWeight.Medium, tracking = 1.2f)
            text("Walked before work. Slept better than the week before.", 24f, 43f,
                15, journal.dim, width = 306, lineHeight = 22)
            draw.drawCircle(lamp, 3f, Offset(27f, 125f))
            text("Tonight", 38f, 117f, 14, journal.ink, OnboardingNunito, FontWeight.ExtraBold, lineHeight = 18)
            text("Finished the chapter I kept avoiding.\nLighter than expected", 24f, 144f,
                17, journal.ink, width = 306, lineHeight = 25)
            if (caret) draw.drawRoundRect(lamp, Offset(203f, 169f), Size(2f, 22f), CornerRadius(1f))
            listOf("Mood" to 7, "Energy" to 5).forEachIndexed { index, (label, count) ->
                text(label, 24f, 236f + index * 24f, 11, journal.faint.copy(alpha = 0.55f), lineHeight = 14)
                repeat(count) { dot ->
                    draw.drawCircle(journal.faint.copy(alpha = 0.55f), 4.5f,
                        Offset(85f + dot * 18f, 243f + index * 24f), style = Stroke(0.8f))
                }
            }
            text("saved", 338f, 310f, 10, journal.faint, OnboardingMono, tracking = 0.6f, right = true)
            caption(journal.faint)
        }
    }

    fun gym(progress: Float, reduced: Boolean) {
        val elapsed = progress * 870f
        val done = if (reduced) progress else easeStandard.transform(((elapsed - 150f) / 320f).coerceIn(0f, 1f))
        val logged = if (reduced) progress else WindmillMotion.easeSoft.transform(((elapsed - 590f) / 280f).coerceIn(0f, 1f))
        card(340f, gymColors.canvas, if (dark) gymColors.lineStrong else gymColors.line) {
            text("Squat", 20f, 18f, 22, gymColors.ink, OnboardingNunito, FontWeight.ExtraBold, lineHeight = 28)
            text("set 3 of 5", 20f, 48f, 11, gymColors.inkDim, OnboardingMono, tracking = 0.4f)
            text("1   ✓   100 kg × 5", 28f, 78f, 12, gymColors.inkDim, OnboardingMono, lineHeight = 16)
            text("2   ✓   100 kg × 5", 28f, 100f, 12, gymColors.inkDim, OnboardingMono, lineHeight = 16)
            draw.drawRoundRect(accent.copy(alpha = if (dark) 0.16f else 0.12f), Offset(20f, 120f), Size(314f, 26f), CornerRadius(8f))
            draw.drawRoundRect(accent, Offset(20f, 120f), Size(3f, 26f), CornerRadius(2f))
            text("Set 3 · target 100 × 5", 32f, 125f, 12, gymColors.ink, OnboardingMono, lineHeight = 16)
            text("100", 18f, 162f, 72, gymColors.ink, OnboardingMono, FontWeight.Medium, lineHeight = 80, tracking = -2f)
            text("kg × 5", 154f, 208f, 18, gymColors.inkDim, OnboardingMono, lineHeight = 24)
            text("Last time · 97.5 kg × 5", 20f, 252f, 11, gymColors.inkFaint, OnboardingMono, tracking = 0.3f)
            val press = if (reduced || elapsed >= 150f) 1f else 1f - 0.03f *
                (1f - kotlin.math.abs(elapsed - 75f) / 75f)
            draw.scale(press, press, Offset(285.5f, 298f)) {
                draw.drawRoundRect(accent, Offset(237f, 276f), Size(97f, 44f), CornerRadius(22f))
                text("Log set", 285.5f, 288f, 15, onAccent, OnboardingNunito, FontWeight.ExtraBold,
                    centered = true, lineHeight = 20)
            }
            draw.drawCircle(gymColors.setDone.copy(alpha = done), 11f, Offset(31f, 299f))
            check(Offset(31f, 299f), gymColors.onAccent, if (reduced) 1f else done, alpha = done)
            text("Set 3 logged", 50f, 291f, 11, gymColors.inkDim.copy(alpha = logged), OnboardingMono)
            caption(gymColors.inkFaint)
        }
    }

    fun check(center: Offset, color: Color, progress: Float = 1f, alpha: Float = 1f) {
        val first = Offset(center.x - 4f, center.y)
        val elbow = Offset(center.x - 1f, center.y + 3f)
        val end = Offset(center.x + 5f, center.y - 4f)
        val part = (progress / 0.35f).coerceIn(0f, 1f)
        draw.drawLine(color.copy(alpha = alpha), first, first + (elbow - first) * part,
            strokeWidth = 1.6f, cap = StrokeCap.Round)
        if (progress > 0.35f) draw.drawLine(color.copy(alpha = alpha), elbow,
            elbow + (end - elbow) * ((progress - 0.35f) / 0.65f), strokeWidth = 1.6f, cap = StrokeCap.Round)
    }

    fun rooms(progress: Float, reduced: Boolean) {
        val palettes = listOf(roadmap, journal, GlimpsePalette(gymColors.canvas, gymColors.surface,
            if (dark) gymColors.lineStrong else gymColors.line, gymColors.ink, gymColors.inkDim, gymColors.inkFaint))
        palettes.forEachIndexed { index, palette ->
            val appear = if (reduced) progress else WindmillMotion.easeSoft.transform(
                ((progress * 920f - index * 320f) / 280f).coerceIn(0f, 1f))
            draw.translate(0f, index * 110f + if (reduced) 0f else (1f - appear) * 8f) {
                draw.drawContext.canvas.saveLayer(Rect(0f, 0f, 354f, 100f), androidx.compose.ui.graphics.Paint().apply { alpha = appear })
                card(100f, palette.canvas, palette.line, 20f) {
                    val dot = when (index) { 0 -> terracotta; 1 -> lamp; else -> accent }
                    draw.drawCircle(dot, 3.5f, Offset(24f, 33f))
                    text(listOf("Roadmap", "Journal", "Gym")[index], 36f, 22f, 18, palette.ink,
                        OnboardingNunito, FontWeight.ExtraBold, lineHeight = 22)
                    text(listOf("Map what you're learning", "Notice what happened", "Keep a training log")[index],
                        36f, 50f, 13, palette.dim, lineHeight = 18)
                    when (index) {
                        0 -> {
                            val root = Offset(258f, 50f)
                            val skyNode = Offset(302f, 32f)
                            val clayNode = Offset(302f, 68f)
                            val lit = if (dark) roadmap.faint else Color(0xFF9C6B44)
                            val dormant = if (dark) Color(0xFF2E2E32) else WindmillColor.neutral300.light
                            edge(root, skyNode, lit, 1.5f); edge(root, clayNode, lit, 1.5f)
                            edge(skyNode, Offset(332f, 20f), dormant, 1f)
                            edge(clayNode, Offset(332f, 80f), dormant, 1f)
                            draw.drawCircle(olive.copy(alpha = 0.28f), 15f, root)
                            node(root, 9f, olive, if (dark) Color(0xFFB6C385) else olive, 1.5f)
                            node(skyNode, 7f, roadmap.card, sky, 1.5f)
                            node(clayNode, 7f, terracotta, if (dark) Color(0xFFE2A887) else terracotta, 1.5f)
                            node(Offset(332f, 20f), 6f, sky.copy(alpha = 0.22f).compositeOver(roadmap.canvas), sky.copy(alpha = 0.35f), 1f)
                            node(Offset(332f, 80f), 6f, gold.copy(alpha = 0.22f).compositeOver(roadmap.canvas), gold.copy(alpha = 0.35f), 1f)
                        }
                        1 -> {
                            glow(Offset(300f, 120f), 106f, if (dark) 0.24f else 0.12f)
                            draw.drawRoundRect(journal.faint.copy(alpha = 0.7f), Offset(254f, 30f), Size(72f, 3f), CornerRadius(2f))
                            draw.drawRoundRect(journal.faint.copy(alpha = 0.7f), Offset(254f, 40f), Size(46f, 3f), CornerRadius(2f))
                            draw.drawRoundRect(journal.ink, Offset(254f, 62f), Size(60f, 3f), CornerRadius(2f))
                            draw.drawRoundRect(lamp, Offset(320f, 56f), Size(2f, 14f), CornerRadius(1f))
                        }
                        2 -> {
                            text("100", 240f, 26f, 30, gymColors.ink, OnboardingMono, FontWeight.Medium,
                                lineHeight = 34, tracking = -1f)
                            text("kg × 5", 240f, 62f, 11, gymColors.inkDim, OnboardingMono)
                            draw.drawCircle(accent, 11f, Offset(327f, 50f))
                            check(Offset(327f, 50f), onAccent)
                        }
                    }
                }
                draw.drawContext.canvas.restore()
            }
        }
    }
}
