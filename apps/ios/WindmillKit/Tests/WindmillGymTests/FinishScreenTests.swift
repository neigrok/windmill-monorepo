import XCTest
@testable import WindmillGym

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

    func testASessionWithNoLoadedSetShowsADashRatherThanAZero() {
        let tiles = Finish.tiles(Review.Stats(durationMs: 660_000, workingSets: 3, topE1rm: nil))
        XCTAssertEqual(tiles.map(\.value), ["11m", "3", "—"])
    }

    func testNoRecordDrawsNoLineAtAll() {
        XCTAssertNil(Finish.recordSentence(nil, catalog: catalog))
    }

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

    func testAMovementThatFellShortOfThePlanSaysItPlainly() {
        let against = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 140, reps: 10, sets: 3),
                             planned: Against.Target(sets: 3, reps: 12, weightKg: 140)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3×12 · did 3×10"])
    }

    func testABodyweightMovementPrintsNoLoad() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 8, sets: 3),
                             before: Against.Effort(weightKg: 0, reps: 7, sets: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail), ["3×7 → 3×8"])
    }

    func testAMovementWithNoRepTargetReadsAsMaxAndNeverAsAShortfall() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 6, sets: 3),
                             planned: Against.Target(sets: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["3 × max → 3×6"])
    }

    func testAPlanThatNamesNoRepTargetCannotBeFallenShortOf() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 4, sets: 2),
                             planned: Against.Target(sets: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["3 × max → 2×4"])
    }

    func testASessionThatRampedThroughItsWholePlanIsNeverToldItFellShort() {
        let ramped = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "back-squat",
                             now: Against.Effort(weightKg: 110, reps: 5, sets: 3),
                             before: Against.Effort(weightKg: 105, reps: 5, sets: 3),
                             planned: Against.Target(sets: 5, reps: 5, weightKg: 100)),
        ])
        XCTAssertEqual(Finish.comparison(ramped, catalog: catalog)?.rows.map(\.detail),
                       ["5×5 @ 100 → 3×5 @ 110"])
    }

    func testGoingHeavierForFewerRepsIsADifferentSessionAndNotASmallerOne() {
        let heavier = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 160, reps: 8, sets: 5),
                             planned: Against.Target(sets: 3, reps: 12, weightKg: 140)),
        ])
        XCTAssertEqual(Finish.comparison(heavier, catalog: catalog)?.rows.map(\.detail),
                       ["3×12 @ 140 → 5×8 @ 160"])
    }

    func testWhatIsCalledShortIsTheRepsAtALoadThatDidNotGoUp() {
        let heldLoad = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 140, reps: 10, sets: 3),
                             planned: Against.Target(sets: 3, reps: 12, weightKg: 140)),
        ])
        XCTAssertEqual(Finish.comparison(heldLoad, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3×12 · did 3×10"])

        let noLoadNamed = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 6, sets: 3),
                             planned: Against.Target(sets: 3, reps: 8)),
        ])
        XCTAssertEqual(Finish.comparison(noLoadNamed, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3×8 · did 3×6"])
    }

    func testAnAdHocSessionHasNothingToCompareAgainst() {
        XCTAssertNil(Finish.comparison(nil, catalog: catalog))
    }
}

final class DiscardTests: XCTestCase {
    func testDiscardIsAskedBeforeItRunsAndTheAskingSaysWhatItDeletes() {
        XCTAssertEqual(Finish.Discard.action, "Discard session")
        XCTAssertEqual(Finish.Discard.title, "Discard this session?")
        XCTAssertEqual(Finish.Discard.body,
                       "Discarding deletes the session and its sets. There is no undoing it.")
        XCTAssertEqual(Finish.Discard.confirm, "Discard")
        XCTAssertEqual(Finish.Discard.keep, "Keep it")
    }
}

final class FinishedSessionTests: XCTestCase {
    private func session(routineId: String?) -> Session {
        Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 900_000, routineId: routineId)
    }

    private let lifted = [TrainingSet(id: "set_1", exerciseId: "back-squat", weightKg: 100, reps: 5,
                                      completedAtMs: 2_000)]

    func testKeepingASessionAsARoutineIsOfferedOnlyWhenThereWasNoRoutine() {
        XCTAssertTrue(FinishedSession(session: session(routineId: nil), sets: lifted,
                                      review: nil, isFirst: true).offersRoutine)
        XCTAssertFalse(FinishedSession(session: session(routineId: "rt_1"), sets: lifted,
                                       review: nil, isFirst: false).offersRoutine)
    }

    func testASessionOfNothingButWarmupsIsNotOfferedAsARoutine() {
        let warmups = [TrainingSet(id: "set_1", exerciseId: "back-squat", weightKg: 60, reps: 5,
                                   kind: .warmup, completedAtMs: 2_000)]
        XCTAssertFalse(FinishedSession(session: session(routineId: nil), sets: warmups,
                                       review: nil, isFirst: true).offersRoutine)
    }

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

    func testWithoutAReviewASessionIsNeverCalledShort() {
        XCTAssertFalse(FinishedSession(session: session(routineId: nil), sets: lifted,
                                       review: nil, isFirst: false).slight)

        let short = Review(stats: Review.Stats(durationMs: 660_000, workingSets: 3), slight: true)
        XCTAssertTrue(FinishedSession(session: session(routineId: nil), sets: lifted,
                                      review: short, isFirst: false).slight)
    }
}
