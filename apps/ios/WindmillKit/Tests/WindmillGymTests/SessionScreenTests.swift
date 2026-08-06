import XCTest
@testable import WindmillGym

// A session read back is the workout as it was LIVED: movements in the order they were first
// touched, sets inside a movement in the order they were performed. Nothing here re-sorts by load,
// by number or by name — an order that disagreed with the session would be a second account of it.

final class SessionScreenTests: XCTestCase {
    private let catalog = [Exercise(id: "bench-press", name: "Bench press"),
                           Exercise(id: "row", name: "Barbell row")]

    private func set(_ id: String, _ exerciseId: String, _ weightKg: Double, _ reps: Int,
                     at completedAtMs: Int64, number: Int? = nil,
                     kind: SetKind = .working) -> TrainingSet {
        TrainingSet(id: id, exerciseId: exerciseId, setNumber: number, weightKg: weightKg,
                    reps: reps, kind: kind, completedAtMs: completedAtMs)
    }

    // Interleaved on the clock — a lifter supersetting two movements — and grouped on screen, with
    // the movement order taken from when each was FIRST touched.
    func testSetsAreGroupedByMovementInTheOrderTheyWereFirstTouched() {
        let movements = Performed.movements([
            set("s4", "row", 60, 10, at: 4_000, number: 2),
            set("s1", "bench-press", 80, 5, at: 1_000, number: 1),
            set("s3", "bench-press", 82.5, 5, at: 3_000, number: 2),
            set("s2", "row", 60, 10, at: 2_000, number: 1),
        ], catalog: catalog)

        XCTAssertEqual(movements.map(\.movement), ["Bench press", "Barbell row"])
        XCTAssertEqual(movements[0].rows.map(\.id), ["s1", "s3"])
        XCTAssertEqual(movements[1].rows.map(\.id), ["s2", "s4"])
        XCTAssertEqual(movements[0].rows.map(\.effort), ["80 × 5", "82.5 × 5"])
        XCTAssertEqual(movements[0].rows.map(\.number), ["1", "2"])
    }

    // The number is the LOG's own count of this movement in this session. A row that somehow arrives
    // without one is still numbered, from its place in the movement's own run — a numberless row in a
    // column of numbers reads as a set that did not count.
    func testASetWithNoNumberFromTheLogIsNumberedByItsPlaceInTheRun() {
        let movements = Performed.movements([
            set("s1", "bench-press", 80, 5, at: 1_000),
            set("s2", "bench-press", 80, 5, at: 2_000),
        ], catalog: catalog)

        XCTAssertEqual(movements[0].rows.map(\.number), ["1", "2"])
    }

    // A warmup counts toward nothing — not the records, not the prefill, not the comparison — so the
    // kind travels to the screen rather than being flattened into a row that looks like a working set.
    func testTheKindTravelsSoAWarmupIsNotDrawnAsAWorkingSet() {
        let movements = Performed.movements([
            set("s1", "bench-press", 40, 8, at: 1_000, number: 1, kind: .warmup),
            set("s2", "bench-press", 80, 5, at: 2_000, number: 1),
            set("s3", "bench-press", 80, 3, at: 3_000, number: 2, kind: .failure),
        ], catalog: catalog)

        XCTAssertEqual(movements[0].rows.map(\.kind), [.warmup, .working, .failure])
        XCTAssertEqual(movements[0].rows.map(\.effort), ["40 × 8", "80 × 5", "80 × 3"])
    }

    // The catalog has not answered yet, or never will: a slug a lifter can still recognise beats a
    // blank where the movement should be. The same fallback the whole product uses.
    func testAMovementTheCatalogHasNoNameForKeepsItsId() {
        let movements = Performed.movements([set("s1", "zercher-squat", 60, 5, at: 1_000)],
                                            catalog: catalog)

        XCTAssertEqual(movements.map(\.movement), ["zercher-squat"])
        XCTAssertEqual(movements.map(\.id), ["zercher-squat"])
    }

    func testASessionWithNoSetsGroupsIntoNothing() {
        XCTAssertEqual(Performed.movements([], catalog: catalog), [])
    }
}
