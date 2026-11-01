package works.windmill.gym.domain

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

sealed interface LogEntry {
    val atMs: Long?
    val key: String

    fun day(zone: ZoneId): LocalDate = when (this) {
        is Weight -> entry.date
        else -> Instant.ofEpochMilli(atMs!!).atZone(zone).toLocalDate()
    }

    data class Workout(val summary: SessionSummary) : LogEntry {
        override val atMs: Long get() = summary.startedAtMs
        override val key: String get() = "session:${summary.id}"
    }

    data class Weight(val entry: WeighIn, override val atMs: Long?) : LogEntry {
        override val key: String get() = "weight:${entry.dateLocal}"
    }

    sealed interface Moment : LogEntry {
        override val atMs: Long
        val priority: Int

        data class Best(val best: NewBest) : Moment {
            override val atMs: Long get() = best.startedAt
            override val key: String get() = "best:${best.exerciseId}:${best.sessionId}"
            override val priority: Int get() = 0
        }

        data class Month(val month: YearMonth, val weeks: Int, override val atMs: Long) : Moment {
            override val key: String get() = "month:$month"
            override val priority: Int get() = 1
        }
    }
}

fun logTimeline(
    sessions: List<SessionSummary>,
    progress: StatsProgress?,
    bodyweight: List<WeighIn>,
    nowMs: Long,
    zone: ZoneId,
    oldestDay: LocalDate? = null,
): List<LogEntry> {
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    val monday = TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)
    val facts = progress?.until(nowMs) ?: StatsProgress.empty(nowMs)
    val moments = mutableListOf<LogEntry.Moment>()
    moments += facts.newBests.map { LogEntry.Moment.Best(it) }

    val trainedDays = facts.sessions.map { Instant.ofEpochMilli(it.startedAt).atZone(zone).toLocalDate() }
    trainedDays.groupBy { YearMonth.from(it) }.toSortedMap().forEach { (month, days) ->
        if (month >= YearMonth.from(today)) return@forEach
        val firstWeek = month.atDay(1).with(monday)
        val lastWeek = month.atEndOfMonth().with(monday)
        val monthWeeks = generateSequence(firstWeek) { it.plusWeeks(1) }.takeWhile { it <= lastWeek }.toSet()
        if (days.map { it.with(monday) }.toSet() == monthWeeks) {
            moments += LogEntry.Moment.Month(month, monthWeeks.size,
                month.atEndOfMonth().atStartOfDay(zone).toInstant().toEpochMilli())
        }
    }

    val weights = bodyweight.filter { it.date <= today }.map { entry ->
        val recorded = entry.recordedAt?.takeIf { it <= nowMs }
            ?.takeIf { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() == entry.date }
        LogEntry.Weight(entry, recorded)
    }
    val chosen = moments.groupBy { it.day(zone).with(monday) }.values.map { week ->
        week.minWith(compareBy<LogEntry.Moment> { it.priority }.thenByDescending { it.atMs }.thenBy { it.key })
    }.filter { oldestDay == null || it.day(zone) >= oldestDay }
    val workouts = sessions.filter { !it.session.isOpen && it.startedAtMs <= nowMs }.map { LogEntry.Workout(it) }
    // Date-only facts follow timed facts on their selected day; exact ties put workouts first, then markers, then weights.
    return (workouts + weights + chosen).sortedWith(compareByDescending<LogEntry> { it.day(zone) }
        .thenByDescending { it.atMs }.thenBy { when (it) { is LogEntry.Workout -> 0; is LogEntry.Moment -> 1; is LogEntry.Weight -> 2 } }
        .thenBy { it.key })
}
