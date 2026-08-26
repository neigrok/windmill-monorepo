package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.SessionSummary

// C18: the fifty-session window the six are ranked from is read ONCE. The log behind an open picker
// keeps moving — a poll lands a finished session, a claim replays the shelf — and six rows may not
// reorder under a thumb already reaching for one of them. C20 says WHICH read is the one: the first
// non-empty one, so a picker raised before the log answered still gets a ranking.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class PickerWindowFreezeTests {
    @get:Rule
    val compose = createComposeRule()

    private val catalog = (1..8).map { Exercise(id = "ex_$it", name = "Movement $it") }

    private fun session(at: Int, named: String) = SessionSummary(
        id = "ses_$at",
        startedAtMs = at.toLong(),
        finishedAtMs = at.toLong(),
        exercises = listOf(named),
    )

    // Six movements trained in a strict order: Movement 1 in six sessions down to Movement 6 in one.
    private fun opening(): List<SessionSummary> {
        var at = 0
        return (1..6).flatMap { rank -> List(7 - rank) { session(++at, "ex_$rank") } }
    }

    // What lands underneath: the two movements the opening window never saw, now the most trained in
    // the log by a mile.
    private fun landed(): List<SessionSummary> {
        var at = 100
        return List(10) { session(++at, "ex_8") } + List(9) { session(++at, "ex_7") } + opening()
    }

    // Sixty sessions arriving at once — a whole log answering under a picker that opened on nothing.
    private fun answered(): List<SessionSummary> {
        var at = 200
        return List(20) { session(++at, "ex_8") } + List(19) { session(++at, "ex_7") } + opening()
    }

    // A third window, later still, with a movement neither of the first two ever put on top.
    private fun laterStill(): List<SessionSummary> {
        var at = 400
        return List(30) { session(++at, "ex_5") } + answered()
    }

    // The picker draws the six first and the rest of the catalog under them, so reading the rows top
    // to bottom is reading the ranking.
    private fun sixInOrder(): List<String> = catalog
        .map { it.name to compose.onNodeWithText(it.name).fetchSemanticsNode().positionInRoot.y }
        .sortedBy { it.second }
        .take(PickerOptions.featured)
        .map { it.first }

    private fun picker(sessions: () -> List<SessionSummary>, shown: () -> Boolean) {
        compose.setContent {
            if (shown()) {
                MovementPicker(
                    catalog = catalog,
                    taken = emptyList(),
                    lastSets = null,
                    nowMs = 0,
                    sessions = sessions(),
                    title = "Add movement",
                    onPick = {},
                    onCreate = {},
                )
            }
        }
    }

    private val opened = listOf("Movement 1", "Movement 2", "Movement 3",
                                "Movement 4", "Movement 5", "Movement 6")

    @Test
    fun testTheSixDoNotReorderWhenTheLogMovesUnderAnOpenPicker() {
        var sessions by mutableStateOf(opening())
        picker(sessions = { sessions }, shown = { true })

        assertEquals(opened, sixInOrder())

        compose.runOnIdle { sessions = landed() }
        compose.waitForIdle()

        assertEquals("the six are the window the picker opened on", opened, sixInOrder())
    }

    // C20: the freeze is on the first NON-EMPTY read and not on the first frame. A picker raised
    // before the log has answered holds nothing to rank from, and must not be sentenced to the
    // generic openers for the rest of its life — the window that lands IS the window it opened on.
    @Test
    fun testAPickerRaisedBeforeTheLogAnswersRanksFromTheWindowThatLands() {
        var sessions by mutableStateOf(emptyList<SessionSummary>())
        picker(sessions = { sessions }, shown = { true })

        assertEquals("nothing to rank from is the catalog as it stands", opened, sixInOrder())

        compose.runOnIdle { sessions = answered() }
        compose.waitForIdle()

        assertEquals(
            listOf("Movement 8", "Movement 7", "Movement 1", "Movement 2", "Movement 3", "Movement 4"),
            sixInOrder(),
        )
    }

    // And once one HAS landed the freeze bites: the re-seeding is what an empty window does, not a
    // standing subscription to the log.
    @Test
    fun testTheWindowThatLandsIsTheLastOneTheOpenPickerReads() {
        var sessions by mutableStateOf(emptyList<SessionSummary>())
        picker(sessions = { sessions }, shown = { true })

        compose.runOnIdle { sessions = answered() }
        compose.waitForIdle()
        val ranked = listOf("Movement 8", "Movement 7", "Movement 1",
                            "Movement 2", "Movement 3", "Movement 4")
        assertEquals(ranked, sixInOrder())

        compose.runOnIdle { sessions = laterStill() }
        compose.waitForIdle()

        assertEquals("the six are the window the picker opened on", ranked, sixInOrder())
    }

    // A freeze and not a stale constant: the NEXT picker ranks from the log as it now stands.
    @Test
    fun testAPickerOpenedAfterTheLandingRanksFromWhatItOpenedOn() {
        var sessions by mutableStateOf(opening())
        var shown by mutableStateOf(true)
        picker(sessions = { sessions }, shown = { shown })

        assertEquals(opened, sixInOrder())

        compose.runOnIdle {
            shown = false
            sessions = landed()
        }
        compose.runOnIdle { shown = true }
        compose.waitForIdle()

        assertEquals(
            listOf("Movement 8", "Movement 7", "Movement 1", "Movement 2", "Movement 3", "Movement 4"),
            sixInOrder(),
        )
    }
}
