package works.windmill.gym.store

import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ThreadContextElement
import works.windmill.sync.core.Json
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.gym.domain.TrainingSet
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.SetFix
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class FixSetOutcomeTests {
    @get:Rule val temporary = TemporaryFolder()

    private class Recorder : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Throwable>>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            failures += operation to error
        }
    }

    @Test fun aLiveFixAndAMissingSetEachReportOneContentFreeResult() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(temporary.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val session = room.workout(finish = false)
            val set = room.store.sets.single()
            val fix = SetFix(weightKg = -12.5, reps = 8, note = "private note", rpe = 8.5, rpeNamed = true)
            telemetry.events.clear()
            assertEquals(FixOutcome.Corrected(fix.corrected(set)), room.store.fixSet(session.id, set.id, fix, FixOrigin.Workout))
            assertEquals(listOf(fix.corrected(set)), room.store.sets)
            assertEquals(listOf(fix.corrected(set)), room.training.session(session.id)!!.sets)
            val snapshot = room.engine.snapshot()
            assertEquals(FixOutcome.Gone("that set is no longer on this device"),
                room.store.fixSet(session.id, "missing", fix, FixOrigin.Workout))
            assertEquals(snapshot, room.engine.snapshot())
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "ok"),
                "gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "refused"),
            ), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun closingTheCallerAfterTheWriteDoesNotCancelTheResultOrItsReadback() = runTest {
        var hold = false
        val waiting = ArrayDeque<Runnable>()
        val reads = object : CoroutineDispatcher() {
            override fun isDispatchNeeded(context: CoroutineContext) = hold
            override fun dispatch(context: CoroutineContext, block: Runnable) { waiting.add(block) }
        }
        val telemetry = Recorder()
        EngineRoomFixture(temporary.newFolder(), backgroundScope, telemetry = telemetry, readDispatcher = reads).use { room ->
            room.select(null)
            val session = room.workout()
            runCurrent()
            val set = room.training.session(session.id)!!.sets.single()
            telemetry.events.clear()
            hold = true
            val caller = async(start = CoroutineStart.UNDISPATCHED) {
                room.store.fixSet(session.id, set.id, SetFix(weightKg = 90.0), FixOrigin.Session)
            }
            assertFalse(caller.isCompleted)
            assertEquals(1, waiting.size)
            assertEquals(listOf(set.copy(weightKg = 90.0)), room.training.session(session.id)!!.sets)
            caller.cancel()
            hold = false
            while (waiting.isNotEmpty()) waiting.removeFirst().run()
            runCurrent()
            assertEquals(listOf(450.0), room.store.logged.map { it.tonnageKg })
            val restored = room.freshStore()
            restored.connect(room.account())
            assertEquals(listOf(set.copy(weightKg = 90.0)), (restored.sessionDetail(session.id) as GymResult.Ok).value.sets)
            assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "fix", "outcome" to "ok")), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun aLateFixReadCannotPublishIntoAnotherAccount() = runTest {
        var hold = false
        val waiting = ArrayDeque<Runnable>()
        val reads = object : CoroutineDispatcher() {
            override fun isDispatchNeeded(context: CoroutineContext) = hold
            override fun dispatch(context: CoroutineContext, block: Runnable) { waiting.add(block) }
        }
        val telemetry = Recorder()
        EngineRoomFixture(temporary.newFolder(), backgroundScope, telemetry = telemetry, readDispatcher = reads).use { room ->
            room.select("first")
            room.pull(EngineRoomFixture.server())
            val session = room.workout()
            runCurrent()
            val set = room.training.session(session.id)!!.sets.single()
            telemetry.events.clear()
            hold = true
            val caller = async(start = CoroutineStart.UNDISPATCHED) {
                room.store.fixSet(session.id, set.id, SetFix(weightKg = 90.0), FixOrigin.Session)
            }
            assertEquals(1, waiting.size)
            hold = false
            room.select("second")
            val next = room.workout(load = 25.0, movement = "back-squat", finish = false)
            val nextSets = room.store.sets
            val nextRack = room.store.rack
            val nextLog = room.store.logged
            val otherEvents = telemetry.events.toList()
            while (waiting.isNotEmpty()) waiting.removeFirst().run()
            runCurrent()
            assertEquals(FixOutcome.Corrected(set.copy(weightKg = 90.0)), caller.await())
            assertEquals(next, room.store.session)
            assertEquals(nextSets, room.store.sets)
            assertEquals(nextRack, room.store.rack)
            assertEquals(nextLog, room.store.logged)
            assertEquals(otherEvents, telemetry.events)
            assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "fix", "outcome" to "ok")),
                telemetry.events.filter { it.first == "gym_action" })
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun anImportedShelfFixReportsSuccessAndKeepsTheWholeCorrectedSource() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(temporary.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val ended = room.workout()
            val session = ended.copy(id = "import01", startedAtMs = room.now + 1_000, finishedAtMs = room.now + 3_000)
            val set = room.training.session(ended.id)!!.sets.single().copy(id = "importset", completedAtMs = room.now + 2_000)
            room.training.imports.prepare(SavedWorkout(session, listOf(set)))
            room.store.refreshEngine()
            assertEquals(listOf("bad-instant"), room.training.imports.refusals().map { it.code })
            telemetry.events.clear()
            val fix = SetFix(reps = 9, note = "private note")
            assertEquals(FixOutcome.Corrected(fix.corrected(set)), room.store.fixSet(session.id, set.id, fix, FixOrigin.Session))
            assertEquals(listOf(fix.corrected(set)), room.training.imports.refusals().single().sets)
            assertEquals(listOf(fix.corrected(set)), (room.store.sessionDetail(session.id) as GymResult.Ok).value.sets)
            assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "fix", "outcome" to "ok")), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun engineAndImportWriteFailuresShareTheFixBoundaryAndKeepTheirSources() = runTest {
        for (imported in listOf(false, true)) {
            val telemetry = Recorder()
            EngineRoomFixture(temporary.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
                room.select(null)
                val original = room.workout(finish = imported)
                val logged = room.training.session(original.id)!!.sets.single()
                val session = if (imported) original.copy(id = "import01", startedAtMs = room.now + 1_000,
                    finishedAtMs = room.now + 3_000) else original
                val set = if (imported) logged.copy(id = "importset", completedAtMs = room.now + 2_000) else logged
                if (imported) {
                    room.training.imports.prepare(SavedWorkout(session, listOf(set)))
                    room.store.refreshEngine()
                    assertEquals(listOf("bad-instant"), room.training.imports.refusals().map { it.code })
                }
                val snapshot = room.engine.snapshot()
                telemetry.events.clear()
                room.engine.failNextCommit()
                assertEquals(FixOutcome.Failed(WriteFailure.NoAnswer), room.store.fixSet(session.id, set.id,
                    SetFix(reps = 9), if (imported) FixOrigin.Session else FixOrigin.Workout))
                assertEquals(snapshot, room.engine.snapshot())
                assertEquals(listOf(set), (room.store.sessionDetail(session.id) as GymResult.Ok).value.sets)
                assertEquals(listOf("gym_action" to mapOf("screen" to if (imported) "session" else "workout",
                    "action" to "fix", "outcome" to "failed")), telemetry.events)
                assertEquals(listOf("gym.fixSet"), telemetry.failures.map { it.first })
            }
        }
    }

    @Test fun aPersistedFixSurvivesAControlsPublicationFailureAndReportsItOnce() = runTest {
        var fail = false
        val failure = IOException("private filesystem detail")
        val telemetry = Recorder()
        EngineRoomFixture(temporary.newFolder(), backgroundScope, telemetry = telemetry,
            controlsWrite = { file, value -> if (fail) throw failure else AtomicDocument.write(file, value) }).use { room ->
            room.select("first")
            val server = EngineRoomFixture.server()
            room.pull(server)
            val session = room.workout(finish = false)
            room.sync(server)
            val set = room.training.session(session.id)!!.sets.single()
            room.store.observeEngine()
            runCurrent()
            telemetry.events.clear()
            fail = true
            assertEquals(FixOutcome.Corrected(set.copy(reps = 9)),
                room.store.fixSet(session.id, set.id, SetFix(reps = 9), FixOrigin.Workout))
            assertEquals(listOf(set.copy(reps = 9)), room.training.session(session.id)!!.sets)
            assertEquals("The workout could not be saved safely. Restart the app to recover it.", room.store.workoutFailure)
            assertEquals(listOf("gym.fixSet" to failure), telemetry.failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "ok")), telemetry.events)
            val note = room.training.writeNote("note_after_fix", works.windmill.gym.domain.NoteWrite("Recovery", "Unrelated read"))
            repeat(3) { room.store.refreshEngine() }
            room.sync(server)
            runCurrent()
            assertEquals(listOf(note.copy(updatedAtMs = room.now)), room.store.notes)
            assertEquals(listOf(set.copy(reps = 9)), room.training.session(session.id)!!.sets)
            assertEquals("The workout could not be saved safely. Restart the app to recover it.", room.store.workoutFailure)
            assertEquals(listOf("gym.fixSet" to failure), telemetry.failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "ok")), telemetry.events)
            fail = false
            val restored = room.freshStore()
            restored.connect(room.account())
            assertEquals(listOf(set.copy(reps = 9)), restored.sets)
            assertNull(restored.workoutFailure)
            assertEquals(listOf("gym.fixSet" to failure), telemetry.failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "ok")), telemetry.events)
        }
    }
    @Test fun accountSwitchAndAnonymousAdoptionBeforeTheLockedLoadRefuseWithoutWriting() = runTest {
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
                        if (anonymous) assertEquals("adoption changes ownership without changing the replica", replica, room.engine.activeReplica())
                        room.selected = "second"
                        switched = room.engine.snapshot()
                    }.onFailure { hookFailure = it }
                }
                override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {}
            }
            val telemetry = Recorder()
            EngineRoomFixture(temporary.newFolder(), CoroutineScope(backgroundScope.coroutineContext + hook), telemetry = telemetry).use {
                room = it
                room.select(if (anonymous) null else "first")
                if (!anonymous) room.pull(EngineRoomFixture.server())
                val session = room.workout(finish = false)
                val set = room.store.sets.single()
                telemetry.events.clear()
                armed = true
                assertEquals(FixOutcome.Failed(WriteFailure.Refused("The account changed. Open this again.")),
                    room.store.fixSet(session.id, set.id, SetFix(reps = 9), FixOrigin.Workout))
                assertNull(hookFailure?.stackTraceToString(), hookFailure)
                assertNotNull(switched)
                assertEquals(switched, room.engine.snapshot())
                assertEquals(listOf(set), room.store.sets)
                assertEquals(listOf("gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "refused")), telemetry.events)
                assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
            }
        }
    }

    @Test fun anOwnerSwitchAfterCommitReturnsTheAcceptedQuantizedSnapshotWithoutReadingTheNewReplica() = runTest {
        lateinit var room: EngineRoomFixture
        var armed = false
        var sessionId = ""
        var accepted: List<TrainingSet>? = null
        var switched: Json? = null
        var hookFailure: Throwable? = null
        val hook = object : ThreadContextElement<Unit> {
            override val key = object : CoroutineContext.Key<ThreadContextElement<Unit>> {}
            override fun updateThreadContext(context: CoroutineContext) {}
            override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {
                if (!armed || context[GymActionContext] == null) return
                armed = false
                runCatching {
                    accepted = room.training.session(sessionId)!!.sets
                    assertTrue(room.engine.signOut("keep").member("complete").bool())
                    assertTrue(room.engine.signIn("second", mapOf("gym" to false)).member("complete").bool())
                    room.selected = "second"
                    switched = room.engine.snapshot()
                }.onFailure { hookFailure = it }
            }
        }
        val telemetry = Recorder()
        EngineRoomFixture(temporary.newFolder(), CoroutineScope(backgroundScope.coroutineContext + hook), telemetry = telemetry).use {
            room = it
            val server = EngineRoomFixture.server()
            room.select("first"); room.pull(server)
            sessionId = room.workout(finish = false).id
            room.sync(server); room.store.refreshEngine()
            val set = room.store.sets.single()
            assertEquals(1, set.setNumber)
            telemetry.events.clear()
            armed = true
            val corrected = set.copy(weightKg = -12.51, note = "  exact bytes  ")
            assertEquals(FixOutcome.Corrected(corrected), room.store.fixSet(sessionId, set.id,
                SetFix(weightKg = -12.505, note = "  exact bytes  "), FixOrigin.Workout))
            assertNull(hookFailure?.stackTraceToString(), hookFailure)
            assertEquals(listOf(corrected), accepted)
            assertNotNull(switched)
            assertEquals(switched, room.engine.snapshot())
            assertEquals(emptyList<works.windmill.gym.domain.SessionDetail>(), room.training.details())
            assertEquals(listOf(set), room.store.sets)
            assertEquals(listOf("gym_action" to mapOf("screen" to "workout", "action" to "fix", "outcome" to "ok")), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
            room.store.connect(room.account())
            assertEquals(emptyList<TrainingSet>(), room.store.sets)
        }
    }

}
