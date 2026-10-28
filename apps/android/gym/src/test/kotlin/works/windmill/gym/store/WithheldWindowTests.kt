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
import works.windmill.gym.coach.AskThread
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeGymRest
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
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
            room.store.create("Unclaimed press", "machine", "exercise1")
            room.store.prepareEngineTransition()
            room.engine.signIn("u1", mapOf("gym" to true), mapOf("gym" to "discard"))
            room.selected = "u1"
            room.store.connect(room.account("u1"))
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull(room.store.holding)
            assertFalse(room.store.catalog.any { it.id == "exercise1" })
        }
    }

    @Test
    fun aRoutineLeavesTheProgramAtItsSettledDeleteWithNoUndo() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertNull(room.store.delete(Deletion.Routine(routine.id, routine.name)))
            assertEquals(emptyList<Routine>(), room.training.program())
            assertEquals(emptyList<Routine>(), room.store.routines)
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull(room.store.keepWithheld())
            assertNull(room.store.delete(Deletion.Routine(routine.id, routine.name)))
            assertEquals(1, room.outbox().count { entry -> entry.member("intent")["d"]?.arr()?.any {
                it["t"]?.str() == "routine" && it["life"]?.arr()?.first()?.str() == "dead"
            } == true })
        }
    }

    @Test
    fun testASessionWithheldIsOffTheLogAndItsSetsSurviveAnUndo() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.workout(82.5)
            runCurrent()

            room.store.withhold(Deletion.Session(session.id))

            assertEquals("the row is off the log", emptyList<String>(), room.store.recent.map { it.id })
            assertEquals("and the workout is still on the account", listOf(session.id),
                room.training.details().map { it.session.id })
            assertEquals("Session deleted.", Withheld.line(room.store.withheld))

            assertNotNull(room.store.keepWithheld())
            assertEquals(listOf(session.id), room.store.recent.map { it.id })
            assertEquals(listOf(82.5), room.training.session(session.id)!!.sets.map { it.weightKg })
        }
    }

    @Test
    fun aSettledSetDeleteSurvivesLeavingTheRoom() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.workout()
            val taken = room.training.session(session.id)!!.sets.single()
            assertNull(room.store.delete(Deletion.Set(session.id, taken)))
            assertFalse(room.store.abandonWithheld())
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull(room.store.keepWithheld())
            advanceTimeBy(Withheld.windowMs * 2)
            runCurrent()
            assertEquals(emptyList<TrainingSet>(), room.training.session(session.id)!!.sets)
            assertEquals(setOf(taken.id), room.store.deletedSets)
        }
    }

    @Test
    fun aSettledSetDeleteQueuesExactlyOneIntent() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.now += 60_000
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            val taken = room.training.session(session.id)!!.sets.first()

            assertNull(room.store.delete(Deletion.Set(session.id, taken)))
            advanceTimeBy(Withheld.windowMs + 1)
            runCurrent()

            assertEquals(listOf(taken.id), room.outbox().map { it.member("intent") }.filter { intent ->
                intent["d"]?.arr()?.any { it["t"]?.str() == "set" && it["life"]?.arr()?.first()?.str() == "dead" } == true
            }.map { it.member("d").arr().single().member("id").str() })
            assertEquals("the set is gone from the log", listOf(90.0),
                room.training.session(session.id)!!.sets.map { it.weightKg })
            assertEquals("and nothing is left holding it", emptyList<WithheldDelete>(), room.store.withheld)
        }
    }

    @Test
    fun aRoutineDeleteLeavesTheHeldWeightWindowRunning() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val held = room.store.withheld.single()
            assertNull(room.store.delete(Deletion.Routine(routine.id, routine.name)))
            assertNull(room.training.routine(routine.id))
            assertEquals(listOf(held), room.store.withheld)
            room.now = held.untilMs
            room.engine.releaseHeld()
            room.store.refreshEngine()
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertEquals(emptyList<Any>(), room.training.weighins())
        }
    }

    @Test
    fun testASettledNoteDeleteTakesTheRowAndTheCapWithIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            repeat(10) { assertTrue(room.store.saveNote("note000$it", NoteWrite("note $it", "")) is GymResult.Ok) }
            room.store.readNotes()
            assertEquals(10, room.store.noteCount)

            assertNull(room.store.delete(Deletion.Note("note0003")))
            assertEquals("off the drawn list at once", 9, room.store.notes.size)
            assertEquals("the committed delete releases the note slot", 9, room.store.noteCount)

            advanceTimeBy(Withheld.windowMs + 1)
            runCurrent()
            assertEquals("the row stays gone", 9, room.store.notes.size)
            assertEquals("and the count is nine, so `Add a note` is offered again", 9, room.store.noteCount)
            assertEquals(9, room.training.notes().size)
        }
    }
    @Test fun weightUndoNamesOneOfferAndCountsSeveralWithoutExposingDates() {
        val first = WithheldDelete(Deletion.Bodyweight("2026-09-01"), 10_000)
        val second = WithheldDelete(Deletion.Bodyweight("2026-09-02"), 10_000)
        assertEquals("Weigh-in deleted.", Withheld.line(listOf(first)))
        assertEquals("2 deleted.", Withheld.line(listOf(first, second)))
        assertNull(Withheld.line(emptyList()))
        assertNull(Withheld.line(listOf(first.copy(sent = true))))
        assertEquals("The Undo window closed.", Withheld.alreadyGone)
        assertEquals("Undo", Withheld.undo)
    }

    @Test fun twoWeightHoldsRestoreNewestFirstWithoutReleasingEitherReceipt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            assertNull(room.store.weighIn("2026-09-02", 82.0))
            room.sync(EngineRoomFixture.server())
            val original = room.store.bodyweight
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            room.store.withhold(Deletion.Bodyweight("2026-09-02"))
            runCurrent()
            assertEquals(setOf("2026-09-01", "2026-09-02"), room.store.withheldIds)
            assertEquals("2 deleted.", Withheld.line(room.store.withheld))
            assertEquals(Deletion.Bodyweight("2026-09-02"), room.store.keepWithheld()?.deletion)
            assertEquals("Weigh-in deleted.", Withheld.line(room.store.withheld))
            assertEquals(Deletion.Bodyweight("2026-09-01"), room.store.keepWithheld()?.deletion)
            assertEquals(original, room.store.bodyweight)
            assertEquals(emptyList<Any>(), room.outbox())
        }
    }

}
