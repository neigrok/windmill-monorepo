package works.windmill.gym.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet

// A week's header is drawn from a label that carries no year — `week of 6 Jan` is true of 2020 and of
// 2025 alike. That label was the LazyColumn's key, and two rows may not share one: a lifter with five
// years of log had a list that refused to compose. The week's own Monday is the identity.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogWeekKeyTests {
    @get:Rule
    val compose = createComposeRule()

    private val zone: ZoneId = ZoneId.systemDefault()

    private fun at(date: String, hour: Int = 18): Long =
        LocalDate.parse(date).atStartOfDay(zone).plusHours(hour.toLong()).toInstant().toEpochMilli()

    private fun session(id: String, day: String) = SessionSummary(
        Session(id = id, startedAtMs = at(day), finishedAtMs = at(day) + 3_600_000,
                plan = PlanSnapshot(routine = "Push A")),
        listOf(TrainingSet(id = "set_$id", exerciseId = "bench-press", weightKg = 100.0, reps = 5,
                           kind = SetKind.Working, completedAtMs = at(day))),
    )

    // Monday 6 January falls in 2020 and again in 2025.
    private val fiveYearsApart = listOf(session("s1", "2025-01-06"), session("s2", "2020-01-06"))

    private fun weeks() = LogFold.weeks(fiveYearsApart, onThisDevice = emptySet(), complete = true,
                                        nowMs = at("2026-08-09"))

    @Test
    fun testTwoWeeksMaySayTheSameWordsAndAreStillTwoWeeks() {
        val folded = weeks()

        assertEquals(2, folded.size)
        assertEquals("week of 6 Jan", folded[0].label)
        assertEquals("the label alone cannot tell them apart", folded[0].label, folded[1].label)
        assertNotEquals("the Monday can", folded[0].startMs, folded[1].startMs)
        assertEquals("so the key is unique per week", 2,
                     folded.map { "week:${it.startMs}" }.distinct().size)
    }

    @Test
    fun testTheListDrawsBothWeeksRatherThanRefusingToCompose() {
        val folded = weeks()
        compose.setContent {
            LazyColumn(Modifier.fillMaxSize()) {
                folded.forEach { week ->
                    item("week:${week.startMs}") { Text(week.label) }
                    items(week.rows, key = { it.summary.id }) { Text(it.title) }
                }
            }
        }

        compose.onAllNodesWithText("Push A").assertCountEquals(2)
        compose.onAllNodesWithText("week of 6 Jan").assertCountEquals(2)
    }

    // The proof that the old key was a defect and not a preference.
    @Test
    fun testKeyingAWeekByItsWordsIsWhatUsedToThrow() {
        val folded = weeks()

        assertThrows(IllegalArgumentException::class.java) {
            compose.setContent {
                LazyColumn(Modifier.fillMaxSize()) {
                    folded.forEach { week ->
                        item("week:${week.label}") { Text(week.label) }
                    }
                }
            }
            compose.waitForIdle()
        }
    }
}
