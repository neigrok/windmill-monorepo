package works.windmill.gym.domain.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.withActionContext
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

class WorkoutPlanTests {
    @Test fun aRevisedPlanLandsOnEveryPhoneAndTheSecondRevisionOfOneBaseReturnsStale() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, rules = GymServerRules()).use { a ->
            withActionContext { context ->
                val phoneA = ActionRunner(a.replica, SyncSchema.registry, FixedZone(0), context)
                val exercise = Exercise(Id("exercise1", Exercise), "Squat", "squat", "barbell", 2.5)
                val planned = routine.copy(entries = listOf(entry.copy(exerciseId = exercise.id)))
                assertTrue(phoneA.run(CreateExercise(exercise)) is Outcome.Committed)
                assertTrue(phoneA.save(Draft.new(planned), Routine, GymRefusal) {} is SaveResult.Saved)
                assertTrue(phoneA.run(StartSession(sessionId, routineId)) is Outcome.Committed)
                a.sync()
                val b = a.device()
                val phoneB = ActionRunner(b.replica, SyncSchema.registry, FixedZone(0), context)
                a.sync()
                val base = PlanSnapshot(planned)
                assertEquals(base, phoneB.read(Session.scope) { OpenWorkout(it, sessionId).plan })

                assertTrue(phoneA.run(ReviseWorkoutPlan(sessionId, base, listOf(PlanOperation.SetRest(0, 90)))) is Outcome.Committed)
                assertTrue(phoneB.run(ReviseWorkoutPlan(sessionId, base, listOf(PlanOperation.AddMovement(bench)))) is Outcome.Committed)
                a.sync()

                val revised = base.copy(entries = listOf(planned.entries.single().copy(restSeconds = 90)))
                for (phone in listOf(a, b)) assertEquals(revised, Session.decode(Fields(phone.drawn(Session.scope, Session.type).single())).plan)
                assertEquals(emptyList<RefusalCode>(), a.notices("gym").map { it.code })
                assertEquals(listOf(RefusalCode.stale), b.notices("gym").map { it.code })
                assertTrue(phoneB.run(ReviseWorkoutPlan(sessionId, base, listOf(PlanOperation.AddMovement(bench)))).let {
                    it is Outcome.Refused && it.refusal is GymRefusal.Stale
                })
            }
        }
    }
}
