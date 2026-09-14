package works.windmill.gym.domain

import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test
import works.windmill.gym.domain.*

class ProgressReadoutTests {
    @Test
    fun recordAndCardUseSameExactPointIdentityAndAbovePlotReading() {
        val point = MovementProgress.Session("ses_exact", 1000L, MovementSessionFact("bench", 3,
            PerformedFact("heavy", 100.0, 12), EstimatedFact("best", 80.0, 8, 9.0, 80.0 * (1 + 8 / 30.0))))
        val progress = MovementProgress("bench", listOf(point))
        val series = progressSeries(progress, 2000L, ZoneId.of("UTC"), all = true)
        assertEquals(listOf(DatedPoint("ses_exact", 1000L, 80.0 * (1 + 8 / 30.0),
            "101.3 kg est · today · 80 × 8")), series.points)
        assertEquals(1000L, series.fromMs)
        assertEquals(2000L, series.untilMs)
        assertEquals("101.3 kg est · today · 80 × 8", progressReading(point, 2000L))
    }
}
