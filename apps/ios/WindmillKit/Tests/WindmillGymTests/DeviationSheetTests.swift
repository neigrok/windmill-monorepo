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
        PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
        PlanEntry(exerciseId: "chin-up", sets: 3, reps: 8),
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
                PlanEntry(exerciseId: "overhead-press", sets: 3, reps: 8, weightKg: 45),
                PlanEntry(exerciseId: "bench-press", sets: 3, reps: 8, weightKg: 80),
                PlanEntry(exerciseId: "bench-press", sets: 1, reps: 3, weightKg: 100),
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
}
