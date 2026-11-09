package works.windmill.gym.presentation

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.spelled

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReadoutTests {
    @Test
    fun workoutCountsUseTheSameWordForEveryCardinality() {
        assertEquals(listOf("0 workouts", "1 workout", "2 workouts"), (0..2).map { Readout.workouts(it).spelled() })
    }

    @Test
    fun aClockTimeFollowsThePhonesTwentyFourHourSetting() {
        fun at(hour: Int, minute: Int) = LocalDate.of(2026, 11, 8).atTime(hour, minute).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        assertEquals(listOf("00:05", "09:30", "12:00", "18:45"), listOf(at(0, 5), at(9, 30), at(12, 0), at(18, 45)).map { Readout.time(it).spelled() })
        assertEquals(listOf("12:05 AM", "9:30 AM", "12:00 PM", "6:45 PM"),
            listOf(at(0, 5), at(9, 30), at(12, 0), at(18, 45)).map { Readout.time(it, hours24 = false).spelled() })
    }

    @Test
    fun aWorkoutWithoutARoutineHasOneSharedTitle() {
        assertEquals("Free workout", Readout.freeWorkout.spelled())
    }

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
    fun testOneSetReadsAsItsLoadAndItsRepsWithTheNullsAsTheirPlaceholders() {
        assertEquals("100 × 5", Readout.setScheme(SetTarget(5, 100.0)).spelled())
        assertEquals("100 × max", Readout.setScheme(SetTarget(null, 100.0)).spelled())
        assertEquals("last × 5", Readout.setScheme(SetTarget(5, null)).spelled())
        assertEquals("last × max", Readout.setScheme(SetTarget()).spelled())
        assertEquals("−20 × 8", Readout.setScheme(SetTarget(8, -20.0)).spelled())
    }

    @Test
    fun testASchemeReadsAsItsCountThenEachColumnAsOneValueOrItsRange() {
        val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))
        assertEquals("5 × 1–5 · 60–100", Readout.scheme(ramp).spelled())
        assertEquals("3 × 8 · 60", Readout.scheme(List(3) { SetTarget(8, 60.0) }).spelled())
        assertEquals("3 × 5–max · 100", Readout.scheme(listOf(SetTarget(5, 100.0), SetTarget(5, 100.0), SetTarget(null, 100.0))).spelled())
        assertEquals("5 × 8–12 · 80", Readout.scheme(listOf(SetTarget(12, 80.0), SetTarget(10, 80.0), SetTarget(10, 80.0),
                                                              SetTarget(8, 80.0), SetTarget(8, 80.0))).spelled())
        assertEquals("open", Readout.scheme(emptyList()).spelled())
        assertEquals("a one-set scheme prints the scheme formula", "1 × 5 · 100", Readout.scheme(listOf(SetTarget(5, 100.0))).spelled())
        assertEquals("1 × max · 100", Readout.scheme(listOf(SetTarget(null, 100.0))).spelled())
        assertEquals("1 × 5", Readout.scheme(listOf(SetTarget(5))).spelled())
        assertEquals("no set names a load, so no load column", "3 × 5", Readout.scheme(List(3) { SetTarget(5) }).spelled())
        assertEquals("a placeholder stands as the high end of a mixed column", "3 × 5 · 60–last",
                     Readout.scheme(listOf(SetTarget(5, 60.0), SetTarget(5), SetTarget(5, 80.0))).spelled())
        assertEquals("3 × 5–max · 60–last",
                     Readout.scheme(listOf(SetTarget(5, 60.0), SetTarget(null), SetTarget(8, 80.0))).spelled())
        assertEquals("3 × max", Readout.scheme(List(3) { SetTarget() }).spelled())
        assertEquals("the range dash is an en dash", '\u2013', Readout.scheme(ramp).spelled()?.get(5))
    }

    @Test
    fun targetUnitUsesResolvedEquipmentAndCountWithoutChangingTheLoad() {
        val targets = List(3) { SetTarget(8, 24.0) }
        val cases = listOf(
            Triple("barbell", 1, "3 × 8 · 24 kg total"),
            Triple("dumbbell", 2, "3 × 8 · 24 kg each"),
            Triple("dumbbell", 1, "3 × 8 · 24 kg"),
            Triple("machine", 1, "3 × 8 · 24 kg"),
            Triple("bodyweight", 1, "3 × 8 · 24 kg added"),
            Triple("cable", 1, "3 × 8 · 24 kg"),
            Triple("kettlebell", 1, "3 × 8 · 24 kg"),
            Triple("unknown", 2, "3 × 8 · 24 kg"),
        )
        for ((equipment, count, expected) in cases) {
            val exercise = Exercise("movement", "Movement", equipment = equipment, loadCount = count)
            assertEquals(expected, Readout.scheme(targets, exercise).spelled())
            assertEquals(expected, Readout.scheme(targets, exercise.copy(name = "My movement")).spelled())
        }
        assertEquals("3 × 8 · 24 kg", Readout.scheme(targets, null).spelled())
        assertEquals(List(3) { SetTarget(8, 24.0) }, targets)
        assertEquals("3 × 8 · 24", Readout.scheme(targets).spelled())
        assertEquals("3 × 8 · 24kg", Readout.schemeKg(targets).spelled())
    }

    @Test
    fun signedAndOpenTargetsKeepTheirMeaningWithEquipmentUnits() {
        val bodyweight = Exercise("pull-up", "Pull Up", equipment = "bodyweight")
        assertEquals("3 × 8 · −10 kg added", Readout.scheme(List(3) { SetTarget(8, -10.0) }, bodyweight).spelled())
        assertEquals("3 × 8 · 0 kg added", Readout.scheme(List(3) { SetTarget(8, 0.0) }, bodyweight).spelled())
        assertEquals("3 × 5–max · −10–last kg added", Readout.scheme(
            listOf(SetTarget(5, -10.0), SetTarget(null, 5.0), SetTarget(8)), bodyweight).spelled())
        assertEquals("open", Readout.scheme(emptyList(), bodyweight).spelled())
        assertEquals("3 × max", Readout.scheme(List(3) { SetTarget() }, bodyweight).spelled())
        val single = Exercise("goblet-squat", "Goblet Squat", equipment = "dumbbell")
        val pair = Exercise("dumbbell-bench-press", "Dumbbell Bench Press", equipment = "dumbbell")
        assertEquals("1 × 5 · 16 kg", Readout.scheme(listOf(SetTarget(5, 16.0)), single).spelled())
        assertEquals("1 × 5 · 16 kg each", Readout.scheme(listOf(SetTarget(5, 16.0)), pair).spelled())
    }

    @Test
    fun testADurationNamesHoursOnlyWhenThereAreSome() {
        assertEquals("47m", Readout.lasted(47 * 60_000L).spelled())
        assertEquals("1h 02m", Readout.lasted(62 * 60_000L).spelled())
        assertEquals("1h 02m", Readout.lasted(3_720_000).spelled())
        assertEquals("1m", Readout.lasted(900).spelled())
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
        assertEquals("today", Readout.daysAgo(now, now = now).spelled())
        assertEquals("yesterday", Readout.daysAgo(now - day, now = now).spelled())
        assertEquals("5 days ago", Readout.daysAgo(now - 5 * day, now = now).spelled())
    }

    @Test
    fun testHowLongAgoCountsCalendarDaysAndNotElapsedHours() {
        val zone = ZoneId.systemDefault()
        val midnight = Instant.ofEpochSecond(1_754_308_320).atZone(zone).toLocalDate().atStartOfDay(zone)
        fun at(days: Int, hour: Int): Long =
            midnight.plusDays(days.toLong()).plusHours(hour.toLong()).toInstant().toEpochMilli()

        assertEquals("fourteen hours is not yesterday when it never crossed a midnight",
                     "today", Readout.daysAgo(at(0, 7), now = at(0, 21)).spelled())
        assertEquals("two hours is yesterday once it has",
                     "yesterday", Readout.daysAgo(at(0, 23), now = at(1, 1)).spelled())
        assertEquals("5 days ago", Readout.daysAgo(at(0, 23), now = at(5, 1)).spelled())
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
        assertEquals("e1RM 122.5", Readout.e1rm(122.5).spelled())
        assertEquals("e1RM 141", Readout.e1rm(141.0).spelled())
    }

    @Test
    fun testASmallCountIsSpelledAsAWord() {
        assertEquals("one", Readout.spelledOut(1).spelled())
        assertEquals("two", Readout.spelledOut(2).spelled())
        assertEquals("ten", Readout.spelledOut(10).spelled())
        assertEquals("11", Readout.spelledOut(11).spelled())
    }

    // The readout names days and months from its own tables, whatever language the phone is set to.
    @Test @Config(qualifiers = "ru-rRU")
    fun everyWeekdayAndMonthReadsFromTheReadoutsOwnTables() {
        val zone = ZoneId.systemDefault()
        assertEquals(listOf("Sun 1 Nov", "Mon 2 Nov", "Tue 3 Nov", "Wed 4 Nov", "Thu 5 Nov", "Fri 6 Nov", "Sat 7 Nov"),
            (1..7).map { Readout.day(LocalDate.of(2026, 11, it).atStartOfDay(zone).plusHours(12).toInstant().toEpochMilli()).spelled() })
        assertEquals(listOf("1 Jan 2026", "1 Feb 2026", "1 Mar 2026", "1 Apr 2026", "1 May 2026", "1 Jun 2026", "1 Jul 2026", "1 Aug 2026",
            "1 Sep 2026", "1 Oct 2026", "1 Nov 2026", "1 Dec 2026"), (1..12).map { Readout.date(LocalDate.of(2026, it, 1)).spelled() })
        assertEquals("1 Dec", Readout.dayMonth(LocalDate.of(2026, 12, 1)).spelled())
        assertEquals(listOf("12:05 AM", "11:59 AM", "12:00 PM", "11:30 PM"), listOf(0 to 5, 11 to 59, 12 to 0, 23 to 30).map { (hour, minute) ->
            Readout.time(LocalDate.of(2026, 11, 1).atStartOfDay(zone).plusHours(hour.toLong()).plusMinutes(minute.toLong()).toInstant().toEpochMilli(), hours24 = false).spelled()
        })
    }

    @Test
    fun testTheFirstSessionIsADateWithItsYear() {
        val at = LocalDate.parse("2026-05-06").atStartOfDay(ZoneId.systemDefault())
        assertEquals("6 May 2026", Readout.date(at.toInstant().toEpochMilli()).spelled())
    }

    @Test
    fun testTheRecordPagesDayDropsTheWeekdayAndKeepsTheYearOnlyWhereItMatters() {
        val zone = ZoneId.systemDefault()
        val now = LocalDate.parse("2026-08-11").atStartOfDay(zone).plusHours(9).toInstant().toEpochMilli()
        val earlier = LocalDate.parse("2026-08-11").atStartOfDay(zone).plusHours(6).toInstant().toEpochMilli()
        val august = LocalDate.parse("2026-08-03").atStartOfDay(zone).plusHours(18).toInstant().toEpochMilli()
        val lastYear = LocalDate.parse("2025-07-13").atStartOfDay(zone).plusHours(18).toInstant().toEpochMilli()

        assertEquals("today", Readout.brief(earlier, now).spelled())
        assertEquals("3 Aug", Readout.brief(august, now).spelled())
        assertEquals("13 Jul 2025", Readout.brief(lastYear, now).spelled())

        assertEquals("an axis end is a date and never a word", "11 Aug", Readout.shortDate(earlier, now).spelled())
        assertEquals("3 Aug", Readout.shortDate(august, now).spelled())
        assertEquals("13 Jul 2025", Readout.shortDate(lastYear, now).spelled())
    }

    @Test
    fun testACountOfSetsIsSingularAtOne() {
        assertEquals("1 set", Readout.sets(1).spelled())
        assertEquals("16 sets", Readout.sets(16).spelled())
        assertEquals("0 sets", Readout.sets(0).spelled())
    }

    @Test
    fun testAMovementWithoutACatalogRowKeepsItsId() {
        val catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))
        assertEquals("Bench Press", Readout.movement("bench-press", catalog))
        assertEquals("zercher-squat", Readout.movement("zercher-squat", catalog))
        assertEquals("bench-press", Readout.movement("bench-press", emptyList()))
    }
}
