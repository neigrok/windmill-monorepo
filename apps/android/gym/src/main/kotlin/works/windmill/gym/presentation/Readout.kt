package works.windmill.gym.presentation

import androidx.annotation.StringRes
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlin.math.max
import works.windmill.gym.R
import works.windmill.platform.i18n.Words

object Readout {
    // Days and months are named from the readout's own tables rather than the phone's locale, as the web names them.
    private val weekdays = listOf(R.string.gym_readout_weekday_sun, R.string.gym_readout_weekday_mon, R.string.gym_readout_weekday_tue,
        R.string.gym_readout_weekday_wed, R.string.gym_readout_weekday_thu, R.string.gym_readout_weekday_fri, R.string.gym_readout_weekday_sat)
    private val months = listOf(R.string.gym_readout_month_jan, R.string.gym_readout_month_feb, R.string.gym_readout_month_mar,
        R.string.gym_readout_month_apr, R.string.gym_readout_month_may, R.string.gym_readout_month_jun, R.string.gym_readout_month_jul,
        R.string.gym_readout_month_aug, R.string.gym_readout_month_sep, R.string.gym_readout_month_oct, R.string.gym_readout_month_nov,
        R.string.gym_readout_month_dec)
    private val spelledNumbers = listOf(R.string.gym_readout_zero, R.string.gym_readout_one, R.string.gym_readout_two,
        R.string.gym_readout_three, R.string.gym_readout_four, R.string.gym_readout_five, R.string.gym_readout_six,
        R.string.gym_readout_seven, R.string.gym_readout_eight, R.string.gym_readout_nine, R.string.gym_readout_ten)

    // Trailing zeros stripped and a real U+2212 minus; the grid is the LADDER's own.
    fun weight(kg: Double): String {
        return works.windmill.gym.domain.sync.Readout.weight(kg)
    }

    fun effort(weightKg: Double, reps: Int): String = "${weight(weightKg)} × $reps"

    fun reps(count: Int): Words = Words.Counted(R.plurals.gym_readout_reps, count, listOf(count.toString()))

    // A rep target a routine declines to set is `max` — never a zero and never a blank.
    fun repsTarget(reps: Int?): Words = reps?.let { Words.Plain(it.toString()) } ?: Words.Message(R.string.gym_readout_max)

    val open: Words = Words.Message(R.string.gym_readout_open)

    // One set as `{load} × {reps}`, with the nulls as their placeholders:
    // `100 × 5` · `100 × max` · `last × 5`.
    fun setScheme(set: SetTarget): Words = Words.Message(R.string.gym_readout_set,
        listOf(set.weightKg?.let { Words.Plain(weight(it)) } ?: Words.Message(R.string.gym_readout_last), repsTarget(set.reps)))

    // A scheme: `{n} × {reps or lo–hi} · {load or lo–hi}`, a one-set scheme included — `1 × 5 · 100`.
    // A column whose sets agree prints its one value; one whose sets disagree prints its range over
    // the named values with the placeholder as the high end — `5–max` when any set is max, `60–last`
    // when any set is last time's — and the load column is left off where no set names a load.
    fun scheme(sets: List<SetTarget>): Words {
        if (sets.isEmpty()) return open
        val load = loadColumn(sets) ?: return Words.Message(R.string.gym_readout_scheme, listOf(sets.size.toString(), repsColumn(sets)))
        return Words.Message(R.string.gym_readout_scheme_load, listOf(sets.size.toString(), repsColumn(sets), load))
    }

    // Coach review and the rack use the compact unit line.
    fun schemeKg(sets: List<SetTarget>): Words =
        if (sets.any { it.weightKg != null }) Words.Message(R.string.gym_readout_scheme_kg, listOf(scheme(sets))) else scheme(sets)

    // The basis a movement's load is read in: `kg total` on a barbell, `kg each` on two dumbbells.
    fun loadUnit(exercise: Exercise?): String =
        works.windmill.gym.domain.sync.Readout.loadUnit(exercise?.equipment, exercise?.loadCount ?: 1)

    fun scheme(sets: List<SetTarget>, exercise: Exercise?): Words {
        if (sets.none { it.weightKg != null }) return scheme(sets)
        return Words.Message(R.string.gym_readout_scheme_unit, listOf(scheme(sets), loadUnit(exercise)))
    }

    private fun repsColumn(sets: List<SetTarget>): Words {
        val named = sets.mapNotNull { it.reps }
        if (named.isEmpty()) return repsTarget(null)
        val low = named.min()
        if (sets.any { it.reps == null }) return Words.Message(R.string.gym_readout_reps_to_max, listOf(low.toString()))
        val high = named.max()
        if (low == high) return Words.Plain(low.toString())
        return Words.Plain("$low–$high")
    }

    private fun loadColumn(sets: List<SetTarget>): Words? {
        val named = sets.mapNotNull { it.weightKg }.map(Ladder::round)
        if (named.isEmpty()) return null
        val low = named.min()
        if (sets.any { it.weightKg == null }) return Words.Message(R.string.gym_readout_load_to_last, listOf(weight(low)))
        val high = named.max()
        if (low == high) return Words.Plain(weight(low))
        return Words.Plain("${weight(low)}–${weight(high)}")
    }

    // A clock time on the phone's own 24-hour or 12-hour setting.
    fun time(ms: Long, hours24: Boolean = true): Words {
        val at = at(ms)
        if (hours24) return Words.Plain(pad(at.hour) + ":" + pad(at.minute))
        return Words.Message(if (at.hour < 12) R.string.gym_readout_time_am else R.string.gym_readout_time_pm,
            listOf("${(at.hour + 11) % 12 + 1}:${pad(at.minute)}"))
    }

    // The shared readout omits zero tonnage and spells a positive total without integer narrowing.
    fun tonnes(kg: Double): String? {
        return works.windmill.gym.domain.sync.Readout.tonnes(kg)
    }

    val freeWorkout: Words = Words.Message(R.string.gym_readout_free_workout)

    // The shared readout states an estimate to a tenth.
    fun estimatedWeight(e1rm: Double): String = works.windmill.gym.domain.sync.Readout.estimatedWeight(e1rm)

    fun e1rm(e1rm: Double): Words = Words.Message(R.string.gym_readout_e1rm, listOf(estimatedWeight(e1rm)))

    // Up to ten in words, past it in digits.
    fun spelledOut(count: Int): Words = spelledNumbers.getOrNull(count)?.let { Words.Message(it) } ?: Words.Plain(count.toString())

    fun date(ms: Long): Words = date(at(ms).toLocalDate())

    fun date(date: LocalDate): Words =
        Words.Message(R.string.gym_readout_date, listOf(date.dayOfMonth.toString(), month(date), date.year.toString()))

    // A date with its year left to the reader.
    fun dayMonth(date: LocalDate): Words = Words.Message(R.string.gym_readout_day_month, listOf(date.dayOfMonth.toString(), month(date)))

    fun loggedWhen(ms: Long, now: Long): Words {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        if (then == today) return Words.Message(R.string.gym_readout_today_at, listOf(time(ms)))
        return day(ms)
    }

    fun day(ms: Long): Words {
        val at = at(ms).toLocalDate()
        return Words.Message(R.string.gym_readout_day, listOf(Words.Message(weekdays[at.dayOfWeek.value % 7]), at.dayOfMonth.toString(), month(at)))
    }

    fun shortDate(ms: Long, now: Long): Words {
        val at = at(ms).toLocalDate()
        if (at.year == at(now).year) return dayMonth(at)
        return date(at)
    }

    fun brief(ms: Long, now: Long): Words {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        if (then == Instant.ofEpochMilli(now).atZone(zone).toLocalDate()) return Words.Message(R.string.gym_readout_today)
        return shortDate(ms, now)
    }

    // A claim about the CALENDAR, not elapsed hours: both instants fall to their local date first.
    fun daysAgo(ms: Long, now: Long): Words {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(then, today)
        if (days <= 0) return Words.Message(R.string.gym_readout_today)
        if (days == 1L) return Words.Message(R.string.gym_readout_yesterday)
        return Words.Counted(R.plurals.gym_readout_days_ago, days.toInt(), listOf(days.toString()))
    }

    fun clock(ms: Long): String {
        val total = max(0L, ms / 1000)
        val hours = total / 3600
        val minutes = (total % 3600) / 60
        val seconds = total % 60
        val head = if (hours > 0) "$hours:${pad(minutes.toInt())}" else minutes.toString()
        return head + ":" + pad(seconds.toInt())
    }

    fun lasted(ms: Long): Words {
        val minutes = max(1L, ms / 60_000)
        if (minutes < 60) return Words.Message(R.string.gym_readout_minutes_short, listOf(minutes.toString()))
        return Words.Message(R.string.gym_readout_hours_short, listOf((minutes / 60).toString(), pad((minutes % 60).toInt())))
    }

    fun sets(count: Int): Words = Words.Counted(R.plurals.gym_readout_sets, count, listOf(count.toString()))

    fun workouts(count: Int): Words = Words.Counted(R.plurals.gym_readout_workouts, count, listOf(count.toString()))

    // A movement's equipment in a word, `dumbbell` how this place counts dumbbells; a kind this build does not name reads as its own word.
    fun equipment(equipment: String, @StringRes dumbbell: Int = R.string.gym_equipment_dumbbells): Words = when (equipment) {
        "barbell" -> Words.Message(R.string.gym_equipment_barbell)
        "dumbbell" -> Words.Message(dumbbell)
        "machine" -> Words.Message(R.string.gym_equipment_machine)
        "cable" -> Words.Message(R.string.gym_equipment_cable)
        "bodyweight" -> Words.Message(R.string.gym_equipment_bodyweight)
        "kettlebell" -> Words.Message(R.string.gym_equipment_kettlebell)
        "other" -> Words.Message(R.string.gym_equipment_other)
        else -> Words.Plain(equipment.replaceFirstChar { it.titlecase() })
    }

    fun movement(exerciseId: String, catalog: List<Exercise>): String =
        catalog.firstOrNull { it.id == exerciseId }?.name ?: exerciseId

    private fun month(date: LocalDate): Words = Words.Message(months[date.monthValue - 1])

    private fun at(ms: Long): ZonedDateTime =
        Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())

    private fun pad(value: Int): String = if (value < 10) "0$value" else value.toString()
}
