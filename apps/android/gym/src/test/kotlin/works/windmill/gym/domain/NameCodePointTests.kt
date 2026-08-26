package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// One fixture, three surfaces. The same sixty-character name is pinned here, in
// `web/test/products/gym/nameCodePoints.test.js` and in `NameCodePointTests.swift` (iOS): thirty
// emoji and thirty accented letters. It reads as sixty characters on all three because a character
// is a CODE POINT — the unit Postgres `char_length` counts — and it weighs 180 bytes, under the
// store's 240. The three units this one name tells apart: 60 code points · 90 UTF-16 units · 180
// UTF-8 bytes.
class NameCodePointTests {
    private val sixty = "😀".repeat(30) + "ü".repeat(30)
    private val sixtyOne = sixty + "ü"

    // The other half of the fixture, and the shape that tells a code point from what the eye counts:
    // one lifter is ONE thing on screen and five code points underneath. Sixty of these would weigh
    // 960 bytes, four times the store's ceiling; twelve of them are the sixty characters this cap
    // allows.
    private val lifter = "🏋️‍♀️"

    @Test
    fun testTheSharedFixtureIsSixtyCodePointsNinetyUtf16UnitsAndOneHundredEightyBytes() {
        assertEquals(60, Program.length(sixty))
        assertEquals("UTF-16 units are the unit this fixture exists to rule out", 90, sixty.length)
        assertEquals(180, sixty.toByteArray(Charsets.UTF_8).size)
        assertEquals(61, Program.length(sixtyOne))
    }

    @Test
    fun testANameOfSixtyCodePointsIsAcceptedWholeAndCountsSixty() {
        assertEquals(sixty, Program.capped(sixty))
        assertEquals("60/60", Program.counter(sixty))
        assertTrue("sixty code points always fit the store's 240 bytes",
                   Program.capped(sixty).toByteArray(Charsets.UTF_8).size <= 240)
    }

    @Test
    fun testTheSixtyFirstCodePointIsTheOnlyOneRefusedAndTheCutNeverHalvesACharacter() {
        assertEquals(sixty, Program.capped(sixtyOne))
        assertEquals("61/60", Program.counter(sixtyOne))

        val cut = Program.capped("😀".repeat(61))
        assertEquals("😀".repeat(60), cut)
        assertEquals(60, Program.length(cut))
        assertEquals("the heaviest sixty characters there are", 240, cut.toByteArray(Charsets.UTF_8).size)
        // A cut through a surrogate pair would leave half a character, which UTF-8 cannot carry: the
        // encoder replaces it and the round trip stops matching.
        assertEquals("no half of a character survives the cut",
                     cut, String(cut.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
    }

    @Test
    fun testOneThingOnScreenCanBeFiveCharactersAndTheCapCountsAllFive() {
        assertEquals(5, Program.length(lifter))
        assertEquals(6, lifter.length)
        assertEquals(16, lifter.toByteArray(Charsets.UTF_8).size)

        val twelve = lifter.repeat(12)
        assertEquals("60/60", Program.counter(twelve))
        assertEquals(twelve, Program.capped(twelve))
        assertEquals("under the store's 240", 192, twelve.toByteArray(Charsets.UTF_8).size)

        val thirteen = lifter.repeat(13)
        assertEquals(twelve, Program.capped(thirteen))
        assertEquals("65/60", Program.counter(thirteen))
        assertEquals(60, Notes.titleLength(twelve))
        assertTrue(Notes.titleOver(thirteen))
    }

    @Test
    fun testANotesTitleCountsTheSameFixtureTheSameWay() {
        assertEquals(60, Notes.titleLength(sixty))
        assertEquals("60 of 60 characters", Notes.titleCounter(sixty))
        assertFalse(Notes.titleOver(sixty))
        assertEquals(61, Notes.titleLength(sixtyOne))
        assertTrue(Notes.titleOver(sixtyOne))
        assertEquals("one cap for a name and a title", Program.maxNameLength, Notes.titleMax)
    }
}
