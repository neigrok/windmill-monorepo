package works.windmill.gym.ui

import androidx.compose.animation.core.AnimationState
import androidx.compose.animation.core.animateDecay
import androidx.compose.animation.rememberSplineBasedDecay
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.traversalIndex
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt
import works.windmill.gym.domain.DatedGeometry
import works.windmill.gym.domain.DatedPoint
import works.windmill.gym.domain.DatedSeries
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont

enum class PlotInteraction { Preview, Inspect, Select }
private enum class PlotGesture { Hold, Pan, Yield }

@Composable
fun DatedPlot(
    series: DatedSeries,
    modifier: Modifier = Modifier,
    interaction: PlotInteraction = PlotInteraction.Preview,
    standingBestId: String? = null,
    onInspect: (DatedPoint?) -> Unit = {},
    onSelect: (DatedPoint) -> Unit = {},
    valueLabel: (Double) -> String = Readout::weight,
    gapLabel: ((DatedPoint, DatedPoint) -> String)? = null,
) {
    val skin = LocalGymColors.current
    val density = LocalDensity.current
    val text = rememberTextMeasurer()
    val haptic = rememberGymHaptics()
    val scope = rememberCoroutineScope()
    val decay = rememberSplineBasedDecay<Float>()
    val labelStyle = WindmillFont.body(12).copy(lineHeight = 17.sp, color = skin.inkDim)
    val facts = series.ordered
    var pan by remember(facts, series.fromMs, series.zone, series.maxGapDays) { mutableFloatStateOf(0f) }
    var inspected by remember(facts, series.fromMs, series.zone, series.maxGapDays) { mutableStateOf<DatedPoint?>(null) }
    var fling by remember { mutableStateOf<Job?>(null) }
    val inspect by rememberUpdatedState<(DatedPoint?) -> Unit> { point ->
        if (point != inspected) {
            if (point != null && point.id != inspected?.id) haptic.revealed()
            inspected = point
            onInspect(point)
        }
    }
    val select by rememberUpdatedState(onSelect)
    val preview = interaction == PlotInteraction.Preview
    val firstDate = Instant.ofEpochMilli(series.fromMs).atZone(series.zone).toLocalDate()
    val lastDate = Instant.ofEpochMilli(series.untilMs).atZone(series.zone).toLocalDate()
    val dateFormat = DateTimeFormatter.ofPattern(if (firstDate.year == lastDate.year) "d MMM" else "d MMM yy", Locale.getDefault())
    val gapFormat = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault())
    if (interaction == PlotInteraction.Inspect) {
        DisposableEffect(facts, series.fromMs, series.zone, series.maxGapDays) {
            onDispose { fling?.cancel(); inspect(null) }
        }
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val width = constraints.maxWidth.toFloat()
            val inset = with(density) { 6.dp.toPx() }
            val axis = DatedGeometry(series, width, 1f)
            val ticks = if (preview) listOf(axis.ticks.first(), axis.ticks.last()) else axis.ticks
            val values = ticks.map { text.measure(AnnotatedString(valueLabel(it)), labelStyle) }
            val valueHeight = values.maxOf { it.size.height }.toFloat()
            val left = values.maxOf { it.size.width }.toFloat() + 2 * inset
            val plotWidth = (width - left - inset).coerceAtLeast(1f)
            val pitch = with(density) { if (interaction == PlotInteraction.Inspect) 24.dp.toPx() else 0f }
            val horizontal = DatedGeometry(series, plotWidth, 1f, pitch, pan)
            val dates = listOf(horizontal.fromMs, horizontal.untilMs).map {
                dateFormat.format(Instant.ofEpochMilli(it).atZone(series.zone))
            }.distinct()
            val dateLabels = dates.map {
                text.measure(AnnotatedString(it), labelStyle, maxLines = 2,
                    constraints = Constraints(maxWidth = (plotWidth / dates.size - inset).toInt().coerceAtLeast(1)))
            }
            val dateHeight = dateLabels.maxOf { it.size.height }.toFloat()
            val top = valueHeight / 2 + inset
            val height = max(with(density) { (if (preview) 90.dp else 220.dp).toPx() },
                dateHeight + 2 * top + with(density) { (if (preview) 28.dp else 72.dp).toPx() })
            val plotHeight = (height - dateHeight - 2 * inset - top * 2).coerceAtLeast(1f)
            val geometry = DatedGeometry(series, plotWidth, plotHeight, pitch, pan)
            val currentGeometry by rememberUpdatedState(geometry)
            val actions = if (interaction != PlotInteraction.Inspect || series.ordered.isEmpty()) emptyList() else {
                val index = series.ordered.indexOfFirst { it.id == inspected?.id }.takeIf { it >= 0 } ?: series.ordered.lastIndex
                buildList {
                    if (index > 0) add(CustomAccessibilityAction("Earlier session") {
                        fling?.cancel()
                        val point = series.ordered[index - 1]
                        pan = currentGeometry.reveal(point.id)
                        inspect(point)
                        true
                    })
                    if (index < series.ordered.lastIndex) add(CustomAccessibilityAction("Later session") {
                        fling?.cancel()
                        val point = series.ordered[index + 1]
                        pan = currentGeometry.reveal(point.id)
                        inspect(point)
                        true
                    })
                }
            }
            val gestures = when (interaction) {
                PlotInteraction.Preview -> Modifier
                PlotInteraction.Select -> Modifier.pointerInput(series, left, top) {
                    detectTapGestures { position ->
                        currentGeometry.hit(position.x - left, position.y - top, 24.dp.toPx())?.let(select)
                    }
                }
                PlotInteraction.Inspect -> Modifier.pointerInput(facts, series.fromMs, series.zone, series.maxGapDays, left, top) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        fling?.cancel()
                        if (down.position.x !in left..(left + currentGeometry.width) ||
                            down.position.y !in top..(top + currentGeometry.height)) return@awaitEachGesture
                        val velocity = VelocityTracker()
                        velocity.addPosition(down.uptimeMillis, down.position)
                        var gesture = PlotGesture.Hold
                        var last = down
                        withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            while (gesture == PlotGesture.Hold) {
                                val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id }
                                if (change == null || change.isConsumed || !change.pressed) {
                                    gesture = PlotGesture.Yield
                                    break
                                }
                                last = change
                                val distance = last.position - down.position
                                if (distance.getDistance() > viewConfiguration.touchSlop) {
                                    gesture = if (abs(distance.x) > abs(distance.y)) PlotGesture.Pan else PlotGesture.Yield
                                }
                            }
                        }
                        if (gesture == PlotGesture.Yield) return@awaitEachGesture
                        val scrub = gesture == PlotGesture.Hold
                        try {
                            velocity.addPosition(last.uptimeMillis, last.position)
                            if (scrub) inspect(currentGeometry.nearest(last.position.x - left))
                            else pan = (pan + last.position.x - down.position.x).coerceIn(0f, currentGeometry.maxPan)
                            last.consume()
                            while (last.pressed) {
                                last = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                                if (last.isConsumed) break
                                velocity.addPosition(last.uptimeMillis, last.position)
                                if (scrub) inspect(currentGeometry.nearest(last.position.x - left))
                                else pan = (pan + last.positionChange().x).coerceIn(0f, currentGeometry.maxPan)
                                last.consume()
                            }
                            if (!scrub && !last.pressed) {
                                val speed = velocity.calculateVelocity().x
                                if (abs(speed) > 50.dp.toPx()) fling = scope.launch {
                                    AnimationState(initialValue = pan, initialVelocity = speed).animateDecay(decay) {
                                        pan = value.coerceIn(0f, currentGeometry.maxPan)
                                        if (pan != value) cancelAnimation()
                                    }
                                }
                            }
                        } finally {
                            inspect(null)
                        }
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(with(density) { height.toDp() }).then(gestures).then(
                if (interaction == PlotInteraction.Inspect) Modifier.semantics {
                    isTraversalGroup = true
                    contentDescription = "Session estimates"
                    stateDescription = (inspected ?: series.ordered.lastOrNull())?.label.orEmpty()
                    liveRegion = LiveRegionMode.Polite
                    customActions = actions
                } else Modifier,
            )) {
                Canvas(Modifier.fillMaxWidth().height(with(density) { height.toDp() })) {
                    ticks.forEach { value ->
                        val y = top + geometry.y(value)
                        drawLine(skin.line, Offset(left, y), Offset(left + plotWidth, y), 1.dp.toPx())
                    }
                    clipRect(left - inset, top - inset, left + plotWidth + inset, top + plotHeight + inset) {
                        geometry.segments.forEach { (before, after) ->
                            drawLine(skin.accent, Offset(left + before.x, top + before.y),
                                Offset(left + after.x, top + after.y), 2.dp.toPx())
                        }
                        geometry.visible.forEach { point ->
                            val best = point.fact.id == standingBestId
                            val radius = when {
                                best -> 5.dp.toPx()
                                interaction == PlotInteraction.Select -> 4.dp.toPx()
                                else -> 3.5.dp.toPx()
                            }
                            if (point.fact.id == inspected?.id) drawCircle(skin.accentSoft, radius + 4.dp.toPx(),
                                Offset(left + point.x, top + point.y))
                            drawCircle(if (best) skin.prInk else skin.accent, radius, Offset(left + point.x, top + point.y))
                        }
                    }
                }
                ticks.forEachIndexed { index, value ->
                    Text(valueLabel(value), style = labelStyle, maxLines = 1,
                        modifier = Modifier.offset { IntOffset(0, (top + geometry.y(value) - values[index].size.height / 2f).roundToInt()) }
                            .width(with(density) { values[index].size.width.toDp() }))
                }
                dateLabels.forEachIndexed { index, label ->
                    val x = when {
                        dateLabels.size == 1 -> left + (plotWidth - label.size.width) / 2
                        index == 0 -> left
                        else -> left + plotWidth - label.size.width
                    }
                    Text(dates[index], style = labelStyle, maxLines = 2,
                        modifier = Modifier.offset { IntOffset(x.roundToInt(), (height - dateHeight).roundToInt()) }
                            .width(with(density) { label.size.width.toDp() }))
                }
                if (interaction == PlotInteraction.Inspect) geometry.visible.forEachIndexed { index, point ->
                    Box(Modifier.offset { IntOffset((left + point.x).roundToInt(), (top + point.y).roundToInt()) }
                        .size(1.dp).semantics {
                            contentDescription = point.fact.label + if (point.fact.id == standingBestId) ", standing best" else ""
                            traversalIndex = index.toFloat()
                        })
                }
            }
        }
        if (!preview) series.gaps.forEach { (before, after) ->
            val label = gapLabel?.invoke(before, after) ?: "No data · " +
                gapFormat.format(Instant.ofEpochMilli(before.atMs).atZone(series.zone)) + " – " +
                gapFormat.format(Instant.ofEpochMilli(after.atMs).atZone(series.zone))
            Text(label, style = labelStyle, modifier = Modifier.fillMaxWidth())
        }
    }
}
