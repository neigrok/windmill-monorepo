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
}
