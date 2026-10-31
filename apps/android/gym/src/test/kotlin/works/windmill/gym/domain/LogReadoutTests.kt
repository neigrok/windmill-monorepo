package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class LogReadoutTests {
    @Test
    fun cardsKeepAllSetFactsAndStateASharedNewBestOnlyWhenItsMarkerWasOmitted() {
        val zone = ZoneId.of("UTC")
        val at = Instant.parse("2026-09-21T18:00:00Z").toEpochMilli()
        val now = at + 1
        val catalog = listOf(Exercise("bench", "Bench Press"))
        fun detail(id: String, time: Long, kg: Double) = SessionDetail(Session(id, time, time + 3_600_000, plan = PlanSnapshot("Push A")),
            listOf(TrainingSet("$id-set", "bench", weightKg = kg, reps = 1, completedAtMs = time)))
        val baseline = detail("baseline", at - 86_400_000, 80.0)
        val best = detail("best", at, 90.0)
        val summary = SessionSummary(best.session, best.sets, catalog).copy(setCount = 4, workingSetCount = 1)
        val progress = StatsProgress.of(listOf(baseline, best), now)
        assertEquals(LogReadout.Row(summary, "Push A", "4 sets · 1 h 00 min", "18:00", true),
            LogReadout.row(summary, progress, now, zone))
        assertEquals(LogReadout.Row(summary, "Push A", "4 sets · 1 h 00 min", "18:00", false),
            LogReadout.row(summary, progress, now, zone, selectedMarker = true))
        assertEquals(false, LogReadout.row(summary, StatsProgress.of(listOf(best), now), now, zone).record)
        assertEquals(false, LogReadout.row(summary, StatsProgress.empty(now), now, zone).record)
    }

    @Test
    fun rowsHaveAClockButNoRepeatedDateAndNeverInventDurationOrTime() {
        val zone = ZoneId.of("America/New_York")
        val at = Instant.parse("2026-09-22T01:00:00Z").toEpochMilli()
        val summary = SessionSummary("s", at, at + 10_000)
        val now = at + 86_400_000
        assertEquals(LogReadout.Row(summary, Readout.noRoutine, "0 sets · <1 min", "21:00", false),
            LogReadout.row(summary, null, now, zone))
        assertEquals("19:00", LogReadout.row(summary.copy(startedAtMs = 0), null, now, zone).time)
        assertEquals(null, LogReadout.row(summary.copy(startedAtMs = now + 1), null, now, zone).time)
        assertEquals("0 sets · —", LogReadout.row(summary.copy(finishedAtMs = null), null, now, zone).facts)
    }

    @Test
    fun datedSectionsUseTheSelectedDayAndIncludeTheYearOnlyWhenNeeded() {
        val zone = ZoneId.of("UTC")
        val now = Instant.parse("2026-10-22T20:00:00Z").toEpochMilli()
        val current = LogEntry.Weight(WeighIn("2026-10-22", 82.0), null)
        val old = LogEntry.Weight(WeighIn("2025-10-22", 83.0), null)
        assertEquals(listOf(LogReadout.Day(LocalDate.parse("2026-10-22"), "Today · 22 Oct", listOf(current)),
            LogReadout.Day(LocalDate.parse("2025-10-22"), "Wednesday · 22 Oct 2025", listOf(old))),
            LogReadout.days(listOf(current, old), now, zone))
    }

    @Test
    fun markersAndWeightsDescribeOnlyTheChangeTheActualHistoryHolds() {
        val zone = ZoneId.of("UTC")
        val at = Instant.parse("2026-09-24T12:45:00Z").toEpochMilli()
        val previousAt = Instant.parse("2026-08-21T18:00:00Z").toEpochMilli()
        val best = NewBest("bench", sessionId = "b", startedAt = at, previousSessionId = "a", previousStartedAt = previousAt, estimate = 76.0, gain = 4.0)
        val catalog = listOf(Exercise("bench", "Bench Press"))
        assertEquals(LogReadout.Moment("Bench Press · new best", "76 kg est · up 4 kg since August"),
            LogReadout.moment(LogEntry.Moment.Best(best), catalog, zone))
        val entry = WeighIn("2026-09-24", 82.4, at)
        assertEquals(LogReadout.Weight("82.4 kg", "0.5 kg down since August", "12:45"),
            LogReadout.weight(LogEntry.Weight(entry, at), listOf(entry, WeighIn("2026-08-30", 82.9, previousAt)), zone))
        assertEquals(LogReadout.Weight("82.4 kg", null, null), LogReadout.weight(LogEntry.Weight(entry, null), listOf(entry), zone))
    }
}
