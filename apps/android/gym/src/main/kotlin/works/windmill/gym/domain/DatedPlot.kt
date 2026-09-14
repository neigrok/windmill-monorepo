package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToLong

data class DatedPoint(val id: String, val atMs: Long, val value: Double, val label: String)

data class DatedSeries(
    val points: List<DatedPoint>,
    val fromMs: Long,
    val untilMs: Long,
    val zone: ZoneId,
    val maxGapDays: Long,
) {
    val ordered: List<DatedPoint> = points.filter { it.atMs in fromMs..untilMs && it.value.isFinite() }
        .sortedWith(compareBy<DatedPoint> { it.atMs }.thenBy { it.id })

    val gaps: List<Pair<DatedPoint, DatedPoint>> = ordered.zipWithNext().filter { (before, after) ->
        ChronoUnit.DAYS.between(Instant.ofEpochMilli(before.atMs).atZone(zone).toLocalDate(),
            Instant.ofEpochMilli(after.atMs).atZone(zone).toLocalDate()) > maxGapDays
    }
}

class DatedGeometry(
    val series: DatedSeries,
    width: Float,
    height: Float,
    minimumPitch: Float = 0f,
    pan: Float = 0f,
) {
    data class Point(val fact: DatedPoint, val x: Float, val y: Float)

    val width = width.coerceAtLeast(1f)
    val height = height.coerceAtLeast(1f)
    val duration = (series.untilMs.toDouble() - series.fromMs.toDouble()).coerceAtLeast(1.0)
    val axis: ClosedFloatingPointRange<Double> = run {
        val low = series.ordered.minOfOrNull { it.value } ?: 0.0
        val high = series.ordered.maxOfOrNull { it.value } ?: 1.0
        val padding = max((high - low) * 0.1, 0.25)
        val rough = (high - low + 2 * padding) / 4
        val power = 10.0.pow(floor(log10(rough)))
        val step = listOf(1.0, 2.0, 2.5, 5.0, 10.0).first { it * power >= rough } * power
        floor((low - padding) / step) * step..ceil((high + padding) / step) * step
    }
    val ticks = listOf(axis.endInclusive, (axis.start + axis.endInclusive) / 2, axis.start)
    val contentWidth: Float = run {
        val dates = series.ordered.map { it.atMs }.distinct()
        val span = ((dates.lastOrNull() ?: 0).toDouble() - (dates.firstOrNull() ?: 0).toDouble())
        if (span <= 0) return@run this.width
        max(this.width.toDouble(), (dates.size - 1) * minimumPitch * duration / span).toFloat()
    }
    val maxPan = (contentWidth - this.width).coerceAtLeast(0f)
    val pan = pan.coerceIn(0f, maxPan)
    val points = series.ordered.map { point ->
        Point(point, x(point.atMs), y(point.value))
    }
    val segments = series.gaps.toSet().let { gaps ->
        points.zipWithNext().filter { (before, after) -> (before.fact to after.fact) !in gaps }
    }
    val visible = points.filter { it.x in 0f..this.width }
    val fromMs = time(0f)
    val untilMs = time(this.width)

    fun x(atMs: Long): Float {
        if (series.fromMs == series.untilMs) return width / 2
        return ((atMs.toDouble() - series.fromMs.toDouble()) / duration * contentWidth).toFloat() - maxPan + pan
    }

    fun y(value: Double): Float =
        ((axis.endInclusive - value) / (axis.endInclusive - axis.start) * height).toFloat()

    fun time(x: Float): Long =
        (series.fromMs.toDouble() + ((x.toDouble() + maxPan - pan) / contentWidth) * duration).roundToLong()
            .coerceIn(series.fromMs, max(series.fromMs, series.untilMs))

    fun nearest(x: Float): DatedPoint? = points.minByOrNull { abs(it.x - x) }?.fact

    fun hit(x: Float, y: Float, radius: Float): DatedPoint? {
        if (x !in 0f..width || y !in 0f..height) return null
        val point = visible.minByOrNull { hypot(it.x - x, it.y - y) } ?: return null
        return point.fact.takeIf { hypot(point.x - x, point.y - y) <= radius }
    }

    fun panBy(delta: Float): Float = (pan + delta).coerceIn(0f, maxPan)

    fun reveal(id: String): Float {
        val point = points.firstOrNull { it.fact.id == id } ?: return pan
        if (point.x < 0) return panBy(1f - point.x)
        if (point.x > width) return panBy(width - 1f - point.x)
        return pan
    }
}
