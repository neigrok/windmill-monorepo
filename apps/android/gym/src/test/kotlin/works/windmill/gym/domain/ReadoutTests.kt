package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
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
