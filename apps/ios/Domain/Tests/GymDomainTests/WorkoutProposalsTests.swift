import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
import Testing

struct WorkoutProposalsTests {
  static let proposalId = ID<WorkoutProposal>(RecordID("wproposal1"))

  static func propose(_ h: Harness, _ entries: [RoutineEntry]) throws -> Outcome<ID<WorkoutProposal>, GymRefusal> {
    try h.runner.run(ProposeWorkout(id: proposalId, sessionId: WorkoutPlanTests.sessionId, entries: entries, summary: " Lighter pull-ups "))
  }

  // A proposal lands as its diff against the plan, guarded on it; applying it predicts the proposed plan at once, and a
  // set logged since on a movement it changes makes it out of date before anything is sent.
  @Test func aProposalAppliesItsPlanAtOnceUntilAMovementItChangesIsLogged() throws {
    let a = try WorkoutPlanTests.phone()
    let lighter = RoutineEntry(exerciseId: ID("pullup01"), sets: Array(repeating: SetTarget(reps: 8, weightKg: 5), count: 3), restSeconds: 120)
    #expect(try committed(Self.propose(a, [WorkoutPlanTests.entries[0], lighter])) == Self.proposalId)
    a.sync()
    #expect(try a.notices(GymRefusal.self).isEmpty)
    let proposal = try #require(try a.drawn(WorkoutProposal.self).first)
    #expect(proposal.summary == "Lighter pull-ups" && proposal.state == "pending")
    #expect(proposal.changes.map(\.kind) == ["kept", "retargeted"])
    #expect(try a.runner.read(Gym.scope) { try WorkoutProposalState($0, id: Self.proposalId).outOfDate } == nil)

    let pull = WorkoutPlanTests.set(a, "pullup01")
    #expect(try committed(a.runner.run(AppendSet(pull))) == pull.id)
    #expect(try a.runner.read(Gym.scope) { try WorkoutProposalState($0, id: Self.proposalId).outOfDate }
      == WorkoutProposalState.OutOfDate(.workoutMoved, exerciseId: ID("pullup01")))
    let moved = GymRefusal(Refused(Gym.Codes.proposalSuperseded, subject: Self.proposalId.ref, detail: ["reason": "workout-moved"], path: .predicted))
    #expect(try a.runner.run(ApplyWorkoutProposal(Self.proposalId)).refusal == moved)
    #expect(try a.runner.read(Gym.scope) { try $0.commands().isEmpty })

    _ = try #require(try a.runner.run(DeleteSet(pull.id)).receipt)
    a.advance(ms: Constants.holdMs)
    #expect(try a.runner.run(ApplyWorkoutProposal(Self.proposalId)).receipt != nil)
    #expect(try a.drawn(WorkoutProposal.self).map(\.state) == ["applied"])
    #expect(try WorkoutPlanTests.plan(a) == SessionPlan(routine: "Upper A", entries: [WorkoutPlanTests.entries[0], lighter]))
    #expect(try unchanged(a.runner.run(ApplyWorkoutProposal(Self.proposalId))) != nil)
    #expect(try a.runner.run(DismissWorkoutProposal(Self.proposalId)).refusal
      == GymRefusal(Refused(Gym.Codes.proposalSettled, subject: Self.proposalId.ref, detail: ["state": "applied"], path: .predicted)))
  }

  @Test func everyWorkoutProposalFieldAgreesWithTheCurrentRegistry() throws {
    let value = WorkoutProposal(id: Self.proposalId, sessionId: WorkoutPlanTests.sessionId, summary: "Lighter pull-ups",
                                changes: [RoutineChange(kind: "added", exerciseId: ID("facepull"), after: EntryTargets(sets: [SetTarget(reps: 15, weightKg: 15)]))])
    try RegistryCheck.entity(WorkoutProposal.self, sample: value, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.command(ApplyWorkoutProposal.Command.self, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.command(DismissWorkoutProposal.Command.self, book: GymRules.book, registry: SyncSchema.registry)
  }

  @Test func clientFieldsLeaveOutServerFieldsAndKeepProvenance() throws {
    let p = try WorkoutProposal(form: ["id": "wproposal1", "fields": ["sessionId": "session1", "changes": [], "door": "mcp", "connection": "c",
      "agent": "a", "baseRevision": 2, "changeCount": 3, "threadId": "thread01", "state": "superseded", "supersededBy": "wproposal2", "settledAt": 9]])
    #expect(p.baseRevision == 2 && p.changeCount == 3 && p.supersededBy == ID("wproposal2") && p.settledAt == Instant(ms: 9))
    #expect(p.provenance == .mcp(connection: "c", agent: "a"))
    #expect(p.fields == ["sessionId": "session1", "summary": "", "changes": [], "door": "mcp", "connection": "c", "agent": "a"])
  }

  @Test(arguments: try Contract.vectors("gym/domain/workout-proposals-actions.json"))
  func vector(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let fields = try Fields(input)
    let id = try fields.ref("id", WorkoutProposal.self)
    let result: JSON
    if let action = vector.input["action"] {
      result = switch try action.asString() {
      case "ProposeWorkout":
        try corpus.decision(of: ProposeWorkout(id: id, sessionId: try fields.ref("sessionId", Session.self), entries: try fields.list("entries", of: RoutineEntry.self),
                                               summary: try fields.string("summary", default: "")), vector, result: \.json, refusal: \.form)
      case "ApplyWorkoutProposal": try corpus.decision(of: ApplyWorkoutProposal(id), vector, result: { _ in .null }, refusal: \.form)
      case "DismissWorkoutProposal": try corpus.decision(of: DismissWorkoutProposal(id), vector, result: { _ in .null }, refusal: \.form)
      case let name: throw ContractError("no workout proposal action \(name)")
      }
    } else {
      guard try vector.input.member("read").asString() == "WorkoutOutOfDate" else { throw ContractError("no workout proposal read \(vector)") }
      result = try corpus.read(vector, in: WorkoutProposal.scope) { read in
        guard let outOfDate = try WorkoutProposalState(read, id: id).outOfDate else { return ["outOfDate": .null] }
        return ["outOfDate": .object(omittingNil: ["reason": .string(outOfDate.reason.rawValue), "exerciseId": outOfDate.exerciseId?.json])]
      }
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}
