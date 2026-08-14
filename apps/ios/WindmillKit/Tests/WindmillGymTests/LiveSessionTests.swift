import XCTest
@testable import WindmillGym

// The decisions the logger makes before it draws anything: which movements a session holds and in
// what order, where a lifter is standing when they come back to a workout that never stopped, and
// the two halves of the counter — the set number over the numeral, the target under the movement's
// name.

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
    // The plan is the session's spine, and a movement the plan never named still belongs to the
    // workout that performed it — it lands after the written ones, in the order it happened.
    func testThePlanLeadsAndWhateverElseWasLiftedFollowsIt() {
        let order = LiveOrder.merged(
            held: [],
            plan: pushA,
            sets: [aSet("cable-fly", 22.5, 12, at: 3_000), aSet("bench-press", 82.5, 5, at: 1_000)]
        )
        XCTAssertEqual(order, ["bench-press", "overhead-press", "cable-fly"])
    }

    // A movement appended on the bench mid-rest belongs where the lifter put it. A second pass that
    // re-sorted it behind the plan would move the list under a thumb already reaching for it.
    func testAMovementAlreadyHeldKeepsItsPlaceAtTheHead() {
        let order = LiveOrder.merged(held: ["cable-fly", "bench-press"], plan: pushA, sets: [])
        XCTAssertEqual(order, ["cable-fly", "bench-press", "overhead-press"])
    }

    // A movement chosen and not yet logged is an intention, and it survives — that is the whole of
    // "no sets yet — logging one starts it".
    func testAMovementWithNoSetsStaysInTheOrder() {
        let order = LiveOrder.merged(held: ["romanian-deadlift"], plan: nil, sets: [])
        XCTAssertEqual(order, ["romanian-deadlift"])
    }

    // Coming back to a workout that never stopped stands where the last set went, not at the head of
    // a plan the lifter finished with two movements ago.
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
    // "set 4 of 3" is legal, normal, and says both true things at once: the plan is what was written
    // down, the log is what happened. Nothing here warns and nothing hides the target.
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

    // "movement 3 of 6" (§K) counts off the MERGED order — the plan plus whatever was appended on
    // the bench — so an appended movement counts like a written one. Counting the plan alone would
    // print "movement 7 of 6".
    func testTheMovementPositionCountsTheMergedOrderNotThePlan() {
        let order = ["bench-press", "overhead-press", "cable-fly"]
        XCTAssertEqual(LiveLines.movementPosition(order: order, current: "bench-press"),
                       "movement 1 of 3")
        XCTAssertEqual(LiveLines.movementPosition(order: order, current: "cable-fly"),
                       "movement 3 of 3")
    }

    // Nothing in hand is the picker's screen, a movement no longer in the order has no place to
    // claim, and a walk of one is not a position worth a line — "movement 1 of 1" would be the
    // screen narrating itself. All three answer nothing rather than a line that says nothing.
    func testTheMovementPositionDegradesToSilence() {
        XCTAssertNil(LiveLines.movementPosition(order: ["bench-press"], current: nil))
        XCTAssertNil(LiveLines.movementPosition(order: ["bench-press"], current: "cable-fly"))
        XCTAssertNil(LiveLines.movementPosition(order: [], current: "bench-press"))
        XCTAssertNil(LiveLines.movementPosition(order: ["romanian-deadlift"],
                                                current: "romanian-deadlift"),
                     "a walk of one is not a position worth a line")
    }

    // A routine line that names sets and reps and leaves the load to last time prints no load —
    // never a zero, which would be a target nobody wrote.
    func testAPlanWithNoTargetWeightPrintsNoLoad() {
        let entry = PlanEntry(exerciseId: "chin-up", sets: 3, reps: 8)
        XCTAssertEqual(LiveLines.counter(workingSetsToday: 1, planEntry: entry).plan, "plan 3 × 8")
    }

    // A rep target the routine declined to set is `max` — a chin-up taken to whatever it gives that
    // day. It is not a zero and it is not a blank, and the plan line has to be able to say it or a
    // program with chin-ups in it cannot be drawn.
    func testAPlanWithNoRepTargetReadsAsMax() {
        let entry = PlanEntry(exerciseId: "chin-up", sets: 3)
        let counter = LiveLines.counter(workingSetsToday: 2, planEntry: entry)
        XCTAssertEqual(counter.count, "set 3 of 3")
        XCTAssertEqual(counter.plan, "plan 3 × max")

        let loaded = PlanEntry(exerciseId: "chin-up", sets: 3, weightKg: 10)
        XCTAssertEqual(LiveLines.counter(workingSetsToday: 0, planEntry: loaded).plan,
                       "plan 3 × max @ 10")
    }

    // Warmups carry a w and never advance the counter — they count toward no volume, no record and
    // no history, and a row that numbered them would be the first place that stopped being true.
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

    // ONE WORD FOR WHAT COUNTS. A drop and a failure are things that happened to a set the plan never
    // asked for, so neither advances "set 3 of 5" and neither counts toward a movement's tally — the
    // same word log.js `workingSetsOf` counts on, over the same stored session. The phone counted
    // everything that was not a warmup and said "set 5 of 5" where the desk said "set 4 of 5".
    //
    // THE TODAY COLUMN IS DELIBERATELY NOT THIS RULE: its ordinal numbers every set that is not a
    // warmup, drops included, because that column is the record of what was PERFORMED and not a
    // count toward the plan. (It used to be justified by Logger.jsx numbering them the same way;
    // the web stopped lifting on 2026-08-09 and there is no second copy to agree with — the reason
    // stands on its own.) So the two numbers on the logger disagree on purpose, and the column has
    // to say why: every kind that counts toward nothing is NAMED in the row's own note, or a drop
    // numbered 3 under a counter reading "set 3 of 5" is two accounts of one movement.
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

    // THE COLUMN IS THIS MOVEMENT'S SETS AND NOTHING ELSE, which is the whole of it nine times in
    // ten: the walk is standing where the sets went in.
    func testTheColumnDrawsTheMovementInHand() {
        let sets = [aSet("bench-press", 82.5, 5, at: 1_000, id: "s1"),
                    aSet("overhead-press", 45, 5, at: 2_000, id: "s2")]

        let column = LiveLines.column(sets, of: "bench-press", undoable: nil, catalog: [], stalled: [])
        XCTAssertEqual(column.map(\.id), ["s1"])
        XCTAssertEqual(column.map(\.value), ["82.5 × 5"])
        XCTAssertEqual(column.map(\.note), [""])
    }

    // AND THE UNDO TRAVELS. §K hung the verb on the row of the set it takes back and put two
    // chevrons in the title one tap away — so a set logged seconds before a walk to the next
    // movement would arm an Undo whose row is on no screen at all, which is the verb deleted rather
    // than moved. The row follows the lifter, carrying the movement it belongs to: unnamed, it would
    // be this column claiming a lift that happened somewhere else.
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

    // Standing on the movement the set went into, it is one row and not two — the same set drawn
    // twice would be the column doubling a lift.
    func testTheTravellingUndoIsNotDrawnTwiceOnItsOwnMovement() {
        let bench = aSet("bench-press", 82.5, 5, at: 1_000, id: "s1")
        let column = LiveLines.column([bench], of: "bench-press", undoable: bench,
                                      catalog: [Exercise(id: "bench-press", name: "Bench Press")],
                                      stalled: ["s1"])
        XCTAssertEqual(column.map(\.id), ["s1"])
        XCTAssertEqual(column.map(\.note), ["on this device"])
    }

    // A movement with nothing in it says what would start it, rather than reading as a mistake. The
    // count and that sentence are two lines and not one — the count is the row's right-hand meta and
    // the sentence sits under the name, so a plan movement nothing has gone into yet says both.
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

    // THE ROW A SWIPE MAY TAKE, and it is the same row that reads `just added`: appended on the
    // bench, nothing logged into it, and no plan line holding it in place. A movement with a set in
    // it is a lift that happened, and no gesture on a list may un-happen one.
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

    // `just added` is the LAST one appended and only that one: two empty movements are two
    // appends, and the row the primary aims at is the one the thumb made most recently.
    func testOnlyTheLastAppendedMovementReadsAsJustAdded() {
        let rows = LiveLines.jumpRows(order: ["cable-fly", "face-pull"], sets: [], plan: nil,
                                      catalog: [], current: nil)
        XCTAssertEqual(rows.map(\.meta), ["0 sets", "just added"])
        XCTAssertEqual(rows.map(\.canDrop), [true, true])
    }

    func testTheOfflineStripCountsSetsAndSaysNothingWhenThereAreNone() {
        XCTAssertNil(LiveLines.onThisDeviceLine(0))
        XCTAssertEqual(LiveLines.onThisDeviceLine(1),
                       "1 set is saved on this device only. No signal down here — they flush when you’re back up.")
        XCTAssertEqual(LiveLines.onThisDeviceLine(3),
                       "3 sets are saved on this device only. No signal down here — they flush when you’re back up.")
    }
}
