package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

object LogReadout {
    data class Row(val summary: SessionSummary, val title: String, val facts: String, val date: String,
        val onThisDeviceOnly: Boolean, val record: Boolean)
    data class Month(val month: YearMonth, val label: String, val entries: List<LogEntry>)
    data class Moment(val title: String, val detail: String)

    fun months(entries: List<LogEntry>, nowMs: Long, zone: ZoneId): List<Month> {
        val year = Instant.ofEpochMilli(nowMs).atZone(zone).year
        return entries.groupBy { YearMonth.from(Instant.ofEpochMilli(it.atMs).atZone(zone)) }.map { (month, rows) ->
            Month(month, month.format(DateTimeFormatter.ofPattern(if (month.year == year) "MMMM" else "MMMM uuuu", Locale.ENGLISH)), rows)
        }
    }

    fun day(date: LocalDate, nowMs: Long, zone: ZoneId): String {
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        if (date == today) return "Today"
        if (date == today.minusDays(1)) return "Yesterday"
        return date.format(DateTimeFormatter.ofPattern("EEE d", Locale.ENGLISH))
    }

    fun row(summary: SessionSummary, onThisDevice: Boolean, progress: StatsProgress?, catalog: List<Exercise>,
        nowMs: Long, zone: ZoneId): Row {
        val record = progress?.sessions?.firstOrNull { it.sessionId == summary.id }?.movements
            ?.sortedBy { it.exerciseId }?.firstOrNull { fact ->
                progress.movement(fact.exerciseId).records.any { it.id == summary.id }
            }
        val minutes = ((summary.finishedAtMs!! - summary.startedAtMs) / 60_000).coerceAtLeast(0)
        val facts = record?.estimate?.let { "Record · ${Readout.movement(record.exerciseId, catalog)} ${Readout.effort(it.weightKg, it.reps)}" }
            ?: if (minutes == 0L) "<1 min" else "$minutes min"
        return Row(summary, summary.plan?.routine ?: Readout.noRoutine, facts,
            day(Instant.ofEpochMilli(summary.startedAtMs).atZone(zone).toLocalDate(), nowMs, zone),
            onThisDevice, record != null)
    }

    fun moment(moment: LogEntry.Moment, catalog: List<Exercise>, bodyweight: List<WeighIn>, nowMs: Long, zone: ZoneId): Moment {
        val date = Instant.ofEpochMilli(moment.atMs).atZone(zone).toLocalDate()
        val monthFormat = DateTimeFormatter.ofPattern("MMMM", Locale.ENGLISH)
        return when (moment) {
            is LogEntry.Moment.Best -> {
                val value = moment.session.fact.estimate!!.e1rm
                val previous = moment.previous
                val change = if (previous == null) day(date, nowMs, zone) else {
                    val previousDate = Instant.ofEpochMilli(previous.startedAt).atZone(zone).toLocalDate()
                    val since = previousDate.format(DateTimeFormatter.ofPattern(
                        if (previousDate.year != date.year) "MMMM uuuu" else if (previousDate.month == date.month) "d MMM" else "MMMM", Locale.ENGLISH))
                    "up ${Readout.estimatedWeight(value - previous.fact.estimate!!.e1rm)} kg since $since"
                }
                Moment("${Readout.movement(moment.exerciseId, catalog)} · new best", "${Readout.estimatedWeight(value)} kg est · $change")
            }
            is LogEntry.Moment.Month -> Moment("Trained ${moment.weeks} of ${moment.weeks} weeks", "${moment.month.format(monthFormat)} · full month")
            is LogEntry.Moment.Weight -> {
                val previous = bodyweight.filter { it.date < date.withDayOfMonth(1) }.maxByOrNull { it.date }
                val change = previous?.let {
                    val difference = moment.entry.weightKg - it.weightKg
                    if (difference == 0.0) null else "${Bodyweight.kilograms(kotlin.math.abs(difference))} kg ${if (difference > 0) "up" else "down"} since ${it.date.format(monthFormat)}"
                }
                Moment("Weighed in · ${Bodyweight.kilograms(moment.entry.weightKg)} kg", listOfNotNull(day(date, nowMs, zone), change).joinToString(" · "))
            }
        }
    }
}
