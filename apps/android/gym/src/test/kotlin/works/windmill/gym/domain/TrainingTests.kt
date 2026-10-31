package works.windmill.gym.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
import works.windmill.platform.net.WindmillJson

private val json = Json { ignoreUnknownKeys = true }

private inline fun <reified T> fields(value: T): JsonObject = json.encodeToJsonElement(value).jsonObject

private val lowerARamp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0),
                                SetTarget(1, 100.0), SetTarget(5, 80.0))

private const val lowerARampWire =
    """{"position":1,"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":60.0},{"reps":5,"weightKg":80.0},""" +
        """{"reps":3,"weightKg":90.0},{"reps":1,"weightKg":100.0},{"reps":5,"weightKg":80.0}]}"""

class TrainingWireTests {
    @Test
    fun testASessionCarriesItsFrozenPlanSnapshot() {
        val session = json.decodeFromString(Session.serializer(), """
        { "id": "ses_9f", "startedAt": 1754300000000, "routineId": "rt_1",
          "plan": { "routine": "Push A",
                    "entries": [ { "exerciseId": "bench-press",
                                   "sets": [ { "reps": 5, "weightKg": 82.5 }, { "reps": 5, "weightKg": 82.5 },
                                             { "reps": 5, "weightKg": 82.5 } ],
                                   "restSeconds": 180 } ] } }
        """)

        assertEquals("ses_9f", session.id)
        assertEquals(1_754_300_000_000, session.startedAtMs)
        assertNull(session.finishedAtMs)
        assertTrue(session.isOpen)
        assertEquals("rt_1", session.routineId)
        assertEquals("Push A", session.plan?.routine)
        assertEquals(PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(5, 82.5) }),
                     session.plan?.entry("bench-press"))
    }

    @Test
    fun testASetWithNoLoadIsAnAbsenceAndNotAZero() {
        val entry = json.decodeFromString(PlanEntry.serializer(),
                                          """{"exerciseId":"chin-up","sets":[{"reps":8},{"reps":8},{"reps":8}]}""")

        assertEquals(PlanEntry(exerciseId = "chin-up", sets = List(3) { SetTarget(reps = 8) }), entry)
    }

    @Test
    fun testASetWithNoRepsIsMaxOnEveryCarrierAndIsNeverSentAsNull() {
        val entry = json.decodeFromString(PlanEntry.serializer(), """{"exerciseId":"chin-up","sets":[{},{},{}]}""")
        assertEquals(PlanEntry(exerciseId = "chin-up", sets = List(3) { SetTarget() }), entry)

        val line = json.decodeFromString(RoutineEntry.serializer(),
                                         """{"position":3,"exerciseId":"chin-up","sets":[{"weightKg":100}]}""")
        assertEquals(RoutineEntry(position = 3, exerciseId = "chin-up", sets = listOf(SetTarget(weightKg = 100.0))), line)
    }

    @Test
    fun testTheRampEncodesToItsExactBytesAndRoundTrips() {
        val entry = RoutineEntry(position = 1, exerciseId = "back-squat", sets = lowerARamp)

        val written = WindmillJson.encodeToString(RoutineEntry.serializer(), entry)
        assertEquals(lowerARampWire, written)

        val read = WindmillJson.decodeFromString(RoutineEntry.serializer(), written)
        assertEquals(entry, read)
        assertEquals(lowerARampWire, WindmillJson.encodeToString(RoutineEntry.serializer(), read))
    }

    @Test
    fun testTheContractsWholeNumberSpellingReadsAsTheSameScheme() {
        val read = WindmillJson.decodeFromString(RoutineEntry.serializer(),
            """{"position":1,"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":60},{"reps":5,"weightKg":80},""" +
                """{"reps":3,"weightKg":90},{"reps":1,"weightKg":100},{"reps":5,"weightKg":80}]}""")

        assertEquals(RoutineEntry(position = 1, exerciseId = "back-squat", sets = lowerARamp), read)
    }

    @Test
    fun testAnOpenLineTravelsWithNoSetsKeyOnEveryCarrier() {
        assertEquals("""{"position":2,"exerciseId":"face-pull"}""",
            WindmillJson.encodeToString(RoutineEntry.serializer(), RoutineEntry(position = 2, exerciseId = "face-pull")))
        assertEquals("""{"exerciseId":"face-pull"}""",
            WindmillJson.encodeToString(PlanEntry.serializer(), PlanEntry(exerciseId = "face-pull")))
        assertEquals("{}", WindmillJson.encodeToString(ProposalTargets.serializer(), ProposalTargets()))

        assertTrue(WindmillJson.decodeFromString(RoutineEntry.serializer(), """{"position":2,"exerciseId":"face-pull"}""").isOpen)
        assertTrue(WindmillJson.decodeFromString(PlanEntry.serializer(), """{"exerciseId":"face-pull"}""").isOpen)
    }

    @Test
    fun testAProposalSideEncodesItsScheme() {
        assertEquals(
            """{"sets":[{"reps":5,"weightKg":60.0},{"reps":5,"weightKg":80.0},{"reps":3,"weightKg":90.0},""" +
                """{"reps":1,"weightKg":100.0},{"reps":5,"weightKg":80.0}]}""",
            WindmillJson.encodeToString(ProposalTargets.serializer(), ProposalTargets(sets = lowerARamp)))
        assertEquals("""{"sets":[{"weightKg":100.0}]}""",
            WindmillJson.encodeToString(ProposalTargets.serializer(), ProposalTargets(sets = listOf(SetTarget(weightKg = 100.0)))))
        assertEquals("""{"sets":[{"reps":5}]}""",
            WindmillJson.encodeToString(ProposalTargets.serializer(), ProposalTargets(sets = listOf(SetTarget(reps = 5)))))
        assertEquals("""{"sets":[{}]}""",
            WindmillJson.encodeToString(ProposalTargets.serializer(), ProposalTargets(sets = listOf(SetTarget()))))
    }

    @Test
    fun testASetDecodesTheLogsOwnNumberingAndDefaultsTheRest() {
        val set = json.decodeFromString(TrainingSet.serializer(), """
        { "id": "set_1", "exerciseId": "back-squat", "setNumber": 3, "weightKg": 105,
          "reps": 5, "completedAt": 1754300000000 }
        """)

        assertEquals(3, set.setNumber)
        assertEquals("note is a String on the wire, so an absent one is empty and not missing", "", set.note)
        assertNull(set.rpe)
        assertEquals(1_754_300_000_000, set.completedAtMs)
    }

    @Test
    fun testAnAbsentOptionalIsOmittedRatherThanWrittenAsNull() {
        val queued = TrainingSet(id = "set_1", exerciseId = "bench-press", weightKg = 82.5, reps = 5,
                                 completedAtMs = 1_754_300_000_000)
        val written = fields(queued)

        assertNull("a set this device minted has no number until the log gives it one", written["setNumber"])
        assertNull(written["rpe"])
        assertEquals(1_754_300_000_000, written["completedAt"]?.jsonPrimitive?.long)
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
    fun testARowWithNoSetCarriesNoTopSetAndWasNotClosedByTheRule() {
        val row = json.decodeFromString(SessionSummary.serializer(), """
        { "id": "ses_2", "startedAt": 1754300000000, "finishedAt": 1754303720000, "setCount": 2 }
        """)

        assertNull(row.topSet)
        assertFalse(row.closedItself)
    }

    @Test
    fun aPlannedLineStandsOnItsHeaviestNamedSetAndAnOpenLineOnNothing() {
        val ramp = PlannedLine(listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)))
        assertEquals(SetTarget(1, 100.0), ramp.top)
        assertEquals(SetTarget(8, null), PlannedLine(listOf(SetTarget(8, null), SetTarget(6, null))).top)
        assertTrue(PlannedLine().isOpen)
        assertNull(PlannedLine().top)
    }

    // A receipt is saved across a process restart with its record whole, however large the load it names.
    @Test
    fun aReceiptsReviewRoundTripsThroughSavedStateWithoutAnInfiniteNumber() {
        val review = Review(PersonalRecord("heaviest", "bench-press", Double.MAX_VALUE, Double.MAX_VALUE, 8, 80.0, 1_000),
            Against("before", "Push A", 1_000, listOf(AgainstMovement("bench-press", Effort(4, 8, Double.MAX_VALUE, minReps = 5, minWeightKg = 80.0),
                Effort(4, 5, 80.0), PlannedLine(listOf(SetTarget(5, 80.0)))))))
        val saved = WindmillJson.encodeToString(Review.serializer(), review)
        assertEquals(review, WindmillJson.decodeFromString(Review.serializer(), saved))
        assertFalse(saved.contains("Infinity") || saved.contains("NaN"))
    }

    @Test
    fun testARoutineCarriesItsOwnOrderAndItsLastTrainedStamp() {
        val routine = json.decodeFromString(Routine.serializer(), """
        { "id": "rt_9f", "name": "Push A", "position": 0, "lastTrainedAt": 1754300000000,
          "entries": [ { "position": 1, "exerciseId": "bench-press",
                         "sets": [ { "reps": 5, "weightKg": 82.5 }, { "reps": 5, "weightKg": 82.5 },
                                   { "reps": 5, "weightKg": 82.5 } ],
                         "restSeconds": 180 } ] }
        """)

        assertEquals(1_754_300_000_000L, routine.lastTrainedAtMs)
        assertEquals(
            listOf(RoutineEntry(position = 1, exerciseId = "bench-press",
                                sets = List(3) { SetTarget(5, 82.5) }, restSeconds = 180)),
            routine.entries)
    }

    @Test
    fun testARoutineNeverTrainedHasNoStampAtAll() {
        val routine = json.decodeFromString(Routine.serializer(),
                                            """{"id":"rt_1","name":"Pull A","position":1,"entries":[]}""")

        assertNull(routine.lastTrainedAtMs)
    }
}





class SchemeTests {
    @Test
    fun testRampingUpDrawsAStraightLineFromSetOneToTheTopSet() {
        val ends = listOf(SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(1, 100.0))

        assertTrue(Scheme.canRamp(ends))
        assertEquals(
            listOf(SetTarget(5, 60.0), SetTarget(4, 70.0), SetTarget(3, 80.0), SetTarget(2, 90.0), SetTarget(1, 100.0)),
            Scheme.rampUp(ends))
    }

    @Test
    fun testAColumnWhoseEndsAreNotBothNamedIsLeftAsItStands() {
        val loadsOnly = listOf(SetTarget(null, 60.0), SetTarget(3, 70.0), SetTarget(5, 100.0))
        assertEquals(listOf(SetTarget(null, 60.0), SetTarget(3, 80.0), SetTarget(5, 100.0)), Scheme.rampUp(loadsOnly))

        val repsOnly = listOf(SetTarget(8, null), SetTarget(3, 70.0), SetTarget(2, 100.0))
        assertEquals(listOf(SetTarget(8, null), SetTarget(5, 70.0), SetTarget(2, 100.0)), Scheme.rampUp(repsOnly))
    }

    @Test
    fun testThereIsNothingToRampBetweenTwoSetsOrBetweenEndsThatAgree() {
        val two = listOf(SetTarget(5, 60.0), SetTarget(1, 100.0))
        assertFalse(Scheme.canRamp(two))
        assertEquals(two, Scheme.rampUp(two))

        val flat = listOf(SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(5, 80.000001))
        assertFalse("the ends agree on the ladder's grid", Scheme.canRamp(flat))
        assertEquals(flat, Scheme.rampUp(flat))
    }

    // Each interpolated load lands on the plate grid of the band it stands in — the band's SMALL
    // step, half away from zero — never on hundredths. Over 20 → 22.5 the middle set's 21.25 sits
    // in the 20–50 band, whose small step is 2.5, and lands on 22.5.
    @Test
    fun testTheLoadsBetweenTheEndsLandOnThePlateGrid() {
        val fives = listOf(SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(5, 100.0))
        assertEquals(listOf(60.0, 70.0, 80.0, 90.0, 100.0), Scheme.rampUp(fives).map { it.weightKg })

        val light = listOf(SetTarget(5, 20.0), SetTarget(5, 20.0), SetTarget(5, 22.5))
        assertEquals(listOf(20.0, 22.5, 22.5), Scheme.rampUp(light).map { it.weightKg })

        val thirds = listOf(SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(5, 60.0), SetTarget(5, 100.0))
        assertEquals("73.33 and 86.67 are 72.5 and 87.5 on the grid",
                     listOf(60.0, 72.5, 87.5, 100.0), Scheme.rampUp(thirds).map { it.weightKg })

        val ends = listOf(SetTarget(5, 61.0), SetTarget(5, 61.0), SetTarget(5, 101.0))
        assertEquals("the two ends stand as typed; only the sets between are snapped",
                     listOf(61.0, 80.0, 101.0), Scheme.rampUp(ends).map { it.weightKg })
    }

    @Test
    fun testAStraightSchemeIsOneWhoseSetsAgreeOnTheLaddersGrid() {
        assertTrue(Scheme.straight(List(3) { SetTarget(8, 60.0) }))
        assertTrue(Scheme.straight(listOf(SetTarget(8, 60.0), SetTarget(8, 60.004))))
        assertFalse(Scheme.straight(lowerARamp))
        assertFalse("an open line is not a straight scheme", Scheme.straight(emptyList()))
        assertTrue(Scheme.same(listOf(SetTarget(5, 82.5)), listOf(SetTarget(5, 82.500000001))))
    }
}


class PrefillTests {
    private fun aSet(weightKg: Double, reps: Int, at: Long): TrainingSet =
        TrainingSet(id = "set_$at", exerciseId = "bench-press", weightKg = weightKg,
                    reps = reps, completedAtMs = at)

    private val pushA = PlanEntry(exerciseId = "bench-press", sets = List(5) { SetTarget(5, 82.5) })

    private val lowerA = PlanEntry(exerciseId = "back-squat", sets = lowerARamp)

    @Test
    fun testWithNoPlanAndNoHistoryThePadOpensOnTheEmptyBar() {
        val prefill = Prefill.of(todaySets = emptyList(), planEntry = null, lastTime = null)

        assertEquals(Prefill(weightKg = 20.0, reps = 5), prefill)
    }

    @Test
    fun testTodaysLastSetWinsOverThePlanAndOverLastTime() {
        val prefill = Prefill.of(
            todaySets = listOf(aSet(82.5, 5, at = 100), aSet(85.0, 3, at = 200)),
            planEntry = pushA,
            lastTime = LastTime(exerciseId = "bench-press", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(80.0, 8, at = 1)))
        )

        assertEquals(Prefill(weightKg = 85.0, reps = 3), prefill)
    }

    @Test
    fun testThePlansTargetBeatsLastTimeBeforeAnythingIsLifted() {
        val prefill = Prefill.of(
            todaySets = emptyList(),
            planEntry = pushA,
            lastTime = LastTime(exerciseId = "bench-press", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(80.0, 8, at = 1)))
        )

        assertEquals(Prefill(weightKg = 82.5, reps = 5), prefill)
    }

    @Test
    fun testOnASchemeWhoseSetsDisagreeThePadFollowsTheSlot() {
        val rack = Prefill.of(
            todaySets = listOf(aSet(60.0, 5, at = 100), aSet(80.0, 5, at = 200)),
            planEntry = lowerA,
            lastTime = null
        )
        assertEquals("two sets landed, so the third set's numbers", Prefill(90.0, 3), rack)

        assertEquals("before anything is lifted, set 1", Prefill(60.0, 5),
                     Prefill.of(todaySets = emptyList(), planEntry = lowerA, lastTime = null))
        assertEquals("each set advances the slot", Prefill(80.0, 5),
                     Prefill.of(todaySets = listOf(aSet(40.0, 10, at = 100)),
                                planEntry = lowerA, lastTime = null))
    }

    @Test
    fun testPastTheEndOfTheSchemeThePadFallsToLastTimesNthSetThenToday() {
        val fiveLanded = lowerARamp.mapIndexed { index, set -> aSet(set.weightKg!!, set.reps!!, at = 100L * (index + 1)) }
        val lastTime = LastTime(exerciseId = "back-squat", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = List(6) { aSet(70.0, 6, at = 1L + it) })

        assertEquals("last time's sixth set", Prefill(70.0, 6),
                     Prefill.of(todaySets = fiveLanded, planEntry = lowerA, lastTime = lastTime))
        assertEquals("and with no sixth set last time, today's last set", Prefill(80.0, 5),
                     Prefill.of(todaySets = fiveLanded, planEntry = lowerA, lastTime = null))
    }

    @Test
    fun testASlotThatNamesNoLoadTakesLastTimesNthSetsLoad() {
        val topSetToLastTime = PlanEntry(exerciseId = "back-squat",
                                         sets = listOf(SetTarget(5, 60.0), SetTarget(3, null), SetTarget(null, null)))
        val lastTime = LastTime(exerciseId = "back-squat", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(60.0, 5, at = 1), aSet(95.0, 3, at = 2), aSet(100.0, 2, at = 3)))

        assertEquals(Prefill(95.0, 3),
                     Prefill.of(todaySets = listOf(aSet(60.0, 5, at = 100)), planEntry = topSetToLastTime, lastTime = lastTime))
        assertEquals("a max set takes last time's reps too", Prefill(100.0, 2),
                     Prefill.of(todaySets = listOf(aSet(60.0, 5, at = 100), aSet(95.0, 3, at = 200)),
                                planEntry = topSetToLastTime, lastTime = lastTime))
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
    fun testEverySetCanSupplyTheStickyWeight() {
        val afterOneSet = Prefill.of(
            todaySets = listOf(aSet(40.0, 10, at = 100)),
            planEntry = pushA,
            lastTime = null
        )
        assertEquals("the last set supplies the rack", Prefill(weightKg = 40.0, reps = 10), afterOneSet)

        val afterThreeSets = Prefill.of(
            todaySets = listOf(aSet(40.0, 10, at = 100),
                               aSet(85.0, 5, at = 200),
                               aSet(65.0, 3, at = 300)),
            planEntry = pushA,
            lastTime = null
        )
        assertEquals("the last set is the one the thumb is following",
                     Prefill(weightKg = 65.0, reps = 3), afterThreeSets)
    }

    @Test
    fun testAPlanWithNoRepTargetFallsThroughToLastTimeRatherThanToZero() {
        val threeToMax = PlanEntry(exerciseId = "chin-up", sets = List(3) { SetTarget() })
        val prefill = Prefill.of(
            todaySets = emptyList(),
            planEntry = threeToMax,
            lastTime = LastTime(exerciseId = "chin-up", session = Session(id = "ses_p", startedAtMs = 1),
                                sets = listOf(aSet(0.0, 9, at = 1), aSet(0.0, 6, at = 2)))
        )

        assertEquals(Prefill(weightKg = 0.0, reps = 9), prefill)
        assertEquals("and with no history at all, the empty bar",
                     Prefill(weightKg = 20.0, reps = 5),
                     Prefill.of(todaySets = emptyList(), planEntry = threeToMax, lastTime = null))
    }

    @Test
    fun testAPlanWithNoTargetWeightStillGivesItsReps() {
        val prefill = Prefill.of(
            todaySets = emptyList(),
            planEntry = PlanEntry(exerciseId = "chin-up", sets = List(3) { SetTarget(reps = 8) }),
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
