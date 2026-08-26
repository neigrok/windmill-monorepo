package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.TheSix

// C2: an empty query shows six most-used movements and then the WHOLE catalogue, on every empty
// query — never gated on a first session. The six are ranked off the last fifty sessions this device
// holds and topped up in order from the shared opener list, so a fresh account still sees six.
class PickerSixRankingTests {
    private val openers = TheSix.movements
    private val extras = (1..12).map { Exercise(id = "ex_$it", name = "Movement $it") }
    private val catalog = openers + extras

    private fun session(id: Int, vararg named: String) = SessionSummary(
        id = "ses_$id",
        startedAtMs = id.toLong(),
        finishedAtMs = id.toLong(),
        exercises = named.toList(),
    )

    @Test
    fun testAnEmptyQueryShowsTheSixAndThenTheWholeCatalogueUncapped() {
        val options = PickerOptions.matching(query = "", catalog = catalog, taken = emptyList())

        assertEquals(6, options.six.size)
        assertEquals("the rest of the catalogue follows, uncapped",
                     catalog.size - 6, options.matches.size)
        assertTrue("and nothing is listed twice",
                   options.matches.none { row -> options.six.any { it.id == row.id } })
    }

    @Test
    fun testTheSixAreRankedFromTheLogAndToppedUpFromTheOpeners() {
        val sessions = listOf(
            session(3, "Movement 5", "Movement 9"),
            session(2, "Movement 5"),
            session(1, "Movement 9"),
        )

        val options = PickerOptions.matching(query = "", catalog = catalog, taken = emptyList(),
                                             sessions = sessions)

        assertEquals(
            listOf("Movement 5", "Movement 9", "Back Squat", "Bench Press", "Deadlift", "Overhead Press"),
            options.six.map { it.name },
        )
    }

    // The device's own sessions name their movements by ID; the log's name them by NAME. A movement is
    // counted by either spelling of itself, or a shelf full of training would rank nothing.
    @Test
    fun testAShelvedSessionCountsTheSameAsOneTheLogServed() {
        val sessions = listOf(session(2, "ex_7"), session(1, "ex_7"), session(3, "Movement 4"))

        val options = PickerOptions.matching(query = "", catalog = catalog, taken = emptyList(),
                                             sessions = sessions)

        assertEquals(listOf("Movement 7", "Movement 4"), options.six.take(2).map { it.name })
    }

    @Test
    fun testTheRankingReadsFiftySessionsAndNoMore() {
        val recent = (1..50).map { session(it, "Movement 1") }
        val older = (51..80).map { session(it, "Movement 2") }

        val options = PickerOptions.matching(query = "", catalog = catalog, taken = emptyList(),
                                             sessions = recent + older)

        assertEquals("Movement 1", options.six.first().name)
        assertTrue("the fifty-first session and beyond rank nothing",
                   options.six.drop(1).none { it.name == "Movement 2" })
    }

    @Test
    fun testAFreshAccountStillSeesSixAndTheyAreTheOpenersInOrder() {
        val options = PickerOptions.matching(query = "", catalog = catalog, taken = emptyList(),
                                             sessions = emptyList())

        assertEquals(
            listOf("Back Squat", "Bench Press", "Deadlift", "Overhead Press", "Barbell Row", "Chin Up"),
            options.six.map { it.name },
        )
    }

    @Test
    fun testATypedQueryFeaturesNothingAndKeepsTheSevenRowCap() {
        val many = (1..20).map { Exercise(id = "press_$it", name = "Press $it") }

        val options = PickerOptions.matching(query = "press", catalog = many, taken = emptyList(),
                                             sessions = listOf(session(1, "Press 3")))

        assertTrue(options.six.isEmpty())
        assertEquals(PickerOptions.shown, options.matches.size)
    }

    @Test
    fun testAMovementAlreadyInTheSessionIsNotOfferedAsOneOfTheSix() {
        val options = PickerOptions.matching(query = "", catalog = catalog,
                                             taken = listOf("back-squat", "bench-press"),
                                             sessions = emptyList())

        assertEquals(
            listOf("Deadlift", "Overhead Press", "Barbell Row", "Chin Up"),
            options.six.take(4).map { it.name },
        )
        assertTrue(options.six.none { it.id == "back-squat" || it.id == "bench-press" })
    }

    // C11: the same bytes web and iOS say.
    @Test
    fun testTheCatalogueThatDidNotLoadSaysWhatTheOtherSurfacesSay() {
        val options = PickerOptions.matching(query = "bench", catalog = emptyList(), taken = emptyList())

        assertEquals("The catalog didn’t load. It comes back when you have signal.", options.unread)
        assertNull("one silence, one sentence", options.empty)
        assertNull(options.create)
    }
}
