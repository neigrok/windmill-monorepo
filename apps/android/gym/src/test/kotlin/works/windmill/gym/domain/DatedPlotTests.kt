package works.windmill.gym.domain

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import org.junit.Assert.*
import org.junit.Test

class DatedPlotTests {
    @Test
    fun irregularDatesAndIdleTimeKeepTheirActualProportions() {
        val points = listOf(0L, 2L, 10L).map { DatedPoint("$it", it * 86_400_000, 50.0 + it, "$it days") }
        val series = DatedSeries(points, 0, 20 * 86_400_000L, ZoneOffset.UTC, 21)
        val plot = DatedGeometry(series, 200f, 100f)
        assertEquals(listOf(0f, 20f, 100f), plot.points.map { it.x })
        assertEquals(0L, plot.fromMs)
        assertEquals(20 * 86_400_000L, plot.untilMs)
        assertEquals(listOf("0" to "2", "2" to "10"), plot.segments.map { it.first.fact.id to it.second.fact.id })
        assertEquals("2", plot.nearest(31f)?.id)
    }

    @Test
    fun denseHistoryStartsAtTheLatestEndAndPansWithinTheRealTimeBounds() {
        val points = (0..30).map { DatedPoint("$it", it * 86_400_000L, it.toDouble(), "Day $it") }
        val series = DatedSeries(points, 0, points.last().atMs, ZoneOffset.UTC, 21)
        val latest = DatedGeometry(series, 240f, 100f, minimumPitch = 24f)
        assertEquals(720f, latest.contentWidth)
        assertEquals(480f, latest.maxPan)
        assertEquals((20..30).map(Int::toString), latest.visible.map { it.fact.id })
        assertEquals(20 * 86_400_000L, latest.fromMs)
        assertEquals(30 * 86_400_000L, latest.untilMs)
        assertEquals(480f, latest.reveal("0"))
        assertEquals(0f, latest.panBy(-1_000f))
        val earlier = DatedGeometry(series, 240f, 100f, 24f, latest.panBy(1_000f))
        assertEquals((0..10).map(Int::toString), earlier.visible.map { it.fact.id })
        assertEquals(0L, earlier.fromMs)
        assertEquals(10 * 86_400_000L, earlier.untilMs)
        assertEquals(0f, earlier.reveal("30"))
        assertEquals(latest.axis, earlier.axis)
    }

    @Test
    fun sevenCalendarDaysJoinAndEightBreakEvenAcrossDaylightSavingTime() {
        val zone = ZoneId.of("America/New_York")
        val points = listOf("2026-03-01", "2026-03-08", "2026-03-16").map { date ->
            DatedPoint(date, LocalDate.parse(date).atStartOfDay(zone).toInstant().toEpochMilli(), 82.4, date)
        }
        val series = DatedSeries(points, points.first().atMs, points.last().atMs, zone, 7)
        val plot = DatedGeometry(series, 300f, 180f)
        assertEquals(listOf(points[1] to points[2]), series.gaps)
        assertEquals(listOf(points[0] to points[1]), plot.segments.map { it.first.fact to it.second.fact })
        assertEquals(8 * 86_400_000L - 3_600_000L, points[2].atMs - points[1].atMs)
    }

    @Test
    fun recordGapThresholdIsInclusiveAndClippedPointsDoNotCreateSegments() {
        val points = listOf(-1L, 0L, 21L, 43L).map { DatedPoint("$it", it * 86_400_000, 60.0, "$it") }
        val series = DatedSeries(points, 0, points.last().atMs, ZoneOffset.UTC, 21)
        val plot = DatedGeometry(series, 300f, 180f)
        assertEquals(points.drop(1), series.ordered)
        assertEquals(listOf(points[2] to points[3]), series.gaps)
        assertEquals(listOf(points[1] to points[2]), plot.segments.map { it.first.fact to it.second.fact })
    }

    @Test
    fun simultaneousFactsShareAnXCoordinateAndTiesUseChronologicalIdentity() {
        val points = listOf(DatedPoint("b", 0, 50.0, "B"), DatedPoint("a", 0, 50.0, "A"),
            DatedPoint("c", 100, 60.0, "C"))
        val plot = DatedGeometry(DatedSeries(points, 0, 100, ZoneOffset.UTC, 21), 100f, 100f, 24f)
        assertEquals(listOf("a", "b", "c"), plot.points.map { it.fact.id })
        assertEquals(listOf(0f, 0f, 100f), plot.points.map { it.x })
        assertEquals("a", plot.nearest(0f)?.id)
        assertEquals("a", plot.nearest(50f)?.id)
        assertEquals("a", plot.hit(0f, plot.points.first().y, 24f)?.id)
        assertNull(plot.hit(50f, 50f, 5f))
    }

    @Test
    fun negativeZeroAndEqualValuesRemainFiniteWithoutInventedFacts() {
        val points = listOf(-20.0, 0.0, 20.0).mapIndexed { i, value -> DatedPoint("$i", i.toLong(), value, "$value") }
        val plot = DatedGeometry(DatedSeries(points, 0, 2, ZoneOffset.UTC, 7), 100f, 100f)
        assertEquals(points, plot.points.map { it.fact })
        assertTrue(plot.axis.start < -20)
        assertTrue(plot.axis.endInclusive > 20)
        assertEquals(50f, plot.points[1].y)
        assertTrue(plot.points.all { it.y in 0f..100f })
        val single = DatedGeometry(DatedSeries(listOf(points[0]), 0, 0, ZoneOffset.UTC, 7), 100f, 100f)
        assertEquals(50f, single.points.single().x)
        assertEquals(50f, single.points.single().y)
        assertEquals(emptyList<Pair<DatedGeometry.Point, DatedGeometry.Point>>(), single.segments)
        val empty = DatedGeometry(DatedSeries(emptyList(), 0, 0, ZoneOffset.UTC, 7), 0f, 0f)
        assertEquals(emptyList<DatedGeometry.Point>(), empty.points)
        assertNull(empty.nearest(0f))
        assertNull(empty.hit(0f, 0f, 24f))
        assertTrue(empty.ticks.all(Double::isFinite))
    }
}
