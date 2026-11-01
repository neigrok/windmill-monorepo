package works.windmill.gym.store

import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.presentation.WeighIn
import works.windmill.sync.engine.signIn

class WithheldWindowTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun loggedSet(id: String = "set_1", weightKg: Double = 81.5, reps: Int = 5) =
        TrainingSet(id = id, exerciseId = "bench-press", weightKg = weightKg, reps = reps,
                    completedAtMs = 1_000)

    @Test
    fun anonymousDiscardIsAnAccountDecisionWithNoDeleteWindow() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.store.routines.create("Unclaimed press", "machine", "exercise1")
            room.store.prepareEngineTransition()
            room.engine.signIn("u1", mapOf("gym" to true), mapOf("gym" to "discard"))
            room.selected = "u1"
            room.store.connect(room.account("u1"))
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.holding)
            assertFalse(room.store.routines.catalog.any { it.id == "exercise1" })
        }
    }

    @Test
    fun aRoutineLeavesTheProgramAtItsSettledDeleteWithNoUndo() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertNull(room.store.deletions.delete(Deletion.Routine(routine.id, routine.name)))
            assertEquals(emptyList<Routine>(), room.training.program())
            assertEquals(emptyList<Routine>(), room.store.routines.all)
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.keepWithheld())
            assertNull(room.store.deletions.delete(Deletion.Routine(routine.id, routine.name)))
            assertEquals(1, room.outbox().count { entry -> entry.member("intent")["d"]?.arr()?.any {
                it["t"]?.str() == "routine" && it["life"]?.arr()?.first()?.str() == "dead"
            } == true })
        }
    }

    @Test
    fun aSettledSetDeleteSurvivesLeavingTheRoom() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.workout()
            val taken = room.training.session(session.id)!!.sets.single()
            assertNull(room.store.deletions.delete(Deletion.Set(session.id, taken)))
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.keepWithheld())
            advanceTimeBy(Withheld.windowMs * 2)
            runCurrent()
            assertEquals(emptyList<TrainingSet>(), room.training.session(session.id)!!.sets)
            assertEquals(setOf(taken.id), room.store.held.deletedSets)
        }
    }

    @Test
    fun aSettledSetDeleteQueuesExactlyOneIntent() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.store.workout.logSet(weightKg = 90.0, reps = 3)
            room.now += 60_000
            assertTrue(room.store.workout.finish() is FinishOutcome.Closed)
            val taken = room.training.session(session.id)!!.sets.first()

            assertNull(room.store.deletions.delete(Deletion.Set(session.id, taken)))
            advanceTimeBy(Withheld.windowMs + 1)
            runCurrent()

            assertEquals(listOf(taken.id), room.outbox().map { it.member("intent") }.filter { intent ->
                intent["d"]?.arr()?.any { it["t"]?.str() == "set" && it["life"]?.arr()?.first()?.str() == "dead" } == true
            }.map { it.member("d").arr().single().member("id").str() })
            assertEquals("the set is gone from the log", listOf(90.0),
                room.training.session(session.id)!!.sets.map { it.weightKg })
            assertEquals("and nothing is left holding it", emptyList<WithheldDelete>(), room.store.held.withheld)
        }
    }

    @Test
    fun aRoutineDeleteLeavesTheHeldWeightWindowRunning() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val held = room.store.held.withheld.single()
            assertNull(room.store.deletions.delete(Deletion.Routine(routine.id, routine.name)))
            assertNull(room.training.routine(routine.id))
            assertEquals(listOf(held), room.store.held.withheld)
            room.now = held.untilMs
            room.engine.releaseHeld()
            room.store.refreshEngine()
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertEquals(emptyList<Any>(), room.training.weighins())
        }
    }

    @Test
    fun testASettledNoteDeleteTakesTheRowAndTheCapWithIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            repeat(10) { assertTrue(room.store.notes.saveNote("note000$it", NoteWrite("note $it", "")) is GymResult.Ok) }
            room.store.notes.readNotes()
            assertEquals(10, room.store.notes.noteCount)

            assertNull(room.store.deletions.delete(Deletion.Note("note0003")))
            assertEquals("off the drawn list at once", 9, room.store.notes.all.size)
            assertEquals("the committed delete releases the note slot", 9, room.store.notes.noteCount)

            advanceTimeBy(Withheld.windowMs + 1)
            runCurrent()
            assertEquals("the row stays gone", 9, room.store.notes.all.size)
            assertEquals("and the count is nine, so `Add a note` is offered again", 9, room.store.notes.noteCount)
            assertEquals(9, room.training.notes().size)
        }
    }
    @Test fun weightUndoNamesOneOfferAndCountsSeveralWithoutExposingDates() {
        fun held(day: String) = WithheldDelete(Deletion.Bodyweight(day), 10_000,
            HeldWeightReceipt("replica", anonymous = false, gestureId = "gesture-$day", localIds = emptyList(), weighIn = WeighIn(day, 80.0)))
        val first = held("2026-09-01")
        val second = held("2026-09-02")
        assertEquals("Weigh-in deleted.", Withheld.line(listOf(first)))
        assertEquals("2 deleted.", Withheld.line(listOf(first, second)))
        assertNull(Withheld.line(emptyList()))
        assertEquals("The Undo window closed.", Withheld.alreadyGone)
        assertEquals("Undo", Withheld.undo)
    }

    @Test fun twoWeightHoldsRestoreNewestFirstWithoutReleasingEitherReceipt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            assertNull(room.store.bodyweight.weighIn("2026-09-02", 82.0))
            room.sync(EngineRoomFixture.server())
            val original = room.store.bodyweight.drawn
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-02"))
            runCurrent()
            assertEquals(setOf("2026-09-01", "2026-09-02"), room.store.held.withheldIds)
            assertEquals("2 deleted.", Withheld.line(room.store.held.withheld))
            assertEquals(Deletion.Bodyweight("2026-09-02"), room.store.deletions.keepWithheld()?.deletion)
            assertEquals("Weigh-in deleted.", Withheld.line(room.store.held.withheld))
            assertEquals(Deletion.Bodyweight("2026-09-01"), room.store.deletions.keepWithheld()?.deletion)
            assertEquals(original, room.store.bodyweight.drawn)
            assertEquals(emptyList<Any>(), room.outbox())
        }
    }

}
