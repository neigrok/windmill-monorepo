package works.windmill.gym.store

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.AskQuestion

class LocalCoachTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun requestsSurviveRelaunchUnderTheirOriginalAccountAndRetainEachRetryIdentity() {
        val file = File(tmp.root, "coach")
        val first = AskQuestion("conversation-a", "First\nquestion", "request-a")
        val second = AskQuestion("conversation-a", "Second question", "request-b")
        val other = AskQuestion("conversation-b", "Other account", "request-c")
        LocalCoach(file).apply { keep("a", first); keep("a", second); keep("b", other) }
        val restored = LocalCoach(file)
        assertEquals(listOf(first, second), restored.pending("a"))
        assertEquals(listOf(other), restored.pending("b"))
        assertEquals(emptyList<AskQuestion>(), restored.pending("c"))
        restored.clear("a", first.thread, first.requestId)
        assertEquals(listOf(second), LocalCoach(file).pending("a"))
        restored.clear("a", second.thread)
        assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
        assertEquals(listOf(other), LocalCoach(file).pending("b"))
    }

    @Test
    fun abandoningAConversationRemovesItsDraftAndRequestWithoutTouchingOtherThreads() {
        val file = File(tmp.root, "coach")
        val abandoned = AskQuestion("thread-a", "Question", "request-a")
        val retained = AskQuestion("thread-b", "Question", "request-b")
        val disk = LocalCoach(file)
        disk.keep("a", abandoned)
        disk.keep("a", retained)
        disk.saveDraft("a", abandoned.thread, works.windmill.gym.domain.CoachDraft("Question"))
        disk.clear("a", abandoned.thread)
        val restored = LocalCoach(file)
        assertEquals(listOf(retained), restored.pending("a"))
        assertEquals(works.windmill.gym.domain.CoachDraft(), restored.draft("a", abandoned.thread))
    }

    @Test
    fun unreadableOrUnwritableStorageCannotClaimARequestIsDurable() {
        val file = File(tmp.root, "coach")
        file.writeText("unreadable")
        val broken = LocalCoach(file)
        assertThrows(Exception::class.java) { broken.keep("a", AskQuestion("thread", "Question", "request-a")) }
        assertEquals("unreadable", file.readText())
        val parent = File(tmp.root, "not-a-directory").apply { writeText("keep") }
        val unwritable = LocalCoach(File(parent, "coach"))
        assertThrows(Exception::class.java) { unwritable.keep("a", AskQuestion("thread", "Question", "request-a")) }
        assertEquals(emptyList<AskQuestion>(), unwritable.pending("a"))
    }
}
