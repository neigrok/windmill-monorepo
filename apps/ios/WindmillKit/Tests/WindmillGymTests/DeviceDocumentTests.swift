import XCTest
@testable import WindmillGym

// The bytes the previous app version wrote, read by this one: nothing is lost, and the next flush
// writes the one shape.
final class DeviceDocumentTests: XCTestCase {
    private var localURL: URL!
    private var queueURL: URL!

    override func setUp() {
        localURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("gym-local-\(UUID().uuidString).json")
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("gym-queue-\(UUID().uuidString).json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: localURL)
        try? FileManager.default.removeItem(at: queueURL)
    }

    private let ramp = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80),
                        SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100),
                        SetTarget(reps: 5, weightKg: 80)]

    // F1: a shelf with one finished session on an old-shape plan, one new-shape ramp routine and one
    // minted movement.
    func testAShelfWrittenByThePreviousVersionIsRewrittenOnLoadAndNothingIsLost() throws {
        let previous = #"""
        {"shelves":{"anon":{"sessions":[{"session":{"id":"ses_old","startedAt":1000,"finishedAt":2000,"routineId":"rt_push","plan":{"routine":"Push A","entries":[{"exerciseId":"bench-press","sets":5,"reps":5,"weightKg":82.5,"restSeconds":180},{"exerciseId":"face-pull"}]}},"sets":[{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,"kind":"working","note":"","completedAt":1500}]}],"routines":[{"id":"rt_lower","name":"Lower A","position":2,"entries":[{"position":1,"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":60},{"reps":5,"weightKg":80},{"reps":3,"weightKg":90},{"reps":1,"weightKg":100},{"reps":5,"weightKg":80}],"restSeconds":180}]}],"exercises":[{"id":"ex_1","name":"Zercher Squat","pattern":"squat","equipment":"barbell"}]}}}
        """#
        try Data(previous.utf8).write(to: localURL)

        let shelf = LocalLog(url: localURL, deviceHolds: nil)
        shelf.open(under: nil)
        let expectedSession = Session(
            id: "ses_old", startedAtMs: 1_000, finishedAtMs: 2_000, routineId: "rt_push",
            plan: PlanSnapshot(routine: "Push A", entries: [
                PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5), restSeconds: 180),
                PlanEntry(exerciseId: "face-pull"),
            ]))
        let expectedSet = TrainingSet(id: "set_a", exerciseId: "bench-press", weightKg: 82.5, reps: 5, completedAtMs: 1_500)
        XCTAssertEqual(shelf.sessions, [LocalLog.LocalSession(session: expectedSession, sets: [expectedSet])])
        XCTAssertEqual(shelf.routines, [Routine(id: "rt_lower", name: "Lower A", position: 2, entries: [
            RoutineEntry(position: 1, exerciseId: "back-squat", sets: ramp, restSeconds: 180),
        ])])
        XCTAssertEqual(shelf.exercises, [ExerciseWrite(id: "ex_1", name: "Zercher Squat", pattern: "squat", equipment: "barbell")])

        shelf.flush()
        let written = try String(contentsOf: localURL, encoding: .utf8)
        XCTAssertFalse(written.contains(#""sets":5"#), "the next flush writes the one shape")
        XCTAssertTrue(written.contains(#""sets":[{"#))
        let reopened = LocalLog(url: localURL, deviceHolds: nil)
        reopened.open(under: nil)
        XCTAssertEqual(reopened.sessions, shelf.sessions)
        XCTAssertEqual(reopened.routines, shelf.routines)
        XCTAssertEqual(reopened.exercises, shelf.exercises)
    }

    // F1: a routine entry that spelled its target as the triple becomes n identical sets; one that
    // named no count is the open line, whatever else it named.
    func testARoutineWrittenByThePreviousVersionBecomesTheOneShape() throws {
        let previous = #"""
        {"shelves":{"u.u1":{"routines":[{"id":"rt_push","name":"Push A","position":1,"lastTrainedAt":900,"entries":[{"position":1,"exerciseId":"bench-press","targetSets":3,"targetReps":8,"targetWeightKg":60,"restSeconds":120},{"position":2,"exerciseId":"chin-up","targetSets":3},{"position":3,"exerciseId":"face-pull","targetReps":15},{"position":4,"exerciseId":"dip"}]}]}}}
        """#
        try Data(previous.utf8).write(to: localURL)

        let shelf = LocalLog(url: localURL, deviceHolds: nil)
        shelf.open(under: "u1")
        XCTAssertEqual(shelf.routines, [Routine(id: "rt_push", name: "Push A", position: 1, lastTrainedAtMs: 900, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3), restSeconds: 120),
            RoutineEntry(position: 2, exerciseId: "chin-up", sets: Array(repeating: SetTarget(), count: 3)),
            RoutineEntry(position: 3, exerciseId: "face-pull"),
            RoutineEntry(position: 4, exerciseId: "dip"),
        ])])

        shelf.flush()
        let written = try String(contentsOf: localURL, encoding: .utf8)
        XCTAssertFalse(written.contains("targetSets"))
        XCTAssertFalse(written.contains("targetReps"))
    }

    // F1: a queue with a live session on an old-shape plan and one owed set.
    func testAQueueWrittenByThePreviousVersionKeepsItsLiveSessionAndItsOwedSet() throws {
        let previous = #"""
        {"queues":{"anon":{"session":{"id":"ses_live","startedAt":1000,"routineId":"rt_push","plan":{"routine":"Push A","entries":[{"exerciseId":"bench-press","sets":5,"reps":5,"weightKg":82.5}]}},"entries":{"set_a":{"set":{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,"kind":"working","note":"","completedAt":1500},"sessionId":"ses_live","needsPush":true,"remints":0,"owedWrite":"append"}},"order":["bench-press"],"unclaimed":true}}}
        """#
        try Data(previous.utf8).write(to: queueURL)

        let queue = SetQueue(url: queueURL, deviceHolds: nil)
        queue.open(under: nil)
        XCTAssertEqual(queue.session, Session(
            id: "ses_live", startedAtMs: 1_000, routineId: "rt_push",
            plan: PlanSnapshot(routine: "Push A", entries: [
                PlanEntry(exerciseId: "bench-press", sets: Array(repeating: SetTarget(reps: 5, weightKg: 82.5), count: 5)),
            ])))
        XCTAssertTrue(queue.sessionIsUnclaimed)
        XCTAssertEqual(queue.order, ["bench-press"])
        XCTAssertEqual(queue.sets, [TrainingSet(id: "set_a", exerciseId: "bench-press", weightKg: 82.5, reps: 5, completedAtMs: 1_500)])
        XCTAssertEqual(queue.pending.map(\.set.id), ["set_a"])
        XCTAssertEqual(queue.owes("set_a"), .append)

        queue.flush()
        let written = try String(contentsOf: queueURL, encoding: .utf8)
        XCTAssertFalse(written.contains(#""sets":5"#))
        let reopened = SetQueue(url: queueURL, deviceHolds: nil)
        reopened.open(under: nil)
        XCTAssertEqual(reopened.session, queue.session)
        XCTAssertEqual(reopened.pending, queue.pending)
    }

    // F2: one row this build cannot read costs that row alone.
    func testAnUnreadableSessionRoutineOrMovementIsDroppedAloneAndTheShelfKeepsTheRest() throws {
        let mixed = #"""
        {"shelves":{"anon":{"sessions":[{"session":{"id":"ses_bad","startedAt":"yesterday"},"sets":[]},{"session":{"id":"ses_good","startedAt":1000,"finishedAt":2000},"sets":[]}],"routines":[{"id":7,"name":"Not A Routine","position":1},{"id":"rt_good","name":"Lower A","position":2,"entries":[]}],"exercises":[{"id":"ex_bad","pattern":"squat","equipment":"barbell"},{"id":"ex_good","name":"Zercher Squat","pattern":"squat","equipment":"barbell"}]}},"preferences":{"units":"lb","confirmHaptic":true,"confirmSound":true}}
        """#
        try Data(mixed.utf8).write(to: localURL)

        let shelf = LocalLog(url: localURL, deviceHolds: nil)
        shelf.open(under: nil)
        XCTAssertEqual(shelf.sessions.map { $0.session.id }, ["ses_good"])
        XCTAssertEqual(shelf.routines.map(\.id), ["rt_good"])
        XCTAssertEqual(shelf.exercises.map(\.id), ["ex_good"])
        XCTAssertEqual(shelf.preferences?.units, .lb, "and the rest of the document is untouched")
    }

    func testAnUnreadableOwedSetIsDroppedAloneAndTheQueueKeepsTheLiveSessionAndTheRest() throws {
        let mixed = #"""
        {"queues":{"anon":{"session":{"id":"ses_live","startedAt":1000},"entries":{"set_bad":{"set":{"id":"set_bad","exerciseId":"bench-press","reps":5,"completedAt":1400},"sessionId":"ses_live","needsPush":true,"remints":0},"set_good":{"set":{"id":"set_good","exerciseId":"bench-press","weightKg":82.5,"reps":5,"kind":"working","note":"","completedAt":1500},"sessionId":"ses_live","needsPush":true,"remints":0}},"order":["bench-press"]}}}
        """#
        try Data(mixed.utf8).write(to: queueURL)

        let queue = SetQueue(url: queueURL, deviceHolds: nil)
        queue.open(under: nil)
        XCTAssertEqual(queue.session?.id, "ses_live")
        XCTAssertEqual(queue.sets.map(\.id), ["set_good"])
        XCTAssertEqual(queue.pending.map(\.set.id), ["set_good"])
        XCTAssertEqual(queue.order, ["bench-press"])
    }
}
