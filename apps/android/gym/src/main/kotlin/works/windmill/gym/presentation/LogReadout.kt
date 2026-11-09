package works.windmill.gym.presentation

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.joined

object LogReadout {
    data class Row(val summary: SessionSummary, val named: Words, val said: Words, val time: String?, val record: Boolean)
    data class Day(val date: LocalDate, val heading: Words, val entries: List<LogEntry>)
    data class Moment(val named: Words, val said: Words)
    data class Weight(val named: Words, val said: Words?, val time: String?)

    fun days(entries: List<LogEntry>, nowMs: Long, zone: ZoneId): List<Day> =
        entries.groupBy { it.day(zone) }.map { (date, rows) -> Day(date, dayHeading(date, nowMs, zone), rows) }

    fun dayHeading(date: LocalDate, nowMs: Long, zone: ZoneId): Words {
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val name = when (date) {
            today -> Words.Message(R.string.gym_log_day_today)
            today.minusDays(1) -> Words.Message(R.string.gym_log_day_yesterday)
            else -> Words.Plain(date.format(DateTimeFormatter.ofPattern("EEEE", Locale.ENGLISH)))
        }
        val calendar = date.format(DateTimeFormatter.ofPattern(if (date.year == today.year) "d MMM" else "d MMM uuuu", Locale.ENGLISH))
        return Words.Message(R.string.gym_log_day, listOf(name, calendar))
    }

    fun row(summary: SessionSummary, progress: StatsProgress?, nowMs: Long, zone: ZoneId, selectedMarker: Boolean = false): Row {
        val record = !selectedMarker && progress?.newBests?.any { it.sessionId == summary.id } == true
        val minutes = summary.finishedAtMs?.let { ((it - summary.startedAtMs) / 60_000).coerceAtLeast(0) }
        val duration = when {
            minutes == null -> Words.Plain("—")
            minutes == 0L -> Words.Message(R.string.gym_log_under_a_minute)
            minutes < 60 -> Words.Message(R.string.gym_log_minutes, listOf(minutes.toString()))
            else -> Words.Message(R.string.gym_log_hours, listOf((minutes / 60).toString(), (minutes % 60).toString().padStart(2, '0')))
        }
        val time = summary.startedAtMs.takeIf { it <= nowMs }
            ?.let { Instant.ofEpochMilli(it).atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)) }
        return Row(summary, summary.plan?.routine?.let(Words::Plain) ?: Readout.freeWorkout, listOf(Readout.sets(summary.setCount), duration).joined()!!, time, record)
    }

    fun moment(moment: LogEntry.Moment, catalog: List<Exercise>, zone: ZoneId): Moment = when (moment) {
        is LogEntry.Moment.Best -> {
            val best = moment.best
            val date = moment.day(zone)
            val previousDate = Instant.ofEpochMilli(best.previousStartedAt).atZone(zone).toLocalDate()
            val since = previousDate.format(DateTimeFormatter.ofPattern(
                if (previousDate.year != date.year) "MMMM uuuu" else if (previousDate.month == date.month) "d MMM" else "MMMM", Locale.ENGLISH))
            Moment(Words.Message(R.string.gym_log_moment_best, listOf(Readout.movement(best.exerciseId, catalog))),
                Words.Message(R.string.gym_log_moment_best_detail, listOf(Readout.estimatedWeight(best.estimate), Readout.estimatedWeight(best.gain), since)))
        }
        is LogEntry.Moment.Month -> Moment(Words.Message(R.string.gym_log_full_month, listOf(moment.weeks.toString())),
            Words.Message(R.string.gym_log_full_month_detail, listOf(moment.month.format(DateTimeFormatter.ofPattern("MMMM", Locale.ENGLISH)))))
    }

    // Before the first pull the earlier weigh-in in hand may not be the account's, so no change since is claimed.
    fun weight(weight: LogEntry.Weight, entries: List<WeighIn>, zone: ZoneId, complete: Boolean): Weight {
        val previous = if (!complete) null else entries.filter { it.date < weight.entry.date.withDayOfMonth(1) }.maxByOrNull { it.date }
        val change = previous?.let {
            val difference = weight.entry.weightKg - it.weightKg
            if (difference == 0.0) null else Words.Message(if (difference > 0) R.string.gym_log_weight_up else R.string.gym_log_weight_down,
                listOf(Bodyweight.kilograms(kotlin.math.abs(difference)), it.date.format(DateTimeFormatter.ofPattern("MMMM", Locale.ENGLISH))))
        }
        val time = weight.atMs?.let { Instant.ofEpochMilli(it).atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)) }
        return Weight(Words.Message(R.string.gym_log_weight, listOf(Bodyweight.kilograms(weight.entry.weightKg))), change, time)
    }
}
