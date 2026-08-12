package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.TheSix

// Three different silences, and they must not share a sentence. A lifter who typed a letter the
// catalog does not hold was once told their signal was out — the app reporting a failure that had
// not happened, and pointing them at the wrong thing to fix.
//
// And one line per row that is a claim about the lifter's own history: `never logged` is said only
// where an ANSWER carried no row for that movement, because the read is sparse and a zero load is a
// real thing a lifter can lift. A read that never landed says nothing at all — the map is null
// until one does, and the two are a different fact.

class PickerOptionsTests {
    private val catalog = listOf(
        Exercise(id = "bench-press", name = "Bench Press"),
        Exercise(id = "close-grip-bench-press", name = "Close-Grip Bench Press"),
        Exercise(id = "back-squat", name = "Back Squat"),
        Exercise(id = "zercher-squat", name = "Zercher Squat", custom = true),
    )

    // Two days apart, on a clock that is not the machine's: the row says how long ago in days, and
    // the day is a calendar fact rather than a division by 86 400 000.
    private val nowMs = 1_785_600_000_000L
    private val twoDaysBack = nowMs - 2 * 24 * 60 * 60 * 1_000L

    @Test
    fun testTypingFiltersOnTheNameAndIsBlindToCase() {
        val options = PickerOptions.matching(query = "  bench ", catalog = catalog, taken = emptyList())
        assertEquals(listOf("bench-press", "close-grip-bench-press"), options.matches.map { it.id })
        assertNull(options.empty)
        assertNull("there is something to pick, so there is nothing to mint", options.create)
    }

    // The meta, both ways round. A row that arrived says what was lifted and when; a movement the
    // read left out says so, and says it from the absence rather than from a sentinel.
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

    // A LOAD OF ZERO IS A REAL SET. A chin-up is logged at zero and a band-assisted one below it,
    // so a picker that read "no weight" as "no history" would print `never logged` over a movement
    // somebody has trained for a year — which is why the wire sends no zero row at all.
    @Test
    fun testAZeroLoadIsALiftAndNotAnAbsence() {
        val options = PickerOptions.matching(
            query = "back squat", catalog = catalog, taken = emptyList(),
            lastSets = mapOf("back-squat" to LastSet("back-squat", 0.0, 12, atMs = nowMs)),
            nowMs = nowMs,
        )
        assertEquals(listOf("last 0 × 12 · today"), options.matches.map { it.meta })
    }

    // THE SIX (§J22) — pinned above an untouched field on the first session and on no other screen,
    // in the design's own order, and each one reading `never logged` because nothing has happened
    // yet. Typing dissolves the section: a lifter who has named what they want is not answered with
    // six things they did not ask for.
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

    // A movement already in the session is not offered again: the picker adds movements, and the
    // assembly list is where a lifter goes back to one.
    @Test
    fun testAMovementAlreadyInTheSessionIsNotOffered() {
        val options = PickerOptions.matching(query = "squat", catalog = catalog, taken = listOf("back-squat"))
        assertEquals(listOf("zercher-squat"), options.matches.map { it.id })
    }

    // Only a catalog that did not LOAD may mention signal — and it offers no door, because what is
    // missing is the read and not the movement. Matched to web/src/products/gym/logger/movements.js
    // line for line: two surfaces disagreeing about which silence has a way out is the drift this
    // file exists to catch.
    @Test
    fun testOnlyACatalogThatDidNotLoadBlamesTheNetworkAndItOffersNoDoor() {
        val options = PickerOptions.matching(query = "bench", catalog = emptyList(), taken = emptyList())
        assertEquals("Your catalog didn’t load — the rest of it comes back when you have signal.",
                     options.unread)
        assertNull("one silence, one sentence", options.empty)
        assertNull(options.create)
    }

    // A SHORT CATALOG IS NOT AN EMPTY ONE, and that is what the six changed. Every seat now holds
    // them, so a signed-in lifter whose read missed sees six rows where their sixty-four belong —
    // the old silence was keyed on an empty list and could no longer be reached, and the lifter was
    // shown a catalog with fifty-eight movements quietly gone from it.
    @Test
    fun testAShortCatalogSaysSoOverTheRowsItDoesHave() {
        val short = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList(),
                                           lastSets = emptyMap(), catalogUnread = true)
        assertEquals("Your catalog didn’t load — the rest of it comes back when you have signal.",
                     short.unread)
        assertEquals("the rows it does have are still worth picking", 6, short.matches.size)
        assertNull(short.empty)

        // And the door out stays shut while it is true: minting a movement the missing rows may
        // already hold is the duplicate the stable-identity rule exists to prevent, and signed in
        // the create would fail on the same dead connection anyway.
        val typed = PickerOptions.matching(query = "Zottman Curl", catalog = TheSix.movements,
                                           taken = emptyList(), catalogUnread = true)
        assertNull(typed.create)
        assertNull(typed.empty)
        assertEquals("Your catalog didn’t load — the rest of it comes back when you have signal.",
                     typed.unread)

        // A catalog that answered says nothing about signal, however short the list is.
        val landed = PickerOptions.matching(query = "", catalog = TheSix.movements, taken = emptyList(),
                                            lastSets = emptyMap())
        assertNull(landed.unread)
    }

    // THE FOUR STATES OF ONE LINE, AND THE TWO THAT LOOK ALIKE. A read that has not landed is not a
    // history that is empty: the map is null until one answers, and every row says nothing at all
    // rather than telling a lifter of ten years they have never squatted because a phone was in a
    // basement.
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

    // A catalog already entirely in the session is answered by the assembly list, not by minting a
    // second copy of a movement that is already being logged.
    @Test
    fun testACatalogEntirelyInTheSessionSaysThatAndOffersNoDoor() {
        val taken = catalog.map { it.id }
        val options = PickerOptions.matching(query = "", catalog = catalog, taken = taken)
        assertEquals("Every movement in the catalog is already in this session.", options.empty)
        assertNull(options.create)
    }

    // ...but only over an EMPTY field, and that is a rule this wave had to move. It used to be
    // "nothing is available", which was the same test only while the catalog was the log's
    // sixty-four. An anonymous room's catalog is the six, so a lifter with all six in the session
    // and a seventh movement in mind was told there was nothing left to lift, with no way to say
    // otherwise. A typed name always has a door.
    @Test
    fun testATypedNameHasADoorEvenWhenEveryKnownMovementIsAlreadyInTheSession() {
        val options = PickerOptions.matching(query = "Sled Push", catalog = TheSix.movements,
                                             taken = TheSix.movements.map { it.id })
        assertEquals("No movement by that name.", options.empty)
        assertEquals("Create “Sled Push”", options.create)
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
