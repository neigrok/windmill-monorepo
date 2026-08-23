import XCTest
@testable import WindmillGym

private func aSet(_ exerciseId: String, _ weightKg: Double, _ reps: Int,
                  at completedAtMs: Int64, kind: SetKind = .working, id: String = "") -> TrainingSet {
    TrainingSet(id: id.isEmpty ? "set_\(completedAtMs)" : id, exerciseId: exerciseId,
                weightKg: weightKg, reps: reps, kind: kind, completedAtMs: completedAtMs)
}

private let pushA = PlanSnapshot(routine: "Push A", entries: [
    PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
    PlanEntry(exerciseId: "overhead-press", sets: 3, reps: 8, weightKg: 45),
])

final class LiveOrderTests: XCTestCase {
    func testThePlanLeadsAndWhateverElseWasLiftedFollowsIt() {
        let order = LiveOrder.merged(
            held: [],
            plan: pushA,
            sets: [aSet("cable-fly", 22.5, 12, at: 3_000), aSet("bench-press", 82.5, 5, at: 1_000)]
        )
        XCTAssertEqual(order, ["bench-press", "overhead-press", "cable-fly"])
    }

    func testAMovementAlreadyHeldKeepsItsPlaceAtTheHead() {
        let order = LiveOrder.merged(held: ["cable-fly", "bench-press"], plan: pushA, sets: [])
        XCTAssertEqual(order, ["cable-fly", "bench-press", "overhead-press"])
    }

    func testAMovementWithNoSetsStaysInTheOrder() {
        let order = LiveOrder.merged(held: ["romanian-deadlift"], plan: nil, sets: [])
        XCTAssertEqual(order, ["romanian-deadlift"])
    }

    func testResumingStandsAtTheMovementTheLastSetWentInto() {
        let order = ["bench-press", "overhead-press", "cable-fly"]
        let sets = [aSet("bench-press", 82.5, 5, at: 1_000), aSet("overhead-press", 45, 8, at: 9_000)]
        XCTAssertEqual(LiveOrder.resume(order: order, sets: sets), "overhead-press")
    }

    func testResumingASessionWithNothingLoggedStandsAtTheHeadOfThePlan() {
        XCTAssertEqual(LiveOrder.resume(order: ["bench-press", "overhead-press"], sets: []), "bench-press")
        XCTAssertNil(LiveOrder.resume(order: [], sets: []), "an ad-hoc session with no movements opens the picker")
    }
}

final class LiveLinesTests: XCTestCase {
    func testTheCounterKeepsCountingPastThePlansSetCount() {
        let entry = PlanEntry(exerciseId: "bench-press", sets: 3, reps: 5, weightKg: 82.5)
        let counter = LiveLines.counter(workingSetsToday: 3, planEntry: entry)
        XCTAssertEqual(counter.count, "set 4 of 3")
        XCTAssertEqual(counter.plan, "plan 3 × 5 @ 82.5")
    }

    func testAMovementWithNoPlanSaysSoRatherThanBorrowingATarget() {
        let counter = LiveLines.counter(workingSetsToday: 0, planEntry: nil)
        XCTAssertEqual(counter.count, "set 1")
        XCTAssertEqual(counter.plan, "no target")
    }

    func testTheMovementPositionCountsTheMergedOrderNotThePlan() {
        let order = ["bench-press", "overhead-press", "cable-fly"]
        XCTAssertEqual(LiveLines.movementPosition(order: order, current: "bench-press"),
                       "movement 1 of 3")
        XCTAssertEqual(LiveLines.movementPosition(order: order, current: "cable-fly"),
                       "movement 3 of 3")
    }

    func testTheMovementPositionDegradesToSilence() {
        XCTAssertNil(LiveLines.movementPosition(order: ["bench-press"], current: nil))
        XCTAssertNil(LiveLines.movementPosition(order: ["bench-press"], current: "cable-fly"))
        XCTAssertNil(LiveLines.movementPosition(order: [], current: "bench-press"))
        XCTAssertNil(LiveLines.movementPosition(order: ["romanian-deadlift"],
                                                current: "romanian-deadlift"),
                     "a walk of one is not a position worth a line")
    }

    func testAPlanWithNoTargetWeightPrintsNoLoad() {
        let entry = PlanEntry(exerciseId: "chin-up", sets: 3, reps: 8)
        XCTAssertEqual(LiveLines.counter(workingSetsToday: 1, planEntry: entry).plan, "plan 3 × 8")
    }

    func testAPlanWithNoRepTargetReadsAsMax() {
        let entry = PlanEntry(exerciseId: "chin-up", sets: 3)
        let counter = LiveLines.counter(workingSetsToday: 2, planEntry: entry)
        XCTAssertEqual(counter.count, "set 3 of 3")
        XCTAssertEqual(counter.plan, "plan 3 × max")

        let loaded = PlanEntry(exerciseId: "chin-up", sets: 3, weightKg: 10)
        XCTAssertEqual(LiveLines.counter(workingSetsToday: 0, planEntry: loaded).plan,
                       "plan 3 × max @ 10")
    }

    func testWarmupsCarryAWAndNeverAdvanceTheOrdinal() {
        let rows = LiveLines.rows([
            aSet("bench-press", 40, 8, at: 1_000, kind: .warmup, id: "w1"),
            aSet("bench-press", 82.5, 5, at: 2_000, id: "s1"),
            aSet("bench-press", 82.5, 5, at: 3_000, id: "s2"),
        ], stalled: ["s2"])

        XCTAssertEqual(rows.map(\.index), ["w", "1", "2"])
        XCTAssertEqual(rows.map(\.note), ["warmup", "", "on this device"])
        XCTAssertEqual(rows.map(\.value), ["40 × 8", "82.5 × 5", "82.5 × 5"])
        XCTAssertEqual(rows.map(\.countsTowardNothing), [true, false, false])
    }

    func testOnlyWorkingSetsCountTowardThePlanCounterAndTheJumpSheet() {
        let sets = [
            aSet("bench-press", 40, 8, at: 900, kind: .warmup, id: "w1"),
            aSet("bench-press", 82.5, 5, at: 1_000, id: "s1"),
            aSet("bench-press", 82.5, 5, at: 2_000, id: "s2"),
            aSet("bench-press", 60, 8, at: 2_500, kind: .drop, id: "d1"),
            aSet("bench-press", 82.5, 3, at: 3_000, kind: .failure, id: "f1"),
        ]

        XCTAssertEqual(LiveLines.workingCount(sets), 2)
        XCTAssertEqual(LiveLines.workingCount(sets, of: "cable-fly"), 0)
        XCTAssertEqual(LiveLines.counter(workingSetsToday: LiveLines.workingCount(sets),
                                         planEntry: pushA.entry(for: "bench-press")).count,
                       "set 3 of 5")

        let rows = LiveLines.jumpRows(order: ["bench-press"], sets: sets, plan: pushA,
                                      catalog: [Exercise(id: "bench-press", name: "Bench Press")],
                                      current: "bench-press")
        XCTAssertEqual(rows.map(\.meta), ["2 of 5 sets"])

        let column = LiveLines.rows(sets, stalled: [])
        XCTAssertEqual(column.map(\.index), ["w", "1", "2", "3", "4"],
                       "the today column numbers what was performed, which is not what counts")
        XCTAssertEqual(column.map(\.note), ["warmup", "", "", "drop", "failure"],
                       "and it names every kind that counts toward nothing, so the column and the "
                       + "counter above it cannot be read as one number")
        XCTAssertEqual(column.map(\.countsTowardNothing), [true, false, false, true, true])
    }

    func testTheColumnDrawsTheMovementInHand() {
        let sets = [aSet("bench-press", 82.5, 5, at: 1_000, id: "s1"),
                    aSet("overhead-press", 45, 5, at: 2_000, id: "s2")]

        let column = LiveLines.column(sets, of: "bench-press", undoable: nil, catalog: [], stalled: [])
        XCTAssertEqual(column.map(\.id), ["s1"])
        XCTAssertEqual(column.map(\.value), ["82.5 × 5"])
        XCTAssertEqual(column.map(\.note), [""])
    }

    func testAnUndoStillOwedFollowsTheWalkToTheNextMovement() {
        let bench = aSet("bench-press", 82.5, 5, at: 1_000, id: "s1")
        let sets = [bench, aSet("overhead-press", 45, 5, at: 2_000, id: "s2")]
        let catalog = [Exercise(id: "bench-press", name: "Bench Press")]

        let column = LiveLines.column(sets, of: "overhead-press", undoable: bench,
                                      catalog: catalog, stalled: ["s1"])
        XCTAssertEqual(column.map(\.id), ["s2", "s1"], "it is drawn last, under the sets of the "
                       + "movement in hand, where a bottom-anchored column cannot scroll it away")
        XCTAssertEqual(column.map(\.value), ["45 × 5", "82.5 × 5"])
        XCTAssertEqual(column.map(\.index), ["1", "1"], "and it keeps ITS movement's ordinal")
        XCTAssertEqual(column.map(\.note), ["", "Bench Press"])
        XCTAssertEqual(column.map(\.isOnThisDevice), [false, false],
                       "where it is saved is not the fact a row about to be withdrawn carries")
    }

    func testTheTravellingUndoIsNotDrawnTwiceOnItsOwnMovement() {
        let bench = aSet("bench-press", 82.5, 5, at: 1_000, id: "s1")
        let column = LiveLines.column([bench], of: "bench-press", undoable: bench,
                                      catalog: [Exercise(id: "bench-press", name: "Bench Press")],
                                      stalled: ["s1"])
        XCTAssertEqual(column.map(\.id), ["s1"])
        XCTAssertEqual(column.map(\.note), ["on this device"])
    }

    func testTheJumpSheetSaysWhereEachMovementStands() {
        let rows = LiveLines.jumpRows(
            order: ["bench-press", "overhead-press", "cable-fly"],
            sets: [aSet("bench-press", 82.5, 5, at: 1_000),
                   aSet("bench-press", 40, 8, at: 900, kind: .warmup, id: "w1"),
                   aSet("cable-fly", 22.5, 12, at: 2_000)],
            plan: pushA,
            catalog: [Exercise(id: "bench-press", name: "Bench Press")],
            current: "bench-press"
        )
        XCTAssertEqual(rows.map(\.name), ["Bench Press", "overhead-press", "cable-fly"])
        XCTAssertEqual(rows.map(\.meta), ["1 of 5 sets", "0 of 3 sets", "1 set"])
        XCTAssertEqual(rows.map(\.note),
                       [nil, "no sets yet — logging one starts it", nil])
        XCTAssertEqual(rows.map(\.isCurrent), [true, false, false])
        XCTAssertEqual(rows.map(\.canDrop), [false, false, false],
                       "two were lifted and the third is a plan line — nothing here is a swipe's to take")
        XCTAssertEqual(rows.map { $0.sets.map(\.value) },
                       [["82.5 × 5", "40 × 8"], [], ["22.5 × 12"]],
                       "each movement carries its own sets, in the order they arrive — which is the "
                       + "order they were performed, because the queue hands them over sorted")
    }

    func testOnlyAnEmptyAppendedMovementIsJustAddedAndDroppable() {
        let sets = [aSet("bench-press", 82.5, 5, at: 1_000)]
        let rows = LiveLines.jumpRows(
            order: ["bench-press", "overhead-press", "cable-fly"],
            sets: sets, plan: pushA,
            catalog: [Exercise(id: "cable-fly", name: "Cable Fly")],
            current: "bench-press"
        )
        XCTAssertEqual(rows.map(\.canDrop), [false, false, true])
        XCTAssertEqual(rows.map(\.meta), ["1 of 5 sets", "0 of 3 sets", "just added"])

        XCTAssertFalse(LiveOrder.droppable("bench-press", sets: sets, plan: pushA),
                       "a movement that was lifted stays")
        XCTAssertFalse(LiveOrder.droppable("overhead-press", sets: sets, plan: pushA),
                       "and so does one the frozen plan names")
        XCTAssertTrue(LiveOrder.droppable("cable-fly", sets: sets, plan: pushA))
        XCTAssertTrue(LiveOrder.droppable("cable-fly", sets: [], plan: nil))
    }

    func testOnlyTheLastAppendedMovementReadsAsJustAdded() {
        let rows = LiveLines.jumpRows(order: ["cable-fly", "face-pull"], sets: [], plan: nil,
                                      catalog: [], current: nil)
        XCTAssertEqual(rows.map(\.meta), ["0 sets", "just added"])
        XCTAssertEqual(rows.map(\.canDrop), [true, true])
    }

    func testTheOfflineStripCountsSetsAndSaysNothingWhenThereAreNone() {
        XCTAssertNil(LiveLines.onThisDeviceLine(0, stall: .offline))
        XCTAssertEqual(LiveLines.onThisDeviceLine(1, stall: .offline),
                       "1 set is saved on this device only. No signal down here — they flush when you’re back up.")
        XCTAssertEqual(LiveLines.onThisDeviceLine(3, stall: .offline),
                       "3 sets are saved on this device only. No signal down here — they flush when you’re back up.")
        XCTAssertEqual(LiveLines.onThisDeviceLine(2, stall: .logFailed),
                       "2 sets are saved on this device only. The log didn’t answer — they flush when it does.")
        XCTAssertEqual(LiveLines.onThisDeviceLine(2, stall: .signInLapsed),
                       "2 sets are saved on this device only. Your sign-in lapsed — they flush once you sign in again.")
        XCTAssertEqual(LiveLines.onThisDeviceLine(1, stall: nil),
                       "1 set is saved on this device only. They flush when the log takes them.")
    }
}
