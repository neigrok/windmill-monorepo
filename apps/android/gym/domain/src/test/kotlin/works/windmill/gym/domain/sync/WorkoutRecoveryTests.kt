package works.windmill.gym.domain.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.withActionContext
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

// A saved copy the phone would hold after a sign-in, written straight into the device key.
class SaveSignedOutWorkouts(val workouts: List<SignedOutWorkout>) : Action<List<SignedOutWorkout>, Unit, GymRefusal> {
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader): List<SignedOutWorkout> = SignedOutWorkout.read(read)
    override fun decide(loaded: List<SignedOutWorkout>, ids: IDSource): Decision<Unit, GymRefusal> {
        val plan = Plan()
        plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded, workouts))
        return Decision.Write(plan, Unit)
    }
}

class WorkoutRecoveryTests {
    private val now = testMoment.now.ms
    private val squat = Id("recovery-squat", Exercise)
    private val exercise = Exercise(squat, "Recovery squat", "squat", "barbell", 2.5)
    private val catalogue = Catalogue(listOf(exercise), emptyList())

    private fun harness(body: (SteppedEngine, ActionRunner) -> Unit) = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, now, rules = GymServerRules()).use { step ->
            withActionContext { context ->
                val runner = ActionRunner(step.replica, SyncSchema.registry, FixedZone(0), context)
                committed(runner.run(CreateExercise(exercise)))
                step.sync()
                body(step, runner)
            }
        }
    }
    private fun committed(outcome: Outcome<*, *>) = assertTrue("$outcome", outcome is Outcome.Committed)
    private fun unchanged(outcome: Outcome<*, *>) = assertTrue("$outcome", outcome is Outcome.Unchanged)
    private fun finished(id: String, from: Long, to: Long, sets: List<Long> = listOf(1_000), routine: Routine? = null, closedBy: String = "finish"): SignedOutWorkout {
        val session = Session(Id(id, Session), Instant(from), Instant(to), closedBy, routineId = routine?.id, plan = routine?.let(::PlanSnapshot))
        return SignedOutWorkout(session, sets.mapIndexed { index, offset ->
            TrainingSet(Id("$id-set-$index", TrainingSet), session.id, squat, 60.0, 5, note = "Private set note", completedAt = Instant(from + offset))
        })
    }
    private fun open(id: String, from: Long, sets: List<Long> = listOf(1_000)): SignedOutWorkout {
        val session = Session(Id(id, Session), Instant(from))
        return SignedOutWorkout(session, sets.mapIndexed { index, offset -> TrainingSet(Id("$id-set-$index", TrainingSet), session.id, squat, 60.0, 5, completedAt = Instant(from + offset)) })
    }
    private fun saved(runner: ActionRunner) = runner.read(Session.scope) { SignedOutWorkout.read(it) }
    private fun commands(step: SteppedEngine) = step.replica.commit(Session.scope) { null to it.commands() }.second
    private fun notices(step: SteppedEngine) = step.notices("gym").map { DomainNotice(it, SyncSchema.registry, GymRefusal) }
    private fun storedSessions(step: SteppedEngine) = step.stored(Session.scope, Session.type).map { Session.decode(Fields(it)) }
    private fun storedSets(step: SteppedEngine) = step.stored(Session.scope, TrainingSet.type).map { TrainingSet.decode(Fields(it)) }
    private fun review(step: SteppedEngine, runner: ActionRunner): List<WorkoutRecovery> = runner.read(Session.scope) { read ->
        WorkoutRecovery.review(SignedOutWorkout.read(read), notices(step), TrainingLog(read), Catalogue(read))
    }
    private fun describe(row: WorkoutRecovery) =
        "${row.id} ${row.reason.label} ${row.retry} notices=${row.noticeIds.size} stranded=${row.strandedSets.map { it.id.toString() }} fix=${row.canFix}"

    @Test fun fixRevisesTheCopyAndChecksItBeforeTheAccount() {
        val routine = Routine(Id("fix-routine", Routine), "Private routine", entries = listOf(RoutineEntry(squat)))
        val original = finished("fixed-copy", now - 100_000, now - 80_000, listOf(1_000, 2_000), routine, closedBy = "stale")
        var fix = WorkoutFix(original)
        assertFalse(fix.isChanged)
        assertTrue(fix.hasRoutine && fix.keepsRoutine && !fix.isOpen)
        assertEquals(original, fix.workout)
        assertEquals(original.sets.map { it.id }, fix.sets.map { it.id })
        fix = fix.copy(keepsRoutine = false, startedAt = Instant(now - 90_000), finishedAt = Instant(now - 70_000), sets = listOf(
            fix.sets[0].copy(weightKg = 62.5, completedAt = Instant(now - 85_000), note = ""), fix.sets[1].copy(completedAt = Instant(now - 75_000))))
        val revised = fix.workout
        assertTrue(fix.isChanged)
        assertEquals(Session(original.session.id, Instant(now - 90_000), Instant(now - 70_000), "finish"), revised.session)
        assertEquals(listOf(
            TrainingSet(original.sets[0].id, original.session.id, squat, 62.5, 5, completedAt = Instant(now - 85_000)),
            TrainingSet(original.sets[1].id, original.session.id, squat, 60.0, 5, note = "Private set note", completedAt = Instant(now - 75_000))), revised.sets)
        assertNull(fix.refusal(testMoment, emptyList(), catalogue))
        val crossing = Session(Id("account-earlier", Session), Instant(now - 72_000), Instant(now - 10_000), "finish")
        assertEquals(GymRefusal.predicted(Gym.Codes.sessionOverlap, original.session.id.ref, Json.objectOf("sessionId" to crossing.id.json)),
            fix.refusal(testMoment, listOf(crossing, original.session), catalogue))
        fix = fix.copy(sets = fix.sets.dropLast(1), finishedAt = Instant(now - 86_000))
        assertEquals(GymRefusal.predicted(Gym.Codes.badInstant, original.session.id.ref), fix.refusal(testMoment, emptyList(), catalogue))
        fix = fix.copy(sets = listOf(fix.sets[0].copy(reps = 0)), finishedAt = Instant(now - 70_000))
        val invalid = fix.refusal(testMoment, emptyList(), catalogue) as GymRefusal.Invalid
        assertEquals(Violation("set.reps", Path("reps"), Violation.Reason.Below(1.0)).json, invalid.violation.json)
        fix = fix.copy(sets = listOf(fix.sets[0].copy(reps = 5)), finishedAt = null)
        assertTrue(fix.isOpen && fix.workout.session.isOpen && fix.workout.session.closedBy == null)
        val accountOpen = Session(Id("account-open", Session), Instant(now - 5_000))
        assertEquals(GymRefusal.predicted(Gym.Codes.sessionOpen, original.session.id.ref), fix.refusal(testMoment, listOf(accountOpen, original.session), catalogue))
        fix = fix.markFinished()
        assertEquals(Instant(now - 85_000), fix.finishedAt)
        assertEquals("finish", fix.workout.session.closedBy)
        assertNull(fix.refusal(testMoment, listOf(accountOpen), catalogue))
        assertEquals("stale", WorkoutFix(finished("stale-kept", now - 50_000, now - 40_000, closedBy = "stale")).workout.session.closedBy)
    }

    @Test fun keepRefusesWhatThePhoneSeesAndLandsTheRevisedCopy() = harness { step, runner ->
        val landed = finished("on-the-log", now - 100_000, now - 80_000)
        committed(runner.run(landed.importAction))
        step.sync()
        val saved = finished("crossing", now - 90_000, now - 70_000, listOf(1_000, 15_000))
        committed(runner.run(SaveSignedOutWorkouts(listOf(saved))))
        assertEquals(GymRefusal.predicted(Gym.Codes.sessionOverlap, saved.session.id.ref, Json.objectOf("sessionId" to landed.session.id.json)),
            runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.keep)).refusal)
        assertEquals(listOf(saved), saved(runner))
        assertTrue(commands(step).isEmpty())
        val fix = WorkoutFix(saved).let { fix -> fix.copy(startedAt = Instant(now - 60_000), finishedAt = Instant(now - 40_000),
            sets = listOf(fix.sets[0].copy(completedAt = Instant(now - 59_000)), fix.sets[1].copy(completedAt = Instant(now - 45_000)))) }
        committed(runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.keep, fix.workout)))
        assertEquals(listOf(fix.workout), saved(runner))
        val command = commands(step).single().command
        assertEquals(Gym.Commands.importSession, command.name)
        assertEquals(Json.of(now - 60_000), command.args["startedAt"])
        assertEquals(Json.of(now - 40_000), command.args["finishedAt"])
        step.sync()
        assertTrue(step.notices("gym").isEmpty())
        assertEquals(listOf(saved.session.id, landed.session.id), storedSessions(step).map { it.id })
        assertEquals(listOf(Instant(now - 59_000), Instant(now - 45_000)), storedSets(step).filter { it.sessionId == saved.session.id }.map { it.completedAt })
        assertEquals(GymRefusal.Taken(saved.session.id.ref, Refused.Path.predicted), runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.keep)).refusal)
        committed(runner.run(ReconcileAdoptedWorkouts()))
        assertTrue(saved(runner).isEmpty())
    }

    @Test fun aServerRefusalLeavesTheCopyAndRetryQueuesAFreshImport() = harness { step, runner ->
        val saved = finished("refused-once", now - 100_000, now - 80_000)
        committed(runner.run(SaveSignedOutWorkouts(listOf(saved))))
        val first = runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.keep)) as Outcome.Committed
        step.server.refuse(code = Gym.Codes.sessionOverlap, detail = Json.objectOf("sessionId" to Json.of("elsewhere")))
        step.sync()
        assertTrue(step.drawn(Session.scope, Session.type).isEmpty())
        assertTrue(commands(step).isEmpty())
        assertEquals(listOf(saved), saved(runner))
        val notice = notices(step).single()
        assertEquals(first.receipt.gestureId, notice.gestureId)
        assertEquals(saved.session.id.ref, notice.subject)
        assertEquals(listOf("refused-once session-overlap importWorkout notices=1 stranded=[] fix=true"), review(step, runner).map(::describe))
        val retried = runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.keep)) as Outcome.Committed
        assertNotEquals(first.receipt.gestureId, retried.receipt.gestureId)
        unchanged(runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.keep)))
        assertTrue(review(step, runner).isEmpty())
        step.sync()
        assertEquals(listOf(saved.session.id), storedSessions(step).map { it.id })
        assertEquals(saved.sets.map { it.id }, storedSets(step).map { it.id })
        assertEquals(listOf(notice.id), notices(step).map { it.id })
    }

    @Test fun discardDropsOneSavedCopyAndTheKeyWithTheLast() = harness { step, runner ->
        val first = finished("discard-first", now - 100_000, now - 90_000)
        val second = finished("discard-second", now - 80_000, now - 70_000)
        committed(runner.run(SaveSignedOutWorkouts(listOf(first, second))))
        committed(runner.run(DiscardSignedOutWorkout(first.session.id)))
        assertEquals(listOf(second), saved(runner))
        unchanged(runner.run(DiscardSignedOutWorkout(first.session.id)))
        committed(runner.run(DiscardSignedOutWorkout(second.session.id)))
        assertNull(runner.read(Session.scope) { it.device(SignedOutWorkout.key) })
        assertTrue(commands(step).isEmpty())
        assertTrue(review(step, runner).isEmpty())
    }

    @Test fun restartResubmitsAnOpenWorkoutsStartWithoutJoiningAndItsSetsInOnePlanOrRefusesItWhole() = harness { step, runner ->
        val saved = open("reopened", now - 30_000, listOf(1_000, 2_000))
        val ghost = TrainingSet(Id("ghost-set", TrainingSet), saved.session.id, Id("ghost-movement", Exercise), 20.0, 10, completedAt = Instant(now - 28_500))
        committed(runner.run(SaveSignedOutWorkouts(listOf(SignedOutWorkout(saved.session, saved.sets + ghost)))))
        assertEquals(GymRefusal.predicted(Gym.Codes.unknownExercise, ghost.id.ref), runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.restart)).refusal)
        assertTrue(commands(step).isEmpty() && step.drawn(Session.scope, Session.type).isEmpty() && step.drawn(Session.scope, TrainingSet.type).isEmpty())
        committed(runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.restart, saved)))
        val start = commands(step).single().command
        assertEquals(Gym.Commands.start, start.name)
        assertEquals(Json.of(false), start.args["joinOpenSession"])
        assertEquals(saved.session.id.json, start.args["id"])
        assertEquals(listOf(true), step.drawn(Session.scope, Session.type).map { Session.decode(Fields(it)).isOpen })
        assertEquals(saved.sets.map { it.id }, step.drawn(Session.scope, TrainingSet.type).map { TrainingSet.decode(Fields(it)).id })
        assertEquals(listOf(saved), saved(runner))
        assertTrue(review(step, runner).isEmpty())
        step.sync()
        assertTrue(step.notices("gym").isEmpty())
        assertEquals(listOf(saved.session.id to true), storedSessions(step).map { it.id to it.isOpen })
        assertEquals(saved.sets.map { it.id }, storedSets(step).map { it.id })
        assertEquals(GymRefusal.Taken(saved.session.id.ref, Refused.Path.predicted), runner.run(AdoptWorkout(saved.session.id, AdoptWorkout.Mode.restart)).refusal)
        val another = open("second-open", now - 10_000)
        committed(runner.run(SaveSignedOutWorkouts(listOf(another))))
        assertEquals(GymRefusal.predicted(Gym.Codes.sessionOpen, another.session.id.ref), runner.run(AdoptWorkout(another.session.id, AdoptWorkout.Mode.restart)).refusal)
        val closed = finished("already-finished", now - 200_000, now - 190_000)
        committed(runner.run(SaveSignedOutWorkouts(listOf(closed))))
        assertEquals(GymRefusal.predicted(Gym.Codes.sessionFinished, closed.session.id.ref), runner.run(AdoptWorkout(closed.session.id, AdoptWorkout.Mode.restart)).refusal)
        committed(runner.run(ReconcileAdoptedWorkouts()))
        assertEquals(listOf(closed.session.id, another.session.id), saved(runner).map { it.session.id })
    }

    @Test fun strandedSetsReturnToTheirWorkoutOrMakeASeparateOne() = harness { step, runner ->
        val id = Id("landed-open", Session)
        val start = Instant(now - 100_000)
        committed(runner.run(StartSession(id, startedAt = start)))
        step.sync()
        val inside = TrainingSet(Id("inside-set", TrainingSet), id, squat, 60.0, 5, completedAt = Instant(now - 90_000))
        val late = TrainingSet(Id("late-set", TrainingSet), id, squat, 65.0, 3, "drop", 8.0, "Private late note", Instant(now - 50_000))
        committed(runner.run(AppendSet(inside)))
        committed(runner.run(AppendSet(late)))
        committed(runner.run(FinishSession(id, Instant(now - 70_000))))
        val saved = SignedOutWorkout(Session(id, start), listOf(inside, late))
        committed(runner.run(SaveSignedOutWorkouts(listOf(saved))))
        step.server.refuse(next = 2, code = Gym.Codes.sessionFinished)
        step.sync()
        assertEquals(listOf(id to Instant(now - 70_000)), storedSessions(step).map { it.id to it.finishedAt })
        assertTrue(storedSets(step).isEmpty())
        assertEquals(listOf(inside.id.ref, late.id.ref), notices(step).map { it.subject })
        assertEquals(listOf("landed-open session-finished restoreSets notices=2 stranded=[inside-set, late-set] fix=true"), review(step, runner).map(::describe))
        assertEquals(listOf(true, true), notices(step).map(saved::owns))
        assertEquals(listOf(true, false), notices(step).map(SignedOutWorkout(saved.session, listOf(inside))::owns))

        committed(runner.run(RecoverStrandedSets(id, RecoverStrandedSets.Placement.intoWorkout)))
        val correction = commands(step).first().command
        assertEquals(Gym.Commands.correctSession, correction.name)
        assertEquals(Json.of(true), correction.args["preserveOtherSets"])
        assertEquals(Json.of(start.ms), correction.args["startedAt"])
        assertEquals(Json.of(now - 70_000), correction.args["finishedAt"])
        assertEquals(Json.array(Json.objectOf("id" to inside.id.json, "exerciseId" to squat.json, "setNumber" to Json.of(1), "weightKg" to Json.of(60.0), "reps" to Json.of(5),
            "completedAt" to Json.of(inside.completedAt.ms), "kind" to Json.of("working"), "rpe" to Json.Null, "note" to Json.of(""))), correction.args["sets"])
        assertEquals(listOf(inside.id), step.drawn(Session.scope, TrainingSet.type).map { TrainingSet.decode(Fields(it)).id })
        assertEquals(listOf("landed-open session-finished restoreSets notices=2 stranded=[late-set] fix=true"), review(step, runner).map(::describe))
        unchanged(runner.run(RecoverStrandedSets(id, RecoverStrandedSets.Placement.intoWorkout)))
        committed(runner.run(RecoverStrandedSets(id, RecoverStrandedSets.Placement.separately)))
        val separate = commands(step).last().command
        assertEquals(Gym.Commands.importSession, separate.name)
        assertNotEquals(id.json, separate.args["id"])
        assertEquals(Json.of(late.completedAt.ms), separate.args["startedAt"])
        assertEquals(Json.of(late.completedAt.ms), separate.args["finishedAt"])
        assertEquals(Json.array(Json.objectOf("id" to late.id.json, "exerciseId" to squat.json, "weightKg" to Json.of(65.0), "reps" to Json.of(3),
            "completedAt" to Json.of(late.completedAt.ms), "kind" to Json.of("drop"), "note" to Json.of("Private late note"), "rpe" to Json.of(8.0))), separate.args["sets"])
        val separateId = Id(RecordID(separate.args.member("id")), Session)
        val copies = saved(runner)
        assertEquals(listOf(inside.id), copies.first { it.session.id == id }.sets.map { it.id })
        val separateCopy = copies.first { it.session.id == separateId }
        assertEquals(listOf(late.id to separateId), separateCopy.sets.map { it.id to it.sessionId })
        assertEquals(late.completedAt, separateCopy.session.finishedAt)
        unchanged(runner.run(RecoverStrandedSets(id, RecoverStrandedSets.Placement.separately)))
        assertTrue(review(step, runner).isEmpty())
        assertEquals(2, notices(step).size)
        step.sync()
        assertEquals(2, notices(step).size)
        val sessions = storedSessions(step)
        assertEquals(2, sessions.size)
        assertEquals(Instant(now - 70_000), sessions.first { it.id == id }.finishedAt)
        val separateSession = sessions.first { it.id != id }
        assertEquals(late.completedAt, separateSession.startedAt)
        assertEquals(late.completedAt, separateSession.finishedAt)
        assertEquals("finish", separateSession.closedBy)
        val sets = storedSets(step)
        assertEquals(listOf(inside.id to id, late.id to separateSession.id), sets.map { it.id to it.sessionId })
        assertEquals(1, sets.first().setNumber)
        assertEquals(listOf("", "Private late note"), sets.map { it.note })
        committed(runner.run(ReconcileAdoptedWorkouts()))
        assertTrue(saved(runner).isEmpty())
        unchanged(runner.run(RecoverStrandedSets(id, RecoverStrandedSets.Placement.intoWorkout)))
    }
}
