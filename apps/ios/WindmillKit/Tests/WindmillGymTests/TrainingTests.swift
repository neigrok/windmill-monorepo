import XCTest
@testable import WindmillGym

// The wire, spelled out. Every field name below is the one the backend's codec writes, and every
// absence is an omission rather than a null — a decoder with no key strategy matches these by
// spelling alone, so a rename anywhere is a silent 404 or a silently missing number.

final class TrainingWireTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func fields(of value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testASessionCarriesItsFrozenPlanSnapshot() throws {
        let session = try decode(Session.self, """
        { "id": "ses_9f", "startedAt": 1754300000000, "routineId": "rt_1",
          "plan": { "routine": "Push A",
                    "entries": [ { "exerciseId": "bench-press", "sets": 5, "reps": 5,
                                   "weightKg": 82.5, "restSeconds": 180 } ] } }
        """)

        XCTAssertEqual(session.id, "ses_9f")
        XCTAssertEqual(session.startedAtMs, 1_754_300_000_000)
        XCTAssertNil(session.finishedAtMs)
        XCTAssertTrue(session.isOpen)
        XCTAssertEqual(session.routineId, "rt_1")
        XCTAssertEqual(session.plan?.routine, "Push A")
        XCTAssertEqual(session.plan?.entry(for: "bench-press"),
                       PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5, restSeconds: 180))
    }

    // A plan line with no target weight means "whatever you did last time" — an absence that is a
    // real instruction, and never a zero.
    func testAPlanLineWithNoTargetWeightIsAnAbsenceAndNotAZero() throws {
        let entry = try decode(PlanEntry.self, #"{"exerciseId":"chin-up","sets":3,"reps":8}"#)

        XCTAssertNil(entry.weightKg)
        XCTAssertNil(entry.restSeconds)
    }

    // And a plan line with no REP target means max — `3 × max`, a movement taken to whatever it gives
    // that day. `targetReps` was required, so a program with chin-ups in it could not be expressed at
    // all; it is omitted when absent, like every other optional in this module, and never null.
    func testARepTargetIsOmittedWhenTheRoutineDeclinesToNameOne() throws {
        let entry = try decode(PlanEntry.self, #"{"exerciseId":"chin-up","sets":3}"#)
        XCTAssertNil(entry.reps)
        XCTAssertEqual(entry.sets, 3)

        let line = try decode(RoutineEntry.self,
                              #"{"position":3,"exerciseId":"chin-up","targetSets":3}"#)
        XCTAssertNil(line.targetReps)

        let planned = try decode(Against.Target.self, #"{"sets":3}"#)
        XCTAssertNil(planned.reps)

        let write = try fields(of: RoutineWrite.Entry(exerciseId: "chin-up", targetSets: 3))
        XCTAssertNil(write["targetReps"], "an absent rep target is omitted, never sent as null")
    }

    func testASetDecodesTheLogsOwnNumberingAndDefaultsTheRest() throws {
        let set = try decode(TrainingSet.self, """
        { "id": "set_1", "exerciseId": "back-squat", "setNumber": 3, "weightKg": 105,
          "reps": 5, "kind": "working", "completedAt": 1754300000000 }
        """)

        XCTAssertEqual(set.setNumber, 3)
        XCTAssertEqual(set.kind, .working)
        XCTAssertEqual(set.note, "", "note is a String on the wire, so an absent one is empty and not missing")
        XCTAssertNil(set.rpe)
        XCTAssertEqual(set.completedAtMs, 1_754_300_000_000)
    }

    // A kind this build has never heard of reads as working. Folding it to warmup would be the quiet
    // way to lose a lift: warmups are excluded from history, from the prefill and from every record.
    func testAKindThisBuildHasNeverHeardOfReadsAsWorking() throws {
        let set = try decode(TrainingSet.self,
                             #"{"id":"set_1","exerciseId":"x","weightKg":1,"reps":1,"kind":"cluster","completedAt":1}"#)

        XCTAssertEqual(set.kind, .working)
    }

    // An absent optional is OMITTED, never null — the module's convention on the wire, and the same
    // bytes this device writes to its own disk.
    func testAnAbsentOptionalIsOmittedRatherThanWrittenAsNull() throws {
        let queued = TrainingSet(id: "set_1", exerciseId: "bench-press", weightKg: 82.5, reps: 5,
                                 completedAtMs: 1_754_300_000_000)
        let written = try fields(of: queued)

        XCTAssertNil(written["setNumber"], "a set this device minted has no number until the log gives it one")
        XCTAssertNil(written["rpe"])
        XCTAssertEqual(written["completedAt"] as? Int64, 1_754_300_000_000)

        let start = try fields(of: SessionStart(id: "ses_1", startedAtMs: 1))
        XCTAssertNil(start["routineId"], "an ad-hoc session names no routine, and says so by silence")
        XCTAssertNil(start["joinOpenSession"], "the phone always joins, so it never sends the flag")
    }

    // The log's rows are FLAT: the session's own fields with its four facts beside them, not a
    // session nested under a key that is not there. `topSet` and `closedItself` are decoded and not
    // drawn anywhere on this phone — the only session row iOS has is Today's "Last session", whose
    // copy is fixed by the contract and names neither — so this is what keeps the model matching the
    // wire the web's log row reads.
    func testALogRowIsTheSessionWithItsFactsBesideIt() throws {
        let row = try decode(SessionSummary.self, """
        { "id": "ses_1", "startedAt": 1754300000000, "finishedAt": 1754303720000,
          "setCount": 16, "exercises": ["back-squat", "romanian-deadlift"],
          "topSet": { "weightKg": 105, "reps": 5 }, "closedItself": true }
        """)

        XCTAssertEqual(row.id, "ses_1")
        XCTAssertFalse(row.session.isOpen)
        XCTAssertEqual(row.setCount, 16)
        XCTAssertEqual(row.exercises, ["back-squat", "romanian-deadlift"])
        XCTAssertEqual(row.topSet, TopSet(weightKg: 105, reps: 5))
        XCTAssertTrue(row.closedItself)
    }

    // A session holding no working set has no top set, and a session somebody finished with a tap
    // says nothing about the four-hour rule. Both absences are omissions.
    func testARowWithNoWorkingSetCarriesNoTopSetAndWasNotClosedByTheRule() throws {
        let row = try decode(SessionSummary.self, """
        { "id": "ses_2", "startedAt": 1754300000000, "finishedAt": 1754303720000, "setCount": 2 }
        """)

        XCTAssertNil(row.topSet)
        XCTAssertFalse(row.closedItself)
    }

    // A movement trained for the first time is answered 200 with the movement and nothing else — a
    // fact, not a fault. An absent REPLY means something else entirely: the log did not answer.
    func testAFirstEverMovementComesBackNamedAndEmpty() throws {
        let answer = try decode(LastTime.self, #"{"exerciseId":"zercher-squat"}"#)

        XCTAssertTrue(answer.isFirstTime)
        XCTAssertNil(answer.routine)
        XCTAssertTrue(answer.sets.isEmpty)
    }

    func testTheFinishScreenDecodesItsThreeFactsItsRecordAndItsComparison() throws {
        let review = try decode(Review.self, """
        { "stats": { "durationMs": 3720000, "workingSets": 16, "topE1rm": 122.5 },
          "slight": false,
          "record": { "kind": "e1rm", "exerciseId": "back-squat", "value": 122.5, "weightKg": 105,
                      "reps": 5, "previous": 116.7, "previousAt": 1750723200000 },
          "against": { "sessionId": "ses_p", "routine": "Legs", "startedAt": 1750723200000,
            "movements": [ { "exerciseId": "back-squat",
                             "now": { "weightKg": 105, "reps": 5, "sets": 5 },
                             "before": { "weightKg": 102.5, "reps": 5, "sets": 5 },
                             "planned": { "sets": 3, "reps": 12, "weightKg": 140 } } ] } }
        """)

        XCTAssertEqual(review.stats, Review.Stats(durationMs: 3_720_000, workingSets: 16, topE1rm: 122.5))
        XCTAssertFalse(review.slight)
        XCTAssertEqual(review.record?.kind, .e1rm)
        XCTAssertEqual(review.record?.previousAtMs, 1_750_723_200_000)
        XCTAssertEqual(review.against?.routine, "Legs")
        XCTAssertEqual(review.against?.movements.first?.now, Against.Effort(weightKg: 105, reps: 5, sets: 5))
        XCTAssertEqual(review.against?.movements.first?.planned, Against.Target(sets: 3, reps: 12, weightKg: 140))
    }

    // The ~190 sessions in 200 that earn nothing: three facts, and the space a record would occupy
    // left empty. Nothing takes its place, so nothing here may invent one.
    func testAnOrdinarySessionCarriesNoRecordAndNoComparison() throws {
        let review = try decode(Review.self, #"{"stats":{"durationMs":2820000,"workingSets":14},"slight":false}"#)

        XCTAssertNil(review.stats.topE1rm, "a session of unloaded work has no honest one-rep estimate")
        XCTAssertNil(review.record)
        XCTAssertNil(review.against)
    }

    func testARoutineCarriesItsOwnOrderAndItsLastTrainedStamp() throws {
        let routine = try decode(Routine.self, """
        { "id": "rt_9f", "name": "Push A", "position": 0, "lastTrainedAt": 1754300000000,
          "entries": [ { "position": 1, "exerciseId": "bench-press", "targetSets": 5, "targetReps": 5,
                         "targetWeightKg": 82.5, "restSeconds": 180 } ] }
        """)

        XCTAssertEqual(routine.lastTrainedAtMs, 1_754_300_000_000)
        XCTAssertEqual(routine.entries.map(\.position), [1])
        XCTAssertEqual(routine.entries.first?.targetWeightKg, 82.5)
    }

    // A routine nobody has trained sorts on the ABSENCE, not on a zero pretending to be 1970.
    func testARoutineNeverTrainedHasNoStampAtAll() throws {
        let routine = try decode(Routine.self, #"{"id":"rt_1","name":"Pull A","position":1,"entries":[]}"#)

        XCTAssertNil(routine.lastTrainedAtMs)
    }
}

final class RoutineWriteTests: XCTestCase {
    private func aSet(_ exerciseId: String, _ weightKg: Double, _ reps: Int,
                      _ kind: SetKind = .working, at completedAtMs: Int64) -> TrainingSet {
        TrainingSet(id: "set_\(completedAtMs)", exerciseId: exerciseId, weightKg: weightKg,
                    reps: reps, kind: kind, completedAtMs: completedAtMs)
    }

    // "Keep this as a routine" — the first routine is a by-product of the first session: movements in
    // the order performed, the count of WORKING sets, the modal reps, and the heaviest working load.
    func testARoutineKeptFromASessionIsWhatWasActuallyLifted() throws {
        let write = try XCTUnwrap(RoutineWrite(named: "Push A", from: [
            aSet("bench-press", 40, 10, .warmup, at: 100),
            aSet("bench-press", 82.5, 5, at: 200),
            aSet("bench-press", 82.5, 5, at: 300),
            aSet("bench-press", 85, 3, at: 400),
            aSet("back-squat", 100, 5, at: 500),
            aSet("back-squat", 60, 12, .drop, at: 600),
        ], position: 2, id: "rt_kept"))

        XCTAssertEqual(write.id, "rt_kept")
        XCTAssertEqual(write.position, 2)
        XCTAssertEqual(write.entries.map(\.exerciseId), ["bench-press", "back-squat"],
                       "in the order they were performed")
        XCTAssertEqual(write.entries[0], RoutineWrite.Entry(exerciseId: "bench-press", targetSets: 3,
                                                            targetReps: 5, targetWeightKg: 85))
        XCTAssertEqual(write.entries[1], RoutineWrite.Entry(exerciseId: "back-squat", targetSets: 1,
                                                            targetReps: 5, targetWeightKg: 100),
                       "a drop set is not what next week is aimed at")
    }

    // A tie on the modal reps goes to the SMALLER count: a target you can beat is a fact about last
    // week, and one you cannot hit reads as a failed session every time it comes round.
    func testATiedModalRepCountGoesToTheSmallerTarget() throws {
        let write = try XCTUnwrap(RoutineWrite(named: "Legs", from: [
            aSet("back-squat", 100, 5, at: 100),
            aSet("back-squat", 100, 5, at: 200),
            aSet("back-squat", 110, 3, at: 300),
            aSet("back-squat", 110, 3, at: 400),
        ], position: 0))

        XCTAssertEqual(write.entries.map(\.targetReps), [3])
        XCTAssertEqual(write.entries.map(\.targetWeightKg), [110])
    }

    // A routine with no entries is refused 400, and a session of nothing but warmups has none. There
    // is nothing to create, so nothing is offered.
    func testASessionOfNothingButWarmupsKeepsNoRoutine() {
        XCTAssertNil(RoutineWrite(named: "Push A", from: [
            aSet("bench-press", 40, 10, .warmup, at: 100),
        ], position: 0))
        XCTAssertNil(RoutineWrite(named: "Push A", from: [], position: 0))
    }

    // The mid-session change offer, applied: one target moves and the document is otherwise the one
    // the server handed back — a PUT is a whole-document replace, so a dropped line is a deleted one.
    func testSavingAHeavierWeightMovesOneTargetAndKeepsTheRest() {
        let routine = Routine(id: "rt_1", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5, restSeconds: 180),
            RoutineEntry(position: 2, exerciseId: "overhead-press", targetSets: 3, targetReps: 8,
                         targetWeightKg: 45),
        ])

        let write = RoutineWrite(routine.retargeting("bench-press", toWeightKg: 87.5))

        XCTAssertEqual(write.entries.map(\.exerciseId), ["bench-press", "overhead-press"])
        XCTAssertEqual(write.entries.map(\.targetWeightKg), [87.5, 45])
        XCTAssertEqual(write.entries[0].restSeconds, 180, "only the weight moved")
    }

    // The offer is only ever raised against a planned weight, so a movement the routine does not hold
    // means the answer arrived for some other routine — and nothing is written.
    func testRetargetingAMovementTheRoutineDoesNotHoldChangesNothing() {
        let routine = Routine(id: "rt_1", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ])

        XCTAssertEqual(routine.retargeting("back-squat", toWeightKg: 140), routine)
    }
}

final class PrefillTests: XCTestCase {
    private func aSet(_ weightKg: Double, _ reps: Int, at completedAtMs: Int64,
                      kind: SetKind = .working) -> TrainingSet {
        TrainingSet(id: "set_\(completedAtMs)", exerciseId: "bench-press", weightKg: weightKg,
                    reps: reps, kind: kind, completedAtMs: completedAtMs)
    }

    func testWithNoPlanAndNoHistoryThePadOpensOnTheEmptyBar() {
        let prefill = Prefill(todaySets: [], planEntry: nil, lastTime: nil)

        XCTAssertEqual(prefill, Prefill(weightKg: 20, reps: 5))
    }

    // Three sources in a fixed order: today's own last set, then the plan, then last time. The one
    // that loses is still on screen.
    func testTodaysLastSetWinsOverThePlanAndOverLastTime() {
        let prefill = Prefill(
            todaySets: [aSet(82.5, 5, at: 100), aSet(85, 3, at: 200)],
            planEntry: PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
            lastTime: LastTime(exerciseId: "bench-press", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(80, 8, at: 1)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 85, reps: 3))
    }

    func testThePlansTargetBeatsLastTimeBeforeAnythingIsLifted() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
            lastTime: LastTime(exerciseId: "bench-press", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(80, 8, at: 1)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 82.5, reps: 5))
    }

    // The asymmetry is deliberate: the weight comes from the LAST working set, where the lifter
    // actually ended up, and the reps from the FIRST, before fatigue cut them.
    func testLastTimeGivesTheWeightItEndedOnAndTheRepsItStartedOn() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: nil,
            lastTime: LastTime(exerciseId: "bench-press", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(80, 8, at: 1), aSet(85, 6, at: 2), aSet(90, 4, at: 3)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 90, reps: 8))
    }

    // The sticky carry-forward follows the WORKING sets. A 40 kg ramp-up is not the weight the next
    // set starts from, and carrying it would drag the dial back down the ladder the lifter has just
    // climbed — answering "what am I about to lift" with a warmup.
    func testAWarmupIsNotCarriedForwardAsTheStickyWeight() {
        let afterAWarmup = Prefill(
            todaySets: [aSet(40, 10, at: 100, kind: .warmup)],
            planEntry: PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
            lastTime: nil
        )
        XCTAssertEqual(afterAWarmup, Prefill(weightKg: 82.5, reps: 5), "the dial stays on the plan")

        let afterAWorkingSet = Prefill(
            todaySets: [aSet(40, 10, at: 100, kind: .warmup),
                        aSet(85, 5, at: 200),
                        aSet(65, 3, at: 300, kind: .warmup)],
            planEntry: PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
            lastTime: nil
        )
        XCTAssertEqual(afterAWorkingSet, Prefill(weightKg: 85, reps: 5),
                       "the last working set is the one the thumb is following")
    }

    // A plan that names sets and no rep target asks for NOTHING here: an absent target means max, so
    // the reps fall through to last time exactly as an absent weight does.
    func testAPlanWithNoRepTargetFallsThroughToLastTimeRatherThanToZero() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: PlanEntry(exerciseId: "chin-up", sets: 3),
            lastTime: LastTime(exerciseId: "chin-up", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(0, 9, at: 1), aSet(0, 6, at: 2)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 0, reps: 9))
        XCTAssertEqual(Prefill(todaySets: [], planEntry: PlanEntry(exerciseId: "chin-up", sets: 3),
                               lastTime: nil),
                       Prefill(weightKg: 20, reps: 5), "and with no history at all, the empty bar")
    }

    // A plan that names sets and reps and leaves the load to last time gets both halves from where
    // each is written — the plan is not all-or-nothing.
    func testAPlanWithNoTargetWeightStillGivesItsReps() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: PlanEntry(exerciseId: "chin-up", sets: 3, reps: 8),
            lastTime: LastTime(exerciseId: "chin-up", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(0, 12, at: 1)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 0, reps: 8))
    }

    // The rep floor belongs where the number is MINTED and not only on the button that moves it: a 0
    // written by a build from before the floor moved would otherwise open the pad on a value the
    // server refuses, in alarm ink, on a gesture the lifter never made.
    func testARepCountOfZeroFromAnOlderBuildClimbsBackToOne() {
        let prefill = Prefill(todaySets: [aSet(82.5, 0, at: 100)], planEntry: nil, lastTime: nil)

        XCTAssertEqual(prefill.reps, 1)
        XCTAssertEqual(prefill.weightKg, 82.5, "the load is signed and unbounded by design, and is never clamped")
    }
}

final class IdsTests: XCTestCase {
    // The client-minted id IS the idempotency key, so it has to be legal to the server on every
    // path: 8…64 characters of [A-Za-z0-9_-], and enough entropy that a collision is a refusal to
    // repair rather than a thing to plan around.
    func testEveryMintedIdIsLegalToTheServerAndCarriesItsPrefix() {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")

        for id in [Ids.session(), Ids.set(), Ids.routine(), Ids.exercise()] {
            XCTAssertTrue((8...64).contains(id.count), "\(id) is outside the shape the server enforces")
            XCTAssertTrue(CharacterSet(charactersIn: id).isSubset(of: allowed), "\(id) holds a character the server refuses")
        }
        XCTAssertTrue(Ids.session().hasPrefix("ses_"))
        XCTAssertTrue(Ids.set().hasPrefix("set_"))
        XCTAssertTrue(Ids.routine().hasPrefix("rt_"))
        XCTAssertTrue(Ids.exercise().hasPrefix("ex_"))
    }

    func testTwoMintedIdsAreNotTheSameId() {
        XCTAssertEqual(Set((0..<200).map { _ in Ids.set() }).count, 200)
    }
}
