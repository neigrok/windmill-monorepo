package works.windmill.gym.domain

import java.text.NumberFormat
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

object LogReadout {
    data class Row(val summary: SessionSummary, val title: String, val facts: String, val caption: String?,
        val onThisDeviceOnly: Boolean, val record: Boolean)
    data class Week(val startMs: Long, val label: String, val rows: List<Row>)

    fun weeks(sessions: List<SessionSummary>, onThisDevice: Set<String>, nowMs: Long,
        progress: StatsProgress? = null, zone: ZoneId = ZoneId.systemDefault()): List<Week> {
        val currentMonday = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
            .with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        return sessions.filter { !it.session.isOpen }
            .sortedWith(compareByDescending<SessionSummary> { it.startedAtMs }.thenByDescending { it.id })
            .groupBy { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).toLocalDate()
                .with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) }
            .map { (monday, rows) ->
                val start = monday.atStartOfDay(zone).toInstant().toEpochMilli()
                Week(start, when (monday) {
                    currentMonday -> "This week"
                    currentMonday.minusWeeks(1) -> "Last week"
                    else -> Readout.weekOf(start).replaceFirstChar { it.titlecase() }
                }, rows.map { summary ->
                    val minutes = ((summary.finishedAtMs!! - summary.startedAtMs) / 60_000).coerceAtLeast(0)
                    val facts = listOfNotNull(Readout.recentDay(summary.startedAtMs, nowMs).replaceFirstChar { it.titlecase() },
                        if (minutes == 0L) "<1 min" else "$minutes min",
                        summary.workingSetCount?.let { "$it working ${if (it == 1) "set" else "sets"}" }).joinToString(" · ")
                    val caption = listOfNotNull(summary.tonnageKg?.takeIf { it > 0 }?.let {
                        "${NumberFormat.getNumberInstance().format(it)} kg volume"
                    }, progress?.sessionEstimate(summary.id)?.let { "e1RM ${Readout.estimatedWeight(it)} kg" })
                        .takeIf { it.isNotEmpty() }?.joinToString(" · ")
                    Row(summary, summary.plan?.routine ?: Readout.noRoutine, facts, caption,
                        summary.id in onThisDevice, summary.record)
                })
            }
    }

    fun head(weeks: List<Week>, readPending: Boolean, logHolds: Boolean): String? {
        if (weeks.isEmpty()) return if (readPending && !logHolds) "opening the log…" else null
        val sessions = Readout.sessionCount(weeks.sumOf { it.rows.size })
        return "$sessions · ${weeks.size} ${if (weeks.size == 1) "week" else "weeks"} loaded"
    }
}
