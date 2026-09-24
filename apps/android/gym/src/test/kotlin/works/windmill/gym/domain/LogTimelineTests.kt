package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class LogTimelineTests {
    @Test
    fun recordsKeepTheirEventDayWhilePlateausAndOpenSessionsStayQuiet() {
        val zone = ZoneId.of("UTC")
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        val details = listOf("2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24").mapIndexed { index, day ->
            SessionDetail(Session("s$index", at(day), at(day) + 3_600_000), listOf(
                TrainingSet("set$index", "bench", weightKg = if (index == 2) 90.0 else 80.0,
                    reps = 1, completedAtMs = at(day))))
        }
        val now = at("2026-08-27")
        val stats = StatsProgress.of(details.reversed(), now)
        val summaries = details.map { SessionSummary(it.session, it.sets) }
        val records = stats.movement("bench").records
        val expected = listOf(
            LogEntry.Workout(summaries[3]),
            LogEntry.Workout(summaries[2]), LogEntry.Moment.Best("bench", records[1], records[0]),
            LogEntry.Workout(summaries[1]),
            LogEntry.Workout(summaries[0]), LogEntry.Moment.Best("bench", records[0], null))
        assertEquals(expected, logTimeline(summaries.reversed() + SessionSummary("open", now), stats, emptyList(), now, zone))
        assertEquals(expected, logTimeline(summaries, stats.copy(sessions = stats.sessions.reversed()), emptyList(), now, zone))
    }

    @Test
    fun oneMomentPerLocalMondayWeekPrefersBestThenMonthThenLatestWeighIn() {
        val zone = ZoneId.of("UTC")
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        val fact = MovementSessionFact("bench", 1, PerformedFact("set", 80.0, 12))
        val trained = listOf("2026-08-01", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31")
            .map { ProgressSession(it, at(it), listOf(fact)) }
        val best = ProgressSession("record", at("2026-09-02"), listOf(fact.copy(
            estimate = EstimatedFact("best", 90.0, 1, e1rm = 90.0))))
        val now = at("2026-09-06")
        val stats = StatsProgress(now, trained + best)
        val weight = WeighIn("2026-09-06", 82.4, now)
        val earlier = WeighIn("2026-08-31", 83.0, now)
        val record = stats.movement("bench").records.single()
        assertEquals(listOf(LogEntry.Moment.Best("bench", record, null)),
            logTimeline(emptyList(), stats, listOf(weight, earlier), now, zone))
        assertEquals(listOf(LogEntry.Moment.Month(YearMonth.of(2026, 8), 6,
            LocalDate.parse("2026-08-31").atStartOfDay(zone).toInstant().toEpochMilli())),
            logTimeline(emptyList(), stats.copy(sessions = trained), listOf(weight, earlier), now, zone))
        assertEquals(listOf(LogEntry.Moment.Weight(weight,
            LocalDate.parse(weight.dateLocal).atStartOfDay(zone).toInstant().toEpochMilli())),
            logTimeline(emptyList(), null, listOf(earlier, weight), now, zone))
    }

    @Test
    fun aMonthMustFinishAndEveryIntersectingWeekMustHoldTrainingInsideThatMonth() {
        val zone = ZoneId.of("UTC")
        fun at(day: String) = LocalDate.parse(day).atTime(12, 0).atZone(zone).toInstant().toEpochMilli()
        val fact = MovementSessionFact("bench", 1, PerformedFact("set", 80.0, 12))
        val days = listOf("2026-02-01", "2026-02-02", "2026-02-09", "2026-02-16", "2026-02-23")
        val stats = StatsProgress(at("2026-03-01"), days.map { ProgressSession(it, at(it), listOf(fact)) })
        assertEquals(emptyList<LogEntry>(), logTimeline(emptyList(), stats, emptyList(), at("2026-02-28"), zone))
        assertEquals(listOf(LogEntry.Moment.Month(YearMonth.of(2026, 2), 5,
            LocalDate.parse("2026-02-28").atStartOfDay(zone).toInstant().toEpochMilli())),
            logTimeline(emptyList(), stats, emptyList(), at("2026-03-01"), zone))
        assertEquals(emptyList<LogEntry>(), logTimeline(emptyList(), stats.copy(sessions = stats.sessions.drop(1) +
            ProgressSession("outside", at("2026-01-31"), listOf(fact))), emptyList(), at("2026-03-01"), zone))
        assertEquals(emptyList<LogEntry>(), logTimeline(emptyList(), stats.copy(sessions = stats.sessions.mapIndexed { index, session ->
            if (index == 0) session.copy(movements = listOf(fact.copy(workingSetCount = 0))) else session
        }), emptyList(), at("2026-03-01"), zone))
    }

    @Test
    fun eventWeeksFollowLocalTimeAcrossDstAndTheYearBoundary() {
        val sunday = Instant.parse("2026-03-09T03:30:00Z").toEpochMilli()
        val monday = Instant.parse("2026-03-09T04:30:00Z").toEpochMilli()
        val now = Instant.parse("2026-03-10T12:00:00Z").toEpochMilli()
        val stats = StatsProgress(now, listOf(sunday, monday).mapIndexed { index, time ->
            val value = 80.0 + index
            ProgressSession("s$index", time, listOf(MovementSessionFact("bench", 1,
                PerformedFact("set$index", value, 1), EstimatedFact("set$index", value, 1, e1rm = value))))
        })
        val records = stats.movement("bench").records
        assertEquals(listOf(LogEntry.Moment.Best("bench", records[1], records[0]), LogEntry.Moment.Best("bench", records[0], null)),
            logTimeline(emptyList(), stats, emptyList(), now, ZoneId.of("America/New_York")))
        assertEquals(listOf(LogEntry.Moment.Best("bench", records[1], records[0])),
            logTimeline(emptyList(), stats, emptyList(), now, ZoneId.of("UTC")))
        val zone = ZoneId.of("Pacific/Auckland")
        val first = WeighIn("2025-12-31", 82.0, now)
        val second = WeighIn("2026-01-01", 83.0, now)
        assertEquals(listOf(LogEntry.Moment.Weight(second, second.date.atStartOfDay(zone).toInstant().toEpochMilli())),
            logTimeline(emptyList(), null, listOf(second, first), now, zone))
    }

    @Test
    fun equalTimeRecordsResolveByMovementThenSessionIdentityAndPagingDoesNotChooseAnotherWinner() {
        val zone = ZoneId.of("UTC")
        val at = Instant.parse("2026-09-21T12:00:00Z").toEpochMilli()
        val movements = listOf("row", "bench").map { id -> MovementSessionFact(id, 1,
            PerformedFact(id, 80.0, 1), EstimatedFact(id, 80.0, 1, e1rm = 80.0)) }
        val stats = StatsProgress(at, listOf(ProgressSession("b", at, movements), ProgressSession("a", at, movements.reversed())))
        val winner = LogEntry.Moment.Best("bench", stats.movement("bench").records.single(), null)
        assertEquals(listOf(winner), logTimeline(emptyList(), stats, emptyList(), at, zone))
        assertEquals(listOf(winner), logTimeline(emptyList(), stats.copy(sessions = stats.sessions.reversed()), emptyList(), at, zone))
        val later = at + 3 * 86_400_000
        assertEquals(emptyList<LogEntry>(), logTimeline(emptyList(), stats,
            listOf(WeighIn("2026-09-24", 82.0, later)), later, zone, LocalDate.parse("2026-09-23")))
    }

    @Test
    fun weightUsesItsChosenDateIgnoresFutureEntriesAndNeedsNoWorkout() {
        val zone = ZoneId.of("America/New_York")
        val now = Instant.parse("2026-03-09T05:00:00Z").toEpochMilli()
        val entry = WeighIn("2026-03-08", 82.4, now)
        assertEquals(listOf(LogEntry.Moment.Weight(entry, Instant.parse("2026-03-08T05:00:00Z").toEpochMilli())),
            logTimeline(emptyList(), null, listOf(entry, WeighIn("2026-03-10", 90.0, now)), now, zone))
    }
}
