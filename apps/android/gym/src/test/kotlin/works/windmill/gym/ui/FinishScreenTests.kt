package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.Against
import works.windmill.gym.domain.AgainstMovement
import works.windmill.gym.domain.Effort
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.PersonalRecord
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.ReviewStats
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.Target
import works.windmill.gym.domain.TrainingSet

// The end of a session, read. Nothing here computes a review — what is pinned is the reading: which
// word goes above a short session, which slot stays EMPTY on the ordinary 190 in 200, and the one
// comparison row that is not an arrow.

private val catalog = listOf(
    Exercise(id = "back-squat", name = "Back Squat"),
    Exercise(id = "leg-press", name = "Leg Press"),
)

class FinishTests {
    private val started = 1_754_308_320_000L     // Tue 4 Aug 2025, 18:12 local
    private val finished = started + 3_720_000L

    @Test
    fun aFinishedSessionIsTitledByItsRoutineAndAShortOneByItsEndingEarly() {
        val ordinary = Finish.head(startedAtMs = started, finishedAtMs = finished,
                                   routine = "Legs", slight = false, first = false)
        assertEquals("Session finished", ordinary.title)
        assertEquals("Legs", ordinary.subtitle)
        assertEquals("${Readout.day(started)} · ${Readout.time(started)} – ${Readout.time(finished)}",
                     ordinary.at)

        val short = Finish.head(startedAtMs = started, finishedAtMs = finished,
                                routine = "Pull A", slight = true, first = false)
        assertEquals("a short session is asked about, never congratulated", "Ended early", short.title)
        assertEquals("Pull A", short.subtitle)
    }

    // Whether one came before it is a question about the LOG, not about this session.
    @Test
    fun aSessionWithNoRoutineIsNamedByWhetherItIsTheFirstOne() {
        assertEquals("Your first session",
                     Finish.head(startedAtMs = started, finishedAtMs = finished,
                                 routine = null, slight = false, first = true).subtitle)
        assertEquals("No routine",
                     Finish.head(startedAtMs = started, finishedAtMs = finished,
                                 routine = null, slight = false, first = false).subtitle)
    }

    @Test
    fun theThreeFactsAreDurationWorkingSetsAndTopE1rm() {
        val tiles = Finish.tiles(ReviewStats(durationMs = 3_720_000, workingSets = 16, topE1rm = 122.5))
        assertEquals(listOf("Duration", "Working sets", "Top e1RM"), tiles.map { it.label })
        assertEquals(listOf("1h 02m", "16", "122.5"), tiles.map { it.value })
    }

    // A session with no loaded working set has no honest one-rep estimate — a chin-up at zero and a
    // band-assisted pull-up at −20 have none — so the tile says nothing with a dash rather than
    // printing a zero nobody lifted.
    @Test
    fun aSessionWithNoLoadedSetShowsADashRatherThanAZero() {
        val tiles = Finish.tiles(ReviewStats(durationMs = 660_000, workingSets = 3, topE1rm = null))
        assertEquals(listOf("11m", "3", "—"), tiles.map { it.value })
    }

    // The empty slot is a decision: on an ordinary session nothing takes the record line's place.
    @Test
    fun noRecordDrawsNoLineAtAll() {
        assertNull(Finish.recordSentence(null, catalog))
    }

    // The mark that was passed is named beside the one that passed it — a record with nothing to
    // compare against is a first entry, and a first entry is not a record.
    @Test
    fun eachKindOfRecordNamesWhatItBeatAndWhen() {
        val past = 1_750_723_200_000L
        val e1rm = PersonalRecord(kind = "e1rm", exerciseId = "back-squat", value = 122.5,
                                  weightKg = 105.0, reps = 5, previous = 116.7, previousAtMs = past)
        assertEquals("Back Squat e1RM 122.5 kg — past 116.7 from ${Readout.day(past)}.",
                     Finish.recordSentence(e1rm, catalog))

        val heaviest = PersonalRecord(kind = "heaviest", exerciseId = "back-squat", value = 140.0,
                                      weightKg = 140.0, reps = 1, previous = 135.0, previousAtMs = past)
        assertEquals("Back Squat 140 kg × 1 — past 135 from ${Readout.day(past)}.",
                     Finish.recordSentence(heaviest, catalog))

        val reps = PersonalRecord(kind = "reps-at-weight", exerciseId = "back-squat", value = 8.0,
                                  weightKg = 100.0, reps = 8, previous = 6.0, previousAtMs = past)
        assertEquals("Back Squat 8 reps at 100 kg — past 6 from ${Readout.day(past)}.",
                     Finish.recordSentence(reps, catalog))
    }

    // A kind this build has never heard of draws NOTHING. The slot is allowed to be empty, and a
    // sentence assembled out of a rule we do not know is the one thing it may not hold.
    @Test
    fun aRecordKindThisBuildHasNeverHeardOfDrawsNothing() {
        val unheard = PersonalRecord(kind = "volume-at-bodyweight", exerciseId = "back-squat",
                                     value = 9.0, weightKg = 100.0, reps = 9,
                                     previous = 8.0, previousAtMs = 1_750_723_200_000L)
        assertNull(Finish.recordSentence(unheard, catalog))
    }

    // The Swift wire carries `previous` always; this build's model permits its absence, and a
    // record with nothing named beside it is a first entry — not a record, not a line.
    @Test
    fun aRecordThatNamesNothingItBeatDrawsNothing() {
        val firstEntry = PersonalRecord(kind = "e1rm", exerciseId = "back-squat", value = 122.5,
                                        weightKg = 105.0, reps = 5)
        assertNull(Finish.recordSentence(firstEntry, catalog))
    }

    // The plan is what the lifter agreed to and the log is what happened, so the arrow points from
    // the plan when there was one.
    @Test
    fun theComparisonPointsFromThePlanAndFallsBackToLastTime() {
        val against = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1_750_723_200_000,
            movements = listOf(
                AgainstMovement(exerciseId = "back-squat",
                                now = Effort(sets = 5, reps = 5, weightKg = 105.0),
                                before = Effort(sets = 5, reps = 5, weightKg = 102.5),
                                planned = Target(sets = 5, reps = 5, weightKg = 102.5)),
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 12, weightKg = 140.0),
                                before = Effort(sets = 3, reps = 12, weightKg = 135.0)),
            ))
        val comparison = Finish.comparison(against, catalog)
        assertEquals("Against last Legs", comparison?.title)
        assertEquals(listOf("Back Squat", "Leg Press"), comparison?.rows?.map { it.movement })
        assertEquals(listOf("5×5 @ 102.5 → 5×5 @ 105", "3×12 @ 135 → 3×12 @ 140"),
                     comparison?.rows?.map { it.detail })
    }

    // The one row that is not an arrow: a session that did not get through what was written down
    // says so, because an arrow cannot.
    @Test
    fun aMovementThatFellShortOfThePlanSaysItPlainly() {
        val against = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 10, weightKg = 140.0),
                                planned = Target(sets = 3, reps = 12, weightKg = 140.0)),
            ))
        assertEquals(listOf("planned 3×12 · did 3×10"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    // Zero is not a load, it is the absence of one: a chin-up reads its count and nothing else.
    @Test
    fun aBodyweightMovementPrintsNoLoad() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 8, weightKg = 0.0),
                                before = Effort(sets = 3, reps = 7, weightKg = 0.0)),
            ))
        assertEquals(listOf("3×7 → 3×8"), Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    // A rep target the routine declined to set is `3 × max`, and a movement taken to max never fell
    // short of a count it does not have — so this row is an arrow and not the "planned … · did …"
    // sentence. The spacing follows review.js `countLabel`, so the two surfaces print one row alike.
    @Test
    fun aMovementWithNoRepTargetReadsAsMaxAndNeverAsAShortfall() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 6, weightKg = 0.0),
                                planned = Target(sets = 3)),
            ))
        assertEquals(listOf("3 × max → 3×6"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    // A `3 × max` plan cannot be fallen short of AT ALL: there is no rep target to miss, and a
    // count of sets is not something this wire can be read short on either (see the ramp below).
    @Test
    fun aPlanThatNamesNoRepTargetCannotBeFallenShortOf() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 2, reps = 4, weightKg = 0.0),
                                planned = Target(sets = 3)),
            ))
        assertEquals(listOf("3 × max → 2×4"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    // THE ROW THAT TOLD A FINISHED SESSION IT FELL SHORT. `now.sets` counts only the sets at the
    // TOP LOAD, so a lifter who ramped 100·105·110·110·110 through every one of five planned sets
    // arrives here as `sets: 3` — and a set-count term printed "planned 5×5 · did 3×5" in the
    // loudest row on the screen, over bytes the desk read as an arrow. Set counts are not
    // comparable on this wire and review.js has never compared them.
    @Test
    fun aSessionThatRampedThroughItsWholePlanIsNeverToldItFellShort() {
        val ramped = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "back-squat",
                                now = Effort(sets = 3, reps = 5, weightKg = 110.0),
                                before = Effort(sets = 3, reps = 5, weightKg = 105.0),
                                planned = Target(sets = 5, reps = 5, weightKg = 100.0)),
            ))
        assertEquals(listOf("5×5 @ 100 → 3×5 @ 110"),
                     Finish.comparison(ramped, catalog)?.rows?.map { it.detail })
    }

    // Nor is going heavier for fewer reps a smaller session: it is a different one, and the arrow
    // carries both facts without grading either.
    @Test
    fun goingHeavierForFewerRepsIsADifferentSessionAndNotASmallerOne() {
        val heavier = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 5, reps = 8, weightKg = 160.0),
                                planned = Target(sets = 3, reps = 12, weightKg = 140.0)),
            ))
        assertEquals(listOf("3×12 @ 140 → 5×8 @ 160"),
                     Finish.comparison(heavier, catalog)?.rows?.map { it.detail })
    }

    // What IS short: the reps at a load that did not go up — and a plan that names no load at all
    // is read on the reps alone, because there is no bar to have gone up.
    @Test
    fun whatIsCalledShortIsTheRepsAtALoadThatDidNotGoUp() {
        val heldLoad = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 10, weightKg = 140.0),
                                planned = Target(sets = 3, reps = 12, weightKg = 140.0)),
            ))
        assertEquals(listOf("planned 3×12 · did 3×10"),
                     Finish.comparison(heldLoad, catalog)?.rows?.map { it.detail })

        val noLoadNamed = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 6, weightKg = 0.0),
                                planned = Target(sets = 3, reps = 8)),
            ))
        assertEquals(listOf("planned 3×8 · did 3×6"),
                     Finish.comparison(noLoadNamed, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun anAdHocSessionHasNothingToCompareAgainst() {
        assertNull(Finish.comparison(null, catalog))
    }
}

class FinishedSessionTests {
    private fun session(routineId: String?) =
        Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 900_000, routineId = routineId)

    private val lifted = listOf(
        TrainingSet(id = "set_1", exerciseId = "back-squat", weightKg = 100.0, reps = 5,
                    completedAtMs = 2_000),
    )

    // The offer belongs to a session that had nothing written down for it. A session started FROM
    // a routine already has one, and offering to keep it again would create a second copy of it.
    @Test
    fun keepingASessionAsARoutineIsOfferedOnlyWhenThereWasNoRoutine() {
        assertTrue(FinishedSession(session = session(routineId = null), sets = lifted,
                                   review = null, isFirst = true).offersRoutine)
        assertFalse(FinishedSession(session = session(routineId = "rt_1"), sets = lifted,
                                    review = null, isFirst = false).offersRoutine)
    }

    // A session of nothing but warmups has no targets to write down, and RoutineWrite would refuse
    // to compose one — so the offer is not made in the first place.
    @Test
    fun aSessionOfNothingButWarmupsIsNotOfferedAsARoutine() {
        val warmups = listOf(
            TrainingSet(id = "set_1", exerciseId = "back-squat", weightKg = 60.0, reps = 5,
                        kind = SetKind.Warmup, completedAtMs = 2_000),
        )
        assertFalse(FinishedSession(session = session(routineId = null), sets = warmups,
                                    review = null, isFirst = true).offersRoutine)
    }

    // SCREEN 11 WINS. A short ad-hoc session satisfied both, and drew "Keep this as a routine" /
    // "Save routine" directly above "Ended early" / "Keep it" / "Discard session" — two primary
    // buttons and two different "keep" verbs, asking the lifter to write this into their program
    // and to consider deleting it in the same scroll.
    @Test
    fun aShortSessionIsNeverAlsoOfferedAsARoutine() {
        val short = Review(stats = ReviewStats(durationMs = 660_000, workingSets = 3), slight = true)
        val ended = FinishedSession(session = session(routineId = null), sets = lifted,
                                    review = short, isFirst = true)

        assertTrue(ended.slight)
        assertFalse("too slight to say anything about is too slight to keep as a routine",
                    ended.offersRoutine)
        assertEquals("Ended early",
                     Finish.head(startedAtMs = 1_000, finishedAtMs = 900_000, routine = null,
                                 slight = ended.slight, first = ended.isFirst).title)
    }

    // A review that never came back cannot make a session slight — and slight is what offers the
    // one destructive action in the product, so it is never assumed.
    @Test
    fun withoutAReviewASessionIsNeverCalledShort() {
        assertFalse(FinishedSession(session = session(routineId = null), sets = lifted,
                                    review = null, isFirst = false).slight)

        val short = Review(stats = ReviewStats(durationMs = 660_000, workingSets = 3), slight = true)
        assertTrue(FinishedSession(session = session(routineId = null), sets = lifted,
                                   review = short, isFirst = false).slight)
    }
}
