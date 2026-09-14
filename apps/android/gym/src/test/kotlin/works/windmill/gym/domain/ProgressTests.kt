package works.windmill.gym.domain

import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ProgressTests {
    @Test
    fun completeWireKeepsSessionSetEffortAndNoEstimateIdentities() {
        val raw = """{"asOf":500,"sessions":[{"sessionId":"a","startedAt":100,"movements":[{"exerciseId":"bench","workingSetCount":3,"heaviest":{"setId":"heavy","weightKg":100,"reps":12,"rpe":6.5},"estimate":{"setId":"best","weightKg":80,"reps":8,"e1rm":101.33333333333333}},{"exerciseId":"pull","workingSetCount":1,"heaviest":{"setId":"assisted","weightKg":-20,"reps":8}}]}]}"""
        assertEquals(StatsProgress(500, listOf(ProgressSession("a", 100, listOf(
            MovementSessionFact("bench", 3, PerformedFact("heavy", 100.0, 12, 6.5), EstimatedFact("best", 80.0, 8, null, 101.33333333333333)),
            MovementSessionFact("pull", 1, PerformedFact("assisted", -20.0, 8)))))), Json.decodeFromString<StatsProgress>(raw))
    }

    @Test
    fun rawReducerFindsNonHeaviestWinnerAndDeterministicSameLoadTies() {
        val sets = listOf(
            TrainingSet("warmup", "bench", weightKg = 500.0, reps = 1, kind = SetKind.Warmup, completedAtMs = 100),
            TrainingSet("heavy", "bench", weightKg = 120.0, reps = 12, rpe = 10.0, completedAtMs = 100),
            TrainingSet("bad", "bench", weightKg = 100.0, reps = 10, rpe = 6.5, completedAtMs = 100),
            TrainingSet("z", "bench", weightKg = 100.0, reps = 5, rpe = 7.0, completedAtMs = 100),
            TrainingSet("a", "bench", weightKg = 100.0, reps = 5, completedAtMs = 100),
            TrainingSet("zero", "pull", weightKg = 0.0, reps = 10, completedAtMs = 100),
            TrainingSet("minus", "pull", weightKg = -20.0, reps = 8, completedAtMs = 100))
        val detail = SessionDetail(Session("session", 100, finishedAtMs = 200), sets)
        assertEquals(StatsProgress(300, listOf(ProgressSession("session", 100, listOf(
            MovementSessionFact("bench", 4, PerformedFact("heavy", 120.0, 12, 10.0), EstimatedFact("a", 100.0, 5, null, 100.0 * (1 + 5 / 30.0))),
            MovementSessionFact("pull", 2, PerformedFact("zero", 0.0, 10)))))), StatsProgress.of(listOf(detail), 300))
        assertEquals(100.0, StatsProgress.estimate(100.0, 1, null))
        assertEquals(100.0 * (1 + 10 / 30.0), StatsProgress.estimate(100.0, 10, 7.0))
        for (reps in listOf(0, 11, 100)) assertNull(StatsProgress.estimate(100.0, reps, null))
        for (weight in listOf(-20.0, 0.0)) assertNull(StatsProgress.estimate(weight, 5, null))
        assertNull(StatsProgress.estimate(100.0, 5, 6.5))
    }

    @Test
    fun chartThresholdAndLifetimePeakAreSeparateFromUncappedRecentMovements() {
        val zone = ZoneId.of("UTC")
        val today = LocalDate.of(2026, 9, 14)
        fun at(days: Long) = today.minusDays(days).atStartOfDay(zone).toInstant().toEpochMilli()
        val sessions = listOf(180L, 21L, 14L, 7L, 0L).mapIndexed { index, days ->
            ProgressSession("s$index", at(days), (0..16).map { movement ->
                MovementSessionFact("m$movement", 1, PerformedFact("set$index-$movement", 100.0, 1),
                    EstimatedFact("set$index-$movement", if (days == 180L) 200.0 else 100.0, 1, null, if (days == 180L) 200.0 else 100.0))
            })
        }
        val progress = StatsProgress(at(0), sessions)
        assertEquals(17, progress.recentMovements(at(0), zone).size)
        val full = progress.movement("m0")
        val window = full.window(at(0), zone)
        assertEquals("s0", full.best?.id)
        assertEquals("s1", window.best?.id)
        assertEquals(listOf("s1", "s2", "s3", "s4"), window.sessions.map { it.id })
        assertTrue(window.hasChart(zone))
        assertFalse(window.copy(sessions = window.sessions.drop(1)).hasChart(zone))
        assertFalse(window.copy(sessions = window.sessions.mapIndexed { i, row -> if (i == 0) row.copy(startedAt = at(20)) else row }).hasChart(zone))
        assertEquals(100.0, progress.sessionEstimate("s4"))
    }

    @Test
    fun localMondayWeeksUseCalendarBoundariesAcrossDaylightSavingAndIndependentPages() {
        val zone = ZoneId.of("America/New_York")
        fun at(day: String, hour: Long = 12) = LocalDate.parse(day).atStartOfDay(zone).plusHours(hour).toInstant().toEpochMilli()
        val fact = MovementSessionFact("bench", 1, PerformedFact("set", 100.0, 1))
        val progress = StatsProgress(at("2026-03-16"), listOf(
            ProgressSession("too-old", at("2026-02-22", 23), listOf(fact)),
            ProgressSession("a", at("2026-02-23", 0), listOf(fact)),
            ProgressSession("b", at("2026-03-02"), listOf(fact)),
            ProgressSession("c", at("2026-03-08", 23), listOf(fact)),
            ProgressSession("d", at("2026-03-09", 0), listOf(fact)),
            ProgressSession("e", at("2026-03-16", 0), listOf(fact))))
        assertEquals(4, progress.trainedWeeks(at("2026-03-16"), zone))
        assertEquals(3, progress.copy(sessions = progress.sessions.filterNot { it.sessionId == "e" }).trainedWeeks(at("2026-03-16"), zone))
    }
    @Test
    fun oneRecentWeekIsShownAfterTheAccountHasTrainedInTwoLifetimeWeeks() {
        val zone = ZoneId.of("UTC")
        val now = LocalDate.of(2026, 9, 14).atStartOfDay(zone).toInstant().toEpochMilli()
        val fact = MovementSessionFact("bench", 1, PerformedFact("set", 100.0, 1))
        val one = ProgressSession("recent", now, listOf(fact))
        val old = ProgressSession("old", now - 180L * 86_400_000, listOf(fact))
        assertNull(StatsProgress(now, listOf(one)).consistencyWeeks(now, zone))
        assertEquals(1, StatsProgress(now, listOf(old, one)).consistencyWeeks(now, zone))
        assertNull(StatsProgress(now, listOf(old, old.copy(sessionId = "older", startedAt = old.startedAt - 7L * 86_400_000))).consistencyWeeks(now, zone))
    }

}
