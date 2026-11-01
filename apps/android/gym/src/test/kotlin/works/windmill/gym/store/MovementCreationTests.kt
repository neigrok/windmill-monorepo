package works.windmill.gym.store

import java.io.IOException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.*
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.signIn
import works.windmill.sync.schema.SyncSchema

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MovementCreationTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun explicitLoadCountReachesTheExistingDomainCreationAction() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            for ((equipment, count) in listOf("barbell" to 1, "dumbbell" to 2, "other" to 1, "dumbbell" to 1)) {
                val id = "ex_${equipment}_$count"
                val expected = Exercise(id, "Movement $id", Exercise.unclassified, equipment,
                    works.windmill.gym.domain.sync.ExerciseRules.defaultStepKg(equipment), custom = true, loadCount = count)
                val write = ExerciseWrite(id, expected.name, Exercise.unclassified, equipment, loadCount = count)
                assertEquals(expected, room.training.createExercise(write))
                assertEquals(expected, room.training.createExercise(write))
                assertEquals(listOf(expected), room.training.catalogue().filter { it.id == id })
            }
        }
    }

    @Test fun decomposedNamesReturnTheCanonicalMovementAndRetryTheSameCreation() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val write = ExerciseWrite("ex_nfc", "Cafe\u0301 carry", Exercise.unclassified, "other", loadCount = 1)
            val expected = Exercise(write.id, "Café carry", Exercise.unclassified, "other", 2.5, custom = true)
            assertEquals(expected, room.training.createExercise(write))
            assertEquals(listOf(expected), room.training.catalogue().filter { it.id == write.id })
            val saved = room.engine.snapshot()
            assertEquals(expected, room.training.createExercise(write))
            assertEquals(saved, room.engine.snapshot())
            assertEquals(GymResult.Ok(expected), room.store.routines.create(write.name, write.equipment, write.id, write.loadCount))
            assertEquals(saved, room.engine.snapshot())
            val live = room.startExternalWorkout()
            assertEquals(MovementCreateOutcome.Added(expected), room.store.workout.createForWorkout(write, live.id))
            assertEquals(listOf(expected.id), room.store.workout.order)
            assertEquals(expected, room.store.routines.catalog.single { it.id == expected.id })
        }
    }

    @Test fun liveCreationAddsOnceAndKeepsTheWorkoutSetsRoutineAndRackDrafts() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val routine = RoutineDraft(name = "Pull", creationId = "routine_pull").adding("bench-press", listOf(SetTarget(8, 70.0)))
            assertTrue(room.store.routines.saveRoutine(routine.capturingMovements(room.store.routines.catalog)) is GymResult.Ok)
            val live = (room.store.workout.start("routine_pull") as GymResult.Ok).value
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(70.0, 8)
            room.store.workout.editRack(72.5, 9)
            val sets = room.store.workout.sets
            val program = room.training.program()
            val write = ExerciseWrite("ex_pair", "Shrug", Exercise.unclassified, "dumbbell", loadCount = 2)
            val first = room.store.workout.createForWorkout(write, live.id) as MovementCreateOutcome.Added
            assertEquals(first, room.store.workout.createForWorkout(write, live.id))
            assertEquals(live.id, room.store.workout.session?.id)
            assertEquals(sets, room.store.workout.sets)
            assertEquals(program, room.training.program())
            assertEquals(listOf("bench-press", "ex_pair"), room.store.workout.order)
            assertEquals("ex_pair", room.store.workout.exerciseId)
            assertEquals(listOf(first.movement), room.training.catalogue().filter { it.id == write.id })
            room.store.workout.choose("bench-press")
            assertEquals(72.5, room.store.workout.rack!!.weightKg, 0.0)
            assertEquals(9, room.store.workout.rack!!.reps)
        }
    }

    @Test fun aCreationStorageFailureKeepsTheIdentityForAnExactRetry() = runTest {
        val failures = mutableListOf<String>()
        val events = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { if (name == "gym_action") events += properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val live = room.startExternalWorkout()
            val write = ExerciseWrite("ex_once", "Assisted", Exercise.unclassified, "other", loadCount = 1)
            val before = room.engine.snapshot()
            val controls = room.controlsFile.readBytes()
            events.clear(); failures.clear()
            room.engine.failNextCommit()
            assertEquals(MovementCreateOutcome.Failed(WriteFailure.NoAnswer), room.store.workout.createForWorkout(write, live.id))
            assertEquals(before, room.engine.snapshot())
            assertArrayEquals(controls, room.controlsFile.readBytes())
            assertEquals(listOf("gym.create"), failures)
            assertEquals(listOf(mapOf("screen" to "movement_form", "action" to "create", "outcome" to "failed")), events)
            val accepted = room.store.workout.createForWorkout(write, live.id) as MovementCreateOutcome.Added
            assertEquals(listOf(accepted.movement), room.training.catalogue().filter { it.id == write.id })
            assertEquals(listOf(write.id), room.store.workout.order)
        }
    }

    @Test fun aKnownCreationSurvivesInsertionFailureAndRestartRetriesOnlyInsertion() = runTest {
        var failInsertion = false
        val failures = mutableListOf<String>()
        val events = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { if (name == "gym_action") events += properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry, controlsWrite = { file, value ->
            if (failInsertion) { failInsertion = false; throw IOException("PRIVATE_STORAGE_DETAIL") }
            AtomicDocument.write(file, value)
        }).use { room ->
            room.select("a")
            val live = room.startExternalWorkout()
            room.store.workout.choose("bench-press"); room.store.workout.logSet(60.0, 8)
            val sets = room.store.workout.sets
            val write = ExerciseWrite("ex_once", "Shrug", Exercise.unclassified, "dumbbell", loadCount = 2)
            val controls = room.controlsFile.readBytes()
            events.clear(); failures.clear(); failInsertion = true
            val failed = room.store.workout.createForWorkout(write, live.id) as MovementCreateOutcome.Failed
            val created = requireNotNull(failed.created)
            assertEquals(WriteFailure.NoAnswer, failed.why)
            assertEquals(listOf(created), room.training.catalogue().filter { it.id == write.id })
            assertArrayEquals(controls, room.controlsFile.readBytes())
            val owed = room.outbox()
            assertEquals(listOf("gym.choose"), failures)
            val restarted = room.freshStore()
            restarted.connect(room.account())
            assertEquals(MovementCreateOutcome.Added(created), restarted.workout.createForWorkout(write, live.id))
            assertEquals(owed, room.outbox())
            assertEquals(sets, restarted.workout.sets)
            assertEquals(listOf("bench-press", write.id), restarted.workout.order)
            assertEquals(write.id, restarted.workout.exerciseId)
            assertEquals(listOf(
                mapOf("screen" to "movement_form", "action" to "create", "outcome" to "ok"),
                mapOf("screen" to "movement_form", "action" to "add", "outcome" to "failed"),
                mapOf("screen" to "movement_form", "action" to "add", "outcome" to "ok")), events)
        }
    }

    @Test fun aCancelledCallerDoesNotCancelTheApplicationOwnedCreationAndInsertion() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope,
            readDispatcher = StandardTestDispatcher(testScheduler)).use { room ->
            room.select(null)
            val live = room.startExternalWorkout()
            val write = ExerciseWrite("ex_kept", "Kept", Exercise.unclassified, "other", loadCount = 1)
            val caller = launch(start = CoroutineStart.UNDISPATCHED) { room.store.workout.createForWorkout(write, live.id) }
            caller.cancel()
            advanceUntilIdle()
            val accepted = room.store.workout.createForWorkout(write, live.id) as MovementCreateOutcome.Added
            assertEquals(listOf(accepted.movement), room.training.catalogue().filter { it.id == write.id })
            assertEquals(listOf(write.id), room.store.workout.order)
            assertEquals(write.id, room.store.workout.exerciseId)
        }
    }

    @Test fun aStaleWorkoutOrReplicaCannotCreateOrAppendAnything() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val first = room.startExternalWorkout()
            val oldAccount = room.store.seat.accountKey
            val oldReplica = room.store.seat.replica
            assertTrue(room.store.workout.finish() is FinishOutcome.Closed)
            val next = room.startExternalWorkout()
            val write = ExerciseWrite("ex_stale", "Stale", Exercise.unclassified, "other", loadCount = 1)
            val before = room.engine.snapshot()
            val controls = room.controlsFile.readBytes()
            assertTrue(room.store.workout.createForWorkout(write, first.id, oldAccount, oldReplica) is MovementCreateOutcome.Failed)
            assertEquals(before, room.engine.snapshot())
            assertArrayEquals(controls, room.controlsFile.readBytes())
            assertEquals(next.id, room.store.workout.session?.id)
            assertEquals(emptyList<String>(), room.store.workout.order)
            assertTrue(room.engine.signIn("a", mapOf("gym" to false), serverSchema = SyncSchema.registry.version).member("complete").bool())
            val adopted = room.engine.snapshot()
            try {
                room.training.createExercise(write, requireNotNull(oldReplica), expectedAnonymous = true)
                fail("An anonymous opening cannot create after account adoption.")
            } catch (refusal: TrainingRefused) { assertEquals("account-changed", refusal.code) }
            assertEquals(adopted, room.engine.snapshot())
        }
    }
}
