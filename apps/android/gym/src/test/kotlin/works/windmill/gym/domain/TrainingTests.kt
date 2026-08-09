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

// The wire, spelled out. Every field name below is the one the backend's codec writes, and every
// absence is an omission rather than a null — the decoder matches these by spelling alone, so a
// rename anywhere is a silent 404 or a silently missing number.

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

    // A plan line with no target weight means "whatever you did last time" — an absence that is a
    // real instruction, and never a zero.
    @Test
    fun testAPlanLineWithNoTargetWeightIsAnAbsenceAndNotAZero() {
        val entry = json.decodeFromString(PlanEntry.serializer(), """{"exerciseId":"chin-up","sets":3,"reps":8}""")

        assertNull(entry.weightKg)
        assertNull(entry.restSeconds)
    }

    // And a plan line with no REP target means max — `3 × max`, a movement taken to whatever it gives
    // that day. It is omitted when absent, like every other optional in this module, and never null.
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

    // A kind this build has never heard of reads as working. Folding it to warmup would be the quiet
    // way to lose a lift: warmups are excluded from history, from the prefill and from every record.
    @Test
    fun testAKindThisBuildHasNeverHeardOfReadsAsWorking() {
        val set = json.decodeFromString(TrainingSet.serializer(),
                                        """{"id":"set_1","exerciseId":"x","weightKg":1,"reps":1,"kind":"cluster","completedAt":1}""")

        assertEquals(SetKind.Working, set.kind)
    }

    // An absent optional is OMITTED, never null — the module's convention on the wire, and the same
    // bytes this device writes to its own disk.
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
        assertNull("an ordinary start omits the flag — the phone joins by default", start["joinOpenSession"])

        // The claim is the one caller that sends it, and it must ride as an explicit false: a
        // replayed past session that silently joined a live workout would file yesterday's sets
        // into today's.
        val claimed = fields(SessionStart(id = "ses_1", startedAt = 1, joinOpenSession = false))
        assertEquals(false, claimed["joinOpenSession"]?.jsonPrimitive?.boolean)
    }

    // The log's rows are FLAT: the session's own fields with its four facts beside them, not a
    // session nested under a key that is not there. `topSet` and `closedItself` are decoded and not
    // drawn anywhere on this phone — the only session row the room has is Today's "Last session",
    // whose copy is fixed by the contract and names neither — so this is what keeps the model
    // matching the wire the web's log row reads.
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

    // A session holding no working set has no top set, and a session somebody finished with a tap
    // says nothing about the four-hour rule. Both absences are omissions.
    @Test
    fun testARowWithNoWorkingSetCarriesNoTopSetAndWasNotClosedByTheRule() {
        val row = json.decodeFromString(SessionSummary.serializer(), """
        { "id": "ses_2", "startedAt": 1754300000000, "finishedAt": 1754303720000, "setCount": 2 }
        """)

        assertNull(row.topSet)
        assertFalse(row.closedItself)
    }

    // A movement trained for the first time is answered 200 with the movement and nothing else — a
    // fact, not a fault. An absent REPLY means something else entirely: the log did not answer.
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

    // The ~190 sessions in 200 that earn nothing: three facts, and the space a record would occupy
    // left empty. Nothing takes its place, so nothing here may invent one.
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

    // A routine nobody has trained sorts on the ABSENCE, not on a zero pretending to be 1970.
    @Test
    fun testARoutineNeverTrainedHasNoStampAtAll() {
        val routine = json.decodeFromString(Routine.serializer(),
                                            """{"id":"rt_1","name":"Pull A","position":1,"entries":[]}""")

        assertNull(routine.lastTrainedAtMs)
    }
}

class RoutineWriteTests {
    private fun aSet(exerciseId: String, weightKg: Double, reps: Int,
                     kind: SetKind = SetKind.Working, at: Long): TrainingSet =
        TrainingSet(id = "set_$at", exerciseId = exerciseId, weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    private fun aDetail(sets: List<TrainingSet>): SessionDetail =
        SessionDetail(Session(id = "ses_1", startedAtMs = 1), sets)

    // "Keep this as a routine" — the first routine is a by-product of the first session: movements in
    // the order performed, the count of WORKING sets, the modal reps, and the heaviest working load.
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

    // A tie on the modal reps goes to the SMALLER count: a target you can beat is a fact about last
    // week, and one you cannot hit reads as a failed session every time it comes round.
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

    // A routine with no entries is refused 400, and a session of nothing but warmups has none. There
    // is nothing to create, so nothing is offered.
    @Test
    fun testASessionOfNothingButWarmupsKeepsNoRoutine() {
        assertNull(RoutineWrite.from("Push A", aDetail(listOf(
            aSet("bench-press", 40.0, 10, SetKind.Warmup, at = 100),
        )), position = 0))
        assertNull(RoutineWrite.from("Push A", aDetail(emptyList()), position = 0))
    }

    // The mid-session change offer, applied: one target moves and the document is otherwise the one
    // the server handed back — a PUT is a whole-document replace, so a dropped line is a deleted one.
    @Test
    fun testSavingAHeavierWeightMovesOneTargetAndKeepsTheRest() {
        val routine = Routine(id = "rt_1", name = "Push A", position = 0, entries = listOf(
            RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5, targetReps = 5,
                         targetWeightKg = 82.5, restSeconds = 180),
            RoutineEntry(position = 2, exerciseId = "overhead-press", targetSets = 3, targetReps = 8,
                         targetWeightKg = 45.0),
        ))

        val retargeted = routine.retargeting("bench-press", toWeightKg = 87.5)

        assertEquals(listOf("bench-press", "overhead-press"), retargeted.entries.map { it.exerciseId })
        assertEquals(listOf(87.5, 45.0), retargeted.entries.map { it.targetWeightKg })
        assertEquals("only the weight moved", 180, retargeted.entries[0].restSeconds)
    }

    // The offer is only ever raised against a planned weight, so a movement the routine does not hold
    // means the answer arrived for some other routine — and nothing is written.
    @Test
    fun testRetargetingAMovementTheRoutineDoesNotHoldChangesNothing() {
        val routine = Routine(id = "rt_1", name = "Push A", position = 0, entries = listOf(
            RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5, targetReps = 5,
                         targetWeightKg = 82.5),
        ))

        assertEquals(routine, routine.retargeting("back-squat", toWeightKg = 140.0))
    }
}

class TrainingStatisticsTests {
    private fun aSet(exerciseId: String, at: Long): TrainingSet = TrainingSet(
        id = "set_$at", exerciseId = exerciseId, weightKg = 100.0, reps = 5, completedAtMs = at)

    // Every multi-movement session TIES on lastTrainedAt — both movements stamp the session's own
    // startedAt — so without the server's id tie-break (Statistics.cpp: most recently trained
    // first, ties to the id) the signed-out list sits in encounter order and visibly reorders the
    // moment the claim lands.
    @Test
    fun testMovementsOrderMostRecentFirstWithTiesToTheIdAsTheServerDoes() {
        val statistics = TrainingStatistics.of(listOf(
            SessionDetail(
                Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 3_000),
                listOf(aSet("ex_zeta", at = 1_100), aSet("ex_alpha", at = 1_200))),
            SessionDetail(
                Session(id = "ses_2", startedAtMs = 700_000_000, finishedAtMs = 700_060_000),
                listOf(aSet("ex_omega", at = 700_000_100))),
        ))

        assertEquals(listOf("ex_omega", "ex_alpha", "ex_zeta"),
                     statistics.movements.map { it.exerciseId })
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

    // Three sources in a fixed order: today's own last set, then the plan, then last time. The one
    // that loses is still on screen.
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

    // The asymmetry is deliberate: the weight comes from the LAST working set, where the lifter
    // actually ended up, and the reps from the FIRST, before fatigue cut them.
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

    // The sticky carry-forward follows the WORKING sets. A 40 kg ramp-up is not the weight the next
    // set starts from, and carrying it would drag the dial back down the ladder the lifter has just
    // climbed — answering "what am I about to lift" with a warmup.
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

    // A plan that names sets and no rep target asks for NOTHING here: an absent target means max, so
    // the reps fall through to last time exactly as an absent weight does.
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

    // A plan that names sets and reps and leaves the load to last time gets both halves from where
    // each is written — the plan is not all-or-nothing.
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

    // The rep floor belongs where the number is MINTED and not only on the button that moves it: a 0
    // written by a build from before the floor moved would otherwise open the pad on a value the
    // server refuses, in alarm ink, on a gesture the lifter never made.
    @Test
    fun testARepCountOfZeroFromAnOlderBuildClimbsBackToOne() {
        val prefill = Prefill.of(todaySets = listOf(aSet(82.5, 0, at = 100)), planEntry = null, lastTime = null)

        assertEquals(1, prefill.reps)
        assertEquals("the load is signed and unbounded by design, and is never clamped",
                     82.5, prefill.weightKg, 0.0)
    }
}

class IdsTests {
    // The client-minted id IS the idempotency key, so it has to be legal to the server on every
    // path: 8…64 characters of [A-Za-z0-9_-], and enough entropy that a collision is a refusal to
    // repair rather than a thing to plan around.
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
