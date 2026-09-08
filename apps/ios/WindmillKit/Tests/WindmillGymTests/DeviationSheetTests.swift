import XCTest
@testable import WindmillGym

private func aSet(_ exerciseId: String, _ weightKg: Double, kind: SetKind = .working,
                  at completedAtMs: Int64 = 1_000) -> TrainingSet {
    TrainingSet(id: "set_\(exerciseId)_\(Int(weightKg))_\(completedAtMs)", exerciseId: exerciseId,
                weightKg: weightKg, reps: 5, kind: kind, completedAtMs: completedAtMs)
}

private let pushA = Session(
    id: "ses_1", startedAtMs: 1_000, routineId: "rt_push_a",
    plan: PlanSnapshot(routine: "Push A", entries: [
        PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5)),
        PlanEntry(exerciseId: "chin-up", sets: Array(repeating: SetTarget(reps: 8), count: 3)),
    ])
)

final class DeviationTests: XCTestCase {
    func testAHeavierWorkingSetRaisesTheOfferAgainstThePlansWeight() {
        let deviation = Deviation(leaving: "bench-press", session: pushA,
                                  sets: [aSet("bench-press", 82.5), aSet("bench-press", 87.5, at: 2_000)],
                                  asked: [])
        XCTAssertEqual(deviation?.plannedKg, 82.5)
        XCTAssertEqual(deviation?.liftedKg, 87.5)
        XCTAssertEqual(deviation?.routine, "Push A")
        XCTAssertEqual(deviation?.routineId, "rt_push_a")
        XCTAssertEqual(deviation?.position, 1)
        XCTAssertEqual(deviation?.saveLabel, "Save 87.5 to Push A")
        XCTAssertEqual(deviation?.sentence(movement: "Bench Press"),
                       "Today’s Bench Press ran at 87.5 against a planned 82.5. "
                       + "Today’s session already has it. Push A does not.")
    }

    func testALighterSessionIsNeverOfferedToTheProgram() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 75)], asked: []))
    }

    func testMatchingThePlanAsksNothing() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 82.5)], asked: []))
    }

    func testAWarmupOrADropNeverRaisesTheOffer() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 100, kind: .warmup),
                                      aSet("bench-press", 100, kind: .drop, at: 2_000),
                                      aSet("bench-press", 100, kind: .failure, at: 3_000)],
                               asked: []))
    }

    func testAMovementAlreadyAskedAboutIsNotAskedAgain() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 87.5)], asked: ["bench-press"]))
    }

    func testWithNothingWrittenDownThereIsNothingToChange() {
        let adHoc = Session(id: "ses_2", startedAtMs: 1_000)
        XCTAssertNil(Deviation(leaving: "bench-press", session: adHoc,
                               sets: [aSet("bench-press", 87.5)], asked: []))
        XCTAssertNil(Deviation(leaving: "chin-up", session: pushA,
                               sets: [aSet("chin-up", 10)], asked: []))
        XCTAssertNil(Deviation(leaving: "cable-fly", session: pushA,
                               sets: [aSet("cable-fly", 30)], asked: []),
                     "a movement the plan never named cannot have been deviated from")
    }

    func testTheOfferCarriesTheHeaviestWorkingSetAndNotTheLast() {
        let deviation = Deviation(leaving: "bench-press", session: pushA,
                                  sets: [aSet("bench-press", 90, at: 2_000),
                                         aSet("bench-press", 85, at: 3_000)],
                                  asked: [])
        XCTAssertEqual(deviation?.liftedKg, 90)
    }

    func testWhenTheMovementIsPlannedTwiceTheOfferIsAgainstTheHeaviestLine() {
        let topAndBackOff = Session(
            id: "ses_3", startedAtMs: 1_000, routineId: "rt_push_b",
            plan: PlanSnapshot(routine: "Push B", entries: [
                PlanEntry(exerciseId: "overhead-press", sets: Array(repeating: SetTarget(reps: 8, weightKg: 45), count: 3)),
                PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 8, weightKg: 80), count: 3)),
                PlanEntry(exerciseId: "bench-press", sets: [SetTarget(reps: 3, weightKg: 100)]),
            ])
        )

        let deviation = Deviation(leaving: "bench-press", session: topAndBackOff,
                                  sets: [aSet("bench-press", 105), aSet("bench-press", 82.5, at: 2_000)],
                                  asked: [])
        XCTAssertEqual(deviation?.exerciseId, "bench-press")
        XCTAssertEqual(deviation?.routineId, "rt_push_b")
        XCTAssertEqual(deviation?.routine, "Push B")
        XCTAssertEqual(deviation?.position, 3)
        XCTAssertEqual(deviation?.plannedKg, 100)
        XCTAssertEqual(deviation?.liftedKg, 105)

        XCTAssertNil(Deviation(leaving: "bench-press", session: topAndBackOff,
                               sets: [aSet("bench-press", 90)], asked: []),
                     "heavier than the back-off but not the top set is the program as written")
    }

    // R8: on a straight scheme the offer is every load at the lifted weight; on a ladder it is the sets as lifted.
    func testAStraightSchemeOffersEveryLoadAtTheLiftedWeight() {
        let deviation = Deviation(leaving: "bench-press", session: pushA,
                                  sets: [aSet("bench-press", 82.5), aSet("bench-press", 87.5, at: 2_000)],
                                  asked: [])
        XCTAssertEqual(deviation?.isLadder, false)
        XCTAssertEqual(deviation?.planned, Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5))
        XCTAssertEqual(deviation?.offered, Array(repeating: SetTarget(reps: 5, weightKg: 87.5), count: 5))
        XCTAssertEqual(deviation?.saveLabel, "Save 87.5 to Push A")
    }

    func testALadderOffersTheSetsAsLifted() {
        let lowerA = Session(
            id: "ses_2", startedAtMs: 1_000, routineId: "rt_lower_a",
            plan: PlanSnapshot(routine: "Lower A", entries: [
                PlanEntry(exerciseId: "back-squat", sets: [
                    SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 90),
                    SetTarget(reps: 1, weightKg: 100), SetTarget(reps: 5, weightKg: 80),
                ]),
            ])
        )
        let lifted = [(60.0, 5), (80.0, 5), (90.0, 3), (102.5, 1), (80.0, 5)].enumerated().map { index, set in
            TrainingSet(id: "set_\(index)", exerciseId: "back-squat", weightKg: set.0, reps: set.1,
                        completedAtMs: Int64(index + 1) * 1_000)
        }
        let deviation = Deviation(leaving: "back-squat", session: lowerA, sets: lifted, asked: [])
        XCTAssertEqual(deviation?.isLadder, true)
        XCTAssertEqual(deviation?.plannedKg, 100)
        XCTAssertEqual(deviation?.liftedKg, 102.5)
        XCTAssertEqual(deviation?.offered, [
            SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 90),
            SetTarget(reps: 1, weightKg: 102.5), SetTarget(reps: 5, weightKg: 80),
        ])
        XCTAssertEqual(deviation?.saveLabel, "Save today’s sets")
        XCTAssertNil(Deviation(leaving: "back-squat", session: lowerA, sets: Array(lifted.prefix(3)), asked: []),
                     "a ramp run short of its top set beat nothing")
    }

    // F4: a ladder's offer is the sets as lifted, and a line holds twenty — past that no sheet rises.
    func testALadderRunToTwentyOneWorkingSetsIsNotOfferedBecauseNothingCouldBeSaved() {
        let lowerA = Session(
            id: "ses_2", startedAtMs: 1_000, routineId: "rt_lower_a",
            plan: PlanSnapshot(routine: "Lower A", entries: [
                PlanEntry(exerciseId: "back-squat", sets: [
                    SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 90),
                    SetTarget(reps: 1, weightKg: 100), SetTarget(reps: 5, weightKg: 80),
                ]),
            ])
        )
        let twentyOne = (0..<21).map { index in
            TrainingSet(id: "set_\(index)", exerciseId: "back-squat", weightKg: index == 20 ? 102.5 : 80, reps: 5,
                        completedAtMs: Int64(index + 1) * 1_000)
        }
        XCTAssertNil(Deviation(leaving: "back-squat", session: lowerA, sets: twentyOne, asked: []))
        XCTAssertEqual(Deviation(leaving: "back-squat", session: lowerA, sets: Array(twentyOne.dropFirst()), asked: [])?.offered.count, 20,
                       "twenty is the last count the sheet can save")
        XCTAssertEqual(Deviation(leaving: "bench-press", session: pushA, sets: twentyOne.map {
            TrainingSet(id: $0.id, exerciseId: "bench-press", weightKg: $0.weightKg, reps: 5, completedAtMs: $0.completedAtMs)
        }, asked: [])?.offered, Array(repeating: SetTarget(reps: 5, weightKg: 102.5), count: 5),
                       "a straight scheme's offer is the plan's own count at the lifted load, so it still rises")
    }
}
