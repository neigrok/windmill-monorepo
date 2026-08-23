package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.TheSix

class PickerOptionsTests {
    private val catalog = listOf(
        Exercise(id = "bench-press", name = "Bench Press"),
        Exercise(id = "close-grip-bench-press", name = "Close-Grip Bench Press"),
        Exercise(id = "back-squat", name = "Back Squat"),
        Exercise(id = "zercher-squat", name = "Zercher Squat", custom = true),
    )

    private val nowMs = 1_785_600_000_000L
    private val twoDaysBack = nowMs - 2 * 24 * 60 * 60 * 1_000L

    @Test
    fun testTypingFiltersOnTheNameAndIsBlindToCase() {
        val options = PickerOptions.matching(query = "  bench ", catalog = catalog, taken = emptyList())
        assertEquals(listOf("bench-press", "close-grip-bench-press"), options.matches.map { it.id })
        assertNull(options.empty)
        assertNull("there is something to pick, so there is nothing to mint", options.create)
    }

    @Test
    fun testARowSaysWhatWasLastLiftedAndAMovementWithNoRowSaysNeverLogged() {
        val options = PickerOptions.matching(
            query = "squat", catalog = catalog, taken = emptyList(),
            lastSets = mapOf("back-squat" to LastSet("back-squat", 82.5, 5, atMs = twoDaysBack)),
            nowMs = nowMs,
        )
        assertEquals(listOf("last 82.5 × 5 · 2 days ago", "never logged"), options.matches.map { it.meta })
        assertEquals("a movement the lifter minted is tagged so they recognise their own",
                     listOf(false, true), options.matches.map { it.yours })
    }

    @Test
    fun testAZeroLoadIsALiftAndNotAnAbsence() {
        val options = PickerOptions.matching(
            query = "back squat", catalog = catalog, taken = emptyList(),
            lastSets = mapOf("back-squat" to LastSet("back-squat", 0.0, 12, atMs = nowMs)),
            nowMs = nowMs,
        )
        assertEquals(listOf("last 0 × 12 · today"), options.matches.map { it.meta })
    }

    @Test
    fun testTheSixArePinnedOnlyOverAnUntouchedFieldOnTheFirstSession() {
        val pinned = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList(),
                                            lastSets = emptyMap(), pinTheSix = true)
        assertEquals(listOf("Back Squat", "Bench Press", "Deadlift", "Overhead Press", "Barbell Row",
                            "Chin Up"),
                     pinned.six.map { it.name })
        assertTrue("nothing is listed twice", pinned.matches.isEmpty())
        assertEquals(List(6) { "never logged" }, pinned.six.map { it.meta })
        assertNull("there is plenty to pick", pinned.empty)

        val typed = PickerOptions.matching(query = "dead", catalog = TheSix.movements, taken = emptyList(),
                                           pinTheSix = true)
        assertTrue(typed.six.isEmpty())
        assertEquals(listOf("Deadlift"), typed.matches.map { it.name })

        val ordinary = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList())
        assertTrue("every later session is the plain list", ordinary.six.isEmpty())
        assertEquals(6, ordinary.matches.size)
    }

    @Test
    fun testAMovementAlreadyInTheSessionIsNotOffered() {
        val options = PickerOptions.matching(query = "squat", catalog = catalog, taken = listOf("back-squat"))
        assertEquals(listOf("zercher-squat"), options.matches.map { it.id })
    }

    @Test
    fun testOnlyACatalogThatDidNotLoadBlamesTheNetworkAndItOffersNoDoor() {
        val options = PickerOptions.matching(query = "bench", catalog = emptyList(), taken = emptyList())
        assertEquals("Your catalog didn’t load — the rest of it comes back when you have signal.",
                     options.unread)
        assertNull("one silence, one sentence", options.empty)
        assertNull(options.create)
    }

    @Test
    fun testAShortCatalogSaysSoOverTheRowsItDoesHave() {
        val short = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList(),
                                           lastSets = emptyMap(), catalogUnread = true)
        assertEquals("Your catalog didn’t load — the rest of it comes back when you have signal.",
                     short.unread)
        assertEquals("the rows it does have are still worth picking", 6, short.matches.size)
        assertNull(short.empty)

        val typed = PickerOptions.matching(query = "Zottman Curl", catalog = TheSix.movements,
                                           taken = emptyList(), catalogUnread = true)
        assertNull(typed.create)
        assertNull(typed.empty)
        assertEquals("Your catalog didn’t load — the rest of it comes back when you have signal.",
                     typed.unread)

        val landed = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList(),
                                            lastSets = emptyMap())
        assertNull(landed.unread)
    }

    @Test
    fun testAMetaLineIsSaidOnlyByAnAnswerAndNeverByAMissingRead() {
        val unread = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList(),
                                            lastSets = null, pinTheSix = true)
        assertEquals(List(6) { null }, unread.six.map { it.meta })

        val answered = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList(),
                                              lastSets = emptyMap(), pinTheSix = true)
        assertEquals("an answer with no rows in it is what `never logged` is said by",
                     List(6) { "never logged" }, answered.six.map { it.meta })
    }

    @Test
    fun testACatalogEntirelyInTheSessionSaysThatAndOffersNoDoor() {
        val taken = catalog.map { it.id }
        val options = PickerOptions.matching(query = "", catalog = catalog, taken = taken)
        assertEquals("Every movement in the catalog is already in this session.", options.empty)
        assertNull(options.create)
    }

    @Test
    fun testATypedNameHasADoorEvenWhenEveryKnownMovementIsAlreadyInTheSession() {
        val options = PickerOptions.matching(query = "Sled Push", catalog = TheSix.movements,
                                             taken = TheSix.movements.map { it.id })
        assertEquals("No movement by that name.", options.empty)
        assertEquals("Create “Sled Push”", options.create)
    }

    @Test
    fun testAQueryThatMatchesNothingSaysOnlyThatAndOffersToMintIt() {
        val options = PickerOptions.matching(query = " zottman ", catalog = catalog, taken = emptyList())
        assertEquals("No movement by that name.", options.empty)
        assertEquals("Create “zottman”", options.create)
    }

    @Test
    fun testTheSentenceDoesNotRepeatWhatTheButtonAlreadySays() {
        val options = PickerOptions.matching(query = "zottman", catalog = catalog, taken = emptyList())
        assertFalse(options.empty?.contains("zottman") ?: true)
    }

    @Test
    fun testTheListIsCutToWhatAThumbCanRead() {
        val long = (0 until 20).map { Exercise(id = "ex_$it", name = "Press $it") }
        assertEquals(PickerOptions.shown,
                     PickerOptions.matching(query = "press", catalog = long, taken = emptyList()).matches.size)
    }

    @Test
    fun testTheFilterReadsAliasesAndTheRowNamesTheWordThatFoundIt() {
        val renamed = listOf(
            Exercise(id = "bench-press", name = "Flat press", aliases = listOf("Bench Press")),
            Exercise(id = "back-squat", name = "Back Squat"),
        )

        val found = PickerOptions.matching(query = "bench", catalog = renamed, taken = emptyList())
        assertEquals(listOf("Flat press"), found.matches.map { it.name })
        assertEquals("Bench Press", found.matches.single().alias)

        val plain = PickerOptions.matching(query = "flat", catalog = renamed, taken = emptyList())
        assertEquals(listOf("Flat press"), plain.matches.map { it.name })
        assertNull(plain.matches.single().alias)

        val neither = PickerOptions.matching(query = "zottman", catalog = renamed, taken = emptyList())
        assertEquals("Create “zottman”", neither.create)
    }

    @Test
    fun testAnUntypedFieldNamesNoAliases() {
        val renamed = listOf(Exercise(id = "bench-press", name = "Flat press", aliases = listOf("Bench Press")))
        val options = PickerOptions.matching(query = "", catalog = renamed, taken = emptyList())
        assertEquals(listOf("Flat press"), options.matches.map { it.name })
        assertNull(options.matches.single().alias)
    }
}
