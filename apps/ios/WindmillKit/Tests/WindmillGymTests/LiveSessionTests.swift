import XCTest
@testable import WindmillGym

// The decisions the logger makes before it draws anything: which movements a session holds and in
// what order, where a lifter is standing when they come back to a workout that never stopped, and
// the four different things the card above the weight is allowed to say.

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
        XCTAssertEqual(counter.tail, "  ·  plan 3 × 5 @ 82.5")
    }

    func testAMovementWithNoPlanSaysSoRatherThanBorrowingATarget() {
        let counter = LiveLines.counter(workingSetsToday: 0, planEntry: nil)
        XCTAssertEqual(counter.count, "set 1")
        XCTAssertEqual(counter.tail, "  ·  no target")
    }

    // A routine line that names sets and reps and leaves the load to last time prints no load —
    // never a zero, which would be a target nobody wrote.
    func testAPlanWithNoTargetWeightPrintsNoLoad() {
        let entry = PlanEntry(exerciseId: "chin-up", sets: 3, reps: 8)
        XCTAssertEqual(LiveLines.counter(workingSetsToday: 1, planEntry: entry).tail, "  ·  plan 3 × 8")
    }

    // A rep target the routine declined to set is `max` — a chin-up taken to whatever it gives that
    // day. It is not a zero and it is not a blank, and the plan line has to be able to say it or a
    // program with chin-ups in it cannot be drawn.
    func testAPlanWithNoRepTargetReadsAsMax() {
        let entry = PlanEntry(exerciseId: "chin-up", sets: 3)
        let counter = LiveLines.counter(workingSetsToday: 2, planEntry: entry)
        XCTAssertEqual(counter.count, "set 3 of 3")
        XCTAssertEqual(counter.tail, "  ·  plan 3 × max")

        let loaded = PlanEntry(exerciseId: "chin-up", sets: 3, weightKg: 10)
        XCTAssertEqual(LiveLines.counter(workingSetsToday: 0, planEntry: loaded).tail,
                       "  ·  plan 3 × max @ 10")
    }

    // Four states, not two. A read still in flight and a read that failed are different facts, and
    // ONLY an answer may say "first time" — a card claiming no history over a movement squatted for
    // a year, because the phone was in a basement, is the product lying in the pixel it exists for.
    func testTheCardTellsAPendingReadFromAFailedOne() {
        let reading = LiveLines.prefillCard(lastTime: nil, planEntry: nil, routine: nil,
                                            readFailed: false, now: 0)
        XCTAssertEqual(reading, LiveLines.Card(title: "Last time", body: "reading your log…"))

        let failed = LiveLines.prefillCard(lastTime: nil, planEntry: nil, routine: nil,
                                           readFailed: true, now: 0)
        XCTAssertEqual(failed, LiveLines.Card(title: "Last time", body: "the log didn’t answer"))
    }

    func testAMovementNeverTrainedSaysSoAndNamesThePlansNumber() {
        let answered = LastTime(exerciseId: "zercher-squat")
        let entry = PlanEntry(exerciseId: "zercher-squat", sets: 3, reps: 5, weightKg: 60)

        XCTAssertEqual(LiveLines.prefillCard(lastTime: answered, planEntry: entry, routine: nil,
                                             readFailed: false, now: 0),
                       LiveLines.Card(title: "First time logging this",
                                      body: "no history — dialled to the plan’s 60 kg"))

        XCTAssertEqual(LiveLines.prefillCard(lastTime: answered, planEntry: nil, routine: nil,
                                             readFailed: false, now: 0),
                       LiveLines.Card(title: "First time logging this",
                                      body: "no history — start where you like"))
    }

    // The card names the day of the program that block came from when it was not this one. Hiding
    // that difference is what makes a lifter read Tuesday's numbers as Thursday's.
    func testTheCardNamesTheOtherRoutineTheBlockCameFrom() {
        let day: Int64 = 1_754_000_000_000
        let answer = LastTime(
            exerciseId: "bench-press",
            session: Session(id: "ses_1", startedAtMs: day, finishedAtMs: day + 1),
            routine: "Push B",
            sets: [aSet("bench-press", 80, 5, at: day), aSet("bench-press", 80, 5, at: day + 1)]
        )
        let card = LiveLines.prefillCard(lastTime: answer, planEntry: nil, routine: "Push A",
                                         readFailed: false, now: day + 3 * 86_400_000)
        XCTAssertEqual(card.title, "Last time · \(Readout.day(day)) · 3 days ago  ·  Push B")
        XCTAssertEqual(card.body, "80 × 5,   80 × 5")

        let sameDay = LiveLines.prefillCard(lastTime: answer, planEntry: nil, routine: "Push B",
                                            readFailed: false, now: day + 3 * 86_400_000)
        XCTAssertEqual(sameDay.title, "Last time · \(Readout.day(day)) · 3 days ago")
    }

    func testTheCardShowsFourSetsAndCountsTheRest() {
        let day: Int64 = 1_754_000_000_000
        let answer = LastTime(
            exerciseId: "bench-press",
            session: Session(id: "ses_1", startedAtMs: day, finishedAtMs: day + 1),
            sets: (0..<6).map { aSet("bench-press", 80, 5, at: day + Int64($0)) }
        )
        let card = LiveLines.prefillCard(lastTime: answer, planEntry: nil, routine: nil,
                                         readFailed: false, now: day)
        XCTAssertEqual(card.body, "80 × 5,   80 × 5,   80 × 5,   80 × 5,   +2 more")
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
        XCTAssertEqual(rows.map(\.isWarmup), [true, false, false])
    }

    // ONE WORD FOR WHAT COUNTS. A drop and a failure are things that happened to a set the plan never
    // asked for, so neither advances "set 3 of 5" and neither counts toward a movement's tally — the
    // same word log.js `workingSetsOf` counts on, over the same stored session. The phone counted
    // everything that was not a warmup and said "set 5 of 5" where the desk said "set 4 of 5".
    //
    // THE TODAY LIST IS DELIBERATELY NOT THIS RULE: its ordinal numbers every set that is not a
    // warmup, drops included, because that column is the record of what was performed and not a
    // count toward the plan — Logger.jsx's TodayList numbers them the same way.
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

        XCTAssertEqual(LiveLines.rows(sets, stalled: []).map(\.index), ["w", "1", "2", "3", "4"],
                       "the today list numbers what was performed, which is not what counts")
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
