package works.windmill.gym.store

import java.io.File
import java.io.IOException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimConsent
import works.windmill.gym.domain.ClaimItem
import works.windmill.gym.domain.ClaimKind
import works.windmill.gym.domain.ClaimSource

class LocalClaimConsentTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun theExactSignInSnapshotAndOwnerSurviveFreshInstances() {
        val file = File(tmp.root, "consent.json")
        val batch = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Queue, "s1", "a".repeat(64), "{\"sets\":[\"set-1\"]}", 123, true)))
        val store = LocalClaimConsent(file)
        assertNull(store.state)
        store.requestSignIn(batch, "flow-1")
        val reopened = LocalClaimConsent(file)
        assertEquals(ClaimConsent.AwaitingSignIn(batch, "flow-1"), reopened.state)
        assertThrows(IllegalStateException::class.java) { reopened.approve(batch, "B", "unrelated-flow") }
        reopened.approve(batch, "A", "flow-1")
        val expected = """{"version":1,"consent":{"type":"approved","batch":{"id":"batch","items":[{"source":"Anonymous","kind":"Queue","id":"s1","revision":"${"a".repeat(64)}","payload":"{\"sets\":[\"set-1\"]}","atMs":123,"activeSession":true}]},"owner":"A","flowId":"flow-1"}}"""
        assertEquals(expected, file.readText())
        val approved = LocalClaimConsent(file).state as ClaimConsent.Approved
        assertEquals(batch, approved.resumeFor("A"))
        assertNull(approved.resumeFor("B"))
        assertThrows(IllegalStateException::class.java) { LocalClaimConsent(file).approve(batch, "B") }
        assertEquals(expected, file.readText())
    }

    @Test
    fun callersCannotMutateTheDurableSnapshotThroughTheirInputOrARead() {
        val file = File(tmp.root, "consent.json")
        val item = ClaimItem(ClaimSource.Anonymous, ClaimKind.Session, "s1", "a".repeat(64), "{}")
        val items = mutableListOf(item, item.copy(id = "s2"))
        val original = ClaimBatch("batch", items.toList())
        val store = LocalClaimConsent(file)
        store.approve(ClaimBatch("batch", items), "A")
        items.clear()
        val returned = store.state as ClaimConsent.Approved
        (returned.batch.items as MutableList<ClaimItem>).clear()
        assertEquals(ClaimConsent.Approved(original, "A"), store.state)
        assertEquals(store.state, LocalClaimConsent(file).state)
    }

    @Test
    fun anInterruptedTemporaryWriteCannotReplaceApprovalOrResurrectCompletedWork() {
        val file = File(tmp.root, "consent.json")
        val batch = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Routine, "r1", "a".repeat(64), "{}")))
        LocalClaimConsent(file).approve(batch, "A")
        File(tmp.root, "consent.json.tmp").writeText("{\"version\":1,\"consent\":")
        assertEquals(ClaimConsent.Approved(batch, "A"), LocalClaimConsent(file).state)
        LocalClaimConsent(file).complete(batch.id)
        assertEquals("""{"version":1,"consent":null}""", file.readText())
        File(tmp.root, "consent.json.tmp").writeText("old interrupted data")
        assertNull(LocalClaimConsent(file).state)
    }

    @Test
    fun failureBeforeReplacementLeavesTheOldDecisionAndStopsThisInstance() {
        val file = File(tmp.root, "consent.json")
        val batch = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Movement, "m1", "a".repeat(64), "{}")))
        LocalClaimConsent(file).requestSignIn(batch, "flow")
        val before = file.readText()
        val broken = LocalClaimConsent(file) { _, _ -> throw IOException("disk full") }
        assertThrows(IOException::class.java) { broken.approve(batch, "A", "flow") }
        assertEquals(before, file.readText())
        assertThrows(IllegalStateException::class.java) { broken.state }
        assertThrows(IllegalStateException::class.java) { broken.discard(batch) }
        assertEquals(ClaimConsent.AwaitingSignIn(batch, "flow"), LocalClaimConsent(file).state)
    }

    @Test
    fun anUncertainReplyAfterAtomicReplacementResumesOnlyThePersistedOwner() {
        val file = File(tmp.root, "consent.json")
        val batch = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Bodyweight, "2026-09-14", "a".repeat(64), "{\"kg\":80}")))
        val broken = LocalClaimConsent(file) { destination, text ->
            persistClaimConsent(destination, text)
            throw IOException("process interrupted after replacement")
        }
        assertThrows(IOException::class.java) { broken.approve(batch, "A") }
        assertThrows(IllegalStateException::class.java) { broken.approve(batch, "B") }
        val reopened = LocalClaimConsent(file)
        assertEquals(ClaimConsent.Approved(batch, "A"), reopened.state)
        assertThrows(IllegalStateException::class.java) { reopened.approve(batch, "B") }
        reopened.approve(batch, "A")
        assertEquals(batch, (reopened.state as ClaimConsent.Approved).resumeFor("A"))
    }

    @Test
    fun aDiscardAndItsCompletionAreDurableWithoutSweepingNewData() {
        val file = File(tmp.root, "consent.json")
        val item = ClaimItem(ClaimSource.Quarantine, ClaimKind.Session, "old", "a".repeat(64), "{}")
        val batch = ClaimBatch("discard", listOf(item))
        LocalClaimConsent(file).discard(batch)
        val store = LocalClaimConsent(file)
        assertEquals(ClaimConsent.Discarding(batch), store.state)
        val newBatch = ClaimBatch("new", listOf(item.copy(source = ClaimSource.Anonymous, id = "new")))
        assertThrows(IllegalStateException::class.java) { store.discard(newBatch) }
        assertThrows(IllegalStateException::class.java) { store.complete("new") }
        assertEquals(batch, store.state!!.batch)
        store.complete(batch.id)
        LocalClaimConsent(file).approve(newBatch, "B")
        assertEquals(ClaimConsent.Approved(newBatch, "B"), LocalClaimConsent(file).state)
    }

    @Test
    fun corruptUnknownAndIncompleteDocumentsFailClosedWithoutBeingOverwritten() {
        val file = File(tmp.root, "consent.json")
        listOf("{", "{}", """{"version":2,"consent":null}""",
            """{"version":1,"consent":{"type":"approved"}}""",
            """{"version":1,"consent":null,"unexpected":true}""").forEach { text ->
            file.writeText(text)
            assertThrows(Exception::class.java) { LocalClaimConsent(file) }
            assertEquals(text, file.readText())
        }
        file.delete()
        assertNull(LocalClaimConsent(file).state)
    }

    @Test
    fun aRealFilesystemFailureCannotProduceAnInMemoryApproval() {
        val parent = File(tmp.root, "not-a-folder").apply { writeText("standing file") }
        val store = LocalClaimConsent(File(parent, "consent.json"))
        val batch = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Preferences, "preferences", "a".repeat(64), "{}")))
        assertThrows(IOException::class.java) { store.approve(batch, "A") }
        assertThrows(IllegalStateException::class.java) { store.state }
        assertEquals("standing file", parent.readText())
    }
}
