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
import works.windmill.gym.presentation.*
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
                .capturingMovements(room.store.routines.catalog)
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Ok)
            val details = mutableListOf<SessionDetail>()
            for (i in 0..50) {
                val id = "history_${i.toString().padStart(2, '0')}"
                val start = room.now + 1_000
                room.now = start + 100
                room.training.startSession(SessionStart(id, start, routineId = "routine_history".takeIf { i < 21 }))
                for (j in 0..1) room.training.appendSet(id, SetWrite("${id}_$j",
                    if (j == 0) "bench-press" else "barbell-row", 40.0, 8, start + 10 + j))
                room.training.finishSession(id, room.now)
                details += requireNotNull(room.training.session(id))
            }
            room.now += 1_000
            room.training.startSession(SessionStart("history_open", room.now, routineId = "routine_history"))
            val expected = details.take(21).drop(1).reversed().map { SessionSummary(it.session, it.sets, room.store.routines.catalog) }
            val snapshot = room.engine.snapshot()
            val controls = room.controlsFile.readBytes()
            events.clear()
            assertEquals(expected, room.training.routineHistory("routine_history"))
            assertEquals(GymResult.Ok(expected), room.store.history.routineHistory("routine_history"))
            assertEquals(List(20) { 2 }, expected.map { it.setCount })
            assertEquals(List(20) { listOf("bench-press", "barbell-row") }, expected.map { it.exercises })
            assertEquals(expected.drop(1) + SessionSummary(details.first().session, details.first().sets, room.store.routines.catalog),
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
            val pending = async(start = CoroutineStart.UNDISPATCHED) { room.store.history.routineHistory("routine_history") }
            assertFalse(pending.isCompleted)
            assertTrue(room.engine.signIn("a", mapOf("gym" to false), serverSchema = SyncSchema.registry.version).member("complete").bool())
            runCurrent()
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), pending.await())
        }
    }
}
