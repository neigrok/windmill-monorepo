package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max

// ONE WAY TO SPELL A NUMBER — the native statement of web/src/products/gym/log.js. A weight, a day,
// a duration and a clock are printed here and nowhere else in gym, so the prefill card, the set row,
// the finish tiles and the log row can never disagree about the same fact.
//
// Days and months are spelled out rather than localised, exactly as the web spells them: "Tue 4 Aug"
// is the string the design draws, and a locale that reordered it would make two surfaces of the same
// product print one day two ways.

object Readout {
    private val weekdays = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    // Trailing zeros stripped and a REAL U+2212 minus, because a negative load is a normal point on
    // the number line here — band-assisted work sits below zero. The grid is the LADDER's own and
    // never a second opinion: this rounded to two decimals itself until the two spellings disagreed
    // on a negative half-cent, and only one of them has a golden.
    fun weight(kg: Double): String {
        val magnitude = Ladder.round(abs(kg))
        val digits = if (magnitude == floor(magnitude)) magnitude.toLong().toString() else magnitude.toString()
        return (if (kg < 0) "−" else "") + digits
    }

    fun effort(weightKg: Double, reps: Int): String = "${weight(weightKg)} × $reps"

    // A rep target a routine declines to set is `3 × max` — a movement taken to whatever it gives
    // that day. It is not a zero and it is not a blank, and this is the only place the word is
    // spelled, so the routine card, the logger's plan line and the finish comparison agree.
    fun repTarget(reps: Int?): String = reps?.toString() ?: "max"

    fun time(ms: Long): String {
        val at = at(ms)
        return pad(at.hour) + ":" + pad(at.minute)
    }

    // `utc` is for one caller and one reason: the statistics weeks are bucketed by
    // `date_trunc('week', … AT TIME ZONE 'UTC')`, so a bucket's start instant is a UTC Monday
    // midnight. Rendered in the reader's own zone it comes out as Sunday for half the planet, and a
    // week label that names the wrong day is worse than none. Everything else in gym is an instant a
    // person lived through and reads in the zone they are standing in, which is the default.
    fun day(ms: Long, utc: Boolean = false): String {
        val at = at(ms, utc)
        return "${weekdays[at.dayOfWeek.value % 7]} ${at.dayOfMonth} ${months[at.monthValue - 1]}"
    }

    // The day a session ran, spelled in full — the one place gym prints a weekday as a NAME rather
    // than as a date, because it is offered as a routine's name and "Tue 4 Aug" is not one.
    fun weekday(ms: Long): String {
        val names = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
        return names[at(ms).dayOfWeek.value % 7]
    }

    // "Yesterday" is a claim about the CALENDAR and not about elapsed hours: a session finished at
    // 07:00 is still today at 21:00, and one finished at 23:00 is already yesterday by 01:00. So both
    // instants fall to their own local date before the difference is taken — which also makes the
    // count right across the 23- and the 25-hour day, where dividing by 86_400_000 is not. The web
    // says it the same way (log.js `agoLabel`), over the same stored instant.
    fun ago(ms: Long, now: Long): String {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(then, today)
        if (days <= 0) return "today"
        if (days == 1L) return "yesterday"
        return "$days days ago"
    }

    // The session clock and the rest timer both read this, and both hand it a span computed from an
    // instant rather than a counter they incremented — so a locked phone and a relaunch both come
    // back showing the true elapsed time instead of the time the app was awake for.
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

    // The product counts SESSIONS — never workouts and never entries — so the word is spelled here
    // beside the set's, and the movement lines on the statistics screen borrow it rather than
    // inventing a second noun for the same thing.
    fun sessionCount(count: Int): String = if (count == 1) "1 session" else "$count sessions"

    // A movement is a stable id everywhere except on screen. Falling back to the id keeps a sentence
    // readable while the catalog has not answered — a slug a lifter can still recognise beats a
    // blank where the movement should be.
    fun movement(exerciseId: String, catalog: List<Exercise>): String =
        catalog.firstOrNull { it.id == exerciseId }?.name ?: exerciseId

    private fun at(ms: Long, utc: Boolean = false): ZonedDateTime =
        Instant.ofEpochMilli(ms).atZone(if (utc) ZoneOffset.UTC else ZoneId.systemDefault())

    private fun pad(value: Int): String = if (value < 10) "0$value" else value.toString()
}
