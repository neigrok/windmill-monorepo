package works.windmill.gym.presentation

import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test
import works.windmill.gym.presentation.*

class ProgressReadoutTests {
    @Test
    fun recordAndCardUseSameExactPointIdentityAndAbovePlotReading() {
        val progress = StatsProgress.of(listOf(SessionDetail(Session("ses_exact", 1000L, 1001L), listOf(
            TrainingSet("heavy", "bench", weightKg = 100.0, reps = 12, completedAtMs = 1000L),
            TrainingSet("best", "bench", weightKg = 80.0, reps = 8, rpe = 9.0, completedAtMs = 1000L)))), 2000L).movement("bench")
        val point = progress.estimates.single()
        val series = progressSeries(progress, 2000L, ZoneId.of("UTC"), all = true)
        assertEquals(listOf(DatedPoint("ses_exact", 1000L, 80.0 * (1 + 8 / 30.0),
            "101.3 kg est · today · 80 × 8")), series.points)
        assertEquals(1000L, series.fromMs)
        assertEquals(2000L, series.untilMs)
        assertEquals("101.3 kg est · today · 80 × 8", progressReading(point, 2000L))
    }
}
