package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.sync.api.Change
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

class TrainingRulesTests {
    @Test fun staleClosureUsesOnlyOwnLastActivityAndIncludesFourHourBoundary() {
        val started = Instant(10_000)
        val workout = Session(sessionId, started)
        val last = trainingSet(completedAt = Instant(20_000))
        val other = last.copy(id = Id("set00002", TrainingSet), sessionId = Id("session2", Session), completedAt = Instant(30_000))
        assertEquals(started, SessionRules.lastActivity(workout, listOf(other)))
        assertEquals(last.completedAt, SessionRules.lastActivity(workout, listOf(last, other)))
        assertNull(SessionRules.autoCloseAt(workout, listOf(last, other), Instant(20_000 + SessionRules.staleAfterMs - 1)))
        assertEquals(last.completedAt, SessionRules.autoCloseAt(workout, listOf(last, other), Instant(20_000 + SessionRules.staleAfterMs)))
        assertEquals(workout.copy(finishedAt = last.completedAt, closedBy = "stale"),
            SessionRules.drawn(workout, listOf(last), Instant(20_000 + SessionRules.staleAfterMs)))
        assertNull(SessionRules.autoCloseAt(workout.copy(finishedAt = last.completedAt), emptyList(), testMoment.now))
    }

    @Test fun startAndFinishInstantBoundsIncludeEdges() {
        val workout = Session(sessionId, Instant(1000))
        for (at in listOf(Instant(0), Instant(999), Instant(SessionRules.maxInstantMs + 1)))
            assertFalse(SessionRules.canFinishAt(workout, at))
        for (at in listOf(workout.startedAt, Instant(SessionRules.maxInstantMs))) assertTrue(SessionRules.canFinishAt(workout, at))
        assertTrue(SessionRules.canStartAt(Instant(1), testMoment.now))
        assertTrue(SessionRules.canStartAt(Instant(testMoment.now.ms + SessionRules.maxClockAheadMs), testMoment.now))
        assertFalse(SessionRules.canStartAt(Instant(testMoment.now.ms + SessionRules.maxClockAheadMs + 1), testMoment.now))
        assertFalse(SessionRules.canStartAt(Instant(0), testMoment.now))
    }

    @Test fun finishIsFirstWriterWinsAndOnlyStaleClosureYields() {
        val workout = Session(sessionId, Instant(1000))
        assertEquals(workout.copy(finishedAt = Instant(2000), closedBy = "finish"), SessionRules.finish(workout, Instant(2000)))
        for (who in listOf<String?>(null, "finish")) {
            val finished = workout.copy(finishedAt = Instant(2000), closedBy = who)
            assertEquals(finished, SessionRules.finish(finished, Instant(3000)))
            assertFalse(SessionRules.lateSetLands(finished, Instant(1500)))
        }
        val stale = workout.copy(finishedAt = Instant(2000), closedBy = "stale")
        for (at in listOf(1500L, 2000L, 2000 + SessionRules.staleAfterMs)) {
            assertEquals(stale.copy(finishedAt = Instant(maxOf(2000, at)), closedBy = "finish"), SessionRules.finish(stale, Instant(at)))
            assertTrue(SessionRules.lateSetLands(stale, Instant(at)))
        }
        assertEquals(stale.copy(closedBy = "finish"), SessionRules.finish(stale, Instant(2001 + SessionRules.staleAfterMs)))
        assertFalse(SessionRules.lateSetLands(stale, Instant(2001 + SessionRules.staleAfterMs)))
        assertTrue(SessionRules.lateSetLands(workout, Instant(SessionRules.maxInstantMs)))
    }

    @Test fun overlapUsesHalfOpenSpansAndZeroDurationHasOneMillisecond() {
        val other = Session(Id("session2", Session), Instant(100), Instant(200))
        assertFalse(SessionRules.crosses(Instant(200), Instant(300), other))
        assertFalse(SessionRules.crosses(Instant(1), Instant(100), other))
        assertTrue(SessionRules.crosses(Instant(199), Instant(199), other))
        assertFalse(SessionRules.crosses(Instant(200), Instant(200), other))
        assertTrue(SessionRules.crosses(Instant(100), Instant(100), other.copy(finishedAt = Instant(100))))
        assertFalse(SessionRules.crosses(Instant(100), Instant(200), other.copy(finishedAt = null)))
    }

    @Test fun liveHintAndReviewReadDrawnSetsAndCloseStaleSessions() {
        val workout = session()
        val first = trainingSet(number = 1).copy(weightKg = 100.0, reps = 5)
        val best = first.copy(id = Id("set00002", TrainingSet), weightKg = 95.0, reps = 10, completedAt = Instant(first.completedAt.ms + 1))
        val ignored = first.copy(id = Id("set00003", TrainingSet), kind = "warmup", weightKg = 500.0)
        val assisted = first.copy(id = Id("set00004", TrainingSet), weightKg = -20.0)
        val log = TrainingLog(reader(drawn = listOf(row(workout), setRow(best), setRow(first), setRow(ignored), setRow(assisted))))
        assertEquals(workout, log.open)
        assertTrue(log.liveHint)
        assertEquals(1450.0, log.volumeKg(sessionId), 0.0)
        assertEquals(95.0 * (1 + 10 / 30.0), log.topE1rm(sessionId)!!, 0.0)
        assertEquals(listOf(first, ignored, assisted, best).sortedWith(compareBy({ it.completedAt }, { it.id })), log.sets(sessionId))
        val stale = TrainingLog(listOf(workout), listOf(first), Moment(Instant(first.completedAt.ms + SessionRules.staleAfterMs), FixedZone(0)))
        assertNull(stale.open)
        assertFalse(stale.liveHint)
        assertEquals(listOf(workout.copy(finishedAt = first.completedAt, closedBy = "stale")), stale.drawnSessions)
        for (kind in listOf("warmup", "drop", "failure")) {
            assertEquals(0.0, first.copy(kind = kind).volumeKg, 0.0)
            assertNull(first.copy(kind = kind).e1rm)
        }
        assertNull(assisted.e1rm)
        assertNull(first.copy(weightKg = 0.0).e1rm)
        assertEquals(100.0, first.copy(reps = 1).e1rm!!, 0.0)
        assertNull(first.copy(reps = 11).e1rm)
        assertNull(first.copy(rpe = 6.9).e1rm)
        assertEquals(first.e1rm, first.copy(rpe = 7.0).e1rm)
    }

    @Test fun setsNormalizeLoadRpeAndPreserveUntrimmedNotes() {
        val value = trainingSet().copy(weightKg = -20.125, rpe = 7.25, note = "  e\u0301  ")
        assertEquals(value.copy(weightKg = -20.13, rpe = 7.3), Valid(value, TrainingSet, at = testMoment).value)
        for (weight in listOf(-500.0, 0.0, 500.0))
            assertEquals(weight, Valid(value.copy(weightKg = weight), TrainingSet, at = testMoment).value.weightKg, 0.0)
        for (reps in listOf(1, 500)) assertEquals(reps, Valid(value.copy(reps = reps), TrainingSet, at = testMoment).value.reps)
        for (kind in listOf("warmup", "working", "drop", "failure"))
            assertEquals(kind, Valid(value.copy(kind = kind), TrainingSet, at = testMoment).value.kind)
    }

    @Test fun eachSetFieldHasOrderedLocalRefusals() {
        val value = trainingSet()
        val cases = listOf(
            Triple(value.copy(weightKg = -501.0), "weightKg", Violation.Reason.Below(-500.0)),
            Triple(value.copy(weightKg = 501.0), "weightKg", Violation.Reason.Above(500.0)),
            Triple(value.copy(reps = 0), "reps", Violation.Reason.Below(1.0)),
            Triple(value.copy(reps = 501), "reps", Violation.Reason.Above(500.0)),
            Triple(value.copy(kind = "unknown"), "kind", Violation.Reason.NotOneOf),
            Triple(value.copy(rpe = 0.9), "rpe", Violation.Reason.Below(1.0)),
            Triple(value.copy(rpe = 10.1), "rpe", Violation.Reason.Above(10.0)),
            Triple(value.copy(note = "\u0000"), "note", Violation.Reason.Nul),
            Triple(value.copy(completedAt = Instant(0)), "completedAt", Violation.Reason.Below(1.0)),
            Triple(value.copy(completedAt = Instant(SessionRules.maxInstantMs + 1)), "completedAt", Violation.Reason.Above(SessionRules.maxInstantMs.toDouble())),
        )
        for ((input, field, reason) in cases) invalid(decide(AppendSet(input)), "set.$field", field, reason)
        invalidValue("set.weightKg", "weightKg", Violation.Reason.NotANumber) { SetRules.weightKg.apply(Double.NaN, Path("weightKg")) }
        invalid(decide(AppendSet(value.copy(note = "é".repeat(2001)))), "set.note", "note", Violation.Reason.TooLong(4000, works.windmill.sync.core.MeasureUnit.bytes, 4002))
    }

    @Test fun serialNumberUsesMaximumPerSessionAndMovementAndRejectsOverflow() {
        val first = trainingSet(number = 1)
        val third = first.copy(id = Id("set00003", TrainingSet), setNumber = 3)
        val other = third.copy(id = Id("set00004", TrainingSet), exerciseId = bench, setNumber = 100)
        assertEquals(4, SetRules.nextNumber(listOf(first, third, other), sessionId, squat))
        assertEquals(1, SetRules.nextNumber(listOf(first.copy(sessionId = Id("session2", Session))), sessionId, squat))
        assertNull(SetRules.nextNumber(listOf(first.copy(setNumber = Int.MAX_VALUE)), sessionId, squat))
        invalid(decide(AppendSet(first.copy(id = Id("set00002", TrainingSet))), reader(listOf(row(session()), setRow(first.copy(setNumber = Int.MAX_VALUE))))),
            "set.setNumber", "setNumber", Violation.Reason.Above(Int.MAX_VALUE.toDouble()))
    }

    @Test fun appendCreatesCheckedClientFieldsAndLeavesSerialAssignmentToServer() {
        val value = trainingSet().copy(weightKg = 80.125)
        val result = writing(decide(AppendSet(value), reader(listOf(row(session())))))
        assertEquals(setId, result.result)
        assertEquals(listOf(Change.create(TrainingSet.type, works.windmill.sync.api.NewID.Given(setId.record), value.copy(weightKg = 80.13).fields())),
            result.plan.gesture(Session.scope, SyncSchema.registry).changes)
        assertFalse(result.plan.operations.single().values.containsKey("setNumber"))
    }

    @Test fun appendPredictsMissingFinishedUnknownExerciseAndTakenRefusals() {
        val value = trainingSet()
        assertEquals(Decision.Refuse(GymRefusal.Gone(sessionId.ref, Refused.Path.predicted)), decide(AppendSet(value)))
        val finished = session(testMoment.now, "finish")
        assertEquals(Decision.Refuse(GymRefusal.SessionFinished(Refused(RefusalCode(Gym.Codes.sessionFinished), setId.ref, path = Refused.Path.predicted))),
            decide(AppendSet(value), reader(listOf(row(finished)))))
        val unknown = value.copy(exerciseId = Id("not-owned", Exercise))
        assertEquals(Decision.Refuse(GymRefusal.UnknownExercise(Refused(RefusalCode(Gym.Codes.unknownExercise), setId.ref, path = Refused.Path.predicted))),
            decide(AppendSet(unknown), reader(listOf(row(session())))))
        assertEquals(Decision.Refuse(GymRefusal.Taken(setId.ref, Refused.Path.predicted)), decide(AppendSet(value), reader(listOf(row(session()), setRow(value)))))
    }

    @Test fun appendUsesStoredLifeAndStaleBoundaryDespiteDrawnOverlay() {
        val value = trainingSet()
        val stored = session(testMoment.now, "finish")
        val drawn = stored.copy(finishedAt = null, closedBy = null)
        assertTrue((decide(AppendSet(value), reader(listOf(row(stored)), listOf(row(drawn)))) as Decision.Refuse).refusal is GymRefusal.SessionFinished)
        assertTrue(decide(AppendSet(value), reader(listOf(row(drawn)), listOf(row(stored)))) is Decision.Write)
        val stale = session(Instant(testMoment.now.ms - SessionRules.staleAfterMs), "stale")
        assertTrue(decide(AppendSet(value.copy(completedAt = testMoment.now)), reader(listOf(row(stale)))) is Decision.Write)
        assertTrue((decide(AppendSet(value.copy(completedAt = Instant(testMoment.now.ms + 1))), reader(listOf(row(stale)))) as Decision.Refuse).refusal is GymRefusal.SessionFinished)
    }

    @Test fun correctSetChangesOnlyMutableFieldsAfterFinishAndDetectsEveryIdentityChange() {
        val old = trainingSet(number = 3).copy(kind = "drop", rpe = 8.0, note = "old")
        val read = reader(listOf(row(session(testMoment.now, "finish")), setRow(old)))
        assertEquals(Decision.Unchanged(Unit), decide(CorrectSet(old), read))
        val current = old.copy(weightKg = 82.125, reps = 6, kind = "failure", rpe = 9.25, note = "new")
        val normalized = current.copy(weightKg = 82.13, rpe = 9.3)
        assertEquals(listOf(Change.update(TrainingSet.type, setId.record, normalized.fields().filterKeys { it in listOf("weightKg", "reps", "kind", "rpe", "note") })),
            writing(decide(CorrectSet(current), read)).plan.gesture(Session.scope, SyncSchema.registry).changes)
        for (changed in listOf(old.copy(sessionId = Id("session2", Session)), old.copy(exerciseId = bench),
            old.copy(completedAt = Instant(old.completedAt.ms + 1)), old.copy(setNumber = 4)))
            invalid(decide(CorrectSet(changed), read), "set.identity", "id", Violation.Reason.Custom("immutable"))
        assertEquals(Decision.Refuse(GymRefusal.Gone(setId.ref, Refused.Path.predicted)), decide(CorrectSet(old)))
    }

    @Test fun startJoinsStoredOpenSessionOrPredictsDrawnRoutineSnapshot() {
        val open = session()
        val join = writing(decide(StartSession(Id("session2", Session), startedAt = Instant(SessionRules.maxInstantMs)), reader(listOf(row(open)))))
        assertEquals(sessionId, join.result)
        assertTrue(join.plan.predictions.isEmpty())
        assertEquals(Json.objectOf("id" to Json.of("session2"), "startedAt" to Json.of(SessionRules.maxInstantMs), "joinOpenSession" to Json.of(true)), join.plan.command!!.args)
        val drawn = routine.copy(name = "Unsynced plan", entries = listOf(entry.copy(sets = null)))
        val created = writing(decide(StartSession(sessionId, routineId), reader(listOf(row(routine)), listOf(row(drawn)))))
        assertEquals(listOf(Prediction.create(Session, sessionId, Session(sessionId, testMoment.now, routineId = routineId, plan = PlanSnapshot(drawn)).fields())), created.plan.predictions)
        assertEquals(Gym.Commands.start, created.plan.command!!.name)
        val absentRoutine = writing(decide(StartSession(sessionId, routineId)))
        assertEquals(listOf(Prediction.create(Session, sessionId, Session(sessionId, testMoment.now).fields())), absentRoutine.plan.predictions)
    }

    @Test fun startRecognizesOwnHeldAndDeadIdentitiesAndDefersFutureClockForReplay() {
        for (record in listOf(row(session()), row(session(), visible = false), row(session(), held = true)))
            assertEquals(Decision.Unchanged(sessionId), decide(StartSession(sessionId, startedAt = Instant(0)), reader(listOf(record))))
        assertTrue(decide(StartSession(sessionId, startedAt = Instant(testMoment.now.ms + SessionRules.maxClockAheadMs + 1))) is Decision.Write)
        invalid(decide(StartSession(sessionId, startedAt = Instant(0))), "session.startedAt", "startedAt", Violation.Reason.Below(1.0))
    }

    @Test fun startDoesNotJoinAStaleStoredWorkoutAndAppendCanFollowPendingStart() {
        val old = Session(Id("session2", Session), Instant(testMoment.now.ms - SessionRules.staleAfterMs))
        val started = writing(decide(StartSession(sessionId), reader(listOf(row(old))))).plan
        assertEquals(listOf(Prediction.create(Session, sessionId, Session(sessionId, testMoment.now).fields())), started.predictions)
        val pending = reader(drawn = listOf(row(session(), pending = true)))
        val appended = writing(decide(AppendSet(trainingSet()), pending)).plan.gesture(Session.scope, SyncSchema.registry)
        assertEquals(listOf(Change.create(TrainingSet.type, works.windmill.sync.api.NewID.Given(setId.record), trainingSet().fields())), appended.changes)
    }

    @Test fun finishPredictsOnlyFinishRegistersAndPreservesTerminalFinish() {
        val workout = session()
        val result = writing(decide(FinishSession(sessionId), reader(listOf(row(workout)))))
        assertEquals(listOf(Prediction.update(Session, sessionId, mapOf("finishedAt" to Json.of(testMoment.now.ms), "closedBy" to Json.of("finish")))), result.plan.predictions)
        assertEquals(Json.objectOf("sessionId" to sessionId.json, "finishedAt" to Json.of(testMoment.now.ms)), result.plan.command!!.args)
        for (who in listOf<String?>(null, "finish"))
            assertEquals(Decision.Unchanged(Unit), decide(FinishSession(sessionId), reader(listOf(row(workout.copy(finishedAt = testMoment.now, closedBy = who))))))
        assertEquals(Decision.Refuse(GymRefusal.Gone(sessionId.ref, Refused.Path.predicted)), decide(FinishSession(sessionId)))
        assertTrue((decide(FinishSession(sessionId, Instant(workout.startedAt.ms - 1)), reader(listOf(row(workout)))) as Decision.Refuse).refusal is GymRefusal.BadInstant)
    }

    @Test fun discardAndDeleteSetsProduceHeldRemovalsAndMissingIsUnchanged() {
        assertTrue((decide(DiscardSession(sessionId), reader(listOf(row(session())))) as Decision.Refuse).refusal is GymRefusal.SessionOpen)
        for (workout in listOf(session(testMoment.now, "finish"), Session(sessionId, Instant(testMoment.now.ms - SessionRules.staleAfterMs)))) {
            val gesture = writing(decide(DiscardSession(sessionId), reader(listOf(row(workout))))).plan.gesture(Session.scope, SyncSchema.registry)
            assertEquals(listOf(Change.delete(Session.type, sessionId.record)), gesture.changes)
            assertTrue(gesture.hold)
        }
        val deleted = writing(decide(deleteSet(setId), reader(listOf(setRow(trainingSet()))))).plan.gesture(Session.scope, SyncSchema.registry)
        assertEquals(listOf(Change.delete(TrainingSet.type, setId.record)), deleted.changes)
        assertTrue(deleted.hold)
        assertEquals(Decision.Unchanged(Unit), decide(DiscardSession(sessionId)))
        assertEquals(Decision.Unchanged(Unit), decide(deleteSet(setId)))
    }
}
