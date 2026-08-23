package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max

// Days and months are spelled out rather than localised, exactly as the web spells them.

object Readout {
    private val weekdays = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    private val fullMonths = listOf("January", "February", "March", "April", "May", "June",
                                    "July", "August", "September", "October", "November", "December")
    private val names = listOf("zero", "one", "two", "three", "four", "five",
                               "six", "seven", "eight", "nine", "ten")

    // Trailing zeros stripped and a real U+2212 minus; the grid is the LADDER's own.
    fun weight(kg: Double): String {
        val magnitude = Ladder.round(abs(kg))
        val digits = if (magnitude == floor(magnitude)) magnitude.toLong().toString() else magnitude.toString()
        return (if (kg < 0) "−" else "") + digits
    }

    fun effort(weightKg: Double, reps: Int): String = "${weight(weightKg)} × $reps"

    // A rep target a routine declines to set is `max` — never a zero and never a blank.
    fun repTarget(reps: Int?): String = reps?.toString() ?: "max"

    // An absent weight — and a literal zero, which is the absence of a load — prints nothing, while a
    // band-assisted −20 prints.
    const val openTarget = "open"

    fun target(sets: Int?, reps: Int?, weightKg: Double?): String {
        if (sets == null) return openTarget
        val count = "$sets × ${repTarget(reps)}"
        if (weightKg == null || weightKg == 0.0) return count
        return "$count · ${weight(weightKg)}"
    }

    fun time(ms: Long): String {
        val at = at(ms)
        return pad(at.hour) + ":" + pad(at.minute)
    }

    // A sum that reaches zero prints NOTHING rather than `0.0 t`, rounded by hand with the tenths as
    // an INTEGER so no locale touches it.
    fun tonnes(kg: Double): String? {
        val tenths = floor(kg / 100.0 + 0.5).toLong()
        if (tenths <= 0) return null
        return "${tenths / 10}.${tenths % 10} t"
    }

    const val noRoutine = "Session · no routine"

    fun workingSets(count: Int): String = "$count working"

    // The server computes the e1RM; this phone only spells it.
    fun estimate(e1rm: Double): String = "e1RM ${weight(e1rm)}"

    fun spelled(count: Int): String = names.getOrNull(count) ?: count.toString()

    fun weekOf(ms: Long): String {
        val at = at(ms)
        return "week of ${at.dayOfMonth} ${months[at.monthValue - 1]}"
    }

    fun date(ms: Long): String {
        val at = at(ms)
        return "${at.dayOfMonth} ${months[at.monthValue - 1]} ${at.year}"
    }

    fun whenLogged(ms: Long, now: Long): String {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        if (then == today) return "today · ${time(ms)}"
        return day(ms)
    }

    fun day(ms: Long): String {
        val at = at(ms)
        return "${weekdays[at.dayOfWeek.value % 7]} ${at.dayOfMonth} ${months[at.monthValue - 1]}"
    }

    fun shortDate(ms: Long, now: Long): String {
        val at = at(ms)
        val here = at(now)
        val date = "${at.dayOfMonth} ${months[at.monthValue - 1]}"
        if (at.year == here.year) return date
        return "$date ${at.year}"
    }

    fun month(ms: Long, now: Long): String {
        val at = at(ms)
        val name = fullMonths[at.monthValue - 1]
        if (at.year == at(now).year) return name
        return "$name ${at.year}"
    }

    fun briefDay(ms: Long, now: Long): String {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        if (then == Instant.ofEpochMilli(now).atZone(zone).toLocalDate()) return "today"
        return shortDate(ms, now)
    }

    fun recentDay(ms: Long, now: Long): String {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(then, today)
        if (days == 0L) return "today"
        if (days == 1L) return "yesterday"
        if (days in 2..6) return weekday(ms)
        return shortDate(ms, now)
    }

    fun weekday(ms: Long): String {
        val names = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
        return names[at(ms).dayOfWeek.value % 7]
    }

    // A claim about the CALENDAR, not elapsed hours: both instants fall to their local date first.
    fun ago(ms: Long, now: Long): String {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(then, today)
        if (days <= 0) return "today"
        if (days == 1L) return "yesterday"
        return "$days days ago"
    }

    fun clock(ms: Long): String {
        val total = max(0L, ms / 1000)
        val hours = total / 3600
        val minutes = (total % 3600) / 60
        val seconds = total % 60
        val head = if (hours > 0) "$hours:${pad(minutes.toInt())}" else minutes.toString()
        return head + ":" + pad(seconds.toInt())
    }

    fun duration(ms: Long): String {
        val minutes = max(1L, ms / 60_000)
        if (minutes < 60) return "${minutes}m"
        return "${minutes / 60}h ${pad((minutes % 60).toInt())}m"
    }

    fun setCount(count: Int): String = if (count == 1) "1 set" else "$count sets"

    fun routineLine(routine: Routine, now: Long): String {
        val movements = Program.movements(routine.entries.size)
        val trained = routine.lastTrainedAtMs ?: return "$movements · never trained"
        return "$movements · trained ${ago(trained, now)}"
    }

    fun routineCount(count: Int): String = if (count == 1) "1 routine" else "$count routines"

    fun sessionCount(count: Int): String = if (count == 1) "1 session" else "$count sessions"

    // A week is the server's Monday-UTC bucket (`date_trunc('week')`); this only spells the count.
    fun weekCount(count: Int): String = if (count == 1) "1 week" else "$count weeks"

    fun movement(exerciseId: String, catalog: List<Exercise>): String =
        catalog.firstOrNull { it.id == exerciseId }?.name ?: exerciseId

    private fun at(ms: Long): ZonedDateTime =
        Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())

    private fun pad(value: Int): String = if (value < 10) "0$value" else value.toString()
}
