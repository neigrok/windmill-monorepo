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

    // ── the frozen plan, read against what was actually done ───────────────────────────────────

    private func plan(_ entries: [PlanEntry]) -> PlanSnapshot {
        PlanSnapshot(routine: "Push A", entries: entries)
    }

    private func notes(_ sets: [TrainingSet], _ plan: PlanSnapshot?) -> [String?] {
        Performed.movements(sets, catalog: catalog, plan: plan)
            .flatMap { $0.rows.map { $0.note?.text } }
    }

    // The load the plan named comes first and the reps it asked for second — and a set that met both
    // is `on plan`, which is the ordinary case and the quiet one.
    func testASetIsReadAgainstTheLoadThePlanNamedAndThenAgainstItsReps() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)])

        XCTAssertEqual(notes([
            set("s1", "bench-press", 82.5, 5, at: 1_000),
            set("s2", "bench-press", 82.5, 3, at: 2_000),
            set("s3", "bench-press", 85, 5, at: 3_000),
            set("s4", "bench-press", 80, 5, at: 4_000),
        ], planned), ["on plan", "two short", "+2.5 over plan", "2.5 under plan"])
    }

    // A shortfall is the one annotation that reads a step brighter, and it is spelled as a word: the
    // column beside it is a column of numerals, and `2 short` there reads as another load.
    func testAShortfallIsSpelledAsAWordAndIsTheOneEmphasisedLine() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)])
        let rows = Performed.movements([set("s1", "bench-press", 82.5, 4, at: 1_000),
                                        set("s2", "bench-press", 82.5, 5, at: 2_000)],
                                       catalog: catalog, plan: planned)[0].rows

        XCTAssertEqual(rows.map { $0.note?.text }, ["one short", "on plan"])
        XCTAssertEqual(rows.map { $0.note?.emphasised }, [true, false])
    }

    // A rep target the routine declined to set is `max` — a movement taken to whatever it gives that
    // day — so no number of reps can ever be short of it.
    func testAMovementTakenToMaxIsNeverShort() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: nil, weightKg: 82.5)])

        XCTAssertEqual(notes([set("s1", "bench-press", 82.5, 1, at: 1_000)], planned), ["on plan"])
    }

    // An absent weight target means "whatever you did last time" and a zero is the absence of a load
    // rather than one — neither is something a set can be over or under.
    func testASetIsNotComparedToAWeightThePlanNeverNamed() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 8, weightKg: nil)])

        XCTAssertEqual(notes([set("s1", "bench-press", 60, 8, at: 1_000),
                              set("s2", "bench-press", 60, 6, at: 2_000)], planned),
                       ["on plan", "two short"])
    }

    // A movement added on the day says so ONCE, on the first working set, and the header says it of
    // the movement. Nothing about it is a fault — changing the day on purpose is the normal case.
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

    // A WARMUP COUNTS TOWARD NOTHING, including the plan: it is never compared to a target, and the
    // first working set is what opens the movement.
    func testAWarmupIsNeverComparedToThePlan() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)])

        XCTAssertEqual(notes([set("s1", "bench-press", 40, 8, at: 1_000, kind: .warmup),
                              set("s2", "bench-press", 82.5, 5, at: 2_000)], planned),
                       [nil, "on plan"])
    }

    // PLANENTRY CARRIES NO ID. A movement the plan names twice cannot be matched to one of its
    // entries, so the whole movement is annotated with nothing — a wrong "two short" beside somebody
    // else's training is worse than a blank, and the header stays silent for the same reason.
    func testAMovementThePlanNamesTwiceIsAnnotatedWithNothingAtAll() {
        let planned = plan([PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5),
                            PlanEntry(exerciseId: "bench-press", sets: 2, reps: 8, weightKg: 60)])
        let movement = Performed.movements([set("s1", "bench-press", 82.5, 5, at: 1_000),
                                            set("s2", "bench-press", 60, 8, at: 2_000)],
                                           catalog: catalog, plan: planned)[0]

        XCTAssertEqual(movement.against, .none)
        XCTAssertEqual(movement.rows.map { $0.note }, [nil, nil])
    }

    // A session nobody planned has nothing to be read against, and no set in it was "added" to
    // anything — the annotation column is empty rather than full of a judgement with no plan behind it.
    func testASessionWithNoPlanIsAnnotatedWithNothing() {
        let movement = Performed.movements([set("s1", "bench-press", 82.5, 5, at: 1_000)],
                                           catalog: catalog, plan: nil)[0]

        XCTAssertEqual(movement.against, .none)
        XCTAssertEqual(movement.rows.map { $0.note }, [nil])
    }

    // A snapshot that names a routine and holds NO entries is a plan that says nothing, and it reads
    // as no plan at all. Read as a plan naming nothing it accuses: every movement "not in the plan",
    // every opening set "added today", and no chip on the head to say where that came from — the
    // chip is suppressed for this very snapshot, so the two would disagree on one screen.
    func testAPlanSnapshotWithNoEntriesIsNoPlanAndNotAPlanNamingNothing() {
        let movements = Performed.movements([set("s1", "bench-press", 82.5, 5, at: 1_000),
                                             set("s2", "row", 60, 10, at: 2_000)],
                                            catalog: catalog, plan: plan([]))

        XCTAssertEqual(movements.map(\.against), [.none, .none])
        XCTAssertEqual(movements.flatMap { $0.rows.map { $0.note } }, [nil, nil])
    }
}
