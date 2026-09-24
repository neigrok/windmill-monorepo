package works.windmill.gym.domain

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

sealed interface LogEntry {
    val atMs: Long
    val key: String

    data class Workout(val summary: SessionSummary) : LogEntry {
        override val atMs: Long get() = summary.startedAtMs
        override val key: String get() = "session:${summary.id}"
    }

    sealed interface Moment : LogEntry {
        val priority: Int

        data class Best(
            val exerciseId: String,
            val session: MovementProgress.Session,
            val previous: MovementProgress.Session?,
        ) : Moment {
            override val atMs: Long get() = session.startedAt
            override val key: String get() = "best:$exerciseId:${session.id}"
            override val priority: Int get() = 0
        }

        data class Month(val month: YearMonth, val weeks: Int, override val atMs: Long) : Moment {
            override val key: String get() = "month:$month"
            override val priority: Int get() = 1
        }

        data class Weight(val entry: WeighIn, override val atMs: Long) : Moment {
            override val key: String get() = "weight:${entry.dateLocal}"
            override val priority: Int get() = 2
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
    val facts = progress?.copy(sessions = progress.sessions.filter { it.startedAt <= nowMs }) ?: StatsProgress(nowMs, emptyList())
    val moments = mutableListOf<LogEntry.Moment>()

    facts.sessions.flatMap { it.movements }.map { it.exerciseId }.distinct().sorted().forEach { id ->
        val records = facts.movement(id).records
        records.forEachIndexed { index, record ->
            moments += LogEntry.Moment.Best(id, record, records.getOrNull(index - 1))
        }
    }

    val trainedDays = facts.sessions.filter { it.movements.any { fact -> fact.workingSetCount > 0 } }
        .map { Instant.ofEpochMilli(it.startedAt).atZone(zone).toLocalDate() }
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

    bodyweight.filter { it.date <= today }.forEach { entry ->
        moments += LogEntry.Moment.Weight(entry, entry.date.atStartOfDay(zone).toInstant().toEpochMilli())
    }

    val chosen = moments.groupBy { Instant.ofEpochMilli(it.atMs).atZone(zone).toLocalDate().with(monday) }
        .values.map { week ->
            week.minWith(compareBy<LogEntry.Moment> { it.priority }.thenByDescending { it.atMs }.thenBy { it.key })
        }.filter { oldestDay == null || Instant.ofEpochMilli(it.atMs).atZone(zone).toLocalDate() >= oldestDay }
    val workouts = sessions.filter { !it.session.isOpen && it.startedAtMs <= nowMs }.map { LogEntry.Workout(it) }
    return (workouts + chosen).sortedWith(compareByDescending<LogEntry> { it.atMs }
        .thenBy { if (it is LogEntry.Workout) 0 else 1 }.thenBy { it.key })
}
