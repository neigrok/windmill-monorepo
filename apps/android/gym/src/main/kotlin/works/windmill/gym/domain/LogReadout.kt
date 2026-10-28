package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

object LogReadout {
    data class Row(val summary: SessionSummary, val title: String, val facts: String, val time: String?, val record: Boolean)
    data class Day(val date: LocalDate, val label: String, val entries: List<LogEntry>)
    data class Moment(val title: String, val detail: String)
    data class Weight(val title: String, val detail: String?, val time: String?)

    fun days(entries: List<LogEntry>, nowMs: Long, zone: ZoneId): List<Day> =
        entries.groupBy { it.day(zone) }.map { (date, rows) -> Day(date, day(date, nowMs, zone), rows) }

    fun day(date: LocalDate, nowMs: Long, zone: ZoneId): String {
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val name = when (date) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> date.format(DateTimeFormatter.ofPattern("EEEE", Locale.ENGLISH))
        }
        val calendar = date.format(DateTimeFormatter.ofPattern(if (date.year == today.year) "d MMM" else "d MMM uuuu", Locale.ENGLISH))
        return "$name · $calendar"
    }

    fun row(summary: SessionSummary, progress: StatsProgress?, nowMs: Long, zone: ZoneId, selectedMarker: Boolean = false): Row {
        val record = !selectedMarker && progress?.newBests?.any { it.sessionId == summary.id } == true
        val minutes = summary.finishedAtMs?.let { ((it - summary.startedAtMs) / 60_000).coerceAtLeast(0) }
        val duration = when {
            minutes == null -> "—"
            minutes == 0L -> "<1 min"
            minutes < 60 -> "$minutes min"
            else -> "${minutes / 60} h ${(minutes % 60).toString().padStart(2, '0')} min"
        }
        val time = summary.startedAtMs.takeIf { it <= nowMs }
            ?.let { Instant.ofEpochMilli(it).atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)) }
        return Row(summary, summary.plan?.routine ?: Readout.noRoutine, "${Readout.setCount(summary.setCount)} · $duration", time, record)
    }

    fun moment(moment: LogEntry.Moment, catalog: List<Exercise>, zone: ZoneId): Moment = when (moment) {
        is LogEntry.Moment.Best -> {
            val best = moment.best
            val date = moment.day(zone)
            val previousDate = Instant.ofEpochMilli(best.previousStartedAt).atZone(zone).toLocalDate()
            val since = previousDate.format(DateTimeFormatter.ofPattern(
                if (previousDate.year != date.year) "MMMM uuuu" else if (previousDate.month == date.month) "d MMM" else "MMMM", Locale.ENGLISH))
            Moment("${Readout.movement(best.exerciseId, catalog)} · new best",
                "${Readout.estimatedWeight(best.estimate)} kg est · up ${Readout.estimatedWeight(best.gain)} kg since $since")
        }
        is LogEntry.Moment.Month -> Moment("Trained ${moment.weeks} of ${moment.weeks} weeks",
            "${moment.month.format(DateTimeFormatter.ofPattern("MMMM", Locale.ENGLISH))} · full month")
    }

    fun weight(weight: LogEntry.Weight, entries: List<WeighIn>, zone: ZoneId): Weight {
        val previous = entries.filter { it.date < weight.entry.date.withDayOfMonth(1) }.maxByOrNull { it.date }
        val change = previous?.let {
            val difference = weight.entry.weightKg - it.weightKg
            if (difference == 0.0) null else "${Bodyweight.kilograms(kotlin.math.abs(difference))} kg ${if (difference > 0) "up" else "down"} since ${it.date.format(DateTimeFormatter.ofPattern("MMMM", Locale.ENGLISH))}"
        }
        val time = weight.atMs?.let { Instant.ofEpochMilli(it).atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)) }
        return Weight("${Bodyweight.kilograms(weight.entry.weightKg)} kg", change, time)
    }
}
