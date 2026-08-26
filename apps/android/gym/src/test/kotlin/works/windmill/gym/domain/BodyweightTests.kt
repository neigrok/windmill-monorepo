package works.windmill.gym.domain

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BodyweightTests {
    private val today: LocalDate = LocalDate.parse("2026-08-26")
    private val nowMs: Long = today.atStartOfDay(ZoneId.systemDefault()).plusHours(9).toInstant().toEpochMilli()

    private fun weighIn(date: String, kg: Double, at: Long = 1_000) = WeighIn(date, kg, at)

    @Test
    fun testTheFieldTakesCommaOrPointAndRefusesOneThingAtATime() {
        assertEquals(ParsedWeight.Ok(82.4), Bodyweight.parse("82.4"))
        assertEquals(ParsedWeight.Ok(82.4), Bodyweight.parse("82,4"))
        assertEquals(ParsedWeight.Ok(82.0), Bodyweight.parse(" 82 "))
        assertEquals("two decimals stored, half up", ParsedWeight.Ok(82.46), Bodyweight.parse("82.455"))
        assertEquals(ParsedWeight.Refused("That is not a number yet."), Bodyweight.parse(""))
        assertEquals(ParsedWeight.Refused("That is not a number yet."), Bodyweight.parse("abc"))
        assertEquals(ParsedWeight.Refused("That is not a number yet."), Bodyweight.parse("82.4kg"))
        assertEquals(ParsedWeight.Refused("That is not a number yet."), Bodyweight.parse("-82"))
        assertEquals(ParsedWeight.Refused("One decimal point only."), Bodyweight.parse("1.2.3"))
        assertEquals(ParsedWeight.Refused("One decimal point only."), Bodyweight.parse("82,4.5"))
        assertEquals(ParsedWeight.Refused("Between 20 and 400 kg — check the number."), Bodyweight.parse("19.99"))
        assertEquals(ParsedWeight.Refused("Between 20 and 400 kg — check the number."), Bodyweight.parse("400.01"))
        assertEquals(ParsedWeight.Ok(20.0), Bodyweight.parse("20"))
        assertEquals(ParsedWeight.Ok(400.0), Bodyweight.parse("400"))
    }

    @Test
    fun testKilogramsDropTrailingZerosAndNothingElse() {
        assertEquals("82.4", Bodyweight.kilograms(82.4))
        assertEquals("82", Bodyweight.kilograms(82.0))
        assertEquals("82.45", Bodyweight.kilograms(82.45))
        assertEquals("100", Bodyweight.kilograms(100.0))
    }

    @Test
    fun testTheReadingIsTheLastWeighInAndItsAgeOrNothingAtAll() {
        assertNull("no weigh-in ever draws nothing — no dash, no zero", Bodyweight.reading(null, nowMs))
        assertEquals("82.4 kg · today", Bodyweight.reading(weighIn("2026-08-26", 82.4), nowMs))
        assertEquals("82.4 kg · yesterday", Bodyweight.reading(weighIn("2026-08-25", 82.4), nowMs))
        assertEquals("83 kg · 3 days ago", Bodyweight.reading(weighIn("2026-08-23", 83.0), nowMs))
    }

    @Test
    fun testTheWindowIsNinetyCalendarDaysEndingTodayOrTheWholeSeries() {
        val series = listOf(
            weighIn("2026-05-28", 84.0),
            weighIn("2026-05-29", 84.1),
            weighIn("2026-08-26", 82.4),
        )
        assertEquals(listOf("2026-05-29", "2026-08-26"),
            Bodyweight.windowed(series, ChartWindow.Ninety, today).map { it.dateLocal })
        assertEquals(listOf("2026-05-28", "2026-05-29", "2026-08-26"),
            Bodyweight.windowed(series, ChartWindow.All, today).map { it.dateLocal })
        // B11: the window label, byte for byte, on every surface.
        assertEquals("last 90 days · 2 weigh-ins", Bodyweight.windowLine(ChartWindow.Ninety, 2))
        assertEquals("last 90 days · 1 weigh-in", Bodyweight.windowLine(ChartWindow.Ninety, 1))
        assertEquals("the whole series · 1 weigh-in", Bodyweight.windowLine(ChartWindow.All, 1))
        assertEquals("the whole series · 12 weigh-ins", Bodyweight.windowLine(ChartWindow.All, 12))
    }

    @Test
    fun testASegmentJoinsDotsSevenDaysApartAndNotEight() {
        val runs = Bodyweight.runs(listOf(
            weighIn("2026-07-01", 83.0),
            weighIn("2026-07-08", 82.8),
            weighIn("2026-07-16", 82.5),
            weighIn("2026-07-07", 82.9),
        ))
        assertEquals(3, runs.size)
        assertTrue(runs[0] is ChartRun.Segment)
        assertTrue("exactly seven days still joins", runs[1] is ChartRun.Segment)
        val gap = runs[2] as ChartRun.Gap
        assertEquals("no weigh-in · 8 Jul – 16 Jul", gap.label)
    }

    @Test
    fun testTheAxisIsTheSeriesOwnFloorAndCeilingPlusPaddingNeverZero() {
        val axis = Bodyweight.axis(listOf(weighIn("2026-08-01", 82.0), weighIn("2026-08-02", 84.5)))!!
        assertEquals(81.0, axis.floorKg, 0.0)
        assertEquals(85.5, axis.ceilingKg, 0.0)
        assertEquals(0.5f, Bodyweight.axis(listOf(weighIn("2026-08-01", 82.0)))!!.fraction(82.0), 0.001f)
        assertNull(Bodyweight.axis(emptyList()))
    }

    @Test
    fun testTheDateRowNamesTodayAndSpellsTheRest() {
        assertEquals("Today · Wed 26 Aug", Bodyweight.dayLine(today, today))
        assertEquals("Tue 25 Aug", Bodyweight.dayLine(today.minusDays(1), today))
    }

    @Test
    fun testAWeighInIsNeverInTheFuture() {
        val today = LocalDate.parse("2026-08-26")
        assertEquals(null, Bodyweight.dated(today, today))
        assertEquals(null, Bodyweight.dated(today.minusDays(40), today))
        assertEquals("A weigh-in is not a forecast — today or earlier.", Bodyweight.dated(today.plusDays(1), today))
        assertEquals(Bodyweight.notAForecast, Bodyweight.dated(today.plusYears(1), today))
    }

    // B2's client half: the log refuses a date a day later than this phone would, so a served row
    // dated past this device's today is neither the reading nor a dot in either window.
    @Test
    fun testAServedFutureRowIsNeverTheReadingNorADot() {
        val series = listOf(
            weighIn("2026-08-27", 90.0),
            weighIn("2026-08-20", 83.0),
            weighIn("2026-08-26", 82.4),
        )
        assertEquals("2026-08-26", Bodyweight.latest(series, today)?.dateLocal)
        assertEquals("82.4 kg · today", Bodyweight.reading(Bodyweight.latest(series, today), nowMs))
        assertEquals(listOf("2026-08-20", "2026-08-26"),
            Bodyweight.windowed(series, ChartWindow.Ninety, today).map { it.dateLocal })
        assertEquals(listOf("2026-08-20", "2026-08-26"),
            Bodyweight.windowed(series, ChartWindow.All, today).map { it.dateLocal })
        assertNull("only a future row is no reading at all", Bodyweight.latest(listOf(weighIn("2026-08-27", 90.0)), today))
        assertEquals(emptyList<WeighIn>(), Bodyweight.windowed(listOf(weighIn("2026-08-27", 90.0)), ChartWindow.All, today))
    }

    @Test
    fun testTheAxisNamesItsUnitAndTheRepairSheetIsTitledByItsDay() {
        assertEquals("85.5 kg", Bodyweight.axisLabel(85.5))
        assertEquals("81 kg", Bodyweight.axisLabel(81.0))
        assertEquals("Weigh in", Bodyweight.sheetTitle(null))
        assertEquals("Weigh-in · 12 Aug", Bodyweight.sheetTitle(LocalDate.parse("2026-08-12")))
    }
}
