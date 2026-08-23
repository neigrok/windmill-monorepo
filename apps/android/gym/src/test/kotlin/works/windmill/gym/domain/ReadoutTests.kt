package works.windmill.gym.domain

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReadoutTests {
    @Test
    fun testAWeightPrintsWithoutTrailingZerosAndWithARealMinus() {
        assertEquals("102.5", Readout.weight(102.5))
        assertEquals("100", Readout.weight(100.0))
        assertEquals("0", Readout.weight(0.0))
        assertEquals("−20", Readout.weight(-20.0))
        assertEquals("−2.5", Readout.weight(-2.5))
    }

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

    @Test
    fun testADurationNamesHoursOnlyWhenThereAreSome() {
        assertEquals("47m", Readout.duration(47 * 60_000L))
        assertEquals("1h 02m", Readout.duration(62 * 60_000L))
        assertEquals("1h 02m", Readout.duration(3_720_000))
        assertEquals("1m", Readout.duration(900))
    }

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
    fun testTonnagePrintsOneDecimalAndSaysNothingAtZero() {
        assertEquals("14.2 t", Readout.tonnes(14_200.0))
        assertEquals("5.4 t", Readout.tonnes(5_350.0))
        assertEquals("1.0 t", Readout.tonnes(1_000.0))
        assertNull("a session that moved nothing has nothing to say", Readout.tonnes(0.0))
        assertNull("and neither does one that would round to nothing", Readout.tonnes(40.0))
    }

    @Test
    fun testTonnageRoundsHalfAwayFromZeroRatherThanHoweverThePlatformWould() {
        assertEquals("0.2 t", Readout.tonnes(150.0))
        assertEquals("0.3 t", Readout.tonnes(250.0))
        assertEquals("1.2 t", Readout.tonnes(1_150.0))
        assertEquals("1.3 t", Readout.tonnes(1_250.0))
        assertEquals("2.3 t", Readout.tonnes(2_250.0))
    }

    @Test
    fun testAnEstimateIsSpelledOnTheSameGridAsAWeight() {
        assertEquals("e1RM 122.5", Readout.estimate(122.5))
        assertEquals("e1RM 141", Readout.estimate(141.0))
    }

    @Test
    fun testASmallCountIsSpelledAsAWord() {
        assertEquals("one", Readout.spelled(1))
        assertEquals("two", Readout.spelled(2))
        assertEquals("ten", Readout.spelled(10))
        assertEquals("11", Readout.spelled(11))
    }

    @Test
    fun testTheFirstSessionIsADateWithItsYear() {
        val at = LocalDate.parse("2026-05-06").atStartOfDay(ZoneId.systemDefault())
        assertEquals("6 May 2026", Readout.date(at.toInstant().toEpochMilli()))
        assertEquals("week of 4 May", Readout.weekOf(at.minusDays(2).toInstant().toEpochMilli()))
    }

    @Test
    fun testTheRecordPagesDayDropsTheWeekdayAndKeepsTheYearOnlyWhereItMatters() {
        val zone = ZoneId.systemDefault()
        val now = LocalDate.parse("2026-08-11").atStartOfDay(zone).plusHours(9).toInstant().toEpochMilli()
        val earlier = LocalDate.parse("2026-08-11").atStartOfDay(zone).plusHours(6).toInstant().toEpochMilli()
        val august = LocalDate.parse("2026-08-03").atStartOfDay(zone).plusHours(18).toInstant().toEpochMilli()
        val lastYear = LocalDate.parse("2025-07-13").atStartOfDay(zone).plusHours(18).toInstant().toEpochMilli()

        assertEquals("today", Readout.briefDay(earlier, now))
        assertEquals("3 Aug", Readout.briefDay(august, now))
        assertEquals("13 Jul 2025", Readout.briefDay(lastYear, now))

        assertEquals("an axis end is a date and never a word", "11 Aug", Readout.shortDate(earlier, now))
        assertEquals("3 Aug", Readout.shortDate(august, now))
        assertEquals("13 Jul 2025", Readout.shortDate(lastYear, now))
    }

    @Test
    fun testACountOfSetsIsSingularAtOne() {
        assertEquals("1 set", Readout.setCount(1))
        assertEquals("16 sets", Readout.setCount(16))
        assertEquals("0 sets", Readout.setCount(0))
    }

    @Test
    fun testAMovementWithoutACatalogRowKeepsItsId() {
        val catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))
        assertEquals("Bench Press", Readout.movement("bench-press", catalog))
        assertEquals("zercher-squat", Readout.movement("zercher-squat", catalog))
        assertEquals("bench-press", Readout.movement("bench-press", emptyList()))
    }
}
