package works.windmill.gym.domain.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.withActionContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

class CoachOnboardingTests {
    private val fingerprint = "a".repeat(64)
    private val receiptKey = ImportCoachRoutineBatch.receiptPrefix + "a".repeat(48)

    @Test fun allRoutinesAndRequiredMovementShareOneCommitAndTheReceiptReplaysWithoutWrites() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, account = null, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val custom = Exercise(runner.mint(Exercise), "Single press", "press", "dumbbell", 2.0, loadCount = 1)
                val routines = listOf(CoachRoutineImport(runner.mint(Routine), "Upper", listOf(RoutineEntry(custom.id,
                    listOf(SetTarget(5, 0.0)), 90))), CoachRoutineImport(runner.mint(Routine), "Lower",
                    listOf(RoutineEntry(squat, listOf(SetTarget(5, 501.0)), 120))))
                val action = ImportCoachRoutineBatch(phone.engine.activeReplica(), "result", fingerprint, receiptKey, routines, listOf(custom))
                val result = runner.run(action)
                assertTrue(result is Outcome.Committed)
                val receipt = (result as Outcome.Committed).result
                assertEquals(CoachImportReceipt("result", fingerprint, routines.map { it.id }, listOf(custom.id)), receipt)
                assertEquals(routines.mapIndexed { index, value -> Routine(value.id, value.name, index, value.entries) },
                    runner.read(Routine.scope) { Routine.ordered(it.repository(Routine).all(works.windmill.sync.api.ViewMode.drawn)) })
                assertEquals(custom, runner.read(Routine.scope) { Catalogue(it).find(custom.id) })
                assertEquals(1, result.receipt.localIds.size)
                assertEquals(receipt.json, runner.read(Routine.scope) { it.device(receiptKey) })
                val before = phone.engine.snapshot()
                assertEquals(Outcome.Unchanged(receipt), runner.run(action))
                assertEquals(before, phone.engine.snapshot())
                val mismatch = ImportCoachRoutineBatch(phone.engine.activeReplica(), "result", "b".repeat(64), receiptKey, routines, listOf(custom))
                assertTrue(runner.run(mismatch) is Outcome.Refused)
                assertEquals(before, phone.engine.snapshot())
            }
        }
    }

    @Test fun invalidSecondRoutineAndCommitFailureLeaveNoMovementRoutineOrReceipt() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, account = null, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val custom = Exercise(runner.mint(Exercise), "Single press", "press", "dumbbell", 2.0, loadCount = 1)
                val good = CoachRoutineImport(runner.mint(Routine), "Upper", listOf(RoutineEntry(custom.id)))
                val bad = CoachRoutineImport(runner.mint(Routine), " ", listOf(RoutineEntry(squat)))
                val before = phone.engine.snapshot()
                assertTrue(runner.run(ImportCoachRoutineBatch(phone.engine.activeReplica(), "result", fingerprint, receiptKey,
                    listOf(good, bad), listOf(custom))) is Outcome.Refused)
                assertEquals(before, phone.engine.snapshot())
                val action = ImportCoachRoutineBatch(phone.engine.activeReplica(), "result", fingerprint, receiptKey,
                    listOf(good, bad.copy(name = "Lower")), listOf(custom))
                phone.failNextCommit()
                assertThrows(CommitFailure::class.java) { runner.run(action) }
                assertEquals(before, phone.engine.snapshot())
                assertNull(runner.read(Routine.scope) { it.device(receiptKey) })
                assertTrue(phone.drawn(Routine.scope, Routine.type).isEmpty())
                assertTrue(phone.drawn(Exercise.scope, Exercise.type).isEmpty())
                assertTrue(phone.drawn(ExerciseName.scope, ExerciseName.type).isEmpty())
                assertTrue(runner.run(action) is Outcome.Committed)
            }
        }
    }

    @Test fun wrongReplicaAndUnknownMovementRefuseTheEntireBatch() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, account = null, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val routine = CoachRoutineImport(runner.mint(Routine), "Upper", listOf(RoutineEntry(bench)))
                val before = phone.engine.snapshot()
                assertTrue(runner.run(ImportCoachRoutineBatch("old-replica", "result", fingerprint, receiptKey, listOf(routine))) is Outcome.Refused)
                assertTrue(runner.run(ImportCoachRoutineBatch(phone.engine.activeReplica(), "result", fingerprint, receiptKey,
                    listOf(routine.copy(entries = listOf(RoutineEntry(Id("unknown-movement", Exercise))))))) is Outcome.Refused)
                assertEquals(before, phone.engine.snapshot())
            }
        }
    }
}
