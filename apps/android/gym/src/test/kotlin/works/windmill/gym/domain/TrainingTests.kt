package works.windmill.gym.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val json = Json { ignoreUnknownKeys = true }

private inline fun <reified T> fields(value: T): JsonObject = json.encodeToJsonElement(value).jsonObject

class TrainingWireTests {
    @Test
    fun testASessionCarriesItsFrozenPlanSnapshot() {
        val session = json.decodeFromString(Session.serializer(), """
        { "id": "ses_9f", "startedAt": 1754300000000, "routineId": "rt_1",
          "plan": { "routine": "Push A",
                    "entries": [ { "exerciseId": "bench-press", "sets": 5, "reps": 5,
                                   "weightKg": 82.5, "restSeconds": 180 } ] } }
        """)

        assertEquals("ses_9f", session.id)
        assertEquals(1_754_300_000_000, session.startedAtMs)
        assertNull(session.finishedAtMs)
        assertTrue(session.isOpen)
        assertEquals("rt_1", session.routineId)
        assertEquals("Push A", session.plan?.routine)
        assertEquals(PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5, restSeconds = 180),
                     session.plan?.entry("bench-press"))
    }

    @Test
    fun testAPlanLineWithNoTargetWeightIsAnAbsenceAndNotAZero() {
        val entry = json.decodeFromString(PlanEntry.serializer(), """{"exerciseId":"chin-up","sets":3,"reps":8}""")

        assertNull(entry.weightKg)
        assertNull(entry.restSeconds)
    }

    @Test
    fun testARepTargetIsOmittedWhenTheRoutineDeclinesToNameOne() {
        val entry = json.decodeFromString(PlanEntry.serializer(), """{"exerciseId":"chin-up","sets":3}""")
        assertNull(entry.reps)
        assertEquals(3, entry.sets)

        val line = json.decodeFromString(RoutineEntry.serializer(),
                                         """{"position":3,"exerciseId":"chin-up","targetSets":3}""")
        assertNull(line.targetReps)

        val planned = json.decodeFromString(Target.serializer(), """{"sets":3}""")
        assertNull(planned.reps)

        val write = fields(RoutineEntryWrite(exerciseId = "chin-up", targetSets = 3))
        assertNull("an absent rep target is omitted, never sent as null", write["targetReps"])
    }

    @Test
    fun testASetDecodesTheLogsOwnNumberingAndDefaultsTheRest() {
        val set = json.decodeFromString(TrainingSet.serializer(), """
        { "id": "set_1", "exerciseId": "back-squat", "setNumber": 3, "weightKg": 105,
          "reps": 5, "kind": "working", "completedAt": 1754300000000 }
        """)

        assertEquals(3, set.setNumber)
        assertEquals(SetKind.Working, set.kind)
        assertEquals("note is a String on the wire, so an absent one is empty and not missing", "", set.note)
        assertNull(set.rpe)
        assertEquals(1_754_300_000_000, set.completedAtMs)
    }

    @Test
    fun testAKindThisBuildHasNeverHeardOfReadsAsWorking() {
        val set = json.decodeFromString(TrainingSet.serializer(),
                                        """{"id":"set_1","exerciseId":"x","weightKg":1,"reps":1,"kind":"cluster","completedAt":1}""")

        assertEquals(SetKind.Working, set.kind)
    }

    @Test
    fun testAnAbsentOptionalIsOmittedRatherThanWrittenAsNull() {
        val queued = TrainingSet(id = "set_1", exerciseId = "bench-press", weightKg = 82.5, reps = 5,
                                 completedAtMs = 1_754_300_000_000)
        val written = fields(queued)

        assertNull("a set this device minted has no number until the log gives it one", written["setNumber"])
        assertNull(written["rpe"])
        assertEquals(1_754_300_000_000, written["completedAt"]?.jsonPrimitive?.long)

        val start = fields(SessionStart(id = "ses_1", startedAt = 1))
        assertNull("an ad-hoc session names no routine, and says so by silence", start["routineId"])
        assertNull("a start that declines to state the flag omits it — and an omitted flag IS the " +
            "join, which is why every real start on this phone states false", start["joinOpenSession"])

        val stated = fields(SessionStart(id = "ses_1", startedAt = 1, joinOpenSession = false))
        assertEquals(false, stated["joinOpenSession"]?.jsonPrimitive?.boolean)
    }

    @Test
    fun testALogRowIsTheSessionWithItsFactsBesideIt() {
        val row = json.decodeFromString(SessionSummary.serializer(), """
        { "id": "ses_1", "startedAt": 1754300000000, "finishedAt": 1754303720000,
          "setCount": 16, "exercises": ["back-squat", "romanian-deadlift"],
          "topSet": { "weightKg": 105, "reps": 5 }, "closedItself": true }
        """)

        assertEquals("ses_1", row.id)
        assertFalse(row.session.isOpen)
        assertEquals(16, row.setCount)
        assertEquals(listOf("back-squat", "romanian-deadlift"), row.exercises)
        assertEquals(TopSet(weightKg = 105.0, reps = 5), row.topSet)
        assertTrue(row.closedItself)
    }

    @Test
    fun testARowWithNoWorkingSetCarriesNoTopSetAndWasNotClosedByTheRule() {
        val row = json.decodeFromString(SessionSummary.serializer(), """
        { "id": "ses_2", "startedAt": 1754300000000, "finishedAt": 1754303720000, "setCount": 2 }
        """)

        assertNull(row.topSet)
        assertFalse(row.closedItself)
    }

    @Test
    fun testAFirstEverMovementComesBackNamedAndEmpty() {
        val answer = json.decodeFromString(LastTime.serializer(), """{"exerciseId":"zercher-squat"}""")

        assertTrue(answer.isFirstTime)
        assertNull(answer.routine)
        assertTrue(answer.sets.isEmpty())
    }

    @Test
    fun testTheFinishScreenDecodesItsThreeFactsItsRecordAndItsComparison() {
        val review = json.decodeFromString(Review.serializer(), """
        { "stats": { "durationMs": 3720000, "workingSets": 16, "topE1rm": 122.5 },
          "slight": false,
          "record": { "kind": "e1rm", "exerciseId": "back-squat", "value": 122.5, "weightKg": 105,
                      "reps": 5, "previous": 116.7, "previousAt": 1750723200000 },
          "against": { "sessionId": "ses_p", "routine": "Legs", "startedAt": 1750723200000,
            "movements": [ { "exerciseId": "back-squat",
                             "now": { "weightKg": 105, "reps": 5, "sets": 5 },
                             "before": { "weightKg": 102.5, "reps": 5, "sets": 5 },
                             "planned": { "sets": 3, "reps": 12, "weightKg": 140 } } ] } }
        """)

        assertEquals(ReviewStats(durationMs = 3_720_000, workingSets = 16, topE1rm = 122.5), review.stats)
        assertFalse(review.slight)
        assertEquals("e1rm", review.record?.kind)
        assertEquals(1_750_723_200_000L, review.record?.previousAtMs)
        assertEquals("Legs", review.against?.routine)
        assertEquals(Effort(sets = 5, reps = 5, weightKg = 105.0), review.against?.movements?.first()?.now)
        assertEquals(Target(sets = 3, reps = 12, weightKg = 140.0), review.against?.movements?.first()?.planned)
    }

    @Test
    fun testAnOpenRowsFrozenTargetDecodesAsAnAbsenceAndNotAsAMissingField() {
        val review = json.decodeFromString(Review.serializer(), """
        { "stats": { "durationMs": 3720000, "workingSets": 16 },
          "slight": false,
          "against": { "sessionId": "ses_p", "routine": "Heavy Thursday", "startedAt": 1750723200000,
            "movements": [ { "exerciseId": "barbell-row",
                             "now": { "weightKg": 60, "reps": 10, "sets": 3 },
                             "before": { "weightKg": 57.5, "reps": 10, "sets": 3 },
                             "planned": {} } ] } }
        """)

        assertEquals(
            listOf(AgainstMovement(exerciseId = "barbell-row",
                                   now = Effort(sets = 3, reps = 10, weightKg = 60.0),
                                   before = Effort(sets = 3, reps = 10, weightKg = 57.5),
                                   planned = Target())),
            review.against?.movements,
        )
    }

    @Test
    fun testAnOrdinarySessionCarriesNoRecordAndNoComparison() {
        val review = json.decodeFromString(Review.serializer(),
                                           """{"stats":{"durationMs":2820000,"workingSets":14},"slight":false}""")

        assertNull("a session of unloaded work has no honest one-rep estimate", review.stats.topE1rm)
        assertNull(review.record)
        assertNull(review.against)
    }

    @Test
    fun testARoutineCarriesItsOwnOrderAndItsLastTrainedStamp() {
        val routine = json.decodeFromString(Routine.serializer(), """
        { "id": "rt_9f", "name": "Push A", "position": 0, "lastTrainedAt": 1754300000000,
          "entries": [ { "position": 1, "exerciseId": "bench-press", "targetSets": 5, "targetReps": 5,
                         "targetWeightKg": 82.5, "restSeconds": 180 } ] }
        """)

        assertEquals(1_754_300_000_000L, routine.lastTrainedAtMs)
        assertEquals(listOf(1), routine.entries.map { it.position })
        assertEquals(82.5, routine.entries.first().targetWeightKg)
    }

    @Test
    fun testARoutineNeverTrainedHasNoStampAtAll() {
        val routine = json.decodeFromString(Routine.serializer(),
                                            """{"id":"rt_1","name":"Pull A","position":1,"entries":[]}""")

        assertNull(routine.lastTrainedAtMs)
    }
}

class LastSetTests {
    private fun aSet(exerciseId: String, weightKg: Double, reps: Int,
                     kind: SetKind = SetKind.Working, at: Long): TrainingSet =
        TrainingSet(id = "set_$at", exerciseId = exerciseId, weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    private fun aSession(id: String, startedAt: Long, finishedAt: Long?, sets: List<TrainingSet>) =
        SessionDetail(Session(id = id, startedAtMs = startedAt, finishedAtMs = finishedAt), sets)

    @Test
    fun testTheWireRowIsTheSessionsMarkAndSpellsItAt() {
        val row = json.decodeFromString(LastSet.serializer(),
                                        """{"exerciseId":"bench-press","weightKg":80,"reps":8,"at":1785600000000}""")
        assertEquals("bench-press", row.exerciseId)
        assertEquals(80.0, row.weightKg, 0.0)
        assertEquals(8, row.reps)
        assertEquals(1_785_600_000_000, row.atMs)
    }

    @Test
    fun testTheShelfAnswersWithTheLastSetOfTheLastTimeBlock() {
        val rows = LastSet.of(listOf(
            aSession("ses_old", startedAt = 1_000, finishedAt = 2_000, sets = listOf(
                aSet("bench-press", 100.0, 1, at = 1_500))),
            aSession("ses_new", startedAt = 5_000, finishedAt = 6_000, sets = listOf(
                aSet("bench-press", 85.0, 5, at = 5_100),
                aSet("bench-press", 80.0, 8, at = 5_200),
                aSet("back-squat", 120.0, 3, at = 5_300))),
        ))

        assertEquals("keyed by movement, in join-key order", listOf("back-squat", "bench-press"),
                     rows.map { it.exerciseId })
        assertEquals("the row the lifter finished on, not the 100 they hit last month",
                     LastSet("bench-press", 80.0, 8, atMs = 5_000), rows.last())
        assertEquals(LastSet("back-squat", 120.0, 3, atMs = 5_000), rows.first())
    }

    @Test
    fun testAWarmupOnlyMovementAndAnOpenSessionAreBothAbsent() {
        val rows = LastSet.of(listOf(
            aSession("ses_done", startedAt = 1_000, finishedAt = 2_000, sets = listOf(
                aSet("chin-up", 0.0, 8, kind = SetKind.Warmup, at = 1_100),
                aSet("deadlift", 140.0, 5, at = 1_200),
                aSet("deadlift", 100.0, 8, kind = SetKind.Drop, at = 1_300))),
            aSession("ses_live", startedAt = 9_000, finishedAt = null, sets = listOf(
                aSet("deadlift", 200.0, 1, at = 9_100))),
        ))

        assertEquals("a movement warmed up and never worked has nothing to say",
                     listOf("deadlift"), rows.map { it.exerciseId })
        assertEquals("a drop set is still what happened last, and today's session is not a last time",
                     LastSet("deadlift", 100.0, 8, atMs = 1_000), rows.single())
    }

    @Test
    fun testALogWithNothingInItAnswersWithNoRowsAtAll() {
        assertEquals(emptyList<LastSet>(), LastSet.of(emptyList()))
    }

    @Test
    fun testLastTimeIsTheNonWarmupBlockAndThePrefillDialsOffIt() {
        val history = listOf(
            aSession("ses_old", startedAt = 1_000, finishedAt = 2_000, sets = listOf(
                aSet("bench-press", 90.0, 5, at = 1_500))),
            aSession("ses_new", startedAt = 5_000, finishedAt = 6_000, sets = listOf(
                aSet("bench-press", 40.0, 10, kind = SetKind.Warmup, at = 5_100),
                aSet("bench-press", 100.0, 5, at = 5_200),
                aSet("bench-press", 100.0, 3, kind = SetKind.Failure, at = 5_300),
                aSet("bench-press", 60.0, 12, kind = SetKind.Drop, at = 5_400))),
            aSession("ses_live", startedAt = 9_000, finishedAt = null, sets = listOf(
                aSet("bench-press", 200.0, 1, at = 9_100))),
        )

        val last = LastTime.of("bench-press", history)

        assertEquals("ses_new", last.session?.id)
        assertEquals("the failure and the drop are last time; the warmup and today's session are not",
            listOf(100.0 to 5, 100.0 to 3, 60.0 to 12), last.sets.map { it.weightKg to it.reps })
        assertEquals("weight from the last row of the block, reps from the first",
            Prefill(60.0, 5), Prefill.of(emptyList(), null, last))
        assertEquals("and the picker's line reports the same last row",
            LastSet("bench-press", 60.0, 12, atMs = 5_000), LastSet.of(history).single())
    }

    @Test
    fun testAMovementOnlyWarmedUpHasNoLastTime() {
        val last = LastTime.of("chin-up", listOf(
            aSession("ses_done", startedAt = 1_000, finishedAt = 2_000, sets = listOf(
                aSet("chin-up", 0.0, 8, kind = SetKind.Warmup, at = 1_100)))))

        assertEquals(LastTime("chin-up"), last)
        assertTrue(last.isFirstTime)
    }
}

class RoutineWriteTests {
    private fun aSet(exerciseId: String, weightKg: Double, reps: Int,
                     kind: SetKind = SetKind.Working, at: Long): TrainingSet =
        TrainingSet(id = "set_$at", exerciseId = exerciseId, weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    private fun aDetail(sets: List<TrainingSet>): SessionDetail =
        SessionDetail(Session(id = "ses_1", startedAtMs = 1), sets)

    @Test
    fun testARoutineKeptFromASessionIsWhatWasActuallyLifted() {
        val write = RoutineWrite.from("Push A", aDetail(listOf(
            aSet("bench-press", 40.0, 10, SetKind.Warmup, at = 100),
            aSet("bench-press", 82.5, 5, at = 200),
            aSet("bench-press", 82.5, 5, at = 300),
            aSet("bench-press", 85.0, 3, at = 400),
            aSet("back-squat", 100.0, 5, at = 500),
            aSet("back-squat", 60.0, 12, SetKind.Drop, at = 600),
        )), position = 2)

        assertNotNull(write)
        assertTrue("the kept routine mints its own id", write!!.id.startsWith("rt_"))
        assertEquals(2, write.position)
        assertEquals("in the order they were performed",
                     listOf("bench-press", "back-squat"), write.entries.map { it.exerciseId })
        assertEquals(RoutineEntryWrite(exerciseId = "bench-press", targetSets = 3,
                                       targetReps = 5, targetWeightKg = 85.0),
                     write.entries[0])
        assertEquals("a drop set is not what next week is aimed at",
                     RoutineEntryWrite(exerciseId = "back-squat", targetSets = 1,
                                       targetReps = 5, targetWeightKg = 100.0),
                     write.entries[1])
    }

    @Test
    fun testATiedModalRepCountGoesToTheSmallerTarget() {
        val write = RoutineWrite.from("Legs", aDetail(listOf(
            aSet("back-squat", 100.0, 5, at = 100),
            aSet("back-squat", 100.0, 5, at = 200),
            aSet("back-squat", 110.0, 3, at = 300),
            aSet("back-squat", 110.0, 3, at = 400),
        )), position = 0)

        assertNotNull(write)
        assertEquals(listOf(3), write!!.entries.map { it.targetReps })
        assertEquals(listOf(110.0), write.entries.map { it.targetWeightKg })
    }

    @Test
    fun testASessionOfNothingButWarmupsKeepsNoRoutine() {
        assertNull(RoutineWrite.from("Push A", aDetail(listOf(
            aSet("bench-press", 40.0, 10, SetKind.Warmup, at = 100),
        )), position = 0))
        assertNull(RoutineWrite.from("Push A", aDetail(emptyList()), position = 0))
    }

    @Test
    fun testSavingAHeavierWeightMovesOneTargetAndKeepsTheRest() {
        val routine = Routine(id = "rt_1", name = "Push A", position = 0, entries = listOf(
            RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5, targetReps = 5,
                         targetWeightKg = 100.0, restSeconds = 180),
            RoutineEntry(position = 2, exerciseId = "bench-press", targetSets = 3, targetReps = 8,
                         targetWeightKg = 80.0, restSeconds = 120),
            RoutineEntry(position = 3, exerciseId = "overhead-press", targetSets = 3, targetReps = 8,
                         targetWeightKg = 45.0),
        ))

        val retargeted = routine.retargeting(1, "bench-press", toWeightKg = 105.0)

        assertEquals(
            Routine(id = "rt_1", name = "Push A", position = 0, entries = listOf(
                RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5, targetReps = 5,
                             targetWeightKg = 105.0, restSeconds = 180),
                RoutineEntry(position = 2, exerciseId = "bench-press", targetSets = 3, targetReps = 8,
                             targetWeightKg = 80.0, restSeconds = 120),
                RoutineEntry(position = 3, exerciseId = "overhead-press", targetSets = 3, targetReps = 8,
                             targetWeightKg = 45.0),
            )),
            retargeted)
    }

    @Test
    fun testRetargetingARowThatNoLongerHoldsTheMovementWritesNothing() {
        val routine = Routine(id = "rt_1", name = "Push A", position = 0, entries = listOf(
            RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5, targetReps = 5,
                         targetWeightKg = 82.5),
        ))

        assertNull("position 1 is the bench now, not the squat",
                   routine.retargeting(1, "back-squat", toWeightKg = 140.0))
        assertNull("no row stands at position 2",
                   routine.retargeting(2, "bench-press", toWeightKg = 87.5))
    }
}

class PrefillTests {
    private fun aSet(weightKg: Double, reps: Int, at: Long,
                     kind: SetKind = SetKind.Working): TrainingSet =
        TrainingSet(id = "set_$at", exerciseId = "bench-press", weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    @Test
    fun testWithNoPlanAndNoHistoryThePadOpensOnTheEmptyBar() {
        val prefill = Prefill.of(todaySets = emptyList(), planEntry = null, lastTime = null)

        assertEquals(Prefill(weightKg = 20.0, reps = 5), prefill)
    }

    @Test
    fun testTodaysLastSetWinsOverThePlanAndOverLastTime() {
        val prefill = Prefill.of(
            todaySets = listOf(aSet(82.5, 5, at = 100), aSet(85.0, 3, at = 200)),
            planEntry = PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5),
            lastTime = LastTime(exerciseId = "bench-press", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(80.0, 8, at = 1)))
        )

        assertEquals(Prefill(weightKg = 85.0, reps = 3), prefill)
    }

    @Test
    fun testThePlansTargetBeatsLastTimeBeforeAnythingIsLifted() {
        val prefill = Prefill.of(
            todaySets = emptyList(),
            planEntry = PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5),
            lastTime = LastTime(exerciseId = "bench-press", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(80.0, 8, at = 1)))
        )

        assertEquals(Prefill(weightKg = 82.5, reps = 5), prefill)
    }

    @Test
    fun testLastTimeGivesTheWeightItEndedOnAndTheRepsItStartedOn() {
        val prefill = Prefill.of(
            todaySets = emptyList(),
            planEntry = null,
            lastTime = LastTime(exerciseId = "bench-press", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(80.0, 8, at = 1), aSet(85.0, 6, at = 2), aSet(90.0, 4, at = 3)))
        )

        assertEquals(Prefill(weightKg = 90.0, reps = 8), prefill)
    }

    @Test
    fun testAWarmupIsNotCarriedForwardAsTheStickyWeight() {
        val afterAWarmup = Prefill.of(
            todaySets = listOf(aSet(40.0, 10, at = 100, kind = SetKind.Warmup)),
            planEntry = PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5),
            lastTime = null
        )
        assertEquals("the dial stays on the plan", Prefill(weightKg = 82.5, reps = 5), afterAWarmup)

        val afterAWorkingSet = Prefill.of(
            todaySets = listOf(aSet(40.0, 10, at = 100, kind = SetKind.Warmup),
                               aSet(85.0, 5, at = 200),
                               aSet(65.0, 3, at = 300, kind = SetKind.Warmup)),
            planEntry = PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5),
            lastTime = null
        )
        assertEquals("the last working set is the one the thumb is following",
                     Prefill(weightKg = 85.0, reps = 5), afterAWorkingSet)
    }

    @Test
    fun testAPlanWithNoRepTargetFallsThroughToLastTimeRatherThanToZero() {
        val prefill = Prefill.of(
            todaySets = emptyList(),
            planEntry = PlanEntry(exerciseId = "chin-up", sets = 3),
            lastTime = LastTime(exerciseId = "chin-up", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(0.0, 9, at = 1), aSet(0.0, 6, at = 2)))
        )

        assertEquals(Prefill(weightKg = 0.0, reps = 9), prefill)
        assertEquals("and with no history at all, the empty bar",
                     Prefill(weightKg = 20.0, reps = 5),
                     Prefill.of(todaySets = emptyList(), planEntry = PlanEntry(exerciseId = "chin-up", sets = 3),
                                lastTime = null))
    }

    @Test
    fun testAPlanWithNoTargetWeightStillGivesItsReps() {
        val prefill = Prefill.of(
            todaySets = emptyList(),
            planEntry = PlanEntry(exerciseId = "chin-up", sets = 3, reps = 8),
            lastTime = LastTime(exerciseId = "chin-up", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(0.0, 12, at = 1)))
        )

        assertEquals(Prefill(weightKg = 0.0, reps = 8), prefill)
    }

    @Test
    fun testARepCountOfZeroFromAnOlderBuildClimbsBackToOne() {
        val prefill = Prefill.of(todaySets = listOf(aSet(82.5, 0, at = 100)), planEntry = null, lastTime = null)

        assertEquals(1, prefill.reps)
        assertEquals("the load is signed and unbounded by design, and is never clamped",
                     82.5, prefill.weightKg, 0.0)
    }
}

class IdsTests {
    @Test
    fun testEveryMintedIdIsLegalToTheServerAndCarriesItsPrefix() {
        val allowed = ('a'..'z').toSet() + ('A'..'Z') + ('0'..'9') + setOf('_', '-')

        for (id in listOf(Ids.session(), Ids.set(), Ids.routine(), Ids.exercise())) {
            assertTrue("$id is outside the shape the server enforces", id.length in 8..64)
            assertTrue("$id holds a character the server refuses", id.all { it in allowed })
        }
        assertTrue(Ids.session().startsWith("ses_"))
        assertTrue(Ids.set().startsWith("set_"))
        assertTrue(Ids.routine().startsWith("rt_"))
        assertTrue(Ids.exercise().startsWith("ex_"))
    }

    @Test
    fun testTwoMintedIdsAreNotTheSameId() {
        assertEquals(200, (0 until 200).map { Ids.set() }.toSet().size)
    }
}
