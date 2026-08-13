package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.ReadTally

// WHAT CROSSES TO THE SYSTEM WHEN THE ACTIVITY GOES DOWN, and the reason it has a ceiling at all:
// everything a `rememberSaveable` holds rides in one Bundle through `onSaveInstanceState`, and that
// transaction is capped for the whole process — past it the app is killed rather than recreated.
// Nothing else bounds a conversation: the composer holds each QUESTION to the wire's ceiling, but an
// answer is server-sized and the number of exchanges is whatever a lifter asks in one activity.
//
// A thread past the ceiling loses its OLDEST exchanges — a conversation is about where it has got
// to, and since §O the oldest of it is the half the log already holds — and the trim happens on the
// way out, so nothing a lifter is looking at disappears while they are looking at it. It is the only
// trim left in Ask: nothing is dropped on the wire any more.
class AskThreadSaverTests {
    private fun answered(question: String, said: String) =
        AskExchange(question = question, answer = AskAnswer(answer = said, read = ReadTally(sets = 12)))

    private fun saved(thread: List<AskExchange>): String =
        savedThread(thread) ?: error("nothing was written")

    @Test
    fun testAConversationInsideTheCeilingIsSavedWholeAndComesBackWhole() {
        val thread = (1..8).map { answered("q$it", "a$it") }

        val written = saved(thread)

        assertTrue("nothing this small is trimmed", written.toByteArray(Charsets.UTF_8).size < 32_000)
        assertEquals(thread, readThread(written))
    }

    @Test
    fun testAConversationPastTheCeilingKeepsItsNewestExchangesAndDropsItsOldest() {
        val thread = (1..40).map { answered("q$it", "a$it ${"x".repeat(4_000)}") }

        val written = saved(thread)
        val kept = readThread(written)

        assertTrue("the Bundle is bounded", written.toByteArray(Charsets.UTF_8).size <= 32_000)
        assertTrue("and the trim is a trim rather than a wipe", kept.isNotEmpty())
        assertTrue("a whole conversation of this size does not fit", kept.size < thread.size)
        assertEquals("what survives is the tail, in order", thread.takeLast(kept.size), kept)
        assertEquals("and what was asked last is in it", thread.last(), kept.last())
    }

    @Test
    fun testTheNewestExchangeIsKeptWhateverItWeighs() {
        val whale = listOf(answered("q", "a".repeat(64_000)))

        assertEquals("a thread that saved nothing would answer a rotation with an empty room",
            whale, readThread(saved(whale)))
    }

    // A Bundle that came back unreadable — a build that changed the shape, a truncated write — opens
    // EMPTY rather than taking the room down with it, exactly as every file this product reads off
    // disk does. Losing a conversation is a disappointment; a crash on rotation is not a trade.
    @Test
    fun testAThreadThatCannotBeReadOpensEmpty() {
        assertEquals(emptyList<AskExchange>(), readThread("{not json"))
        assertEquals(emptyList<AskExchange>(), readThread(""))
    }
}
