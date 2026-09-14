package works.windmill.gym.domain

import org.junit.Assert.*
import org.junit.Test

class ClaimConsentTests {
    @Test
    fun countsDescribeOnlyTheFrozenRecordsAndRealActiveWorkouts() {
        val revision = "a".repeat(64)
        val batch = ClaimBatch("batch", listOf(
            ClaimItem(ClaimSource.Anonymous, ClaimKind.Session, "s1", revision, "{}"),
            ClaimItem(ClaimSource.Anonymous, ClaimKind.Queue, "s1", revision, "{}", activeSession = true),
            ClaimItem(ClaimSource.Quarantine, ClaimKind.Session, "s1", revision, "{}"),
            ClaimItem(ClaimSource.Quarantine, ClaimKind.Queue, "orphan-lanes", revision, "{}"),
            ClaimItem(ClaimSource.Anonymous, ClaimKind.Movement, "m1", revision, "{}"),
            ClaimItem(ClaimSource.Anonymous, ClaimKind.Routine, "r1", revision, "{}"),
            ClaimItem(ClaimSource.Anonymous, ClaimKind.Bodyweight, "2026-09-14", revision, "{}"),
            ClaimItem(ClaimSource.Anonymous, ClaimKind.Preferences, "preferences", revision, "{}"),
        ))
        assertEquals(listOf(2, 1, 1, 1, 1), listOf(batch.sessions, batch.movements, batch.routines, batch.weighIns, batch.preferences))
        assertFalse(batch.isEmpty)
        assertTrue(ClaimBatch("empty", emptyList()).isEmpty)
    }

    @Test
    fun onlyTheRequestedSignInFlowCanApproveAndOnlyThatOwnerCanResume() {
        val batch = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Movement, "m1", "a".repeat(64), "{\"name\":\"Press\"}")))
        val waiting = ClaimConsent.requestSignIn(null, batch, "flow-1")
        assertEquals(waiting, ClaimConsent.requestSignIn(waiting, batch, "flow-1"))
        assertThrows(IllegalStateException::class.java) { ClaimConsent.approve(waiting, batch, "A") }
        assertThrows(IllegalStateException::class.java) { ClaimConsent.approve(waiting, batch, "A", "flow-2") }
        val approved = ClaimConsent.approve(waiting, batch, "A", "flow-1")
        assertEquals(ClaimConsent.Approved(batch, "A", "flow-1"), approved)
        assertEquals(batch, approved.resumeFor("A"))
        assertNull(approved.resumeFor("B"))
        assertNull(approved.resumeFor(null))
        assertEquals(approved, ClaimConsent.approve(approved, batch, "A"))
        assertThrows(IllegalStateException::class.java) { ClaimConsent.approve(approved, batch, "B", "flow-1") }
        assertThrows(IllegalStateException::class.java) { ClaimConsent.requestSignIn(approved, batch, "flow-2") }
    }

    @Test
    fun anApprovedSnapshotCannotBeExpandedReplacedOrTurnedIntoADiscard() {
        val item = ClaimItem(ClaimSource.Anonymous, ClaimKind.Bodyweight, "2026-09-14", "a".repeat(64), "{\"kg\":80}")
        val batch = ClaimBatch("batch", listOf(item))
        val approved = ClaimConsent.approve(null, batch, "A")
        val revised = batch.copy(items = listOf(item.copy(revision = "b".repeat(64), payload = "{\"kg\":81}")))
        val expanded = batch.copy(items = batch.items + item.copy(id = "2026-09-15"))
        listOf(revised, expanded, batch.copy(id = "another")).forEach { other ->
            assertThrows(IllegalStateException::class.java) { ClaimConsent.approve(approved, other, "A") }
            assertThrows(IllegalStateException::class.java) { ClaimConsent.discard(approved, other) }
        }
        assertThrows(IllegalStateException::class.java) { ClaimConsent.discard(approved, batch) }
        assertThrows(IllegalStateException::class.java) { ClaimConsent.complete(approved, "another") }
        assertNull(ClaimConsent.complete(approved, "batch"))
        assertNull(ClaimConsent.complete(null, "batch"))
        assertEquals("{\"kg\":80}", approved.batch.items.single().payload)
    }

    @Test
    fun anExpiredDiscardKeepsItsExactSnapshotAndRetiresTheSignInIntent() {
        val batch = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Quarantine, ClaimKind.Session, "s1", "a".repeat(64), "{}")))
        val waiting = ClaimConsent.requestSignIn(null, batch, "flow")
        val discard = ClaimConsent.discard(waiting, batch)
        assertEquals(ClaimConsent.Discarding(batch), discard)
        assertEquals(discard, ClaimConsent.discard(discard, batch))
        assertThrows(IllegalStateException::class.java) { ClaimConsent.approve(discard, batch, "A", "flow") }
        assertNull(ClaimConsent.complete(discard, batch.id))
        assertThrows(IllegalStateException::class.java) { ClaimConsent.approve(null, batch, "A", "flow") }
    }

    @Test
    fun malformedOrEmptyAuthorityIsRefusedBeforeItCanBePersisted() {
        val item = ClaimItem(ClaimSource.Anonymous, ClaimKind.Preferences, "preferences", "a".repeat(64), "{}")
        assertThrows(IllegalArgumentException::class.java) { item.copy(revision = "not-a-revision") }
        assertThrows(IllegalArgumentException::class.java) { item.copy(id = " ") }
        assertThrows(IllegalArgumentException::class.java) { item.copy(payload = "") }
        assertThrows(IllegalArgumentException::class.java) { item.copy(activeSession = true) }
        assertThrows(IllegalArgumentException::class.java) { ClaimBatch("batch", listOf(item, item)) }
        assertThrows(IllegalArgumentException::class.java) { ClaimConsent.Approved(ClaimBatch("empty", emptyList()), "A") }
        assertThrows(IllegalArgumentException::class.java) { ClaimConsent.Approved(ClaimBatch("batch", listOf(item)), " ") }
        assertThrows(IllegalArgumentException::class.java) { ClaimConsent.AwaitingSignIn(ClaimBatch("batch", listOf(item)), "") }
    }
}
