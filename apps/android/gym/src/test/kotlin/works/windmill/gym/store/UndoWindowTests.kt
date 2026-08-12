package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet

// THE UNDO WINDOW — the one promise in gym that the DEVICE keeps rather than asks the log for. A
// logged row can be taken off the log (§G18's delete), but that is a repair made at rest, on a past
// session, with a sheet and a second gesture; the only moment a MIS-TAP can be taken back without
// telling anybody is while this device is still the only place it exists.
//
// The iOS suite drives these promises through TrainingStore; the store arrives in the next wave,
// so they are pinned here at the queue — the level that actually keeps them. Everything below is a
// way the window can go wrong: a set that never leaves because the hold never ends, a set taken
// back after the log already has it, and a session closing over a set still inside its nine
// seconds — which the log would refuse forever.
class UndoWindowTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clockMs = 1_000L
    private lateinit var file: File
    private lateinit var queue: SetQueue

    @Before
    fun setUp() {
        clockMs = 1_000L
        file = File(tmp.root, "gym-undo-${System.nanoTime()}.json")
        queue = SetQueue(file) { clockMs }
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
    }

    private fun logSet(id: String, weightKg: Double = 82.5, reps: Int = 5) {
        queue.store(
            TrainingSet(id = id, exerciseId = "bench-press", weightKg = weightKg, reps = reps,
                completedAtMs = clockMs),
            sessionId = "ses_1", needsPush = true, heldUntilMs = clockMs + SetQueue.undoWindowMs)
        queue.flush()
    }

    // The set is on the device the instant it is tapped — the window changes when it is SENT,
    // never whether it was kept.
    @Test
    fun testASetJustLoggedIsOnTheDeviceAndNotYetOnTheLog() {
        logSet("set_1")

        assertEquals(listOf(82.5), queue.sets.map { it.weightKg })
        assertNull("nothing goes out while it can still be taken back",
            queue.nextOwed(skipping = emptySet(), readyAt = clockMs))
        assertEquals(82.5, queue.withdrawable()?.set?.weightKg)
        assertEquals("and it is on disk, not in memory", 1, SetQueue(file).pending.size)
    }

    // "Offline" would be the wrong word for a send nobody has attempted. The walk offers nothing
    // while the window is open, so there is nothing for a save line to report — silence is the
    // honest state (SaveState.Idle.line is null, VerdictTests pins the words).
    @Test
    fun testASetInsideItsWindowIsNotOfferedToTheWalk() {
        logSet("set_1")

        assertNull(queue.nextOwed(skipping = emptySet(), readyAt = clockMs))
        assertEquals("held on purpose is not stranded",
            emptyList<SetQueue.Entry>(), queue.pending.filter { !it.isHeld(clockMs) })
    }

    // The gesture the window exists for: the set never reaches the log at all, so nothing already
    // written is destroyed by one tap.
    @Test
    fun testUndoTakesTheSetBackAndTheLogNeverHearsOfIt() {
        logSet("set_1")
        assertTrue(queue.withdraw("set_1"))
        queue.flush()

        assertEquals(emptyList<TrainingSet>(), queue.sets)
        assertEquals("and the disk agrees", 0, SetQueue(file).pending.size)
        assertNull(queue.withdrawable())
    }

    // Undo answers the tap the lifter just made, not the oldest one still waiting.
    @Test
    fun testUndoTakesBackTheNewestSetAndLeavesTheRest() {
        logSet("set_1")
        clockMs += 1_000
        logSet("set_2", weightKg = 85.0, reps = 3)

        val newest = queue.withdrawable()
        assertEquals(85.0, newest?.set?.weightKg)
        assertTrue(queue.withdraw(newest!!.set.id))
        assertEquals(listOf(82.5), queue.sets.map { it.weightKg })
    }

    // Once the window closes the set goes out on its own — a hold that never ended would be a set
    // that never landed.
    @Test
    fun testWhenTheWindowClosesTheSetIsOfferedByItself() {
        logSet("set_1")
        clockMs += SetQueue.undoWindowMs + 1

        assertEquals("set_1", queue.nextOwed(skipping = emptySet(), readyAt = clockMs)?.set?.id)
        assertNull("and there is nothing left to take back", queue.withdrawable())
    }

    // Past the window the log holds the row, and this door does not reach the account's. The answer
    // is no rather than a screen that quietly disagrees with it — the set comes off through §G18's
    // delete on the session read back, never through the logger mid-workout.
    @Test
    fun testUndoAfterTheSetHasLandedRefusesRatherThanPretending() {
        logSet("set_1")
        queue.delivered(
            TrainingSet(id = "set_1", exerciseId = "bench-press", setNumber = 1, weightKg = 82.5,
                reps = 5, completedAtMs = clockMs),
            id = "set_1", sessionId = "ses_1")

        assertFalse(queue.withdraw("set_1"))
        assertEquals("the set the log has stays on screen",
            listOf(82.5), queue.sets.map { it.weightKg })
        assertNull(queue.withdrawable())
    }

    // A forced walk passes null for `readyAt`, and it ends every window: a finish is this device's
    // statement that everything is delivered (a close would refuse a skipped set FOREVER), leaving
    // the room takes the affordance with the subtree, and a boot read settles the session over a
    // gesture nobody can still make.
    @Test
    fun testAForcedWalkOffersASetStillInsideItsWindow() {
        logSet("set_1")
        assertNull("the ordinary walk keeps the window",
            queue.nextOwed(skipping = emptySet(), readyAt = clockMs))

        val offered = queue.nextOwed(skipping = emptySet(), readyAt = null)
        assertEquals("set_1", offered?.set?.id)

        queue.delivered(offered!!.set.copy(setNumber = 1), id = "set_1", sessionId = "ses_1")
        assertEquals("nothing is left to strand against the close",
            emptyList<SetQueue.Entry>(), queue.owed("ses_1"))
        queue.close("ses_1")
        assertTrue(queue.pending.isEmpty())
    }

    // A relaunch is the other end of the same rule: the row is gone from the screen, so the window
    // is protecting a gesture nobody can still make — the boot read walks forced and sends it.
    @Test
    fun testARelaunchStillOwesTheSetAndAForcedWalkOffersIt() {
        logSet("set_1")

        val relaunched = SetQueue(file) { clockMs }
        assertEquals(listOf("set_1"), relaunched.pending.map { it.set.id })
        assertEquals("set_1", relaunched.nextOwed(skipping = emptySet(), readyAt = null)?.set?.id)
    }

    // A queue file written before the window existed has no heldUntilMs and no order key. It must
    // still open — a file that failed to decode opens EMPTY and takes a live session's sets down
    // with it.
    @Test
    fun testAQueueFileWrittenBeforeTheWindowExistedStillOpens() {
        val old = File(tmp.root, "gym-old-${System.nanoTime()}.json")
        old.writeText(
            """{"session":{"id":"ses_1","startedAt":1000},"entries":{"set_a":{"set":""" +
                """{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,""" +
                """"completedAt":1100},"sessionId":"ses_1","needsPush":true,"remints":0}}}""")

        val opened = SetQueue(old) { clockMs }
        assertEquals("ses_1", opened.session?.id)
        assertEquals(listOf("set_a"), opened.pending.map { it.set.id })
        assertFalse("no key, no hold", opened.pending.single().isHeld(at = 0))
        assertNotNull("and the ordinary walk offers it at once",
            opened.nextOwed(skipping = emptySet(), readyAt = clockMs))
        assertEquals(emptyList<String>(), opened.order)
    }
}
