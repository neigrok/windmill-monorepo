import XCTest
@testable import WindmillGym

// The one question gym asks that it did not have to. What is pinned here is mostly what it does NOT
// ask: not without a routine, not about a warmup, not twice, and not when the weight went down.

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
        XCTAssertEqual(deviation?.saveLabel, "Save 87.5 to Push A")
        XCTAssertEqual(deviation?.sentence(movement: "Bench Press"),
                       "Today’s Bench Press ran at 87.5 against a planned 82.5. "
                       + "Today’s session already has it. Push A does not.")
    }

    // ONLY HEAVIER. Dropping the weight mid-exercise is a bad night far more often than it is a
    // decision, and writing that back would lower next week's target off one session.
    func testALighterSessionIsNeverOfferedToTheProgram() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 75)], asked: []))
    }

    func testMatchingThePlanAsksNothing() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 82.5)], asked: []))
    }

    // Warmups, drops and failures are not what the session was, so none of them can raise the offer:
    // a ramp-up above the working weight is not a program change.
    func testAWarmupOrADropNeverRaisesTheOffer() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 100, kind: .warmup),
                                      aSet("bench-press", 100, kind: .drop, at: 2_000),
                                      aSet("bench-press", 100, kind: .failure, at: 3_000)],
                               asked: []))
    }

    // Asked ONCE, when you leave the exercise — never again this session.
    func testAMovementAlreadyAskedAboutIsNotAskedAgain() {
        XCTAssertNil(Deviation(leaving: "bench-press", session: pushA,
                               sets: [aSet("bench-press", 87.5)], asked: ["bench-press"]))
    }

    // An ad-hoc session has no program to change, and a routine line that named no weight named no
    // target to deviate from — 3 × max is a movement taken to whatever it gives that day.
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

    // The heaviest working set is what the offer carries, not the last one — a back-off set after a
    // top single is not the number next week should be aimed at.
    func testTheOfferCarriesTheHeaviestWorkingSetAndNotTheLast() {
        let deviation = Deviation(leaving: "bench-press", session: pushA,
                                  sets: [aSet("bench-press", 90, at: 2_000),
                                         aSet("bench-press", 85, at: 3_000)],
                                  asked: [])
        XCTAssertEqual(deviation?.liftedKg, 90)
    }
}
