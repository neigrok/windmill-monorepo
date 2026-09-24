package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class LogReadoutTests {
    @Test
    fun theSessionRowNamesItsActualRecordAndKeepsTheDateSeparate() {
        val zone = ZoneId.of("UTC")
        val at = Instant.parse("2026-09-21T18:00:00Z").toEpochMilli()
        val now = Instant.parse("2026-09-24T18:00:00Z").toEpochMilli()
        val sets = listOf(TrainingSet("best", "bench", weightKg = 60.0, reps = 10, completedAtMs = at),
            TrainingSet("heavy", "row", weightKg = 120.0, reps = 12, completedAtMs = at))
        val summary = SessionSummary(Session("s", at, at + 3_600_000, plan = PlanSnapshot("Push A")), sets)
        val stats = StatsProgress.of(listOf(SessionDetail(summary.session, sets)), now)
        val catalog = listOf(Exercise("bench", "Bench Press"), Exercise("row", "Barbell Row"))
        assertEquals(LogReadout.Row(summary, "Push A", "Record · Bench Press 60 × 10", "Mon 21", true, true),
            LogReadout.row(summary, true, stats, catalog, now, zone))
        assertEquals(LogReadout.Row(summary, "Push A", "60 min", "Mon 21", false, false),
            LogReadout.row(summary.copy(record = false), false, null, catalog, now, zone))
    }

    @Test
    fun durationNeverClaimsAMinuteForASecondsLongSessionAndDatesUseTheGivenZone() {
        val zone = ZoneId.of("America/New_York")
        val at = Instant.parse("2026-09-22T01:00:00Z").toEpochMilli()
        val summary = SessionSummary("s", at, at + 10_000)
        val now = Instant.parse("2026-09-22T18:00:00Z").toEpochMilli()
        assertEquals(LogReadout.Row(summary, Readout.noRoutine, "<1 min", "Yesterday", false, false),
            LogReadout.row(summary, false, null, emptyList(), now, zone))
    }

    @Test
    fun theMonthNameAndKeyIncludeTheYearWhenItIsNeeded() {
        val zone = ZoneId.of("UTC")
        val now = Instant.parse("2026-09-24T18:00:00Z").toEpochMilli()
        val entries = listOf("2026-09-21", "2025-09-21").map { day ->
            val at = LocalDate.parse(day).atStartOfDay(zone).toInstant().toEpochMilli()
            LogEntry.Workout(SessionSummary(day, at, at + 1000))
        }
        assertEquals(listOf(LogReadout.Month(YearMonth.of(2026, 9), "September", listOf(entries[0])),
            LogReadout.Month(YearMonth.of(2025, 9), "September 2025", listOf(entries[1]))), LogReadout.months(entries, now, zone))
    }

    @Test
    fun momentsSayOnlyTheChangeTheActualHistoryHolds() {
        val zone = ZoneId.of("UTC")
        val at = Instant.parse("2026-09-24T18:00:00Z").toEpochMilli()
        val previousAt = Instant.parse("2026-08-21T18:00:00Z").toEpochMilli()
        val first = MovementProgress.Session("a", previousAt, MovementSessionFact("bench", 1,
            PerformedFact("set-a", 72.0, 1), EstimatedFact("set-a", 72.0, 1, e1rm = 72.0)))
        val last = MovementProgress.Session("b", at, MovementSessionFact("bench", 1,
            PerformedFact("set-b", 76.0, 1), EstimatedFact("set-b", 76.0, 1, e1rm = 76.0)))
        val catalog = listOf(Exercise("bench", "Bench Press"))
        assertEquals(LogReadout.Moment("Bench Press · new best", "76 kg est · up 4 kg since August"),
            LogReadout.moment(LogEntry.Moment.Best("bench", last, first), catalog, emptyList(), at, zone))
        val entry = WeighIn("2026-09-24", 82.4, at)
        assertEquals(LogReadout.Moment("Weighed in · 82.4 kg", "Today · 0.5 kg down since August"),
            LogReadout.moment(LogEntry.Moment.Weight(entry, at), catalog,
                listOf(entry, WeighIn("2026-08-30", 82.9, previousAt)), at, zone))
        assertEquals(LogReadout.Moment("Trained 6 of 6 weeks", "August · full month"),
            LogReadout.moment(LogEntry.Moment.Month(YearMonth.of(2026, 8), 6, previousAt), catalog, emptyList(), at, zone))
    }
}
