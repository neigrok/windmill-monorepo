package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.Exercise

// Three different silences, and they must not share a sentence. A lifter who typed a letter the
// catalog does not hold was once told their signal was out — the app reporting a failure that had
// not happened, and pointing them at the wrong thing to fix.

class PickerOptionsTests {
    private val catalog = listOf(
        Exercise(id = "bench-press", name = "Bench Press"),
        Exercise(id = "close-grip-bench-press", name = "Close-Grip Bench Press"),
        Exercise(id = "back-squat", name = "Back Squat"),
        Exercise(id = "zercher-squat", name = "Zercher Squat", custom = true),
    )

    @Test
    fun testTypingFiltersOnTheNameAndIsBlindToCase() {
        val options = PickerOptions.matching(query = "  bench ", catalog = catalog, taken = emptyList())
        assertEquals(listOf("bench-press", "close-grip-bench-press"), options.matches.map { it.id })
        assertNull(options.empty)
        assertNull("there is something to pick, so there is nothing to mint", options.create)
    }

    // A movement already in the session is not offered again: the picker adds movements, and the
    // jump sheet is where a lifter goes back to one.
    @Test
    fun testAMovementAlreadyInTheSessionIsNotOffered() {
        val options = PickerOptions.matching(query = "squat", catalog = catalog, taken = listOf("back-squat"))
        assertEquals(listOf("zercher-squat"), options.matches.map { it.id })
    }

    // Only an EMPTY catalog may mention signal — and it offers no door, because what is missing is
    // the read and not the movement. Matched to web/src/products/gym/logger/movements.js line for
    // line: two surfaces disagreeing about which silence has a way out is the drift this file exists
    // to catch.
    @Test
    fun testOnlyAnEmptyCatalogBlamesTheNetworkAndItOffersNoDoor() {
        val options = PickerOptions.matching(query = "bench", catalog = emptyList(), taken = emptyList())
        assertEquals("The catalog didn’t load. It comes back when you have signal.", options.empty)
        assertNull(options.create)
    }

    // A catalog already entirely in the session is answered by the jump sheet, not by minting a
    // second copy of a movement that is already being logged.
    @Test
    fun testACatalogEntirelyInTheSessionSaysThatAndOffersNoDoor() {
        val taken = catalog.map { it.id }
        val options = PickerOptions.matching(query = "", catalog = catalog, taken = taken)
        assertEquals("Every movement in the catalog is already in this session.", options.empty)
        assertNull(options.create)
    }

    // The one silence a NAME can answer, and the only one with a door.
    @Test
    fun testAQueryThatMatchesNothingSaysOnlyThatAndOffersToMintIt() {
        val options = PickerOptions.matching(query = " zottman ", catalog = catalog, taken = emptyList())
        assertEquals("No movement by that name.", options.empty)
        assertEquals("Create “zottman”", options.create)
    }

    // The sentence never echoes the query back: the button holds it, and holding it twice would be
    // the same words in the same breath.
    @Test
    fun testTheSentenceDoesNotRepeatWhatTheButtonAlreadySays() {
        val options = PickerOptions.matching(query = "zottman", catalog = catalog, taken = emptyList())
        assertFalse(options.empty?.contains("zottman") ?: true)
    }

    // The list is cut so the sheet never becomes a catalog browser — typing is the filter.
    @Test
    fun testTheListIsCutToWhatAThumbCanRead() {
        val long = (0 until 20).map { Exercise(id = "ex_$it", name = "Press $it") }
        assertEquals(PickerOptions.shown,
                     PickerOptions.matching(query = "press", catalog = long, taken = emptyList()).matches.size)
    }
}
