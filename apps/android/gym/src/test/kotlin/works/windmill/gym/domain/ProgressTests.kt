package works.windmill.gym.domain

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class ProgressTests {
    @Test
    fun equivalentEstimatesKeepTheFirstSessionAndLowestSetIdentity() {
        fun detail(id: String, at: Long, kg: Double, reps: Int) = SessionDetail(
            Session(id, at, finishedAtMs = at + 1),
            listOf(TrainingSet("set-$id", "bench", weightKg = kg, reps = reps, completedAtMs = at)))
        for (lifts in listOf(listOf(70.0 to 10, 80.0 to 5), listOf(80.0 to 5, 70.0 to 10))) {
            val details = lifts.mapIndexed { index, (kg, reps) -> detail("s$index", 100L + index * 10, kg, reps) }
            val movement = StatsProgress.of(details, 200).movement("bench")
            assertEquals("s0", movement.best?.id)
        }
        val combined = detail("same", 100, 70.0, 10).copy(sets = listOf(
            TrainingSet("a", "bench", weightKg = 70.0, reps = 10, completedAtMs = 100),
            TrainingSet("z", "bench", weightKg = 80.0, reps = 5, completedAtMs = 100)))
        assertEquals("a", StatsProgress.of(listOf(combined), 200).movement("bench").best?.fact?.estimate?.setId)
    }

    @Test
    fun rawReducerFindsNonHeaviestWinnerAndDeterministicSameLoadTies() {
        val sets = listOf(
            TrainingSet("heavy", "bench", weightKg = 120.0, reps = 12, rpe = 10.0, completedAtMs = 100),
            TrainingSet("bad", "bench", weightKg = 100.0, reps = 10, rpe = 6.5, completedAtMs = 100),
            TrainingSet("z", "bench", weightKg = 100.0, reps = 5, rpe = 7.0, completedAtMs = 100),
            TrainingSet("a", "bench", weightKg = 100.0, reps = 5, completedAtMs = 100),
            TrainingSet("zero", "pull", weightKg = 0.0, reps = 10, completedAtMs = 100),
            TrainingSet("minus", "pull", weightKg = -20.0, reps = 8, completedAtMs = 100))
        val detail = SessionDetail(Session("session", 100, finishedAtMs = 200), sets)
        assertEquals(listOf(ProgressSession("session", 100, listOf(
            MovementSessionFact("bench", 4, PerformedFact("heavy", 120.0, 12, 10.0), EstimatedFact("a", 100.0, 5, null, 100.0 * (1 + 5 / 30.0))),
            MovementSessionFact("pull", 2, PerformedFact("zero", 0.0, 10), bodyweightReps = PerformedFact("zero", 0.0, 10))))),
            StatsProgress.of(listOf(detail), 300).sessions)
    }

    @Test
    fun chartThresholdAndLifetimePeakAreSeparateFromTheRecentWindow() {
        val zone = ZoneId.of("UTC")
        val today = LocalDate.of(2026, 9, 14)
        fun at(days: Long) = today.minusDays(days).atStartOfDay(zone).toInstant().toEpochMilli()
        fun progress(days: List<Long>) = StatsProgress.of(days.mapIndexed { index, ago -> SessionDetail(Session("s$index", at(ago), at(ago) + 1),
            listOf(TrainingSet("set$index", "bench", weightKg = if (ago == 180L) 200.0 else 100.0, reps = 1, completedAtMs = at(ago)))) }, at(0))
        val progress = progress(listOf(180L, 21L, 14L, 7L, 0L))
        val full = progress.movement("bench")
        val window = full.window(at(0), zone)
        assertEquals("s0", full.best?.id)
        assertEquals("s1", window.best?.id)
        assertEquals(listOf("s1", "s2", "s3", "s4"), window.sessions.map { it.id })
        assertTrue(window.hasChart(zone))
        assertFalse(progress(listOf(180L, 14L, 7L, 0L)).movement("bench").window(at(0), zone).hasChart(zone))
        assertFalse(progress(listOf(180L, 20L, 14L, 7L, 0L)).movement("bench").window(at(0), zone).hasChart(zone))
        assertEquals(100.0, progress.sessionEstimate("s4"))
    }

    @Test
    fun dailyChartPointsKeepTheBestEstimateAndStableTiesInTheChosenZone() {
        val zone = ZoneId.of("Asia/Dubai")
        val first = java.time.Instant.parse("2026-01-01T22:00:00Z").toEpochMilli()
        val now = java.time.Instant.parse("2026-01-03T12:00:00Z").toEpochMilli()
        val rows = listOf(Triple("baseline", first - 7 * 86_400_000, 90.0), Triple("earlier", first, 100.0), Triple("winner", first + 3_600_000, 120.0),
            Triple("tie", first + 7_200_000, 120.0), Triple("tomorrow", first + 86_400_000, 110.0))
        val details = rows.reversed().map { (id, at, kg) -> SessionDetail(Session(id, at, at + 1),
            listOf(TrainingSet("set-$id", "bench", weightKg = kg, reps = 1, completedAtMs = at))) }
        val progress = StatsProgress.of(details, now).movement("bench")
        val series = progressSeries(progress, now, zone, all = true)
        assertEquals(listOf(Triple("baseline", first - 7 * 86_400_000, 90.0), Triple("winner", first + 3_600_000, 120.0), Triple("tomorrow", first + 86_400_000, 110.0)),
            series.ordered.map { Triple(it.id, it.atMs, it.value) })
        assertEquals(listOf("baseline", "earlier", "winner", "tie", "tomorrow"), progress.sessions.map { it.id })
        assertEquals(listOf("earlier", "winner"), StatsProgress.of(details, now).newBests.map { it.sessionId })
        assertNull(series.ordered.firstOrNull { it.id == "earlier" })
        assertEquals("winner", series.ordered.first { it.id == "winner" }.id)
    }

}
