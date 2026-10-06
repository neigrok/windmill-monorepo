package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.sync.api.Change
import works.windmill.sync.core.Json
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

class SessionCommandsTests {
    val start = Instant(testMoment.now.ms - 60_000)
    val finish = testMoment.now
    val imported = ImportedSet(setId, squat, 80.125, 5, Instant(testMoment.now.ms - 1000))
    val corrected = CorrectedSet(setId, squat, 3, 80.125, 5, imported.completedAt)

    @Test fun rawPayloadsStayDistinctEvenWhenTheirPredictionsRoundToTheSameWeight() {
        val importPlans = listOf(10.231, 10.232).map { weight ->
            writing(decide(ImportSession(sessionId, start, finish, listOf(imported.copy(weightKg = weight))))).plan
        }
        assertEquals(importPlans[0].predictions, importPlans[1].predictions)
        assertNotEquals(importPlans[0].command!!.args, importPlans[1].command!!.args)
        val correctionPlans = listOf(10.231, 10.232).map { weight ->
            writing(decide(CorrectSession(sessionId, "request1", start, finish, null, listOf(corrected.copy(weightKg = weight))))).plan
        }
        assertEquals(correctionPlans[0].predictions, correctionPlans[1].predictions)
        assertNotEquals(correctionPlans[0].command!!.args, correctionPlans[1].command!!.args)
    }

    @Test fun importKeepsRawReceiptArgumentsAndPredictsNormalizedSetsWithFrozenDrawnPlan() {
        val drawn = routine.copy(name = "Today", entries = listOf(entry.copy(sets = listOf(SetTarget(null, null)))))
        val explicit = imported.copy(id = Id("set00002", TrainingSet), kind = "warmup", rpe = null, rpeNamed = true, note = "  note  ")
        val result = writing(decide(ImportSession(sessionId, start, finish, listOf(imported, explicit), routineId), reader(listOf(row(routine)), listOf(row(drawn)))))
        val session = Session(sessionId, start, finish, "finish", routineId, plan = PlanSnapshot(drawn))
        assertEquals(sessionId, result.result)
        assertEquals(listOf(Prediction.create(Session, sessionId, session.fields()),
            Prediction.create(TrainingSet, setId, imported.value(sessionId).copy(weightKg = 80.13).fields()),
            Prediction.create(TrainingSet, explicit.id, explicit.value(sessionId).copy(weightKg = 80.13).fields())), result.plan.predictions)
        assertEquals(Json.objectOf("id" to sessionId.json, "routineId" to routineId.json, "startedAt" to Json.of(start.ms), "finishedAt" to Json.of(finish.ms),
            "sets" to Json.array(
                Json.objectOf("id" to setId.json, "exerciseId" to squat.json, "weightKg" to Json.of(80.125), "reps" to Json.of(5), "completedAt" to Json.of(imported.completedAt.ms)),
                Json.objectOf("id" to explicit.id.json, "exerciseId" to squat.json, "weightKg" to Json.of(80.125), "reps" to Json.of(5), "completedAt" to Json.of(explicit.completedAt.ms),
                    "kind" to Json.of("warmup"), "rpe" to Json.Null, "note" to Json.of("  note  ")))), result.plan.command!!.args)
        assertEquals(Gym.Commands.importSession, result.plan.command!!.name)
        assertTrue(result.plan.predictions.all { "setNumber" !in it.values })
    }

    @Test fun importAcceptsZeroSetsAndTwoHundredUniqueSetsButRejectsDuplicateIdsAndExcess() {
        for (count in listOf(0, 200)) {
            val sets = (1..count).map { imported.copy(id = Id("set" + it.toString().padStart(5, '0'), TrainingSet)) }
            assertEquals(1 + count, writing(decide(ImportSession(sessionId, start, finish, sets))).plan.predictions.size)
        }
        for (sets in listOf(listOf(imported, imported), (1..201).map { imported.copy(id = Id("set" + it.toString().padStart(5, '0'), TrainingSet)) }))
            invalid(decide(ImportSession(sessionId, start, finish, sets)), "session.sets", "sets", Violation.Reason.Custom("invalid"))
    }

    @Test fun importChecksIntrinsicIntervalsAndInstantRangeBeforeWriting() {
        invalid(decide(ImportSession(sessionId, Instant(0), finish, emptyList())), "session.startedAt", "startedAt", Violation.Reason.Below(1.0))
        invalid(decide(ImportSession(sessionId, start, Instant(SessionRules.maxInstantMs + 1), emptyList())), "session.finishedAt", "finishedAt",
            Violation.Reason.Above(SessionRules.maxInstantMs.toDouble()))
        for (action in listOf(ImportSession(sessionId, finish, start, emptyList()),
            ImportSession(sessionId, start, finish, listOf(imported.copy(completedAt = Instant(start.ms - 1)))),
            ImportSession(sessionId, start, finish, listOf(imported.copy(completedAt = Instant(finish.ms + 1))))))
            assertTrue((decide(action) as Decision.Refuse).refusal is GymRefusal.BadInstant)
        for (at in listOf(start, finish)) assertTrue(decide(ImportSession(sessionId, start, finish, listOf(imported.copy(completedAt = at)))) is Decision.Write)
        assertTrue(decide(ImportSession(sessionId, start, start, listOf(imported.copy(completedAt = start)))) is Decision.Write)
    }

    @Test fun importLetsServerResolveReceiptFutureOverlapAndExerciseOwnership() {
        val future = Instant(testMoment.now.ms + 1000)
        val overlap = Session(Id("session2", Session), start, future, "finish")
        val dead = row(Session(sessionId, start, finish, "finish"), visible = false)
        val unknown = imported.copy(exerciseId = Id("unowned-exercise", Exercise), completedAt = future)
        val decision = decide(ImportSession(sessionId, start, future, listOf(unknown)), reader(listOf(dead, row(overlap))))
        assertEquals(Gym.Commands.importSession, writing(decision).plan.command!!.name)
    }

    @Test fun correctRetainsKindAndUnnamedValuesAndPredictsRemovalOfMissingSets() {
        val workout = Session(sessionId, start, finish, "stale", routineId, plan = PlanSnapshot(routine))
        val old = imported.value(sessionId).copy(kind = "drop", rpe = 8.0, note = "keep", setNumber = 3)
        val removed = old.copy(id = Id("set00002", TrainingSet), setNumber = 7)
        val added = corrected.copy(id = Id("set00003", TrainingSet), setNumber = 9, completedAt = start, weightKg = -20.125)
        val kept = corrected.copy(completedAt = finish)
        val result = writing(decide(CorrectSession(sessionId, "request1", start, finish, "  New name  ", listOf(kept, added)),
            reader(listOf(row(workout), setRow(old), setRow(removed)))))
        val expectedKept = old.copy(completedAt = finish, weightKg = 80.13)
        val expectedAdded = TrainingSet(added.id, sessionId, squat, -20.13, 5, completedAt = start, setNumber = 9)
        assertEquals(listOf(Prediction.update(Session, sessionId, workout.copy(closedBy = "finish", displayName = "  New name  ").fields()),
            Prediction.update(TrainingSet, setId, expectedKept.fields()), Prediction.create(TrainingSet, added.id, expectedAdded.fields()),
            Prediction.remove(TrainingSet, removed.id)), result.plan.predictions)
        assertEquals(Gym.Commands.correctSession, result.plan.command!!.name)
        assertTrue(result.plan.predictions.all { "setNumber" !in it.values })
        val args = result.plan.command!!.args.member("sets").arr()
        assertEquals(listOf(3, 9), args.map { it.member("setNumber").long().toInt() })
        assertEquals(listOf(80.125, -20.125), args.map { it.member("weightKg").num() })
        assertTrue(args.all { it["rpe"] == null && it["note"] == null && it["kind"] == null })
        assertEquals(Change.delete(TrainingSet.type, removed.id.record), result.plan.gesture(Session.scope, SyncSchema.registry).predict.last())
        assertFalse(result.plan.gesture(Session.scope, SyncSchema.registry).hold)
    }

    @Test fun correctCanExplicitlyClearRpeAndNoteAndKeepsAbsentNameNull() {
        val old = imported.value(sessionId).copy(rpe = 8.0, note = "old", setNumber = 3)
        val read = reader(listOf(row(Session(sessionId, start, finish)), setRow(old)))
        val result = writing(decide(CorrectSession(sessionId, "request1", start, finish, null,
            listOf(corrected.copy(rpe = null, rpeNamed = true, note = ""))), read))
        val set = result.plan.predictions.single { it.type == TrainingSet.type }
        assertEquals(old.copy(weightKg = 80.13, rpe = null, note = "").fields(), set.values)
        assertEquals(Json.Null, result.plan.command!!.args.member("routineName"))
        assertEquals(Json.Null, result.plan.command!!.args.member("sets").arr().single().member("rpe"))
        assertEquals(Json.of(""), result.plan.command!!.args.member("sets").arr().single().member("note"))
    }

    @Test fun correctChecksRequestIdsCountsUniqueMovementNumbersAndInterval() {
        for (request in listOf("short", "x".repeat(65), "request!"))
            invalid(decide(CorrectSession(sessionId, request, start, finish, null, listOf(corrected))), "session.requestId", "requestId", Violation.Reason.Custom("invalid"))
        for (sets in listOf(emptyList(), listOf(corrected, corrected), listOf(corrected.copy(setNumber = 0)), listOf(corrected.copy(setNumber = Int.MAX_VALUE.toLong() + 1)),
            listOf(corrected, corrected.copy(id = Id("set00002", TrainingSet))),
            (1..201).map { corrected.copy(id = Id("set" + it.toString().padStart(5, '0'), TrainingSet), setNumber = it.toLong()) }))
            invalid(decide(CorrectSession(sessionId, "request1", start, finish, null, sets)), "session.sets", "sets", Violation.Reason.Custom("invalid"))
        for (sets in listOf(listOf(corrected.copy(setNumber = Int.MAX_VALUE.toLong())),
            listOf(corrected, corrected.copy(id = Id("set00002", TrainingSet), exerciseId = bench))))
            assertTrue(decide(CorrectSession(sessionId, "request1", start, finish, null, sets)) is Decision.Write)
        for (action in listOf(CorrectSession(sessionId, "request1", finish, start, null, listOf(corrected)),
            CorrectSession(sessionId, "request1", start, finish, null, listOf(corrected.copy(completedAt = Instant(start.ms - 1))))))
            assertTrue((decide(action) as Decision.Refuse).refusal is GymRefusal.BadInstant)
        invalid(decide(CorrectSession(sessionId, "request1", start, finish, "é".repeat(121), listOf(corrected))),
            "gym.correctSession.routineName", "routineName", Violation.Reason.TooLong(240, works.windmill.sync.core.MeasureUnit.bytes, 242))
    }

    @Test fun correctDefersReplaySensitiveLifeStateOwnershipFutureAndOverlapToServer() {
        val future = Instant(finish.ms + 1000)
        val wrongOwnerSet = imported.value(Id("session3", Session)).copy(exerciseId = bench)
        val overlap = Session(Id("session2", Session), start, future)
        val action = CorrectSession(sessionId, "request1", start, future, null, listOf(corrected.copy(completedAt = future, exerciseId = Id("unknown-exercise", Exercise))))
        for (read in listOf(reader(), reader(listOf(row(session()), row(overlap), setRow(wrongOwnerSet))),
            reader(listOf(row(Session(sessionId, start, finish), visible = false)))))
            assertEquals(Gym.Commands.correctSession, writing(decide(action, read)).plan.command!!.name)
    }
}
