import XCTest
@testable import WindmillGym

// The end of a session, read. Nothing here computes a review — what is pinned is the reading: which
// word goes above a short session, which slot stays EMPTY on the ordinary 190 in 200, and the one
// comparison row that is not an arrow.

private let catalog = [
    Exercise(id: "back-squat", name: "Back Squat"),
    Exercise(id: "leg-press", name: "Leg Press"),
]

final class FinishTests: XCTestCase {
    private let started: Int64 = 1_754_308_320_000     // Tue 4 Aug 2025, 18:12 local
    private var finished: Int64 { started + 3_720_000 }

    func testAFinishedSessionIsTitledByItsRoutineAndAShortOneByItsEndingEarly() {
        let ordinary = Finish.head(startedAtMs: started, finishedAtMs: finished,
                                   routine: "Legs", slight: false, first: false)
        XCTAssertEqual(ordinary.title, "Session finished")
        XCTAssertEqual(ordinary.subtitle, "Legs")
        XCTAssertEqual(ordinary.when,
                       "\(Readout.day(started)) · \(Readout.time(started)) – \(Readout.time(finished))")

        let short = Finish.head(startedAtMs: started, finishedAtMs: finished,
                                routine: "Pull A", slight: true, first: false)
        XCTAssertEqual(short.title, "Ended early", "a short session is asked about, never congratulated")
        XCTAssertEqual(short.subtitle, "Pull A")
    }

    // Whether one came before it is a question about the LOG, not about this session.
    func testASessionWithNoRoutineIsNamedByWhetherItIsTheFirstOne() {
        XCTAssertEqual(Finish.head(startedAtMs: started, finishedAtMs: finished,
                                   routine: nil, slight: false, first: true).subtitle,
                       "Your first session")
        XCTAssertEqual(Finish.head(startedAtMs: started, finishedAtMs: finished,
                                   routine: nil, slight: false, first: false).subtitle,
                       "No routine")
    }

    func testTheThreeFactsAreDurationWorkingSetsAndTopE1rm() {
        let tiles = Finish.tiles(Review.Stats(durationMs: 3_720_000, workingSets: 16, topE1rm: 122.5))
        XCTAssertEqual(tiles.map(\.label), ["Duration", "Working sets", "Top e1RM"])
        XCTAssertEqual(tiles.map(\.value), ["1h 02m", "16", "122.5"])
    }

    // A session with no loaded working set has no honest one-rep estimate — a chin-up at zero and a
    // band-assisted pull-up at −20 have none — so the tile says nothing with a dash rather than
    // printing a zero nobody lifted.
    func testASessionWithNoLoadedSetShowsADashRatherThanAZero() {
        let tiles = Finish.tiles(Review.Stats(durationMs: 660_000, workingSets: 3, topE1rm: nil))
        XCTAssertEqual(tiles.map(\.value), ["11m", "3", "—"])
    }

    // The empty slot is a decision: on an ordinary session nothing takes the record line's place.
    func testNoRecordDrawsNoLineAtAll() {
        XCTAssertNil(Finish.recordSentence(nil, catalog: catalog))
    }

    // The mark that was passed is named beside the one that passed it — a record with nothing to
    // compare against is a first entry, and a first entry is not a record.
    func testEachKindOfRecordNamesWhatItBeatAndWhen() {
        let past: Int64 = 1_750_723_200_000
        let e1rm = PersonalRecord(kind: .e1rm, exerciseId: "back-squat", value: 122.5,
                                  weightKg: 105, reps: 5, previous: 116.7, previousAtMs: past)
        XCTAssertEqual(Finish.recordSentence(e1rm, catalog: catalog),
                       "Back Squat e1RM 122.5 kg — past 116.7 from \(Readout.day(past)).")

        let heaviest = PersonalRecord(kind: .heaviest, exerciseId: "back-squat", value: 140,
                                      weightKg: 140, reps: 1, previous: 135, previousAtMs: past)
        XCTAssertEqual(Finish.recordSentence(heaviest, catalog: catalog),
                       "Back Squat 140 kg × 1 — past 135 from \(Readout.day(past)).")

        let reps = PersonalRecord(kind: .repsAtWeight, exerciseId: "back-squat", value: 8,
                                  weightKg: 100, reps: 8, previous: 6, previousAtMs: past)
        XCTAssertEqual(Finish.recordSentence(reps, catalog: catalog),
                       "Back Squat 8 reps at 100 kg — past 6 from \(Readout.day(past)).")
    }

    // The plan is what the lifter agreed to and the log is what happened, so the arrow points from
    // the plan when there was one.
    func testTheComparisonPointsFromThePlanAndFallsBackToLastTime() {
        let against = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1_750_723_200_000, movements: [
            Against.Movement(exerciseId: "back-squat",
                             now: Against.Effort(weightKg: 105, reps: 5, sets: 5),
                             before: Against.Effort(weightKg: 102.5, reps: 5, sets: 5),
                             planned: Against.Target(sets: 5, reps: 5, weightKg: 102.5)),
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 140, reps: 12, sets: 3),
                             before: Against.Effort(weightKg: 135, reps: 12, sets: 3)),
        ])
        let comparison = Finish.comparison(against, catalog: catalog)
        XCTAssertEqual(comparison?.title, "Against last Legs")
        XCTAssertEqual(comparison?.rows.map(\.movement), ["Back Squat", "Leg Press"])
        XCTAssertEqual(comparison?.rows.map(\.detail),
                       ["5×5 @ 102.5 → 5×5 @ 105", "3×12 @ 135 → 3×12 @ 140"])
    }

    // The one row that is not an arrow: a session that did not get through what was written down
    // says so, because an arrow cannot.
    func testAMovementThatFellShortOfThePlanSaysItPlainly() {
        let against = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 140, reps: 10, sets: 3),
                             planned: Against.Target(sets: 3, reps: 12, weightKg: 140)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3×12 · did 3×10"])
    }

    // Zero is not a load, it is the absence of one: a chin-up reads its count and nothing else.
    func testABodyweightMovementPrintsNoLoad() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 8, sets: 3),
                             before: Against.Effort(weightKg: 0, reps: 7, sets: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail), ["3×7 → 3×8"])
    }

    // A rep target the routine declined to set is `3 × max`, and a movement taken to max never fell
    // short of a count it does not have — so this row is an arrow and not the "planned … · did …"
    // sentence. The spacing follows review.js `countLabel`, so the two surfaces print one row alike.
    func testAMovementWithNoRepTargetReadsAsMaxAndNeverAsAShortfall() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 6, sets: 3),
                             planned: Against.Target(sets: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["3 × max → 3×6"])
    }

    // Fewer sets than the plan is still a shortfall, whether or not the reps were named.
    func testFewerSetsThanThePlanIsSaidPlainlyEvenWithNoRepTarget() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 6, sets: 2),
                             planned: Against.Target(sets: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3 × max · did 2×6"])
    }

    func testAnAdHocSessionHasNothingToCompareAgainst() {
        XCTAssertNil(Finish.comparison(nil, catalog: catalog))
    }
}

final class FinishedSessionTests: XCTestCase {
    private func session(routineId: String?) -> Session {
        Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 900_000, routineId: routineId)
    }

    private let lifted = [TrainingSet(id: "set_1", exerciseId: "back-squat", weightKg: 100, reps: 5,
                                      completedAtMs: 2_000)]

    // The offer belongs to a session that had nothing written down for it. A session started FROM a
    // routine already has one, and offering to keep it again would create a second copy of it.
    func testKeepingASessionAsARoutineIsOfferedOnlyWhenThereWasNoRoutine() {
        XCTAssertTrue(FinishedSession(session: session(routineId: nil), sets: lifted,
                                      review: nil, isFirst: true).offersRoutine)
        XCTAssertFalse(FinishedSession(session: session(routineId: "rt_1"), sets: lifted,
                                       review: nil, isFirst: false).offersRoutine)
    }

    // A session of nothing but warmups has no targets to write down, and RoutineWrite would refuse
    // to compose one — so the offer is not made in the first place.
    func testASessionOfNothingButWarmupsIsNotOfferedAsARoutine() {
        let warmups = [TrainingSet(id: "set_1", exerciseId: "back-squat", weightKg: 60, reps: 5,
                                   kind: .warmup, completedAtMs: 2_000)]
        XCTAssertFalse(FinishedSession(session: session(routineId: nil), sets: warmups,
                                       review: nil, isFirst: true).offersRoutine)
    }

    // SCREEN 11 WINS. A short ad-hoc session satisfied both, and drew "Keep this as a routine" /
    // "Save routine" directly above "Ended early" / "Keep it" / "Discard session" — two primary
    // buttons and two different "keep" verbs, asking the lifter to write this into their program and
    // to consider deleting it in the same scroll.
    func testAShortSessionIsNeverAlsoOfferedAsARoutine() {
        let short = Review(stats: Review.Stats(durationMs: 660_000, workingSets: 3), slight: true)
        let ended = FinishedSession(session: session(routineId: nil), sets: lifted,
                                    review: short, isFirst: true)

        XCTAssertTrue(ended.slight)
        XCTAssertFalse(ended.offersRoutine,
                       "too slight to say anything about is too slight to keep as a routine")
        XCTAssertEqual(Finish.head(startedAtMs: 1_000, finishedAtMs: 900_000, routine: nil,
                                   slight: ended.slight, first: ended.isFirst).title, "Ended early")
    }

    // A review that never came back cannot make a session slight — and slight is what offers the one
    // destructive action in the product, so it is never assumed.
    func testWithoutAReviewASessionIsNeverCalledShort() {
        XCTAssertFalse(FinishedSession(session: session(routineId: nil), sets: lifted,
                                       review: nil, isFirst: false).slight)

        let short = Review(stats: Review.Stats(durationMs: 660_000, workingSets: 3), slight: true)
        XCTAssertTrue(FinishedSession(session: session(routineId: nil), sets: lifted,
                                      review: short, isFirst: false).slight)
    }
}
