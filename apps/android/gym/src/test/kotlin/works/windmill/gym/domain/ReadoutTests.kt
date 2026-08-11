package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// One product, one spelling. Every number gym prints goes through this file, so what is pinned here
// is that the prefill card, the set row, the finish tile and the log row cannot drift apart — and
// that the two spellings a training log gets wrong stay right: a negative load, and a duration.

class ReadoutTests {
    // A weight is not a decimal field. Trailing zeros go, and the minus is the TYPOGRAPHIC one —
    // band-assisted work sits below zero, and an ASCII hyphen there is a different glyph from the
    // one the golden and the web both print.
    @Test
    fun testAWeightPrintsWithoutTrailingZerosAndWithARealMinus() {
        assertEquals("102.5", Readout.weight(102.5))
        assertEquals("100", Readout.weight(100.0))
        assertEquals("0", Readout.weight(0.0))
        assertEquals("−20", Readout.weight(-20.0))
        assertEquals("−2.5", Readout.weight(-2.5))
    }

    // The grid is the ladder's own, not a second opinion — a rounding rule of its own here is how
    // two surfaces of one product end up disagreeing about a half-cent.
    @Test
    fun testAWeightIsRoundedOnTheLaddersGrid() {
        assertEquals("102.51", Readout.weight(102.505))
        assertEquals("−102.51", Readout.weight(-102.505))
        assertEquals("0.3", Readout.weight(0.1 + 0.2))
    }

    @Test
    fun testASetReadsAsItsLoadAndItsReps() {
        assertEquals("82.5 × 5", Readout.effort(82.5, 5))
        assertEquals("0 × 9", Readout.effort(0.0, 9))
    }

    // Under an hour there is no hour, over it there are two digits of minutes — and a session that
    // lasted seconds still says a minute rather than "0m", because zero is not a workout.
    @Test
    fun testADurationNamesHoursOnlyWhenThereAreSome() {
        assertEquals("47m", Readout.duration(47 * 60_000L))
        assertEquals("1h 02m", Readout.duration(62 * 60_000L))
        assertEquals("1h 02m", Readout.duration(3_720_000))
        assertEquals("1m", Readout.duration(900))
    }

    // The clock drops the leading hour and never the leading minute: a rest at 47 seconds reads
    // 0:47, and a session at two hours reads 2:00:14.
    @Test
    fun testTheClockKeepsMinutesAndAddsHoursOnlyWhenItHasThem() {
        assertEquals("0:47", Readout.clock(47_000))
        assertEquals("32:04", Readout.clock(1_924_000))
        assertEquals("2:00:14", Readout.clock(7_214_000))
        assertEquals("a span that has not started yet is not negative time", "0:00", Readout.clock(-5_000))
    }

    @Test
    fun testHowLongAgoIsWholeDaysAndNamesTheNearOnes() {
        val day = 86_400_000L
        val now = 20 * day
        assertEquals("today", Readout.ago(now, now = now))
        assertEquals("yesterday", Readout.ago(now - day, now = now))
        assertEquals("5 days ago", Readout.ago(now - 5 * day, now = now))
    }

    // "YESTERDAY" IS A CLAIM ABOUT THE CALENDAR AND NOT ABOUT ELAPSED HOURS, which is the whole of
    // log.js `agoLabel`: a session finished at 07:00 is still today at 21:00, and one finished at
    // 23:00 is already yesterday by 01:00. Dividing the gap by 86_400_000 got both of those backwards
    // — the morning's workout read "yesterday" on the phone before lunch — and it also miscounts
    // across the 23- and 25-hour days. The instants are built in the reader's own zone, because that
    // is the only zone this sentence is ever read in.
    @Test
    fun testHowLongAgoCountsCalendarDaysAndNotElapsedHours() {
        val zone = ZoneId.systemDefault()
        val midnight = Instant.ofEpochSecond(1_754_308_320).atZone(zone).toLocalDate().atStartOfDay(zone)
        fun at(days: Int, hour: Int): Long =
            midnight.plusDays(days.toLong()).plusHours(hour.toLong()).toInstant().toEpochMilli()

        assertEquals("fourteen hours is not yesterday when it never crossed a midnight",
                     "today", Readout.ago(at(0, 7), now = at(0, 21)))
        assertEquals("two hours is yesterday once it has",
                     "yesterday", Readout.ago(at(0, 23), now = at(1, 1)))
        assertEquals("5 days ago", Readout.ago(at(0, 23), now = at(5, 1)))
    }

    // TONNAGE NEVER PRINTS A ZERO. A week of chin-ups and dips moved no external load, and `0.0 t`
    // would be a number nobody lifted standing where a fact belongs — so does anything that would
    // round to it. Nothing is formatted and nothing is localised: the tenths are an integer, for
    // the same reason the days are spelled out by hand — one product may not print one week two
    // ways, and a decimal comma or a platform's own rounding is exactly how that starts.
    @Test
    fun testTonnagePrintsOneDecimalAndSaysNothingAtZero() {
        assertEquals("14.2 t", Readout.tonnes(14_200.0))
        assertEquals("5.4 t", Readout.tonnes(5_350.0))
        assertEquals("1.0 t", Readout.tonnes(1_000.0))
        assertNull("a session that moved nothing has nothing to say", Readout.tonnes(0.0))
        assertNull("and neither does one that would round to nothing", Readout.tonnes(40.0))
    }

    // AND IT ROUNDS HALF AWAY FROM ZERO, which is `Ladder.round`'s law one decimal up rather than
    // a preference. Every one of these is a tie that a platform's own spelling gets to have an
    // opinion about — C and Swift's "%.1f" round the binary approximation half-to-even and answer
    // 1.1 for 1150, JS `toFixed` answers 1.1 for 1150 and 1.3 for 1250 — and a tonnage is a decimal
    // count of kilograms, so it rounds like one on every surface or the two phones in one lifter's
    // pockets caption the same week differently.
    @Test
    fun testTonnageRoundsHalfAwayFromZeroRatherThanHoweverThePlatformWould() {
        assertEquals("0.2 t", Readout.tonnes(150.0))
        assertEquals("0.3 t", Readout.tonnes(250.0))
        assertEquals("1.2 t", Readout.tonnes(1_150.0))
        assertEquals("1.3 t", Readout.tonnes(1_250.0))
        assertEquals("2.3 t", Readout.tonnes(2_250.0))
    }

    // The estimate is spelled here and computed nowhere on this phone: Epley lives in one place per
    // language and no client holds a copy.
    @Test
    fun testAnEstimateIsSpelledOnTheSameGridAsAWeight() {
        assertEquals("e1RM 122.5", Readout.estimate(122.5))
        assertEquals("e1RM 141", Readout.estimate(141.0))
    }

    // A miss is said as a word — a digit in that column reads like a score, and this product does
    // not score anybody against a plan they were free to change. Past the words it is a numeral,
    // because "seventeen short" is not a sentence anybody wants under a set.
    @Test
    fun testASmallCountIsSpelledAsAWord() {
        assertEquals("one", Readout.spelled(1))
        assertEquals("two", Readout.spelled(2))
        assertEquals("ten", Readout.spelled(10))
        assertEquals("11", Readout.spelled(11))
    }

    // The bottom of the log is the one place gym prints a year: it is the fact somebody scrolled all
    // the way down to arrive at.
    @Test
    fun testTheFirstSessionIsADateWithItsYear() {
        val at = LocalDate.parse("2026-05-06").atStartOfDay(ZoneId.systemDefault())
        assertEquals("6 May 2026", Readout.date(at.toInstant().toEpochMilli()))
        assertEquals("week of 4 May", Readout.weekOf(at.minusDays(2).toInstant().toEpochMilli()))
    }

    @Test
    fun testACountOfSetsIsSingularAtOne() {
        assertEquals("1 set", Readout.setCount(1))
        assertEquals("16 sets", Readout.setCount(16))
        assertEquals("0 sets", Readout.setCount(0))
    }

    // A movement is a stable id everywhere except on screen. A catalog that has not answered yet
    // leaves the slug, which a lifter can still recognise — a blank where the movement should be
    // is the one thing that is not readable.
    @Test
    fun testAMovementWithoutACatalogRowKeepsItsId() {
        val catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))
        assertEquals("Bench Press", Readout.movement("bench-press", catalog))
        assertEquals("zercher-squat", Readout.movement("zercher-squat", catalog))
        assertEquals("bench-press", Readout.movement("bench-press", emptyList()))
    }
}
