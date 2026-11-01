package works.windmill.gym.store

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.ThreadContextElement
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.*
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.*
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.schema.Gym

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class RoutinePlanRaceTests {
    @get:Rule val tmp = TemporaryFolder()
    private class Recorder : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
    }

    @Test fun ownerSwitchOrAnonymousAdoptionBeforeTheLockedLoadRefusesWithoutWriting() = runTest {
        for (anonymous in listOf(false, true)) {
            lateinit var room: EngineRoomFixture
            var armed = false
            var switched: Json? = null
            var hookFailure: Throwable? = null
            val hook = object : ThreadContextElement<Unit> {
                override val key = object : CoroutineContext.Key<ThreadContextElement<Unit>> {}
                override fun updateThreadContext(context: CoroutineContext) {
                    if (!armed || context[GymActionContext] == null) return
                    armed = false
                    runCatching {
                        val replica = room.engine.activeReplica()
                        if (!anonymous) assertTrue(room.engine.signOut("keep").member("complete").bool())
                        assertTrue(room.engine.signIn("second", mapOf("gym" to false)).member("complete").bool())
                        if (anonymous) assertEquals(replica, room.engine.activeReplica())
                        room.selected = "second"
                        switched = room.engine.snapshot()
                    }.onFailure { hookFailure = it }
                }
                override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {}
            }
            val telemetry = Recorder()
            EngineRoomFixture(tmp.newFolder(), CoroutineScope(backgroundScope.coroutineContext + hook), telemetry = telemetry).use {
                room = it
                room.select(if (anonymous) null else "first")
                if (anonymous) room.workout(finish = false)
                val draft = RoutineDraft(name = "Only first", creationId = "routine_first").adding("bench-press")
                telemetry.events.clear()
                armed = true
                assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), room.store.routines.saveRoutine(draft))
                assertNull(hookFailure?.stackTraceToString(), hookFailure)
                assertNotNull(switched)
                assertEquals(switched, room.engine.snapshot())
                assertEquals(emptyList<Routine>(), room.store.routines.all)
                assertEquals(emptyList<Routine>(), room.training.program())
                assertEquals(listOf("gym_action" to mapOf("screen" to "routine_editor", "action" to "save", "outcome" to "refused")), telemetry.events)
                assertEquals(emptyList<String>(), telemetry.failures)
            }
        }
    }

    @Test fun anOwnerSwitchAfterCommitKeepsTheAcceptedResultAndDoesNotPublishAcrossOwners() = runTest {
        lateinit var room: EngineRoomFixture
        var armed = false
        var accepted: Routine? = null
        var switched: Json? = null
        var hookFailure: Throwable? = null
        val hook = object : ThreadContextElement<Unit> {
            override val key = object : CoroutineContext.Key<ThreadContextElement<Unit>> {}
            override fun updateThreadContext(context: CoroutineContext) {}
            override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {
                if (!armed || context[GymActionContext] == null) return
                armed = false
                runCatching {
                    accepted = room.training.program().single()
                    assertTrue(room.engine.signOut("keep").member("complete").bool())
                    assertTrue(room.engine.signIn("second", mapOf("gym" to false)).member("complete").bool())
                    room.selected = "second"
                    switched = room.engine.snapshot()
                }.onFailure { hookFailure = it }
            }
        }
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), CoroutineScope(backgroundScope.coroutineContext + hook), telemetry = telemetry).use {
            room = it; room.select("first")
            val movement = room.store.routines.catalog.single { it.id == "bench-press" }
            val draft = RoutineDraft(name = "Exact saved", creationId = "routine_exact",
                entries = listOf(RoutineEntry(1, movement.id, listOf(SetTarget(8, 12.505)))),
                movements = listOf(RoutineMovement(movement, movement)))
            val expected = Routine("routine_exact", "Exact saved", entries = listOf(RoutineEntry(1, "bench-press", listOf(SetTarget(8, 12.51)))))
            val beforeCatalog = room.store.routines.catalog
            telemetry.events.clear(); armed = true
            assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(draft))
            assertNull(hookFailure?.stackTraceToString(), hookFailure)
            assertEquals(expected, accepted)
            assertNotNull(switched)
            assertEquals(switched, room.engine.snapshot())
            assertEquals(emptyList<Routine>(), room.training.program())
            assertEquals(emptyList<Routine>(), room.store.routines.all)
            assertEquals(beforeCatalog, room.store.routines.catalog)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "routine_editor", "action" to "save", "outcome" to "ok"),
                "gym_routine_saved" to mapOf("action" to "create"),
            ), telemetry.events)
            assertEquals(emptyList<String>(), telemetry.failures)
            room.store.connect(room.account())
            assertEquals(emptyList<Routine>(), room.store.routines.all)
        }
    }

    @Test fun callerCancellationAfterCommitCannotCancelPublicationOrItsOneOutcome() = runTest {
        val callerJob = Job()
        var armed = false
        var cancelledAtBoundary = false
        val hook = object : ThreadContextElement<Unit> {
            override val key = object : CoroutineContext.Key<ThreadContextElement<Unit>> {}
            override fun updateThreadContext(context: CoroutineContext) {}
            override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {
                if (!armed || context[GymActionContext] == null) return
                armed = false
                callerJob.cancel()
                cancelledAtBoundary = true
            }
        }
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), CoroutineScope(backgroundScope.coroutineContext + hook), telemetry = telemetry).use { room ->
            room.select("a")
            val draft = RoutineDraft(name = "Accepted", creationId = "routine_cancelled").adding("bench-press")
            val expected = Routine("routine_cancelled", "Accepted", entries = listOf(RoutineEntry(1, "bench-press")))
            telemetry.events.clear(); armed = true
            val caller = async(callerJob, start = CoroutineStart.UNDISPATCHED) { room.store.routines.saveRoutine(draft) }
            runCurrent()
            assertTrue(cancelledAtBoundary)
            assertTrue(caller.isCancelled)
            assertEquals(listOf(expected), room.training.program())
            assertEquals(listOf(expected), room.store.routines.all)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "routine_editor", "action" to "save", "outcome" to "ok"),
                "gym_routine_saved" to mapOf("action" to "create"),
            ), telemetry.events)
            assertEquals(emptyList<String>(), telemetry.failures)
            val restored = room.freshStore(); restored.connect(room.account())
            assertEquals(listOf(expected), restored.routines.all)
        }
    }

    @Test fun restoredTargetEditWithoutOpeningMetadataRefusesChangedEquipmentWithNoWrite() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val opened = room.training.createRoutine(RoutineWrite("routine_legacy", "Legacy", 0,
                listOf(RoutineEntryWrite("bench-press", listOf(SetTarget(8, 75.0))))))
            val draft = RoutineDraft.of(opened).targeting("bench-press", listOf(SetTarget(5, 80.0)))
            val restored = WindmillJson.decodeFromString(RoutineDraft.serializer(), WindmillJson.encodeToString(RoutineDraft.serializer(), draft))
            assertEquals(emptyList<RoutineMovement>(), restored.movements)
            val base = room.training.catalogue().single { it.id == "bench-press" }
            room.training.editExercise(base.id, base.name, "dumbbell", 2, base)
            val before = room.engine.snapshot()
            assertEquals(GymResult.Failed(WriteFailure.Refused("Reopen this routine to review its movement targets before saving.")),
                room.store.routines.saveRoutine(restored))
            assertEquals(before, room.engine.snapshot())
            assertEquals(listOf(opened), room.training.program())
            assertEquals(listOf(RoutineEntry(1, "bench-press", listOf(SetTarget(5, 80.0)))), restored.entries)
        }
    }

    @Test fun identicalReplayCannotClaimAHiddenOrDeletedRoutineAsSaved() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val draft = RoutineDraft(name = "Only once", creationId = "routine_hidden").adding("bench-press")
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Ok)
            room.training.deleteRoutine("routine_hidden")
            val hidden = room.engine.snapshot()
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Failed)
            assertEquals(hidden, room.engine.snapshot())
            assertEquals(emptyList<Routine>(), room.training.program())
            room.engine.releaseHeld(true)
            val deleted = room.engine.snapshot()
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Failed)
            assertEquals(deleted, room.engine.snapshot())
            assertEquals(emptyList<Routine>(), room.training.program())
        }
    }

    @Test fun identicalReplayCannotClaimAnInvisibleMovementAsSaved() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val movement = Exercise("ex_deleted", "Gone movement", equipment = "other", custom = true)
            val draft = RoutineDraft(name = "Only once", creationId = "routine_movement")
                .staging(RoutineMovement(null, movement), TargetEntry.Reading.Open)
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Ok)
            val outcome = room.engine.commit(ScopeRef(Gym.scope), Gesture(listOf(Change.delete(Gym.Types.exercise, RecordID(movement.id)))))
            assertTrue(outcome is works.windmill.sync.api.CommitOutcome.Committed)
            val deleted = room.engine.snapshot()
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Failed)
            assertEquals(deleted, room.engine.snapshot())
            assertEquals(emptyList<Exercise>(), room.training.catalogue().filter { it.id == movement.id })
        }
    }
}
