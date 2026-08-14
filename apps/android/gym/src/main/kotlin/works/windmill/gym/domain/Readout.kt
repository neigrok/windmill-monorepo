package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
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
    private val fullMonths = listOf("January", "February", "March", "April", "May", "June",
                                    "July", "August", "September", "October", "November", "December")
    private val names = listOf("zero", "one", "two", "three", "four", "five",
                               "six", "seven", "eight", "nine", "ten")

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

    // What a routine asks a movement for, in one line — the routine's own page, the builder's list
    // and the finish comparison all print it, so a target reads the same wherever it is read
    // (log.js `entryLabel`). An absent weight is "whatever you did last time" and prints nothing
    // rather than a zero; so does an actual zero, because zero is not a load but the absence of one,
    // while a band-assisted −20 is a real point on this number line and prints.
    //
    // The plan and the routine spell their targets with different field names and the same three
    // numbers, so both hand them over rather than each writing the grammar out again.
    // A row with no SET target is `open` — the routine declined to say, so it asks at the rack. It
    // is the one target that answers with a word instead of numbers, and it is spelled here for the
    // reason `max` is: the routine card, the routines tab, the builder's list and the routine's own
    // page all print it, and four screens inventing four words for one absence is the drift this
    // object exists to prevent. An open row carries no reps and no weight, so nothing else is read.
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

    // TONNAGE IS A CAPTION AND NEVER A METRIC. `domain/Statistics.h` refuses volume brand-wide for a
    // good reason — band-assisted work logs a negative load, so weight × reps FALLS as a lifter gets
    // stronger — and the refusal stands: e1RM is still the headline, and nothing is ever ranked by
    // this. What the log's week divider asks for is the scale of a week, sitting beside the four
    // facts a lifter scans, which is a different claim.
    //
    // So it clamps rather than subtracts: an assisted set moved no external load and contributes
    // zero, and so does a bodyweight one — gym does not know a lifter's bodyweight. And a sum that
    // comes to zero prints NOTHING rather than `0.0 t`: a chin-up-and-dips week did not move zero
    // kilograms, we simply have nothing true to say about it. Absence over a false zero, which is
    // also why anything under fifty kilos — a tonnage that would round to `0.0 t` — says nothing.
    //
    // ROUNDED HALF AWAY FROM ZERO BY HAND, and the tenths are an INTEGER so that no formatter and
    // no locale ever touches this number. That is `Ladder.round`'s law one decimal further up, and
    // it is a law for the same reason: the three languages' own spellings disagree with each other,
    // so a surface that reached for the one its platform ships would print a different week to the
    // phone in the other pocket. Measured, same doubles, three runtimes:
    //
    //     kg     this law   C/Swift "%.1f"   JS toFixed(1)
    //     5350     5.4          5.3              5.3          ← §G17 draws 5.4 t
    //     1150     1.2          1.1              1.1
    //     1250     1.3          1.2              1.3
    //      250     0.3          0.2              0.3
    //
    // Each of those rounds the BINARY APPROXIMATION of a decimal sum, which is why none of them is
    // even self-consistent — toFixed sends 1150 down and 1250 up. A tonnage is a decimal quantity
    // of kilograms and it rounds like one.
    //
    // Java's own `%.1f` happens to agree with the law on every row above, because it rounds the
    // SHORTEST DECIMAL of the double rather than the double. That is one runtime's implementation
    // detail and not a rule anybody wrote down, and a rule the other two rooms cannot reproduce is
    // no use to them — so the arithmetic is here where all three can copy it.
    fun tonnes(kg: Double): String? {
        val tenths = floor(kg / 100.0 + 0.5).toLong()
        if (tenths <= 0) return null
        return "${tenths / 10}.${tenths % 10} t"
    }

    // ONE WORD FOR A SESSION NOBODY PLANNED, everywhere this room names one — the log's row, the
    // session read back and the live logger's own head. It is the
    // design's own (§G16) and it replaced "Ad-hoc", which the web retired for the same reason
    // (log.js NO_ROUTINE): a session with no routine is the ordinary case in most logs and must not
    // read as a fault or as jargon. It is spelled here beside the other phrases this product spells
    // once — a screen that borrowed it from the LOG's file would be the log deciding what the
    // logger calls a workout, and two words for one thing is how two screens start disagreeing.
    const val noRoutine = "Session · no routine"

    // ONE WORD FOR WHAT COUNTS. A set counts toward a target, a record and the prefill only when its
    // kind is working, so the log row and the session head both name the working ones and never the
    // total — the number beside a session's top set has always been about these.
    fun workingSets(count: Int): String = "$count working"

    // The estimate arrives from the log or not at all: Epley lives in one place per language and
    // this phone is not one of them (Review.of and MovementRecord.of say the same). This spells the
    // number the server computed; it never makes one.
    fun estimate(e1rm: Double): String = "e1RM ${weight(e1rm)}"

    // A count said as a word, for the one column that reads better without a numeral in it: a set
    // that came up short gets `two short`, because a digit in a miss column reads like a score, and
    // this product does not score anybody against a plan they were free to change.
    fun spelled(count: Int): String = names.getOrNull(count) ?: count.toString()

    fun weekOf(ms: Long): String {
        val at = at(ms)
        return "week of ${at.dayOfMonth} ${months[at.monthValue - 1]}"
    }

    // The bottom of the log, and the one place gym prints a YEAR: it is the date a lifter scrolled
    // all the way down to arrive at, and "6 May" without the year is the fact they came for with the
    // interesting half missing.
    fun date(ms: Long): String {
        val at = at(ms)
        return "${at.dayOfMonth} ${months[at.monthValue - 1]} ${at.year}"
    }

    // When a session happened, as a log row says it. Today's still carries its clock — a session
    // finished an hour ago is placed by the hour — and every older one is a date, because the minute
    // it started at is no longer something anybody is standing in.
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

    // A day at its shortest that is still unambiguous — `3 Aug` inside the year being lived in, and
    // `13 Jul 2025` outside it, for the reason the log's foot prints a year: a bare day and month
    // three years back is the fact somebody came for with the interesting half missing. §H stacks
    // dates in three narrow columns and a weekday in each would take the width the numbers need,
    // which is why this drops the one `day` keeps.
    fun shortDate(ms: Long, now: Long): String {
        val at = at(ms)
        val here = at(now)
        val date = "${at.dayOfMonth} ${months[at.monthValue - 1]}"
        if (at.year == here.year) return date
        return "$date ${at.year}"
    }

    // THE MONTH A CONVERSATION HAPPENED IN, spelled in full — the only grouping §O's threads list
    // has. In full because it is a heading a lifter reads rather than a value in a column, and with
    // the YEAR outside the one being lived in for the reason the log's foot prints one: `July` three
    // years back is the fact somebody came for with the interesting half missing.
    fun month(ms: Long, now: Long): String {
        val at = at(ms)
        val name = fullMonths[at.monthValue - 1]
        if (at.year == at(now).year) return name
        return "$name ${at.year}"
    }

    // The same day said the way a person says the one they are standing in. The record page's
    // tiles, its personal records and its recent sets all print this; the chart's two axis ends
    // print `shortDate`, because an end of an axis is a date and never a word.
    fun briefDay(ms: Long, now: Long): String {
        val zone = ZoneId.systemDefault()
        val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        if (then == Instant.ofEpochMilli(now).atZone(zone).toLocalDate()) return "today"
        return shortDate(ms, now)
    }

    // A day said the way a person says one they can still picture: today, yesterday, then the
    // weekday for the rest of the week behind them, and a DATE the moment a name can no longer
    // place it. `built Sunday` is true on Monday and a lie in September, which is the whole of why
    // this falls through rather than printing a weekday forever — the same reason `ago` counts in
    // calendar days rather than in elapsed hours, and it counts them the same way.
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

    // What a routine holds and when it was last used — the line the home list prints and the line
    // the routine's own page falls back to, which is one sentence and therefore lives in one place.
    // It is also the fact the list is SORTED by, so a row never has to explain its own order. A
    // routine nobody has trained says exactly that rather than borrowing today. The noun is
    // MOVEMENT — a routine holds movements, never "exercises" (the 13 Aug vocabulary lock) — and it
    // is Program's own spelling, so the head line and this one cannot drift.
    fun routineLine(routine: Routine, now: Long): String {
        val movements = Program.movements(routine.entries.size)
        val trained = routine.lastTrainedAtMs ?: return "$movements · never trained"
        return "$movements · trained ${ago(trained, now)}"
    }

    // How many days a program holds — the home's own sub-line and nothing else's.
    fun routineCount(count: Int): String = if (count == 1) "1 routine" else "$count routines"

    // The product counts SESSIONS — never workouts and never entries — so the word is spelled here
    // beside the set's, and the record page's subhead borrows it rather than inventing a second
    // noun for the same thing.
    fun sessionCount(count: Int): String = if (count == 1) "1 session" else "$count sessions"

    // The third noun the read line counts (§L). A week here is the SERVER's Monday-UTC bucket, the
    // same one `date_trunc('week')` cuts, and this only SPELLS it — nothing on this device works out
    // which weeks a set fell in, because a count this phone could arrive at is a count the model
    // could have invented.
    fun weekCount(count: Int): String = if (count == 1) "1 week" else "$count weeks"

    // A movement is a stable id everywhere except on screen. Falling back to the id keeps a sentence
    // readable while the catalog has not answered — a slug a lifter can still recognise beats a
    // blank where the movement should be.
    fun movement(exerciseId: String, catalog: List<Exercise>): String =
        catalog.firstOrNull { it.id == exerciseId }?.name ?: exerciseId

    private fun at(ms: Long): ZonedDateTime =
        Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())

    private fun pad(value: Int): String = if (value < 10) "0$value" else value.toString()
}
