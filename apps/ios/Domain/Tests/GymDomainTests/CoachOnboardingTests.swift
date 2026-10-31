import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncSchema
import Testing

struct CoachOnboardingTests {
  @Test(arguments: try Contract.vectors("gym/domain/coach-onboarding-actions.json"))
  func sharedBatchImport(_ vector: Vector) throws {
    let input = try vector.input.member("input")
    let fields = try Fields(input)
    let routines = try input.member("routines").asArray().map { value in
      let routine = try Fields(value)
      return CoachRoutineImport(id: try routine.ref("id", Routine.self), name: try routine.string("name"),
                                entries: try routine.list("entries", of: RoutineEntry.self))
    }
    let movements = try input.member("movements").asArray().map { value in
      let movement = try Fields(value)
      return Exercise(id: try movement.ref("id", Exercise.self), name: try movement.string("name"),
        pattern: try movement.string("pattern"), equipment: try movement.string("equipment"),
        stepKg: try movement.double("stepKg"), loadCount: try movement.int("loadCount"))
    }
    let action = ImportCoachRoutineBatch(replica: try fields.string("replica"), resultId: try fields.string("resultId"),
      fingerprint: try fields.string("fingerprint"), receiptKey: try fields.string("receiptKey"), routines: routines, movements: movements)
    let result = try ProductCorpus(GymRules.book).decision(of: action, vector, result: \.json, refusal: \.form)
    #expect(result == vector.expect, "\(vector)\n  got \(result.jcsText)")
  }

  @Test func draftsNormalizeIntoOneFingerprintAndAReceiptKeyOfTheirResult() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let drafts = [CoachRoutineImport(id: ID("routine-a"), name: " Upper ", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8)])]),
                  CoachRoutineImport(id: ID("routine-b"), name: "Lower", entries: [RoutineEntry(exerciseId: ID("back-squat"))])]
    let action = try ImportCoachRoutineBatch(replica: "replica", resultId: "result", drafts: drafts, at: phone.runner.moment())
    #expect(action.fingerprint == "9ee3ce25ffc283ce32f365fe9bc3db8c3fc96bfc2a9a80f9f5b0b179d87e4b83")
    #expect(action.receiptKey == "rack:coachImportf6a214f7a5fcda0c2cee9660b7fc29f5649e3c68aad48e20")
    #expect(action.routines.map(\.name) == ["Upper", "Lower"])
    let opaque = String(repeating: "x", count: 128)
    let key = ImportCoachRoutineBatch.receiptKey(for: opaque)
    #expect(ImportCoachRoutineBatch.validReceiptKey(key))
    #expect(key != ImportCoachRoutineBatch.receiptKey(for: opaque + "y"))
  }

  @Test func allRoutinesAndTheirReplayReceiptCommitTogetherAndARetryReplays() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let replica = try phone.runner.read(Gym.scope) { $0.replica }
    let routines = [CoachRoutine(name: "Upper", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8)])]),
                    CoachRoutine(name: "Lower", entries: [RoutineEntry(exerciseId: ID("back-squat"))])]
    let apply = {
      try ImportCoachRoutineBatch(replica: replica, resultId: "result", drafts: routines.map { routine in
        CoachRoutineImport(id: phone.runner.mint(Routine.self), name: routine.name, entries: routine.entries)
      }, at: phone.runner.moment())
    }
    let key = ImportCoachRoutineBatch.receiptKey(for: "result")
    phone.failNextCommit()
    #expect(throws: (any Error).self) { try phone.runner.run(try apply()) }
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(key) } == nil)
    let first = try apply()
    let receipt = try #require(committed(phone.runner.run(first)))
    let expected = zip(receipt.routines, routines).enumerated().map { index, item in Routine(id: item.0, name: item.1.name, position: index, entries: item.1.entries) }
    #expect(receipt.routines == first.routines.map(\.id))
    #expect(try Routine.ordered(phone.drawn(Routine.self)) == expected)
    let saved = try phone.runner.read(Gym.scope) { try $0.device(key) }
    #expect(saved == ["resultId": "result", "fingerprint": .string(first.fingerprint), "routines": .array(receipt.routines.map(\.json)), "movements": []])
    let retried = try unchanged(phone.runner.run(apply()))
    #expect(retried == receipt)
    #expect(try Routine.ordered(phone.drawn(Routine.self)) == expected)
    let changed = try ImportCoachRoutineBatch(replica: replica, resultId: "result", drafts: [CoachRoutineImport(id: ID("other"), name: "Other", entries: routines[0].entries)], at: phone.runner.moment())
    #expect(try phone.runner.run(changed).refusal != nil)
    #expect(try Routine.ordered(phone.drawn(Routine.self)) == expected)
  }

  @Test func aResultImportedUnderTheEarlierSingleReceiptReplaysItsRoutines() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let replica = try phone.runner.read(Gym.scope) { $0.replica }
    let earlier: JSON = ["request": ["resultId": "result", "routines": ["routine-earlier"]]]
    _ = try phone.runner.run(WriteDeviceRow(key: ImportCoachRoutineBatch.earlierReceiptKey, value: earlier))
    let entries = [RoutineEntry(exerciseId: ID("bench-press"))]
    let action = try ImportCoachRoutineBatch(replica: replica, resultId: "result",
      drafts: [CoachRoutineImport(id: ID("routine-new"), name: "Upper", entries: entries)], at: phone.runner.moment())
    let replayed = try unchanged(phone.runner.run(action))
    #expect(replayed == CoachImportReceipt(resultId: "result", fingerprint: action.fingerprint, routines: [ID("routine-earlier")], movements: []))
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(action.receiptKey) } == nil)
    let other = try ImportCoachRoutineBatch(replica: replica, resultId: "other-result",
      drafts: [CoachRoutineImport(id: ID("routine-new"), name: "Upper", entries: entries)], at: phone.runner.moment())
    #expect(try committed(phone.runner.run(other))?.routines == [ID("routine-new")])
    #expect(try phone.runner.read(Gym.scope) { try $0.device(ImportCoachRoutineBatch.earlierReceiptKey) } == earlier)
  }

  @Test func oneInvalidRoutineRejectsTheEntireResultAndSeatChangeCannotImport() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let replica = try phone.runner.read(Gym.scope) { $0.replica }
    let valid = CoachRoutineImport(id: ID("routine-a"), name: "Upper", entries: [RoutineEntry(exerciseId: ID("bench-press"))])
    let invalid = CoachRoutineImport(id: ID("routine-b"), name: "Unknown", entries: [RoutineEntry(exerciseId: ID("private-custom-movement"))])
    let mixed = try ImportCoachRoutineBatch(replica: replica, resultId: "result", drafts: [valid, invalid], at: phone.runner.moment())
    #expect(try phone.runner.run(mixed).refusal != nil)
    let moved = try ImportCoachRoutineBatch(replica: "old-seat", resultId: "result", drafts: [valid], at: phone.runner.moment())
    #expect(try phone.runner.run(moved).refusal != nil)
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(ImportCoachRoutineBatch.receiptKey(for: "result")) } == nil)
    let account = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let accountReplica = try account.runner.read(Gym.scope) { $0.replica }
    let action = try ImportCoachRoutineBatch(replica: accountReplica, resultId: "result", drafts: [valid], at: account.runner.moment())
    let receipt = try #require(committed(account.runner.run(action)))
    #expect(try account.drawn(Routine.self).map(\.entries) == [valid.entries])
    #expect(try unchanged(account.runner.run(action)) == receipt)
  }

  @Test func resultBoundsRejectOverlargeSetsAndPreserveOpenAndAssistedTargets() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let replica = try phone.runner.read(Gym.scope) { $0.replica }
    let invalid = CoachRoutineImport(id: ID("routine-a"), name: "Upper", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: Array(repeating: SetTarget(reps: 8), count: 9))])
    let overlarge = try ImportCoachRoutineBatch(replica: replica, resultId: "too-many", drafts: [invalid], at: phone.runner.moment())
    #expect(try phone.runner.run(overlarge).refusal != nil)
    let entries = [RoutineEntry(exerciseId: ID("pull-up"), sets: [SetTarget(reps: 5, weightKg: -20)]), RoutineEntry(exerciseId: ID("bench-press"))]
    let valid = try ImportCoachRoutineBatch(replica: replica, resultId: "valid",
      drafts: [CoachRoutineImport(id: ID("routine-b"), name: "Upper", entries: entries)], at: phone.runner.moment())
    #expect(try phone.runner.run(valid).receipt != nil)
    #expect(try phone.drawn(Routine.self).map(\.entries) == [entries])
  }

  @Test func adoptionRewritesTheJoinedIdentitiesOfAnImportReceiptOnly() {
    let receipt = CoachImportReceipt(resultId: "result", fingerprint: String(repeating: "a", count: 64),
      routines: [ID("routine-a"), ID("routine-b")], movements: [ID("movement-a")])
    let key = ImportCoachRoutineBatch.receiptKey(for: "result")
    let rewrite = ImportCoachRoutineBatch.rewriteDeviceValue
    let routine = rewrite("gym", key, receipt.json, Gym.Types.routine, RecordID("routine-b"), RecordID("routine-joined"))
    let movement = rewrite("gym", key, routine, Gym.Types.exercise, RecordID("movement-a"), RecordID("movement-joined"))
    #expect(movement == ["resultId": "result", "fingerprint": .string(String(repeating: "a", count: 64)),
                         "routines": ["routine-a", "routine-joined"], "movements": ["movement-joined"]])
    #expect(rewrite("journal", key, receipt.json, Gym.Types.routine, RecordID("routine-b"), RecordID("routine-joined")) == receipt.json)
    #expect(rewrite("gym", "rack:other", receipt.json, Gym.Types.routine, RecordID("routine-b"), RecordID("routine-joined")) == receipt.json)
    #expect(rewrite("gym", key, receipt.json, Gym.Types.session, RecordID("routine-b"), RecordID("routine-joined")) == receipt.json)
  }
}

struct WriteDeviceRow: Action {
  let key: String
  let value: JSON
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws {}
  func decide(_ loaded: Void, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    var plan = Plan()
    plan.device(key, value)
    return .write(plan)
  }
}
