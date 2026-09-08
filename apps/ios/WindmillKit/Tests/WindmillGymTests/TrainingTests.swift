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

    private let ramp = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80),
                        SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100),
                        SetTarget(reps: 5, weightKg: 80)]

    func testASessionCarriesItsFrozenPlanSnapshot() throws {
        let session = try decode(Session.self, """
        { "id": "ses_9f", "startedAt": 1754300000000, "routineId": "rt_1",
          "plan": { "routine": "Push A",
                    "entries": [ { "exerciseId": "bench-press",
                                   "sets": [ { "reps": 5, "weightKg": 82.5 }, { "reps": 5, "weightKg": 82.5 } ],
                                   "restSeconds": 180 },
                                 { "exerciseId": "face-pull" } ] } }
        """)

        XCTAssertEqual(session.id, "ses_9f")
        XCTAssertEqual(session.startedAtMs, 1_754_300_000_000)
        XCTAssertNil(session.finishedAtMs)
        XCTAssertTrue(session.isOpen)
        XCTAssertEqual(session.routineId, "rt_1")
        XCTAssertEqual(session.plan?.routine, "Push A")
        XCTAssertEqual(session.plan?.entry(for: "bench-press"),
                       PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 2), restSeconds: 180))
        XCTAssertEqual(session.plan?.entry(for: "face-pull"), PlanEntry(exerciseId: "face-pull"))
        XCTAssertEqual(session.plan?.entry(for: "face-pull")?.isOpen, true)
    }

    // The contract's bytes and back. `JSONEncoder` orders keys as it likes, so the pin is its sorted spelling.
    private func sorted(_ value: some Encodable) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try XCTUnwrap(String(data: encoder.encode(value), encoding: .utf8))
    }

    func testTheRampEntryRoundTripsByteExact() throws {
        let wire = #"{"position":1,"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":60},{"reps":5,"weightKg":80},{"reps":3,"weightKg":90},{"reps":1,"weightKg":100},{"reps":5,"weightKg":80}],"restSeconds":180}"#
        let entry = RoutineEntry(position: 1, exerciseId: "back-squat", sets: ramp, restSeconds: 180)
        XCTAssertEqual(try decode(RoutineEntry.self, wire), entry)
        XCTAssertEqual(try sorted(entry),
                       #"{"exerciseId":"back-squat","position":1,"restSeconds":180,"sets":[{"reps":5,"weightKg":60},{"reps":5,"weightKg":80},{"reps":3,"weightKg":90},{"reps":1,"weightKg":100},{"reps":5,"weightKg":80}]}"#)
        XCTAssertEqual(try decode(RoutineEntry.self, try sorted(entry)), entry)

        let write = RoutineWrite.Entry(exerciseId: "back-squat", sets: [SetTarget(reps: 5, weightKg: 60)], restSeconds: 180)
        XCTAssertEqual(try sorted(write), #"{"exerciseId":"back-squat","restSeconds":180,"sets":[{"reps":5,"weightKg":60}]}"#)
        let plan = PlanEntry(exerciseId: "back-squat", sets: [SetTarget(reps: 5, weightKg: 60)], restSeconds: 180)
        XCTAssertEqual(try sorted(plan), #"{"exerciseId":"back-squat","restSeconds":180,"sets":[{"reps":5,"weightKg":60}]}"#)
        XCTAssertEqual(try decode(PlanEntry.self, #"{"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":60}],"restSeconds":180}"#), plan)
    }

    // An open line has no `sets` key — never an empty array, which the log refuses as a zero target.
    func testAnOpenEntryHasNoSetsKeyOnTheWire() throws {
        let open = RoutineEntry(position: 2, exerciseId: "face-pull")
        XCTAssertEqual(try sorted(open), #"{"exerciseId":"face-pull","position":2}"#)
        XCTAssertEqual(try decode(RoutineEntry.self, #"{"position":2,"exerciseId":"face-pull"}"#), open)
        XCTAssertTrue(open.isOpen)
        XCTAssertEqual(try sorted(RoutineWrite.Entry(exerciseId: "face-pull")), #"{"exerciseId":"face-pull"}"#)
        XCTAssertEqual(try sorted(PlanEntry(exerciseId: "face-pull", restSeconds: 90)),
                       #"{"exerciseId":"face-pull","restSeconds":90}"#)
    }

    // A set's nulls keep their meaning: no reps is max, no load is last time, neither is ever null.
    func testASetsAbsencesAreOmittedRatherThanWrittenAsNull() throws {
        XCTAssertEqual(try sorted(SetTarget(weightKg: 100)), #"{"weightKg":100}"#)
        XCTAssertEqual(try sorted(SetTarget(reps: 5)), #"{"reps":5}"#)
        XCTAssertEqual(try sorted(SetTarget()), "{}")
        XCTAssertEqual(try decode(SetTarget.self, "{}"), SetTarget())
        XCTAssertEqual(try decode(RoutineEntry.self, #"{"position":3,"exerciseId":"chin-up","sets":[{},{},{}]}"#).sets,
                       Array(repeating: SetTarget(), count: 3))
    }

    // The review's `planned` is the scheme alone: `{}` is an open line, no key is no plan for the
    // movement, and neither is ever a null.
    func testTheReviewsPlannedSchemeReadsOpenAsEmptyAndAbsentAsNil() throws {
        let effort = #""now":{"reps":5,"sets":5,"weightKg":105}"#
        let open = try decode(Against.Movement.self, #"{"exerciseId":"face-pull",\#(effort),"planned":{}}"#)
        XCTAssertEqual(open.planned, [])
        XCTAssertEqual(try sorted(open), #"{"exerciseId":"face-pull","now":{"reps":5,"sets":5,"weightKg":105},"planned":{}}"#)
        let unplanned = try decode(Against.Movement.self, #"{"exerciseId":"face-pull",\#(effort)}"#)
        XCTAssertNil(unplanned.planned)
        XCTAssertEqual(try sorted(unplanned), #"{"exerciseId":"face-pull","now":{"reps":5,"sets":5,"weightKg":105}}"#)
        let ramped = Against.Movement(exerciseId: "back-squat", now: Against.Effort(weightKg: 100, reps: 1, sets: 1), planned: ramp)
        XCTAssertEqual(try decode(Against.Movement.self, try sorted(ramped)), ramped)
    }

    // A load arriving off the grid is rounded onto it once, so two readers never disagree by a cent.
    func testASetsLoadIsRoundedOntoTheLaddersGridOnTheWayIn() throws {
        XCTAssertEqual(SetTarget(reps: 5, weightKg: 82.505), SetTarget(reps: 5, weightKg: 82.51))
        XCTAssertEqual(try decode(SetTarget.self, #"{"weightKg":82.505}"#).weightKg, 82.51)
        XCTAssertTrue(SetTarget.agree(Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5)))
        XCTAssertTrue(SetTarget.agree([]))
        XCTAssertFalse(SetTarget.agree(ramp))
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
                             "planned": { "sets": [ { "reps": 12, "weightKg": 140 }, { "reps": 12, "weightKg": 140 },
                                                    { "reps": 12, "weightKg": 140 } ] } } ] } }
        """)

        XCTAssertEqual(review.stats, Review.Stats(durationMs: 3_720_000, workingSets: 16, topE1rm: 122.5))
        XCTAssertFalse(review.slight)
        XCTAssertEqual(review.record?.kind, .e1rm)
        XCTAssertEqual(review.record?.previousAtMs, 1_750_723_200_000)
        XCTAssertEqual(review.against?.routine, "Legs")
        XCTAssertEqual(review.against?.movements.first?.now, Against.Effort(weightKg: 105, reps: 5, sets: 5))
        XCTAssertEqual(review.against?.movements.first?.planned,
                       Array(repeating: SetTarget(reps: 12, weightKg: 140), count: 3))
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
          "entries": [ { "position": 1, "exerciseId": "bench-press",
                         "sets": [ { "reps": 5, "weightKg": 82.5 } ], "restSeconds": 180 } ] }
        """)

        XCTAssertEqual(routine.lastTrainedAtMs, 1_754_300_000_000)
        XCTAssertEqual(routine.entries.map(\.position), [1])
        XCTAssertEqual(routine.entries.first?.sets, [SetTarget(reps: 5, weightKg: 82.5)])
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
        XCTAssertEqual(write.entries[0], RoutineWrite.Entry(exerciseId: "bench-press", sets: [
            SetTarget(reps: 5, weightKg: 82.5), SetTarget(reps: 5, weightKg: 82.5), SetTarget(reps: 3, weightKg: 85),
        ]), "every working set, in order, as lifted")
        XCTAssertEqual(write.entries[1], RoutineWrite.Entry(exerciseId: "back-squat", sets: [SetTarget(reps: 5, weightKg: 100)]),
                       "a drop set is not what next week is aimed at")
    }

    // A ramp lifted is a ramp kept: every working set becomes its own planned set, in order.
    func testARoutineKeptFromARampTranscribesEveryWorkingSet() throws {
        let write = try XCTUnwrap(RoutineWrite(named: "Legs", from: [
            aSet("back-squat", 60, 5, at: 100),
            aSet("back-squat", 80, 5, at: 200),
            aSet("back-squat", 90, 3, at: 300),
        ], position: 0))
        XCTAssertEqual(write.entries, [RoutineWrite.Entry(exerciseId: "back-squat", sets: [
            SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 90),
        ])])
        XCTAssertEqual(Readout.target(write.entries[0].sets), "3 × 3\u{2013}5 · 60\u{2013}90")
    }

    func testASessionOfNothingButWarmupsKeepsNoRoutine() {
        XCTAssertNil(RoutineWrite(named: "Push A", from: [
            aSet("bench-press", 40, 10, .warmup, at: 100),
        ], position: 0))
        XCTAssertNil(RoutineWrite(named: "Push A", from: [], position: 0))
    }

    func testSavingASchemeReplacesOneLineAndKeepsTheRest() {
        let routine = Routine(id: "rt_1", name: "Push A", position: 0, lastTrainedAtMs: 9_000, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 100), count: 5), restSeconds: 180),
            RoutineEntry(position: 2, exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 8, weightKg: 80), count: 3), restSeconds: 120),
            RoutineEntry(position: 3, exerciseId: "overhead-press", sets: Array(repeating: SetTarget(reps: 8, weightKg: 45), count: 3)),
        ])

        let changed = routine.retargeting(position: 1, exerciseId: "bench-press",
                                          to: Array(repeating: SetTarget(reps: 5, weightKg: 105), count: 5))

        XCTAssertEqual(changed, Routine(id: "rt_1", name: "Push A", position: 0, lastTrainedAtMs: 9_000, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 105), count: 5), restSeconds: 180),
            RoutineEntry(position: 2, exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 8, weightKg: 80), count: 3), restSeconds: 120),
            RoutineEntry(position: 3, exerciseId: "overhead-press", sets: Array(repeating: SetTarget(reps: 8, weightKg: 45), count: 3)),
        ]))
        XCTAssertEqual(RoutineWrite(changed!).entries.map { $0.sets.map(\.weightKg) }, [Array(repeating: 105, count: 5), Array(repeating: 80, count: 3), Array(repeating: 45, count: 3)])
    }

    func testRetargetingAPositionThatNoLongerHoldsTheMovementIsNothingToWrite() {
        let routine = Routine(id: "rt_1", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "back-squat", sets: Array(repeating: SetTarget(reps: 5, weightKg: 140), count: 5)),
        ])

        XCTAssertNil(routine.retargeting(position: 1, exerciseId: "bench-press", to: [SetTarget(reps: 5, weightKg: 87.5)]))
        XCTAssertNil(routine.retargeting(position: 2, exerciseId: "back-squat", to: [SetTarget(reps: 5, weightKg: 145)]))
    }

    func testRetargetingAnOpenLineIsNothingToWrite() {
        let routine = Routine(id: "rt_1", name: "Pull A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "chin-up"),
        ])

        XCTAssertNil(routine.retargeting(position: 1, exerciseId: "chin-up", to: [SetTarget(reps: 8, weightKg: 10)]))
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
            planEntry: PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5)),
            lastTime: LastTime(exerciseId: "bench-press", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(80, 8, at: 1)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 85, reps: 3))
    }

    func testThePlansTargetBeatsLastTimeBeforeAnythingIsLifted() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5)),
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
            planEntry: PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5)),
            lastTime: nil
        )
        XCTAssertEqual(afterAWarmup, Prefill(weightKg: 82.5, reps: 5), "the dial stays on the plan")

        let afterAWorkingSet = Prefill(
            todaySets: [aSet(40, 10, at: 100, kind: .warmup),
                        aSet(85, 5, at: 200),
                        aSet(65, 3, at: 300, kind: .warmup)],
            planEntry: PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5)),
            lastTime: nil
        )
        XCTAssertEqual(afterAWorkingSet, Prefill(weightKg: 85, reps: 5),
                       "the last working set is the one the thumb is following")
    }

    func testAPlanWithNoRepTargetFallsThroughToLastTimeRatherThanToZero() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: PlanEntry(exerciseId: "chin-up", sets: Array(repeating: SetTarget(), count: 3)),
            lastTime: LastTime(exerciseId: "chin-up", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(0, 9, at: 1), aSet(0, 6, at: 2)])
        )

        XCTAssertEqual(prefill, Prefill(weightKg: 0, reps: 9))
        XCTAssertEqual(Prefill(todaySets: [], planEntry: PlanEntry(exerciseId: "chin-up", sets: Array(repeating: SetTarget(), count: 3)),
                               lastTime: nil),
                       Prefill(weightKg: 20, reps: 5), "and with no history at all, the empty bar")
    }

    // R8: on a scheme whose sets disagree the Nth working set opens on the Nth slot, not on the last set.
    func testOnADisagreeingSchemeThePadFollowsTheSlot() {
        let ramp = PlanEntry(exerciseId: "bench-press", sets: [
            SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 90),
            SetTarget(reps: 1, weightKg: 100), SetTarget(reps: 5, weightKg: 80),
        ])
        XCTAssertEqual(Prefill(todaySets: [], planEntry: ramp, lastTime: nil), Prefill(weightKg: 60, reps: 5))
        XCTAssertEqual(Prefill(todaySets: [aSet(60, 5, at: 1), aSet(80, 5, at: 2)], planEntry: ramp, lastTime: nil),
                       Prefill(weightKg: 90, reps: 3), "the rack fixture: set 3 opens on its own slot")
        XCTAssertEqual(Prefill(todaySets: [aSet(60, 5, at: 1), aSet(40, 10, at: 2, kind: .warmup), aSet(80, 5, at: 3)],
                               planEntry: ramp, lastTime: nil),
                       Prefill(weightKg: 90, reps: 3), "a warmup between does not advance the slot")
        XCTAssertEqual(Prefill(todaySets: (1...5).map { aSet(100, 1, at: Int64($0)) }, planEntry: ramp, lastTime: nil),
                       Prefill(weightKg: 100, reps: 1), "past the plan the last set carries forward again")
    }

    func testASilentSlotTakesLastTimesNthWorkingSetThenTodaysLastThenTheBar() {
        let scheme = PlanEntry(exerciseId: "bench-press", sets: [SetTarget(reps: 5, weightKg: 60), SetTarget(), SetTarget(reps: 3)])
        let history = LastTime(exerciseId: "bench-press", session: Session(id: "ses_p", startedAtMs: 1),
                               sets: [aSet(70, 8, at: 1, kind: .warmup), aSet(80, 8, at: 2), aSet(85, 6, at: 3)])
        XCTAssertEqual(Prefill(todaySets: [aSet(60, 5, at: 10)], planEntry: scheme, lastTime: history),
                       Prefill(weightKg: 85, reps: 6), "last time's second WORKING set, the warmup not counted")
        XCTAssertEqual(Prefill(todaySets: [aSet(60, 5, at: 10)], planEntry: scheme, lastTime: nil),
                       Prefill(weightKg: 60, reps: 5), "then today's last set")
        XCTAssertEqual(Prefill(todaySets: [aSet(60, 5, at: 10), aSet(62.5, 5, at: 11)], planEntry: scheme, lastTime: nil),
                       Prefill(weightKg: 62.5, reps: 3), "the third slot names reps and borrows today's load")
        XCTAssertEqual(Prefill(todaySets: [], planEntry: PlanEntry(exerciseId: "bench-press", sets: [SetTarget(), SetTarget(reps: 3)]),
                               lastTime: nil),
                       Prefill(weightKg: 20, reps: 5), "and the empty bar when nothing has been lifted anywhere")
    }

    func testOnAStraightSchemeTheLastWorkingSetStaysSticky() {
        let straight = PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 80), count: 5))
        XCTAssertEqual(Prefill(todaySets: [aSet(82.5, 5, at: 1)], planEntry: straight, lastTime: nil),
                       Prefill(weightKg: 82.5, reps: 5), "a lifter who chose 82.5 on set 1 chose it for the day")
    }

    func testAPlanWithNoTargetWeightStillGivesItsReps() {
        let prefill = Prefill(
            todaySets: [],
            planEntry: PlanEntry(exerciseId: "chin-up", sets: Array(repeating: SetTarget(reps: 8), count: 3)),
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
