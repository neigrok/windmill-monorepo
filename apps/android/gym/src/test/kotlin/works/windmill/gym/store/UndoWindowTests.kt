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

    @Test
    fun testASetJustLoggedIsOnTheDeviceAndNotYetOnTheLog() {
        logSet("set_1")

        assertEquals(listOf(82.5), queue.sets.map { it.weightKg })
        assertNull("nothing goes out while it can still be taken back",
            queue.nextOwed(skipping = emptySet(), readyAt = clockMs))
        assertEquals(82.5, queue.withdrawable()?.set?.weightKg)
        assertEquals("and it is on disk, not in memory", 1, SetQueue(file).pending.size)
    }

    @Test
    fun testASetInsideItsWindowIsNotOfferedToTheWalk() {
        logSet("set_1")

        assertNull(queue.nextOwed(skipping = emptySet(), readyAt = clockMs))
        assertEquals("held on purpose is not stranded",
            emptyList<SetQueue.Entry>(), queue.pending.filter { !it.isHeld(clockMs) })
    }

    @Test
    fun testUndoTakesTheSetBackAndTheLogNeverHearsOfIt() {
        logSet("set_1")
        assertTrue(queue.withdraw("set_1"))
        queue.flush()

        assertEquals(emptyList<TrainingSet>(), queue.sets)
        assertEquals("and the disk agrees", 0, SetQueue(file).pending.size)
        assertNull(queue.withdrawable())
    }

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

    @Test
    fun testWhenTheWindowClosesTheSetIsOfferedByItself() {
        logSet("set_1")
        clockMs += SetQueue.undoWindowMs + 1

        assertEquals("set_1", queue.nextOwed(skipping = emptySet(), readyAt = clockMs)?.set?.id)
        assertNull("and there is nothing left to take back", queue.withdrawable())
    }

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

    @Test
    fun testARelaunchStillOwesTheSetAndAForcedWalkOffersIt() {
        logSet("set_1")

        val relaunched = SetQueue(file) { clockMs }
        assertEquals(listOf("set_1"), relaunched.pending.map { it.set.id })
        assertEquals("set_1", relaunched.nextOwed(skipping = emptySet(), readyAt = null)?.set?.id)
    }

    @Test
    fun testAQueueFileWrittenBeforeTheWindowExistedStillOpens() {
        val old = File(tmp.root, "gym-old-${System.nanoTime()}.json")
        old.writeText(
            """{"session":{"id":"ses_1","startedAt":1000},"entries":{"set_a":{"set":""" +
                """{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,""" +
                """"completedAt":1100},"sessionId":"ses_1","needsPush":true,"remints":0}}}""")

        val opened = SetQueue(old, "u1") { clockMs }
        assertEquals("ses_1", opened.session?.id)
        assertEquals(listOf("set_a"), opened.pending.map { it.set.id })
        assertFalse("no key, no hold", opened.pending.single().isHeld(at = 0))
        assertNotNull("and the ordinary walk offers it at once",
            opened.nextOwed(skipping = emptySet(), readyAt = clockMs))
        assertEquals(emptyList<String>(), opened.order)
    }
}
