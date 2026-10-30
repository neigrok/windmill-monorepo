package works.windmill.gym.store

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Instant
import works.windmill.domain.kit.Outcome
import works.windmill.gym.domain.*
import works.windmill.gym.domain.sync.ImportSession
import works.windmill.gym.domain.sync.ImportedSet
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.Routine as EngineRoutine
import works.windmill.gym.domain.sync.Session as EngineSession
import works.windmill.gym.domain.sync.TrainingSet as EngineSet
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.signIn
import works.windmill.sync.schema.SyncSchema

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class RoutineHistoryTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun routineFilteringPrecedesTheTwentyFinishedWorkoutLimitAndReadsDoNotWrite() = runTest {
        val events = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val draft = RoutineDraft(name = "Pull", creationId = "routine_history").adding("bench-press")
                .capturingMovements(room.store.catalog)
            assertTrue(room.store.saveRoutine(draft) is GymResult.Ok)
            val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0),
                object : ActionContext { override var insideRun = false })
            val plan = PlanSnapshot("Pull", listOf(PlanEntry("bench-press")))
            val details = mutableListOf<SessionDetail>()
            for (i in 0..50) {
                val id = "history_${i.toString().padStart(2, '0')}"
                val start = room.now + 1_000
                room.now = start + 100
                val routineId = "routine_history".takeIf { i < 21 }
                val sets = (0..1).map { j -> TrainingSet("${id}_$j",
                    if (j == 0) "bench-press" else "barbell-row", weightKg = 40.0, reps = 8, completedAtMs = start + 10 + j) }
                val action = ImportSession(Id(id, EngineSession), Instant(start), Instant(room.now),
                    sets.map { set -> ImportedSet(Id(set.id, EngineSet), Id(set.exerciseId, EngineExercise),
                        set.weightKg, set.reps, Instant(set.completedAtMs)) }, routineId?.let { Id(it, EngineRoutine) })
                assertTrue(runner.run(action) is Outcome.Committed)
                details += SessionDetail(Session(id, start, room.now, routineId, plan.takeIf { routineId != null }), sets)
            }
            room.now += 1_000
            room.training.startSession(SessionStart("history_open", room.now, routineId = "routine_history"))
            assertEquals(listOf(SessionDetail(Session("history_open", room.now, routineId = "routine_history", plan = plan))) +
                details.reversed(), room.training.details())
            val expected = details.take(21).drop(1).reversed().map { SessionSummary(it.session, it.sets, room.store.catalog) }
            val snapshot = room.engine.snapshot()
            val controls = room.controlsFile.readBytes()
            events.clear()
            assertEquals(expected, room.training.routineHistory("routine_history"))
            assertEquals(GymResult.Ok(expected), room.store.routineHistory("routine_history"))
            assertEquals(List(20) { 2 }, expected.map { it.setCount })
            assertEquals(List(20) { listOf("bench-press", "barbell-row") }, expected.map { it.exercises })
            assertEquals(expected.drop(1) + SessionSummary(details.first().session, details.first().sets, room.store.catalog),
                room.training.routineHistory("routine_history", setOf("history_20")))
            assertEquals(emptyList<SessionSummary>(), room.training.routineHistory("another_routine"))
            assertEquals(snapshot, room.engine.snapshot())
            assertArrayEquals(controls, room.controlsFile.readBytes())
            assertEquals(emptyList<String>(), events)
        }
    }

    @Test fun aQueuedHistoryReadCannotCrossAnAccountAdoption() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope,
            readDispatcher = StandardTestDispatcher(testScheduler)).use { room ->
            room.select(null)
            val pending = async(start = CoroutineStart.UNDISPATCHED) { room.store.routineHistory("routine_history") }
            assertFalse(pending.isCompleted)
            assertTrue(room.engine.signIn("a", mapOf("gym" to false), serverSchema = SyncSchema.registry.version).member("complete").bool())
            runCurrent()
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), pending.await())
        }
    }
}
