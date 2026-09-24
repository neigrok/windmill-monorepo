package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoachRevealTests {
    private val second = 1_000_000_000L
    private val frame = 10_000_000L

    // Every frame from `from` to `until` inclusive, in order, with what each one showed.
    private fun CoachReveal.frames(from: Long, until: Long): List<Pair<Long, String>> =
        (from..until step frame).map { it to shown(it) }

    @Test
    fun whatIsShownIsAlwaysAGrowingPrefixOfTheServerText() {
        val reveal = CoachReveal("")
        val text = (1..150).joinToString(" ") { "w$it" }
        reveal.receive(text, atNanos = 0)
        val shown = reveal.frames(0, 2 * second).map { it.second }
        shown.forEach { assertTrue(text.startsWith(it)) }
        assertEquals(shown.map { it.length }, shown.map { it.length }.sorted())
        assertEquals("", shown.first())
        assertEquals(text, shown.last())
    }

    @Test
    fun textPresentWhenTheRevealIsMadeShowsAtOnceAndOnlyLaterDeltasArePaced() {
        val present = "a".repeat(1499)
        val reveal = CoachReveal(present)
        assertEquals(present, reveal.shown(0))
        assertTrue(reveal.settled)
        reveal.receive(present, atNanos = 0)
        assertEquals(present, reveal.shown(0))
        assertTrue(reveal.settled)
        val grown = present + "b".repeat(100)
        reveal.receive(grown, atNanos = second)
        assertEquals(present + "b".repeat(50), reveal.frames(second, second + second / 2).last().second)
        assertEquals(grown, reveal.frames(second + second / 2, 2 * second).last().second)
    }

    @Test
    fun aDeltaIsFullyShownOneIntervalAfterItLandsAndHalfOfItHalfwayThrough() {
        val reveal = CoachReveal("")
        val first = "a".repeat(150)
        reveal.receive(first, atNanos = 0)
        val opening = reveal.frames(0, second)
        assertTrue(opening.first { it.second == first }.first <= second + frame)
        val whole = first + "b".repeat(150)
        reveal.receive(whole, atNanos = second)
        assertEquals(first + "b".repeat(75), reveal.frames(second, second + second / 2).last().second)
        assertEquals(whole, reveal.frames(second + second / 2, 2 * second + frame).last().second)
    }

    @Test
    fun anEarlyArrivalRecomputesTheRateOverEverythingPendingSoNothingLagsMoreThanOneInterval() {
        val reveal = CoachReveal("")
        reveal.receive("a".repeat(150), atNanos = 0)
        reveal.frames(0, second)
        reveal.receive("a".repeat(300), atNanos = second)
        reveal.frames(second, second + second / 2)
        val whole = "a".repeat(450)
        val landed = second + second / 2
        reveal.receive(whole, atNanos = landed)
        val interval = 1.0 + 0.3 * (0.5 - 1.0)
        val settledAt = reveal.frames(landed, landed + 2 * second).first { it.second == whole }.first
        assertTrue("settled ${settledAt / 1e9}s", settledAt <= landed + (interval * second).toLong() + frame)
        assertTrue(settledAt > landed + (0.8 * second).toLong())
    }

    @Test
    fun aStalledStreamRevealsWhatItHasAndThenStops() {
        val reveal = CoachReveal("")
        val text = "a".repeat(100)
        reveal.receive(text, atNanos = 0)
        val shown = reveal.frames(0, 3 * second)
        assertEquals(text, shown.first { it.first >= second + frame }.second)
        assertEquals(setOf(text), shown.filter { it.first > second + frame }.map { it.second }.toSet())
        assertTrue(reveal.settled)
    }

    @Test
    fun aTinyDeltaRevealsAtTheFloorOfFortyCharactersPerSecond() {
        val reveal = CoachReveal("")
        reveal.receive("12345", atNanos = 0)
        assertEquals("1234", reveal.frames(0, second / 10).last().second)
        assertEquals("12345", reveal.frames(second / 10, 13 * second / 100).last().second)
    }

    @Test
    fun aCutNeverSplitsASurrogatePairACombiningMarkOrAnEmojiSequence() {
        val reveal = CoachReveal("")
        val text = "a🏋🏽‍♀️b éc"
        reveal.receive(text, atNanos = 0)
        val distinct = reveal.frames(0, second).map { it.second }.distinct()
        assertEquals(
            listOf("", "a", "a🏋🏽‍♀️", "a🏋🏽‍♀️b", "a🏋🏽‍♀️b ", "a🏋🏽‍♀️b é", text),
            distinct,
        )
    }

    @Test
    fun aReplacementFallsBackToTheCommonPrefixAndRevealsTheRestAgain() {
        val reveal = CoachReveal("")
        reveal.receive("Hello world", atNanos = 0)
        assertEquals("Hello world", reveal.frames(0, second).last().second)
        reveal.receive("Hello there", atNanos = second)
        assertEquals("Hello ", reveal.shown(second))
        assertFalse(reveal.settled)
        assertEquals("Hello there", reveal.frames(second, second + second / 5).last().second)
    }
}
