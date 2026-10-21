import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncSchema
import Testing

struct CoachOnboardingTests {
  @Test func allRoutinesAndTheirReplayReceiptCommitTogether() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let replica = try phone.runner.read(Gym.scope) { $0.replica }
    let routines = [CoachRoutine(name: "Upper", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8)])]),
                    CoachRoutine(name: "Lower", entries: [RoutineEntry(exerciseId: ID("back-squat"))])]
    let action = ImportCoachRoutines(replica: replica, requestId: "request", resultId: "result", routines: routines)
    phone.failNextCommit()
    #expect(throws: (any Error).self) { try phone.runner.run(action) }
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(ImportCoachRoutines.receiptKey) } == nil)
    let created = try #require(committed(phone.runner.run(action)))
    let expected = zip(created, routines).enumerated().map { index, item in Routine(id: item.0, name: item.1.name, position: index, entries: item.1.entries) }
    #expect(try Routine.ordered(phone.drawn(Routine.self)) == expected)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(ImportCoachRoutines.receiptKey) } == ["request": ["resultId": "result", "routines": .array(created.map(\.json))]])
    #expect(try unchanged(phone.runner.run(action)) == created)
    #expect(try Routine.ordered(phone.drawn(Routine.self)) == expected)
    #expect(try phone.runner.run(ImportCoachRoutines(replica: replica, requestId: "request", resultId: "other", routines: routines)).refusal != nil)
  }

  @Test func oneInvalidRoutineRejectsTheEntireResultAndSeatChangeCannotImport() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let replica = try phone.runner.read(Gym.scope) { $0.replica }
    let valid = CoachRoutine(name: "Upper", entries: [RoutineEntry(exerciseId: ID("bench-press"))])
    let invalid = CoachRoutine(name: "Unknown", entries: [RoutineEntry(exerciseId: ID("private-custom-movement"))])
    #expect(try phone.runner.run(ImportCoachRoutines(replica: replica, requestId: "request", resultId: "result", routines: [valid, invalid])).refusal != nil)
    #expect(try phone.runner.run(ImportCoachRoutines(replica: "old-seat", requestId: "request", resultId: "result", routines: [valid])).refusal != nil)
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(ImportCoachRoutines.receiptKey) } == nil)
    let account = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let accountReplica = try account.runner.read(Gym.scope) { $0.replica }
    #expect(try account.runner.run(ImportCoachRoutines(replica: accountReplica, requestId: "request", resultId: "result", routines: [valid])).refusal != nil)
    #expect(try account.drawn(Routine.self).isEmpty)
  }

  @Test func resultBoundsRejectOverlargeSetsAndPreserveOpenAndAssistedTargets() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let replica = try phone.runner.read(Gym.scope) { $0.replica }
    let invalid = CoachRoutine(name: "Upper", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: Array(repeating: SetTarget(reps: 8), count: 9))])
    #expect(try phone.runner.run(ImportCoachRoutines(replica: replica, requestId: "too-many", resultId: "result", routines: [invalid])).refusal != nil)
    let valid = CoachRoutine(name: "Upper", entries: [RoutineEntry(exerciseId: ID("pull-up"), sets: [SetTarget(reps: 5, weightKg: -20)]), RoutineEntry(exerciseId: ID("bench-press"))])
    #expect(try phone.runner.run(ImportCoachRoutines(replica: replica, requestId: "valid", resultId: "result", routines: [valid])).receipt != nil)
    #expect(try phone.drawn(Routine.self).map(\.entries) == [valid.entries])
  }
}
