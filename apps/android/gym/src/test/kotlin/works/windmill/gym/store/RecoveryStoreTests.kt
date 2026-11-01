package works.windmill.gym.store

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.TrainingSet
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class RecoveryStoreTests {
    @get:Rule val tmp = TemporaryFolder()
    private val events = mutableListOf<Map<String, String>>()
    private val failures = mutableListOf<String>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { if (name == "gym_import_recovery") events += properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            assertEquals(emptyMap<String, String>(), properties); failures += operation
        }
    }
    private suspend fun TestScope.phone(): EngineRoomFixture = EngineRoomFixture(tmp.newFolder(), backgroundScope,
        telemetry = telemetry, readDispatcher = StandardTestDispatcher(testScheduler)).also { room ->
        room.select(null)
        val start = room.now + 100_000
        room.training.imports.prepare(SavedWorkout(Session("session01", start, start + 90_000),
            listOf(TrainingSet("set00001", "bench-press", weightKg = 80.0, reps = 5, completedAtMs = start + 1_000))))
        room.select("A"); room.pull(EngineRoomFixture.server()); room.store.refreshEngine()
    }

    @Test fun disposingTheUiWaiterCannotAbandonAnAcceptedLocalDiscard() = runTest {
        phone().use { room ->
            val read = requireNotNull(room.store.recovery)
            val row = read.workouts.single()
            val source = row.workout
            val form = async(start = CoroutineStart.UNDISPATCHED) { room.store.recover(read, row, RecoveryAction.Discard) }
            assertTrue(room.store.recoveryBusy)
            form.cancelAndJoin()
            runCurrent()
            assertTrue(room.training.imports.refusals().isEmpty())
            assertTrue(room.training.imports.discardedWorkout(row.id))
            assertTrue(room.store.recovery!!.workouts.isEmpty())
            assertFalse(room.store.recoveryBusy)
            assertTrue(room.outbox().isEmpty())
            assertNotNull(source)
            assertEquals(listOf(mapOf("action" to "discard", "outcome" to "ok")), events)
            assertTrue(failures.isEmpty())
        }
    }

    @Test fun anAtoBtoARoomReplacementBeforeTheCommitCannotDiscardTheOpeningCopy() = runTest {
        phone().use { room ->
            val read = requireNotNull(room.store.recovery)
            val row = read.workouts.single()
            var current = room.account()
            val before = room.engine.snapshot()
            val action = async(start = CoroutineStart.UNDISPATCHED) {
                room.store.recover(read, row, RecoveryAction.Discard, currentOwner = { read.belongsTo(current) })
            }
            current = Account(current.origin, User("B", "b@example.com"), identityRevision = 1)
            current = Account(current.origin, User("A", "A@example.com"), identityRevision = 2)
            assertNull(action.await())
            assertEquals(before, room.engine.snapshot())
            assertEquals(row.workout, room.training.imports.retainedWorkouts().single())
            assertEquals(emptyList<Map<String, String>>(), events)
            assertEquals(emptyList<String>(), failures)
        }
    }

    @Test fun staleSourceAndLocalWriteFailureRetainTheExactCurrentCopy() = runTest {
        phone().use { room ->
            val read = requireNotNull(room.store.recovery)
            val row = read.workouts.single()
            val source = requireNotNull(row.workout)
            val changed = source.copy(sets = source.sets.map { it.copy(note = "A newer edit") })
            room.training.imports.replaceAndRetry(row.id, changed)
            val before = room.engine.snapshot()
            assertEquals(RecoveryResult.Refused("This saved workout changed. Open it again."), room.store.recover(read, row, RecoveryAction.Discard))
            assertEquals(before, room.engine.snapshot())
            room.store.refreshEngine()
            val fresh = requireNotNull(room.store.recovery)
            room.engine.failNextCommit()
            assertEquals(RecoveryResult.Failed, room.store.recover(fresh, fresh.workouts.single(), RecoveryAction.Discard))
            assertEquals(changed, room.training.imports.retainedWorkouts().single())
            assertEquals(listOf("gym_import_discard"), failures)
            assertEquals(listOf("refused", "failed"), events.mapNotNull { it["outcome"] })
            assertFalse(room.store.recoveryBusy)
        }
    }

    @Test fun aStaleKeepAfterPhoneCopyDiscardEmitsOnlyRefusedAndSchedulesNothing() = runTest {
        phone().use { room ->
            val read = requireNotNull(room.store.recovery)
            val row = read.workouts.single()
            room.training.imports.discardRefusal(row.id, row.openings.single())
            val discarded = room.engine.snapshot()
            assertEquals(RecoveryResult.Refused("This saved workout changed. Open it again."), room.store.recover(read, row, RecoveryAction.Keep))
            assertEquals(discarded, room.engine.snapshot()); assertTrue(room.outbox().isEmpty())
            assertEquals(listOf(mapOf("action" to "keep", "outcome" to "refused")), events)
            assertTrue(failures.isEmpty()); assertFalse(room.store.recoveryBusy)
        }
    }

    @Test fun draftReattachmentKeepsTheCopyOnlyForTheSameOriginUserAndIdentityRevision() = runTest {
        phone().use { room ->
            val read = requireNotNull(room.store.recovery)
            val row = read.workouts.single()
            assertTrue(room.store.beginRecoveryFix(read, row))
            val opening = requireNotNull(room.store.recoveryDraft)
            room.store.changeRecoveryFix(opening, opening.copy.copy(sets = opening.copy.sets.map { it.copy(weightKg = 81.25) }))
            val draft = room.store.recoveryDraft
            room.store.connect(room.account())
            assertSame(draft, room.store.recoveryDraft)
            assertEquals(row.workout, room.training.imports.retainedWorkouts().single())
            room.store.connect(Account("https://other.invalid", User("A", "A@example.com")))
            assertNull(room.store.recoveryDraft)
            assertFalse(room.store.beginRecoveryFix(read, row))
            assertEquals(row.workout, room.training.imports.retainedWorkouts().single())
        }
    }
}
