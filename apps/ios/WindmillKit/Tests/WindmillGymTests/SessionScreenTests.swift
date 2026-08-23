import XCTest
@testable import WindmillGym

final class SessionScreenTests: XCTestCase {
    private let catalog = [Exercise(id: "bench-press", name: "Bench press"),
                           Exercise(id: "row", name: "Barbell row")]

    private func set(_ id: String, _ exerciseId: String, _ weightKg: Double, _ reps: Int,
                     at completedAtMs: Int64, number: Int? = nil,
                     kind: SetKind = .working) -> TrainingSet {
        TrainingSet(id: id, exerciseId: exerciseId, setNumber: number, weightKg: weightKg,
                    reps: reps, kind: kind, completedAtMs: completedAtMs)
    }

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

    func testASetWithNoNumberFromTheLogIsNumberedByItsPlaceInTheRun() {
        let movements = Performed.movements([
            set("s1", "bench-press", 80, 5, at: 1_000),
            set("s2", "bench-press", 80, 5, at: 2_000),
        ], catalog: catalog)

        XCTAssertEqual(movements[0].rows.map(\.number), ["1", "2"])
    }

    func testTheKindTravelsSoAWarmupIsNotDrawnAsAWorkingSet() {
        let movements = Performed.movements([
            set("s1", "bench-press", 40, 8, at: 1_000, number: 1, kind: .warmup),
            set("s2", "bench-press", 80, 5, at: 2_000, number: 1),
            set("s3", "bench-press", 80, 3, at: 3_000, number: 2, kind: .failure),
        ], catalog: catalog)

        XCTAssertEqual(movements[0].rows.map(\.kind), [.warmup, .working, .failure])
        XCTAssertEqual(movements[0].rows.map(\.effort), ["40 × 8", "80 × 5", "80 × 3"])
    }

    func testAMovementTheCatalogHasNoNameForKeepsItsId() {
        let movements = Performed.movements([set("s1", "zercher-squat", 60, 5, at: 1_000)],
                                            catalog: catalog)

        XCTAssertEqual(movements.map(\.movement), ["zercher-squat"])
        XCTAssertEqual(movements.map(\.id), ["zercher-squat"])
    }

    func testASessionWithNoSetsGroupsIntoNothing() {
        XCTAssertEqual(Performed.movements([], catalog: catalog), [])
    }

    private func plan(_ entries: [PlanEntry]) -> PlanSnapshot {
        PlanSnapshot(routine: "Push A", entries: entries)
    }

    private func notes(_ sets: [TrainingSet], _ plan: PlanSnapshot?) -> [String?] {
        Performed.movements(sets, catalog: catalog, plan: plan)
            .flatMap { $0.rows.map { $0.note?.text } }
    }

    func testASetIsReadAgainstTheLoadThePlanNamedAndThenAgainstItsReps() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)])

        XCTAssertEqual(notes([
            set("s1", "bench-press", 82.5, 5, at: 1_000),
            set("s2", "bench-press", 82.5, 3, at: 2_000),
            set("s3", "bench-press", 85, 5, at: 3_000),
            set("s4", "bench-press", 80, 5, at: 4_000),
        ], planned), ["on plan", "two short", "+2.5 over plan", "2.5 under plan"])
    }

    func testAShortfallIsSpelledAsAWordAndIsTheOneEmphasisedLine() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)])
        let rows = Performed.movements([set("s1", "bench-press", 82.5, 4, at: 1_000),
                                        set("s2", "bench-press", 82.5, 5, at: 2_000)],
                                       catalog: catalog, plan: planned)[0].rows

        XCTAssertEqual(rows.map { $0.note?.text }, ["one short", "on plan"])
        XCTAssertEqual(rows.map { $0.note?.emphasised }, [true, false])
    }

    func testAMovementTakenToMaxIsNeverShort() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: nil, weightKg: 82.5)])

        XCTAssertEqual(notes([set("s1", "bench-press", 82.5, 1, at: 1_000)], planned), ["on plan"])
    }

    func testASetIsNotComparedToAWeightThePlanNeverNamed() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 8, weightKg: nil)])

        XCTAssertEqual(notes([set("s1", "bench-press", 60, 8, at: 1_000),
                              set("s2", "bench-press", 60, 6, at: 2_000)], planned),
                       ["on plan", "two short"])
    }

    func testAMovementThePlanNeverNamedIsSaidOnceAndNotScolded() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)])
        let movement = Performed.movements([
            set("s1", "row", 40, 8, at: 1_000, kind: .warmup),
            set("s2", "row", 60, 9, at: 2_000),
            set("s3", "row", 60, 7, at: 3_000),
        ], catalog: catalog, plan: planned)[0]

        XCTAssertEqual(movement.against, .unplanned)
        XCTAssertEqual(movement.rows.map { $0.note?.text }, [nil, "added today", nil])
    }

    func testAWarmupIsNeverComparedToThePlan() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)])

        XCTAssertEqual(notes([set("s1", "bench-press", 40, 8, at: 1_000, kind: .warmup),
                              set("s2", "bench-press", 82.5, 5, at: 2_000)], planned),
                       [nil, "on plan"])
    }

    func testAMovementThePlanNamesTwiceIsAnnotatedWithNothingAtAll() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5),
                            PlanEntry(exerciseId: "bench-press", sets: 2, reps: 8, weightKg: 60)])
        let movement = Performed.movements([set("s1", "bench-press", 82.5, 5, at: 1_000),
                                            set("s2", "bench-press", 60, 8, at: 2_000)],
                                           catalog: catalog, plan: planned)[0]

        XCTAssertEqual(movement.against, .none)
        XCTAssertEqual(movement.rows.map { $0.note }, [nil, nil])
    }

    func testASessionWithNoPlanIsAnnotatedWithNothing() {
        let movement = Performed.movements([set("s1", "bench-press", 82.5, 5, at: 1_000)],
                                           catalog: catalog, plan: nil)[0]

        XCTAssertEqual(movement.against, .none)
        XCTAssertEqual(movement.rows.map { $0.note }, [nil])
    }

    func testAPlanSnapshotWithNoEntriesIsNoPlanAndNotAPlanNamingNothing() {
        let movements = Performed.movements([set("s1", "bench-press", 82.5, 5, at: 1_000),
                                             set("s2", "row", 60, 10, at: 2_000)],
                                            catalog: catalog, plan: plan([]))

        XCTAssertEqual(movements.map(\.against), [.none, .none])
        XCTAssertEqual(movements.flatMap { $0.rows.map { $0.note } }, [nil, nil])
    }
}
