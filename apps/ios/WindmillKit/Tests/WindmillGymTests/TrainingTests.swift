import XCTest
@testable import WindmillGym

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

    func testAPlanLineWithNoTargetWeightIsAnAbsenceAndNotAZero() throws {
        let entry = try decode(PlanEntry.self, #"{"exerciseId":"chin-up","sets":3,"reps":8}"#)

        XCTAssertNil(entry.weightKg)
        XCTAssertNil(entry.restSeconds)
    }

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

    func testAKindThisBuildHasNeverHeardOfReadsAsWorking() throws {
        let set = try decode(TrainingSet.self,
                             #"{"id":"set_1","exerciseId":"x","weightKg":1,"reps":1,"kind":"cluster","completedAt":1}"#)

        XCTAssertEqual(set.kind, .working)
    }

    func testAnAbsentOptionalIsOmittedRatherThanWrittenAsNull() throws {
        let queued = TrainingSet(id: "set_1", exerciseId: "bench-press", weightKg: 82.5, reps: 5,
                                 completedAtMs: 1_754_300_000_000)
        let written = try fields(of: queued)

        XCTAssertNil(written["setNumber"], "a set this device minted has no number until the log gives it one")
        XCTAssertNil(written["rpe"])
        XCTAssertEqual(written["completedAt"] as? Int64, 1_754_300_000_000)

        let start = try fields(of: SessionStart(id: "ses_1", startedAtMs: 1))
        XCTAssertNil(start["routineId"], "an ad-hoc session names no routine, and says so by silence")
        XCTAssertNil(start["joinOpenSession"],
                     "omitted is the wire's join default — every start this room sends spells false instead")
        let stated = try fields(of: SessionStart(id: "ses_1", startedAtMs: 1, joinOpenSession: false))
        XCTAssertEqual(stated["joinOpenSession"] as? Bool, false,
                       "and a stated false reaches the wire rather than being dropped as a default")
    }

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

    func testARowWithNoWorkingSetCarriesNoTopSetAndWasNotClosedByTheRule() throws {
        let row = try decode(SessionSummary.self, """
        { "id": "ses_2", "startedAt": 1754300000000, "finishedAt": 1754303720000, "setCount": 2 }
        """)

        XCTAssertNil(row.topSet)
        XCTAssertFalse(row.closedItself)
    }

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

    func testASessionOfNothingButWarmupsKeepsNoRoutine() {
        XCTAssertNil(RoutineWrite(named: "Push A", from: [
            aSet("bench-press", 40, 10, .warmup, at: 100),
        ], position: 0))
        XCTAssertNil(RoutineWrite(named: "Push A", from: [], position: 0))
    }

    func testSavingAHeavierWeightMovesOneTargetAndKeepsTheRest() {
        let routine = Routine(id: "rt_1", name: "Push A", position: 0, lastTrainedAtMs: 9_000, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 100, restSeconds: 180),
            RoutineEntry(position: 2, exerciseId: "bench-press", targetSets: 3, targetReps: 8,
                         targetWeightKg: 80, restSeconds: 120),
            RoutineEntry(position: 3, exerciseId: "overhead-press", targetSets: 3, targetReps: 8,
                         targetWeightKg: 45),
        ])

        let changed = routine.retargeting(position: 1, exerciseId: "bench-press", toWeightKg: 105)

        XCTAssertEqual(changed, Routine(id: "rt_1", name: "Push A", position: 0, lastTrainedAtMs: 9_000, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 105, restSeconds: 180),
            RoutineEntry(position: 2, exerciseId: "bench-press", targetSets: 3, targetReps: 8,
                         targetWeightKg: 80, restSeconds: 120),
            RoutineEntry(position: 3, exerciseId: "overhead-press", targetSets: 3, targetReps: 8,
                         targetWeightKg: 45),
        ]))
        XCTAssertEqual(RoutineWrite(changed!).entries.map(\.targetWeightKg), [105, 80, 45])
    }

    func testRetargetingAPositionThatNoLongerHoldsTheMovementIsNothingToWrite() {
        let routine = Routine(id: "rt_1", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "back-squat", targetSets: 5, targetReps: 5,
                         targetWeightKg: 140),
        ])

        XCTAssertNil(routine.retargeting(position: 1, exerciseId: "bench-press", toWeightKg: 87.5))
        XCTAssertNil(routine.retargeting(position: 2, exerciseId: "back-squat", toWeightKg: 145))
    }

    func testRetargetingAnOpenLineIsNothingToWrite() {
        let routine = Routine(id: "rt_1", name: "Pull A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "chin-up"),
        ])

        XCTAssertNil(routine.retargeting(position: 1, exerciseId: "chin-up", toWeightKg: 10))
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

    func testLastTimeGivesTheWeightItEndedOnAndTheRepsItStartedOn() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: nil,
            lastTime: LastTime(exerciseId: "bench-press", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(80, 8, at: 1), aSet(85, 6, at: 2), aSet(90, 4, at: 3)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 90, reps: 8))
    }

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

    func testAPlanWithNoTargetWeightStillGivesItsReps() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: PlanEntry(exerciseId: "chin-up", sets: 3, reps: 8),
            lastTime: LastTime(exerciseId: "chin-up", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(0, 12, at: 1)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 0, reps: 8))
    }

    func testARepCountOfZeroFromAnOlderBuildClimbsBackToOne() {
        let prefill = Prefill(todaySets: [aSet(82.5, 0, at: 100)], planEntry: nil, lastTime: nil)

        XCTAssertEqual(prefill.reps, 1)
        XCTAssertEqual(prefill.weightKg, 82.5, "the load is signed and unbounded by design, and is never clamped")
    }
}

final class IdsTests: XCTestCase {
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
