package works.windmill.gym.presentation

import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.plain
import works.windmill.gym.spelled
import works.windmill.gym.string
import works.windmill.gym.R
import works.windmill.platform.i18n.Words

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BodyweightTests {
    private val today: LocalDate = LocalDate.parse("2026-08-26")

    private fun weighIn(date: String, kg: Double, at: Long = 1_000) = WeighIn(date, kg, at)

    @Test
    fun testTheFieldTakesCommaOrPointAndRefusesOneThingAtATime() {
        assertEquals(ParsedWeight.Ok(82.4), Bodyweight.parse("82.4"))
        assertEquals(ParsedWeight.Ok(82.4), Bodyweight.parse("82,4"))
        assertEquals(ParsedWeight.Ok(82.0), Bodyweight.parse(" 82 "))
        assertEquals("two decimals stored, half up", ParsedWeight.Ok(82.46), Bodyweight.parse("82.455"))
        assertEquals(ParsedWeight.Refused(Words.Plain("That is not a number yet.")), Bodyweight.parse("").spelled())
        assertEquals(ParsedWeight.Refused(Words.Plain("That is not a number yet.")), Bodyweight.parse("abc").spelled())
        assertEquals(ParsedWeight.Refused(Words.Plain("That is not a number yet.")), Bodyweight.parse("82.4kg").spelled())
        assertEquals(ParsedWeight.Refused(Words.Plain("That is not a number yet.")), Bodyweight.parse("-82").spelled())
        assertEquals(ParsedWeight.Refused(Words.Plain("One decimal point only.")), Bodyweight.parse("1.2.3").spelled())
        assertEquals(ParsedWeight.Refused(Words.Plain("One decimal point only.")), Bodyweight.parse("82,4.5").spelled())
        assertEquals(ParsedWeight.Refused(Words.Plain("Between 20 and 400 kg — check the number.")), Bodyweight.parse("19.99").spelled())
        assertEquals(ParsedWeight.Refused(Words.Plain("Between 20 and 400 kg — check the number.")), Bodyweight.parse("400.01").spelled())
        assertEquals(ParsedWeight.Refused(Bodyweight.outsideRange), Bodyweight.parse("19.999"))
        assertEquals(ParsedWeight.Refused(Bodyweight.outsideRange), Bodyweight.parse("400.001"))
        assertEquals(ParsedWeight.Refused(Bodyweight.unreadable), Bodyweight.parse("abc1.2.3"))
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
        assertEquals("90 days · 2 weigh-ins", Bodyweight.windowWords(ChartWindow.Ninety, 2).spelled())
        assertEquals("90 days · 1 weigh-in", Bodyweight.windowWords(ChartWindow.Ninety, 1).spelled())
        assertEquals("All · 1 weigh-in", Bodyweight.windowWords(ChartWindow.All, 1).spelled())
        assertEquals("All · 12 weigh-ins", Bodyweight.windowWords(ChartWindow.All, 12).spelled())
    }

    @Test
    fun testAWeighInIsNeverInTheFuture() {
        val today = LocalDate.parse("2026-08-26")
        assertEquals(null, Bodyweight.dateRefusal(today, today))
        assertEquals(null, Bodyweight.dateRefusal(today.minusDays(40), today))
        assertEquals("A weigh-in is not a forecast — today or earlier.", Bodyweight.dateRefusal(today.plusDays(1), today).spelled())
        assertEquals(Bodyweight.inTheFuture, Bodyweight.dateRefusal(today.plusYears(1), today))
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
        assertEquals(listOf("2026-08-20", "2026-08-26"),
            Bodyweight.windowed(series, ChartWindow.Ninety, today).map { it.dateLocal })
        assertEquals(listOf("2026-08-20", "2026-08-26"),
            Bodyweight.windowed(series, ChartWindow.All, today).map { it.dateLocal })
        assertNull("only a future row is no reading at all", Bodyweight.latest(listOf(weighIn("2026-08-27", 90.0)), today))
        assertEquals(emptyList<WeighIn>(), Bodyweight.windowed(listOf(weighIn("2026-08-27", 90.0)), ChartWindow.All, today))
    }

    @Test
    fun everyWeighInAndItsEditorNameTheActualYearAndDate() {
        val date = LocalDate.parse("2025-08-12")
        assertEquals("12 Aug 2025", Bodyweight.listDay(date))
        assertEquals("12 August 2025", Bodyweight.fullDay(date))
        assertEquals("Save weight", string(R.string.gym_bodyweight_save))
    }
}

private fun ParsedWeight.spelled(): ParsedWeight = if (this is ParsedWeight.Refused) copy(why = why.plain()) else this
