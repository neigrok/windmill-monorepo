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
        val record = """{"owner":"a","chat":"c","replica":"x","requestId":"r","body":"{}","createdAtMs":1,"response":{"requestId":"r","resultId":"z","status":"failed","routines":[],"allowance":"""
        for (text in listOf("""{"chats":""", """{"chats":{},"drafts":5}""", "[]",
            """{"onboarding":{"a":{"r":$record 7}}}}""", """{"onboarding":{"a":{"r":$record {"remaining":7}}}}}""")) {
            val directory = tmp.newFolder()
            val file = File(directory, "coach")
            file.writeText(text)
            val photos = File(directory, "coach-photos/feedface").apply { mkdirs() }
            File(photos, "kept-photo").writeBytes(byteArrayOf(9))
            val broken = LocalCoach(file)
            broken.settle()
            assertFalse(broken.readable)
            assertThrows(Exception::class.java) { broken.chats("a") }
            assertThrows(Exception::class.java) { broken.saveChat("a", LocalChat("thread", 1)) }
            assertFalse(broken.writable("a"))
            assertEquals(text, file.readText())
            assertArrayEquals(byteArrayOf(9), File(photos, "kept-photo").readBytes())
        }
    }

    // What a retained answer's allowance read holds outlives the settle that rewrites the file; a file written before it held one, or by a build that dropped it, reads as well and stays as it is.
    @Test
    fun aRetainedAnswerKeepsItsBalanceThroughTheSettleAndAnOlderFileWithoutOneReads() {
        val release = """"allowance":{"code":"subject_exhausted","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":"0.25","used":"0.25","reserved":"0.00","remaining":"0.00"},"""
        fun document(extra: String, allowance: String) = """{"anonymousId":"a"$extra,"onboarding":{"a":{"r":{"owner":"a","chat":"c","replica":"x","requestId":"r","body":"{}","createdAtMs":1,"response":{"requestId":"r","resultId":"z","status":"failed","routines":[],$allowance"errorCode":"subject_exhausted"}}}}}"""
        val rewritten = File(tmp.newFolder(), "coach").apply { writeText(document(""","chats":{}""", release)) }
        val stamp = rewritten.lastModified()
        LocalCoach(rewritten).settle()
        assertEquals("""{"anonymousId":"a","localChats":{"a":{"c":{"id":"c","createdAtMs":$stamp,"updatedAtMs":$stamp}}},"onboarding":{"a":{"r":{"owner":"a","chat":"c","replica":"x","requestId":"r","body":"{}","createdAtMs":1,"response":{"requestId":"r","resultId":"z","status":"failed","routines":[],"errorCode":"subject_exhausted","allowance":{"remaining":"0.00","reserved":"0.00"}}}}}}""", rewritten.readText())
        assertTrue(LocalCoach(rewritten).retained("a", "c").single().response!!.spent)

        val without = document("", "")
        val older = File(tmp.newFolder(), "coach").apply { writeText(without) }
        val read = LocalCoach(older)
        assertTrue(read.readable)
        read.settle()
        assertFalse(read.retained("a", "c").single().response!!.spent)
        assertEquals(without, older.readText())
    }

    // Any write drops an earlier file's conversations; the photos only they named still go at the settle that follows it, in this launch or the next.
    @Test
    fun aWriteBeforeTheSettleLeavesNoOldPhotoBehind() {
        val directory = tmp.newFolder()
        val file = File(directory, "coach")
        file.writeText("""{"chats":{"a":{"gone":{"id":"gone","createdAtMs":1,"exchanges":[{"question":"Private old question"}]}}},"drafts":{"a":{"drafted":{"text":"Keep me"}}}}""")
        val disk = LocalCoach(file)
        val hers = disk.photoFile("a", "draftphoto01").parentFile!!.apply { mkdirs() }
        File(hers, "oldexchangephoto").writeBytes(byteArrayOf(9))
        val gone = File(directory, "coach-photos/feedfacefeedface").apply { mkdirs() }
        File(gone, "owner-gone").writeBytes(byteArrayOf(9))

        disk.anonymousOwner()
        assertFalse(file.readText().contains("Private old question"))
        assertEquals(listOf("oldexchangephoto"), hers.list()?.toList())
        assertEquals(listOf("owner-gone"), gone.list()?.toList())

        LocalCoach(file).settle()
        assertEquals(emptyList<String>(), hers.list()?.toList())
        assertFalse(gone.exists())
        assertEquals(CoachDraft("Keep me"), LocalCoach(file).draft("a", "drafted"))
    }

    // Every draft, kept draft and retained answer has its chat, in a file with none of the keys that mark an earlier version as well; a kept draft emptied since brings none back.
    @Test
    fun aDraftWithNoChatOfItsOwnGetsOneWhateverKeysTheFileHolds() {
        val file = File(tmp.root, "coach")
        file.writeText("""{"anonymousId":"anonymous:phone","selected":{"a":"drafted"},"drafts":{"a":{"drafted":{"text":"Keep me"}}},"keptDrafts":{"a":{"kept":[{"id":"kept-1","draft":{"text":"Kept"}}],"emptied":[]}},"localChats":{"a":{"standing":{"id":"standing","createdAtMs":1,"updatedAtMs":2,"conversation":"thr_00000001"}}}}""")
        val stamp = file.lastModified()
        val disk = LocalCoach(file)
        assertEquals(setOf(LocalChat("drafted", stamp), LocalChat("kept", stamp), LocalChat("standing", 1, 2, conversation = "thr_00000001")), disk.chats("a").toSet())
        assertEquals("drafted", disk.selected("a"))
        assertEquals("anonymous:phone", disk.anonymousOwner())
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
