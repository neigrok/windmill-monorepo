package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet

// What has to be true for a set somebody lifted to survive the queue itself: it comes back from
// disk, an unreadable file opens empty instead of taking the session down, the walk keeps the
// server's own order, and every door — delivered, remint, close, forget — moves exactly what it
// says and nothing else. These are the paths that lose training.
class SetQueueTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun queueFile(): File = File(tmp.root, "gym-${System.nanoTime()}.json")

    private fun aSet(id: String, exerciseId: String = "bench-press", at: Long) = TrainingSet(
        id = id, exerciseId = exerciseId, weightKg = 82.5, reps = 5, completedAtMs = at)

    @Test
    fun testTheLiveSessionAndItsOwedSetsSurviveBeingReadBackFromDisk() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.flush()

        val reopened = SetQueue(file)
        assertEquals("ses_1", reopened.session?.id)
        assertEquals(listOf("set_a"), reopened.sets.map { it.id })
        assertEquals("an unsent set is still owed after a relaunch", 1, reopened.pending.size)
    }

    @Test
    fun testAnUnreadableFileOpensEmptyRatherThanCrashing() {
        val file = queueFile()
        file.writeText("not json at all")

        val queue = SetQueue(file)
        assertNull(queue.session)
        assertTrue(queue.pending.isEmpty())
    }

    @Test
    fun testWhatIsOwedComesBackInTheOrderItWasPerformed() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_c", at = 3_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_a", at = 1_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_b", at = 2_000), sessionId = "ses_1", needsPush = true)

        assertEquals("the server numbers sets max+1 per movement, so the queue sends in that order",
            listOf("set_a", "set_b", "set_c"), queue.pending.map { it.set.id })
    }

    // A jammed lane is skipped, not the queue. Every other movement keeps moving.
    @Test
    fun testABlockedLaneIsSteppedOverAndTheNextMovementIsOffered() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_a", "bench-press", at = 1_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_b", "back-squat", at = 2_000), sessionId = "ses_1", needsPush = true)

        val first = queue.nextOwed(skipping = emptySet(), readyAt = null)
        assertEquals("set_a", first?.set?.id)
        assertEquals("set_b", queue.nextOwed(skipping = setOf(first!!.lane), readyAt = null)?.set?.id)
    }

    // The log holding the row IS delivery, however the news arrived — a reply to our own write, or
    // a read that found it there.
    @Test
    fun testAServerRowArrivingForAnOwedSetSettlesIt() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_a", at = 1_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_a", at = 1_000).copy(setNumber = 4), sessionId = "ses_1", needsPush = false)

        assertTrue(queue.pending.isEmpty())
        assertEquals(listOf(4), queue.sets("ses_1").map { it.setNumber })
    }

    @Test
    fun testDeliveredReplacesTheDrawnSetWithTheStoredRow() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.delivered(aSet("set_a", at = 1_100).copy(setNumber = 1), id = "set_a", sessionId = "ses_1")

        assertTrue(queue.pending.isEmpty())
        assertEquals("the log numbered it, so it is the log's now",
            listOf(1), queue.sets.map { it.setNumber })

        // The row comes back under the id that went out — always — and clearing the SENT key
        // anyway is what stops a reply that ever disagreed from leaving the set owed forever.
        queue.store(aSet("set_b", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.delivered(aSet("set_c", at = 1_200).copy(setNumber = 2), id = "set_b", sessionId = "ses_1")
        assertEquals(emptyList<SetQueue.Entry>(), queue.pending)
        assertEquals(listOf("set_a", "set_c"), queue.sets.map { it.id })
    }

    @Test
    fun testARemintMovesTheSetToTheFreshIdAndSpendsOneOfTheRepairs() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_a", at = 1_000), sessionId = "ses_1", needsPush = true,
            heldUntilMs = 999_999)
        queue.remint("set_a", fresh = "set_b")

        assertEquals(listOf("set_b"), queue.pending.map { it.set.id })
        assertEquals(listOf(1), queue.pending.map { it.remints })
        assertEquals("a remint moves the key and nothing else",
            listOf(82.5), queue.pending.map { it.set.weightKg })
        assertFalse("the fresh id carries no hold — the window was spent on the send that collided",
            queue.pending.single().isHeld(at = 1_000))
    }

    // Closing keeps what is owed and lets go of what is on the log. An owed set is dropped by
    // nobody quietly — it waits for the log to answer for it, and that answer is what tells the
    // lifter.
    @Test
    fun testClosingASessionLetsGoOfTheDeliveredRowsAndKeepsTheOwedOne() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_landed", at = 1_100), sessionId = "ses_1", needsPush = false)
        queue.store(aSet("set_owed", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.close("ses_1")

        assertNull(queue.session)
        assertEquals(listOf("set_owed"), queue.pending.map { it.set.id })
        assertEquals(listOf("set_owed"), queue.sets("ses_1").map { it.id })
    }

    // Discard is the one case where an owed set has nowhere left to go: the session id no longer
    // names anything, so keeping it would re-send it against nothing, forever.
    @Test
    fun testForgettingADiscardedSessionTakesTheOwedSetsWithIt() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_owed", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.forget("ses_1")

        assertNull(queue.session)
        assertTrue(queue.pending.isEmpty())
    }

    @Test
    fun testNextOwedSkipsAnEntryStillInsideItsWindowAndAForcedWalkDoesNot() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_held", at = 1_000), sessionId = "ses_1", needsPush = true,
            heldUntilMs = 10_000)
        queue.store(aSet("set_ready", "back-squat", at = 2_000), sessionId = "ses_1", needsPush = true)

        assertEquals("a held set is being kept on purpose — the walk moves past it",
            "set_ready", queue.nextOwed(skipping = emptySet(), readyAt = 5_000)?.set?.id)
        assertEquals("a forced walk ends every window",
            "set_held", queue.nextOwed(skipping = emptySet(), readyAt = null)?.set?.id)
    }

    // The claim's repair for a live session whose id another account spent: the same workout under
    // a fresh session id, every owed set re-pointed — and the set ids themselves do not move.
    @Test
    fun testRemappingTheSessionMovesTheWorkoutWholeToTheFreshId() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_spent", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_spent", needsPush = true)
        queue.store(aSet("set_b", at = 1_200), sessionId = "ses_other", needsPush = true)
        queue.remapSession("ses_spent", fresh = "ses_fresh")

        assertEquals("ses_fresh", queue.session?.id)
        assertEquals(listOf("set_a"), queue.owed("ses_fresh").map { it.set.id })
        assertEquals("another session's sets are not touched",
            listOf("set_b"), queue.owed("ses_other").map { it.set.id })
        assertTrue(queue.owed("ses_spent").isEmpty())
    }

    // ...and for a locally minted movement: the id changes in the sets, the walk order and the
    // live plan's own lines, because a movement is a stable id everywhere except on screen.
    @Test
    fun testRemappingAMovementReachesTheSetsTheOrderAndThePlan() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000,
            plan = works.windmill.gym.domain.PlanSnapshot(routine = "Push",
                entries = listOf(works.windmill.gym.domain.PlanEntry(exerciseId = "ex_spent", sets = 3)))))
        queue.append("ex_spent")
        queue.store(aSet("set_a", "ex_spent", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.remapExercise("ex_spent", fresh = "ex_fresh")

        assertEquals(listOf("ex_fresh"), queue.order)
        assertEquals(listOf("ex_fresh"), queue.pending.map { it.set.exerciseId })
        assertEquals(listOf("ex_fresh"), queue.session?.plan?.entries?.map { it.exerciseId })
    }

    @Test
    fun testTheMovementOrderBelongsToItsSessionAndGoesWithIt() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.append("bench-press")
        queue.append("bench-press")
        queue.append("back-squat")
        assertEquals(listOf("bench-press", "back-squat"), queue.order)

        queue.flush()
        assertEquals(listOf("bench-press", "back-squat"), SetQueue(file).order)

        queue.hold(Session(id = "ses_2", startedAtMs = 2_000))
        assertEquals("a different session is a different workout",
            emptyList<String>(), queue.order)
    }

    // R2 — WHETHER THE LIVE SESSION IS THE LOG'S IS WRITTEN TO DISK, per session: held false by
    // every caller the server answered, true by the on-device start, false again by the claim's
    // landed start for the same id, and gone with the session. A file from a build before the bit
    // existed reads as UNCLAIMED — that build re-sent every live start on every connect, so its
    // file says nothing about the log, and one idempotent start replay is the cheap side of that
    // doubt; reading it as claimed could forget a device-composed workout as "gone" on its first
    // 404.
    @Test
    fun testTheUnclaimedBitIsPerSessionOnDiskAndAbsentReadsAsUnclaimed() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.flush()
        assertFalse("answered by the server", queue.sessionIsUnclaimed)
        assertFalse(SetQueue(file).sessionIsUnclaimed)

        queue.hold(Session(id = "ses_mine", startedAtMs = 2_000), unclaimed = true)
        queue.flush()
        assertTrue("composed on the device", SetQueue(file).sessionIsUnclaimed)

        queue.claimed("ses_other")
        assertTrue("a claim for some other id changes nothing", queue.sessionIsUnclaimed)
        queue.claimed("ses_mine")
        queue.flush()
        assertFalse("the claim's start landed it", SetQueue(file).sessionIsUnclaimed)

        queue.forget("ses_mine")
        assertFalse("no session, nothing unclaimed", queue.sessionIsUnclaimed)

        file.writeText("""{"session":{"id":"ses_old","startedAt":1000},"entries":{}}""")
        val fromBefore = SetQueue(file, deviceOwner = null)
        assertNull("a file from before the seats, on a phone holding no session, belongs to " +
            "nobody until a human says so", fromBefore.session)
        assertEquals("ses_old", fromBefore.unattributedSession?.id)
        assertFalse("and nobody signed in may claim it", fromBefore.release())
        fromBefore.adopt("alice")
        assertTrue(fromBefore.release())
        assertTrue("and once released it reads as unclaimed — that build's file says nothing " +
            "about whether the log ever answered", fromBefore.sessionIsUnclaimed)
    }

    // THE SEAT IS THE KEY — the whole of MOBILE-3's queue half. A live workout and its owed sets
    // belong to the seat that composed them: the next account to hold this phone is never drawn
    // that workout and never re-sends those sets under its own bearer, and the first lifter finds
    // both exactly where they left them.
    @Test
    fun testALiveSessionIsNeverDrawnForTheNextSeatAndItsOwedSetsAreNotLost() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.adopt("alice")
        queue.hold(Session(id = "ses_alice", startedAtMs = 1_000), unclaimed = true)
        queue.store(aSet("set_a", at = 1_100), "ses_alice", needsPush = true)
        queue.flush()

        queue.adopt(null)
        assertNull("signing out draws no workout", queue.session)
        assertTrue(queue.pending.isEmpty())

        queue.adopt("bob")
        assertNull("and the next account is drawn none of it", queue.session)
        assertEquals("nothing of A's is owed under B's bearer", emptyList<String>(),
            queue.pending.map { it.set.id })

        val relaunched = SetQueue(file)
        relaunched.adopt("alice")
        assertEquals("ses_alice", relaunched.session?.id)
        assertEquals("A's owed set was parked, never dropped",
            listOf("set_a"), relaunched.pending.map { it.set.id })
    }

    // The anonymous-first door on the queue: a workout begun with nobody signed in rides onto the
    // account that claims it — but only onto a seat with nothing live of its own, because a live
    // workout is one slot and the arriving lifter's own unclaimed session wins. Nothing is dropped
    // for that: it waits under its own key.
    @Test
    fun testAnAnonymousWorkoutRidesOntoAFreeSeatAndWaitsForATakenOne() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.adopt("alice")
        queue.hold(Session(id = "ses_alice", startedAtMs = 1_000), unclaimed = true)
        queue.flush()

        queue.adopt(null)
        queue.hold(Session(id = "ses_anon", startedAtMs = 2_000), unclaimed = true)
        queue.store(aSet("set_anon", at = 2_100), "ses_anon", needsPush = true)
        queue.flush()

        queue.adopt("alice")
        assertEquals("A's own live workout holds the slot", "ses_alice", queue.session?.id)
        queue.adopt(null)
        assertEquals("and the anonymous one is still here, whole",
            "ses_anon", queue.session?.id)
        assertEquals(listOf("set_anon"), queue.pending.map { it.set.id })

        queue.adopt("bob")
        assertEquals("a free seat claims it", "ses_anon", queue.session?.id)
        assertEquals(listOf("set_anon"), queue.pending.map { it.set.id })
    }

    // WHO A QUEUE FROM BEFORE THE SEATS BELONGS TO — branch one: the phone was SIGNED IN when it
    // upgraded, so the workout it was holding is that account's and the lifter is put back under
    // their own bar rather than sent hunting for a settings row.
    @Test
    fun testALiveWorkoutFromBeforeTheSeatsBelongsToTheSeatTheDeviceWasHolding() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_old","startedAt":1000},"entries":{}}""")

        // The device was holding A's session when this file was opened — that, and never the
        // account the room is later connected for, is what names the owner.
        val queue = SetQueue(file, deviceOwner = "alice")
        assertEquals("ses_old", queue.session?.id)
        assertNull("no door is needed and none is offered", queue.unattributedSession)

        queue.adopt(null)
        queue.adopt("alice")
        assertEquals("through the app's own null-first connect ordering",
            "ses_old", queue.session?.id)

        queue.adopt("bob")
        assertNull("and it went to A alone", queue.session)
        queue.adopt("alice")
        assertEquals("ses_old", queue.session?.id)
    }

    // Branch two, and the decision is spent on the FIRST seat this room opens for: a phone holding
    // no session at the upgrade quarantines, and signing in afterwards does not undo that.
    @Test
    fun testAQueueFromBeforeTheSeatsOnASignedOutDeviceStaysQuarantined() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_old","startedAt":1000},"entries":{}}""")

        val queue = SetQueue(file, deviceOwner = null)
        queue.adopt(null)
        queue.adopt("alice")
        assertNull("not even the first account to sign in afterwards", queue.session)
        assertEquals("ses_old", queue.unattributedSession?.id)
        assertNull("and the decision is on DISK — a relaunch that does hold a session must still " +
            "find a quarantine", SetQueue(file, deviceOwner = "bob").session)
        assertTrue(queue.release())
        assertEquals("ses_old", queue.session?.id)
    }

    // The queue's half of the same rule: the decision is written before anything else happens, or
    // the legacy file is still on disk for the next launch to hand to somebody.
    @Test
    fun testASignedOutMigrationIsWrittenDownAtOnce() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_before","startedAt":1000},"entries":{}}""")

        SetQueue(file, deviceOwner = null)

        val later = SetQueue(file, deviceOwner = "bob")
        assertNull("B WAS HANDED A STRANGER'S WORKOUT", later.session)
        assertEquals("ses_before", later.unattributedSession?.id)
    }

    // The other half of the same refusal, and the one a live session cannot state: a seat that
    // still OWES SETS with no workout standing over them is not an empty slot either, and a release
    // that landed the shelf's half and quietly dropped this one would lose a workout.
    @Test
    fun testAQuarantineIsNotReleasedOntoASeatThatStillOwesSets() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_before","startedAt":1000},"entries":{}}""")

        val queue = SetQueue(file, deviceOwner = null)
        queue.adopt("alice")
        queue.store(aSet("set_a", at = 1_100), "ses_alice", needsPush = true)

        assertNull("no workout stands over them", queue.session)
        assertEquals(1, queue.pending.size)
        assertFalse("owed lanes are a queue too", queue.release())
        assertTrue("and nothing was taken out of quarantine", queue.hasUnattributed)
    }

    // A remembered identity may paint; it may not adopt. The carry waits for the answer.
    @Test
    fun testAnUnconfirmedSeatDoesNotClaimTheAnonymousWorkout() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_anon", startedAtMs = 1_000), unclaimed = true)
        queue.flush()

        queue.adopt("alice", confirmed = false)
        assertNull(queue.session)
        queue.adopt(null)
        queue.adopt("alice", confirmed = true)
        assertEquals("ses_anon", queue.session?.id)
    }
}
