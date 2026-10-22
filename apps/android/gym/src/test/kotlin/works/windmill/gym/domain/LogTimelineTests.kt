package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class LogTimelineTests {
    @Test
    fun aFirstWorkoutSetsNoBestAndANewBestKeepsItsEventDayWhilePlateausAndOpenSessionsStayQuiet() {
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
        val best = NewBest("bench", "s2", at("2026-08-17"), "s0", at("2026-08-03"), estimate = 90.0, gain = 10.0)
        val expected = listOf(
            LogEntry.Workout(summaries[3]),
            LogEntry.Workout(summaries[2]), LogEntry.Moment.Best(best),
            LogEntry.Workout(summaries[1]),
            LogEntry.Workout(summaries[0]))
        assertEquals(expected, logTimeline(summaries.reversed() + SessionSummary("open", now), stats, emptyList(), now, zone))
        assertEquals(expected, logTimeline(summaries, stats.copy(sessions = stats.sessions.reversed()), emptyList(), now, zone))
        assertEquals("a partial history claims no new best", summaries.reversed().map { LogEntry.Workout(it) },
            logTimeline(summaries, StatsProgress.of(details, now, complete = false), emptyList(), now, zone))
    }

    @Test
    fun aNewBestBeatsTheBestBeforeItAsStatedToATenthOfAKilogram() {
        val zone = ZoneId.of("UTC")
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        val lifts = listOf("2026-08-03" to (46.0 to 8), "2026-08-10" to (50.0 to 5), "2026-08-17" to (51.5 to 4))
        val details = lifts.mapIndexed { index, (day, lift) ->
            SessionDetail(Session("s$index", at(day), at(day) + 3_600_000), listOf(
                TrainingSet("set$index", "bench", weightKg = lift.first, reps = lift.second, completedAtMs = at(day))))
        }
        val now = at("2026-08-20")
        val summaries = details.map { SessionSummary(it.session, it.sets) }
        val best = NewBest("bench", "s2", at("2026-08-17"), "s0", at("2026-08-03"), estimate = 58.4, gain = 0.1)
        assertEquals(listOf(
            LogEntry.Workout(summaries[2]), LogEntry.Moment.Best(best),
            LogEntry.Workout(summaries[1]),
            LogEntry.Workout(summaries[0])),
            logTimeline(summaries.reversed(), StatsProgress.of(details, now), emptyList(), now, zone))
    }

    @Test
    fun oneMomentPerLocalMondayWeekPrefersBestThenMonthThenLatestWeighIn() {
        val zone = ZoneId.of("UTC")
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        fun detail(day: String, kg: Double, reps: Int) = SessionDetail(Session(day, at(day), at(day) + 3_600_000),
            listOf(TrainingSet("set-$day", "bench", weightKg = kg, reps = reps, completedAtMs = at(day))))
        val trained = listOf("2026-08-01", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31")
            .map { detail(it, 80.0, if (it == "2026-08-03") 1 else 12) }
        val record = detail("2026-09-02", 90.0, 1)
        val now = at("2026-09-06")
        val stats = StatsProgress.of(trained + record, now)
        val weight = WeighIn("2026-09-06", 82.4, now)
        val earlier = WeighIn("2026-08-31", 83.0, now)
        val best = NewBest("bench", "2026-09-02", at("2026-09-02"), "2026-08-03", at("2026-08-03"), estimate = 90.0, gain = 10.0)
        assertEquals(listOf(LogEntry.Moment.Best(best)),
            logTimeline(emptyList(), stats, listOf(weight, earlier), now, zone))
        assertEquals(listOf(LogEntry.Moment.Month(YearMonth.of(2026, 8), 6,
            LocalDate.parse("2026-08-31").atStartOfDay(zone).toInstant().toEpochMilli())),
            logTimeline(emptyList(), stats.copy(sessions = stats.sessions.filter { it.sessionId != record.session.id }), listOf(weight, earlier), now, zone))
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
        val baseline = Instant.parse("2026-03-01T12:00:00Z").toEpochMilli()
        val sunday = Instant.parse("2026-03-09T03:30:00Z").toEpochMilli()
        val monday = Instant.parse("2026-03-09T04:30:00Z").toEpochMilli()
        val now = Instant.parse("2026-03-10T12:00:00Z").toEpochMilli()
        val details = listOf(baseline, sunday, monday).mapIndexed { index, time ->
            SessionDetail(Session("s$index", time, time + 1), listOf(TrainingSet("set$index", "bench", weightKg = 79.0 + index, reps = 1, completedAtMs = time)))
        }
        val stats = StatsProgress.of(details, now)
        val onSunday = NewBest("bench", "s1", sunday, "s0", baseline, estimate = 80.0, gain = 1.0)
        val onMonday = NewBest("bench", "s2", monday, "s1", sunday, estimate = 81.0, gain = 1.0)
        assertEquals(listOf(LogEntry.Moment.Best(onMonday), LogEntry.Moment.Best(onSunday)),
            logTimeline(emptyList(), stats, emptyList(), now, ZoneId.of("America/New_York")))
        assertEquals(listOf(LogEntry.Moment.Best(onMonday)),
            logTimeline(emptyList(), stats, emptyList(), now, ZoneId.of("UTC")))
        val zone = ZoneId.of("Pacific/Auckland")
        val first = WeighIn("2025-12-31", 82.0, now)
        val second = WeighIn("2026-01-01", 83.0, now)
        assertEquals(listOf(LogEntry.Moment.Weight(second, second.date.atStartOfDay(zone).toInstant().toEpochMilli())),
            logTimeline(emptyList(), null, listOf(second, first), now, zone))
    }

    @Test
    fun equalTimeBestsResolveByMovementThenSessionIdentityAndPagingDoesNotChooseAnotherWinner() {
        val zone = ZoneId.of("UTC")
        val at = Instant.parse("2026-09-21T12:00:00Z").toEpochMilli()
        val before = at - 7 * 86_400_000
        fun sets(id: String, time: Long, kg: Double, movements: List<String>) = movements.map { movement ->
            TrainingSet("$id-$movement", movement, weightKg = kg, reps = 1, completedAtMs = time)
        }
        val details = listOf(
            SessionDetail(Session("base", before, before + 1), sets("base", before, 80.0, listOf("row", "bench"))),
            SessionDetail(Session("b", at, at + 1), sets("b", at, 81.0, listOf("row", "bench"))),
            SessionDetail(Session("a", at, at + 1), sets("a", at, 81.0, listOf("bench", "row"))))
        val stats = StatsProgress.of(details, at)
        val winner = LogEntry.Moment.Best(NewBest("bench", "a", at, "base", before, estimate = 81.0, gain = 1.0))
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
