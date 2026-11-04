package works.windmill.gym.coach

import java.io.File
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.platform.storage.AtomicDocument

class LocalCoachTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun aChatItsThreadAndItsDraftSurviveRelaunchUnderTheirOriginalAccount() {
        val file = File(tmp.root, "coach")
        val asked = LocalChat("conversation-a", 5, conversation = "thr_00000001", scroll = 3, followEnd = false)
        val other = LocalChat("conversation-c", 6)
        LocalCoach(file, now = { 9L }).apply {
            saveChat("a", asked, select = true)
            saveDraft("a", "conversation-b", CoachDraft("Typing"))
            saveChat("b", other)
        }
        val restored = LocalCoach(file)
        assertEquals(setOf(asked, LocalChat("conversation-b", 9, 9)), restored.chats("a").toSet())
        assertEquals("conversation-a", restored.selected("a"))
        assertEquals(CoachDraft("Typing"), restored.draft("a", "conversation-b"))
        assertEquals(listOf(other), restored.chats("b"))
        assertNull(restored.selected("b"))
        assertEquals(emptyList<LocalChat>(), restored.chats("c"))
    }

    @Test
    fun abandoningAConversationRemovesItsDraftWithoutTouchingOtherThreads() {
        val file = File(tmp.root, "coach")
        val disk = LocalCoach(file)
        disk.saveChat("a", LocalChat("thread-a", 1), select = true)
        disk.saveDraft("a", "thread-a", CoachDraft("Question"))
        disk.saveDraft("a", "thread-b", CoachDraft("Another"))
        disk.clear("a", "thread-a")
        val restored = LocalCoach(file)
        assertEquals(CoachDraft(), restored.draft("a", "thread-a"))
        assertEquals(CoachDraft("Another"), restored.draft("a", "thread-b"))
        assertEquals(listOf("thread-b"), restored.chats("a").map { it.id })
        assertNull(restored.selected("a"))
    }

    @Test
    fun unreadableOrUnwritableStorageCannotClaimAChatIsDurable() {
        val file = File(tmp.root, "coach")
        file.writeText("unreadable")
        val broken = LocalCoach(file)
        assertThrows(Exception::class.java) { broken.saveChat("a", LocalChat("thread", 1)) }
        assertEquals("unreadable", file.readText())
        val parent = File(tmp.root, "not-a-directory").apply { writeText("keep") }
        val unwritable = LocalCoach(File(parent, "coach"))
        assertThrows(Exception::class.java) { unwritable.saveChat("a", LocalChat("thread", 1)) }
        assertEquals(emptyList<LocalChat>(), unwritable.chats("a"))
    }

    @Test
    fun aTurnOpenedTakesTheDraftAndItsPhotoAndTheChatHoldsTheThread() {
        val file = File(tmp.root, "coach")
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        val disk = LocalCoach(file, now = { 9L })
        disk.saveChat("a", LocalChat("chat-a", 1))
        disk.savePhoto("a", photo.id, byteArrayOf(1, 2, 3))
        disk.saveDraft("a", "chat-a", CoachDraft("Question", photo))
        disk.turnOpened("a", "chat-a", "thr_00000001")
        val restored = LocalCoach(file)
        assertEquals(CoachDraft(), restored.draft("a", "chat-a"))
        assertEquals(LocalChat("chat-a", 1, 9, conversation = "thr_00000001"), restored.chat("a", "chat-a"))
        assertFalse(restored.photoFile("a", photo.id).exists())
    }

    @Test
    fun aWithdrawnTurnReturnsTheDraftAndItsPhotoAndTheChatHoldsOnlyAThreadThatStands() {
        val file = File(tmp.root, "coach")
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        val disk = LocalCoach(file, now = { 9L })
        disk.saveChat("a", LocalChat("chat-a", 1, conversation = "thr_00000001"))
        disk.turnWithdrawn("a", "chat-a", null, CoachDraft("Question", photo), byteArrayOf(1, 2, 3))
        val restored = LocalCoach(file)
        assertEquals(CoachDraft("Question", photo), restored.draft("a", "chat-a"))
        assertEquals(LocalChat("chat-a", 1, 9), restored.chat("a", "chat-a"))
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.photoFile("a", photo.id).readBytes())
        disk.turnWithdrawn("a", "chat-a", "thr_00000002", CoachDraft("Again"), null)
        assertEquals(LocalChat("chat-a", 1, 9, conversation = "thr_00000002"), LocalCoach(file).chat("a", "chat-a"))
    }

    @Test
    fun anUnreadableEarlierFileIsLeftWhereItIsAndNeverSettles() {
        for (text in listOf("""{"chats":""", """{"chats":{},"drafts":5}""", "[]")) {
            val directory = tmp.newFolder()
            val file = File(directory, "coach")
            file.writeText(text)
            val photos = File(directory, "coach-photos/feedface").apply { mkdirs() }
            File(photos, "kept-photo").writeBytes(byteArrayOf(9))
            val broken = LocalCoach(file)
            assertThrows(Exception::class.java) { broken.settle() }
            assertThrows(Exception::class.java) { broken.chats("a") }
            assertThrows(Exception::class.java) { broken.saveChat("a", LocalChat("thread", 1)) }
            assertFalse(broken.writable("a"))
            assertEquals(text, file.readText())
            assertArrayEquals(byteArrayOf(9), File(photos, "kept-photo").readBytes())
        }
    }

    @Test
    fun aFailedRewriteOfAnEarlierFileLeavesItWholeForTheNextLaunchAndTheNextSettleFinishes() {
        val directory = tmp.newFolder()
        val file = File(directory, "coach")
        val text = """{"chats":{"a":{"gone":{"id":"gone","createdAtMs":1,"exchanges":[{"question":"Private old question"}]}}},"drafts":{"a":{"drafted":{"text":"Keep me"}}}}"""
        file.writeText(text)
        val photos = File(directory, "coach-photos/feedface").apply { mkdirs() }
        File(photos, "owner-gone").writeBytes(byteArrayOf(9))
        var fail = true
        val disk = LocalCoach(file) { target, value -> if (fail) throw IOException("disk full") else AtomicDocument.write(target, value) }
        assertThrows(IOException::class.java) { disk.settle() }
        assertEquals(text, file.readText())
        assertTrue("the photos wait for the rewrite", File(photos, "owner-gone").exists())
        assertEquals(CoachDraft("Keep me"), disk.draft("a", "drafted"))
        fail = false
        disk.settle()
        assertFalse(file.readText().contains("Private old question"))
        assertFalse(File(photos, "owner-gone").exists())
        assertEquals(CoachDraft("Keep me"), LocalCoach(file).draft("a", "drafted"))
    }
}
