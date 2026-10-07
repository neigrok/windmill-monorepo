import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import SyncModelServer
import SyncTesting
import Testing

struct ProposalsTests {
  static let now: Int64 = 1_800_000_000_000
  static let exerciseId = ID<Exercise>(RecordID("custom01"))
  static let routineId = ID<Routine>(RecordID("routine1"))
  static let proposalId = ID<Proposal>(RecordID("proposal1"))
  static let before = [RoutineEntry(exerciseId: exerciseId, sets: [SetTarget(reps: 5, weightKg: 80)], restSeconds: 90)]
  static let after = [RoutineEntry(exerciseId: exerciseId, sets: [SetTarget(reps: 5, weightKg: 85)], restSeconds: 120)]

  static func phone() throws -> Harness {
    let h = Harness(registry: SyncSchema.registry, start: Instant(ms: now), rules: GymServerRules(), commandResultWrites: RoutineRemovalReceipt.resultWrites)
    _ = try h.runner.run(CreateExercise(Exercise(id: exerciseId, name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: routineId, name: "Strength", entries: before))
    try #require(saved(h.runner.save(&routine, SaveRoutine.self)))
    h.sync()
    return h
  }

  static func propose(_ h: Harness, removing: Bool = false) throws {
    let action = ProposeRoutine(id: proposalId, routineId: routineId, name: "Stronger", entries: after, summary: "More load", removing: removing)
    #expect(try committed(h.runner.run(action)) == proposalId)
    h.sync()
    #expect(try h.drawn(Proposal.self).map(\.id) == [proposalId])
    #expect(try h.notices(GymRefusal.self).isEmpty)
  }

  @Test(arguments: [false, true])
  func receiptCommitsWithItsCommandAndSurvivesUntilAcknowledged(refused: Bool) throws {
    let h = try Self.phone(); try Self.propose(h, removing: true)
    let proposal = try #require(try h.stored(Proposal.self).first)
    h.failNextCommit()
    #expect(throws: (any Error).self) { try h.runner.run(ApplyProposalKeepingReceipt(Self.proposalId)) }
    #expect(try h.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).isEmpty && $0.commands().isEmpty })
    #expect(try h.stored(Routine.self).map(\.id) == [Self.routineId])
    #expect(try h.runner.run(ApplyProposalKeepingReceipt(Self.proposalId)).receipt != nil)
    #expect(try unchanged(h.runner.run(ApplyProposalKeepingReceipt(Self.proposalId))) != nil)
    let replica = try h.runner.read(Gym.scope) { $0.replica }
    #expect(try unchanged(h.runner.run(AcknowledgeRoutineRemoval(Self.proposalId, replica: replica))) != nil)
    #expect(try h.runner.read(Gym.scope) { try $0.commands().count } == 1)
    let pending = try #require(try h.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).first })
    #expect(pending.outcome == .pending && pending.proposal.fields == proposal.fields && pending.proposal.state == "pending")
    if refused { h.server.refuse(code: .invalid) }
    h.sync()
    let receipt = try #require(try h.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).first })
    #expect(receipt.outcome == (refused ? .refused : .applied))
    #expect(receipt.proposal.fields == proposal.fields && receipt.proposal.baseName == proposal.baseName && receipt.proposal.settledAt == nil)
    #expect(try unchanged(h.runner.run(AcknowledgeRoutineRemoval(Self.proposalId, replica: "another-replica"))) != nil)
    #expect(try h.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).count } == 1)
    h.failNextCommit()
    #expect(throws: (any Error).self) { try h.runner.run(AcknowledgeRoutineRemoval(Self.proposalId, replica: replica)) }
    #expect(try h.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).count } == 1)
    #expect(try h.runner.run(AcknowledgeRoutineRemoval(Self.proposalId, replica: replica)).receipt != nil)
    #expect(try h.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).isEmpty })
  }

  @Test func proposalGuardsAdmitItsDiffAndApplyPredictsBothRecordsWhilePending() throws {
    let a = try Self.phone()
    try Self.propose(a)
    #expect(try a.stored(Proposal.self).map(\.state) == ["pending"])
    #expect(try a.runner.run(ApplyProposal(Self.proposalId)).receipt != nil)
    #expect(try a.drawn(Proposal.self).map(\.state) == ["applied"])
    #expect(try a.drawn(Routine.self).map(\.name) == ["Stronger"])
    #expect(try a.drawn(Routine.self).map(\.entries) == [Self.after])
    #expect(try a.stored(Routine.self).map(\.name) == ["Stronger"])
    #expect(try a.stored(Proposal.self).map(\.state) == ["applied"])
    a.sync()
    #expect(try a.stored(Routine.self).map(\.name) == ["Stronger"])
    #expect(try a.stored(Routine.self).map(\.entries) == [Self.after])
    #expect(try a.stored(Proposal.self).map(\.state) == ["applied"])
    #expect(try a.notices(GymRefusal.self).isEmpty)
    #expect(try unchanged(a.runner.run(ApplyProposal(Self.proposalId))) != nil)
  }

  @Test func dismissPredictionSettlesOnlyTheProposalAndIsIdempotent() throws {
    let a = try Self.phone(); try Self.propose(a)
    #expect(try a.runner.run(DismissProposal(Self.proposalId)).receipt != nil)
    #expect(try a.drawn(Proposal.self).map(\.state) == ["dismissed"])
    #expect(try a.stored(Proposal.self).map(\.state) == ["dismissed"])
    #expect(try a.drawn(Routine.self).map(\.name) == ["Strength"])
    a.sync()
    #expect(try a.stored(Proposal.self).map(\.state) == ["dismissed"])
    #expect(try a.stored(Routine.self).map(\.entries) == [Self.before])
    #expect(try unchanged(a.runner.run(DismissProposal(Self.proposalId))) != nil)
  }

  @Test func heldRoutineDeletionRefusesDependentProposalWorkAndUndoRestoresIt() throws {
    let a = try Self.phone(); try Self.propose(a)
    let removal = try #require(try a.runner.run(DeleteRoutine(Self.routineId)).receipt)
    #expect(try a.drawn(Routine.self).isEmpty)
    #expect(try a.runner.run(ApplyProposal(Self.proposalId)).refusal == .gone(Self.routineId.ref, .predicted))
    let action = ProposeRoutine(id: ID("proposal2"), routineId: Self.routineId, name: "Later", entries: Self.after, summary: "")
    #expect(try a.runner.run(action).refusal == .gone(Self.routineId.ref, .predicted))
    #expect(try a.runner.undo(removal.gestureId))
    #expect(try a.drawn(Proposal.self).map(\.state) == ["pending"])
    #expect(try a.runner.run(ApplyProposal(Self.proposalId)).receipt != nil)
    a.sync()
    #expect(try a.stored(Routine.self).map(\.name) == ["Stronger"])
  }

  @Test func aConcurrentRoutineEditRefusesProposalCreationAsAStaleNotice() throws {
    let a = try Self.phone(), b = a.device()
    a.sync()
    let proposal = ProposeRoutine(id: Self.proposalId, routineId: Self.routineId, name: "Stronger", entries: Self.after, summary: "More load")
    #expect(try committed(b.runner.run(proposal)) == Self.proposalId)
    var routine = try #require(try a.runner.open(Self.routineId))
    routine.current.name = "Changed"
    #expect(saved(a.runner.save(&routine, SaveRoutine.self)))
    a.sync()
    let notices = try b.notices(GymRefusal.self)
    #expect(notices.map(\.refusal) == [.stale(Self.proposalId.ref, .notice)])
    #expect(notices.first?.values(of: Self.proposalId.ref)["proposedName"] == "Stronger")
    #expect(try b.drawn(Proposal.self).isEmpty)
    #expect(try b.drawn(Routine.self).map(\.name) == ["Changed"])
  }

  @Test func failedCommandCommitRetainsThePendingProposalAndWholePriorRoutine() throws {
    let a = try Self.phone(); try Self.propose(a)
    a.failNextCommit()
    #expect(throws: (any Error).self) { try a.runner.run(ApplyProposal(Self.proposalId)) }
    #expect(try a.drawn(Proposal.self).map(\.state) == ["pending"])
    #expect(try a.drawn(Routine.self).map(\.name) == ["Strength"])
    #expect(try a.drawn(Routine.self).map(\.entries) == [Self.before])
    #expect(try a.runner.run(ApplyProposal(Self.proposalId)).receipt != nil)
    a.sync()
    #expect(try a.stored(Proposal.self).map(\.state) == ["applied"])
    #expect(try a.stored(Routine.self).map(\.entries) == [Self.after])
  }

  @Test func serverRefusalRetractsBothApplyPredictionsAndRetainsItsReason() throws {
    let a = try Self.phone(); try Self.propose(a)
    a.server.refuse(code: Gym.Codes.proposalSuperseded, detail: ["reason": "routine-changed"])
    #expect(try a.runner.run(ApplyProposal(Self.proposalId)).receipt != nil)
    #expect(try a.drawn(Routine.self).map(\.entries) == [Self.after])
    a.sync()
    #expect(try a.drawn(Proposal.self).map(\.state) == ["pending"])
    #expect(try a.drawn(Routine.self).map(\.name) == ["Strength"])
    #expect(try a.drawn(Routine.self).map(\.entries) == [Self.before])
    let notice = try #require(try a.notices(GymRefusal.self).first)
    guard case .proposalSuperseded(let refusal) = notice.refusal else { Issue.record("missing proposal refusal"); return }
    #expect(refusal.path == .notice && refusal.detail == ["reason": "routine-changed"])
  }

  @Test func removalPredictsRoutineDeathThenCascadesWithoutChangingTheFrozenPlan() throws {
    let a = try Self.phone()
    let sessionId = ID<Session>(RecordID("session1"))
    _ = try a.runner.run(StartSession(id: sessionId, routineId: Self.routineId)); a.sync()
    try Self.propose(a, removing: true)
    #expect(try a.runner.run(ApplyProposal(Self.proposalId)).receipt != nil)
    #expect(try a.drawn(Proposal.self).map(\.state) == ["applied"])
    #expect(try a.drawn(Routine.self).isEmpty)
    a.sync()
    #expect(try a.drawn(Routine.self).isEmpty && a.drawn(Proposal.self).isEmpty)
    let session = try #require(try a.drawn(Session.self).first)
    #expect(session.routineId == nil && session.historyRoutineId == Self.routineId)
    #expect(session.plan == SessionPlan(routine: "Strength", entries: Self.before))
  }

  @Test(arguments: [false, true])
  func removalPredictionPreservesBornAndAcceptsOrRollsBack(refused: Bool) throws {
    let a = try Self.phone(); try Self.propose(a, removing: true)
    let before = try #require(try a.runner.read(Routine.scope) { try $0.repository(Routine.self).record(Self.routineId, in: .drawn) })
    #expect(try a.runner.run(ApplyProposal(Self.proposalId)).receipt != nil)
    let pending = try #require(try a.runner.read(Routine.scope) { try $0.repository(Routine.self).record(Self.routineId, in: .drawn) })
    #expect(!pending.isVisible && pending.life?.isAlive == false)
    #expect(try #require(pending.life).stamp > #require(before.life).stamp)
    #expect(pending.born == before.born)
    #expect(try a.drawn(Routine.self).isEmpty)
    if refused { a.server.refuse(code: .invalid) }
    a.sync()
    if refused {
      #expect(try a.runner.read(Routine.scope) { try $0.repository(Routine.self).record(Self.routineId, in: .drawn) } == before)
      #expect(try a.drawn(Proposal.self).map(\.state) == ["pending"])
      #expect(try a.notices(GymRefusal.self).map(\.refusal) == [GymRefusal(Refused(.invalid, subject: Self.proposalId.ref, path: .notice))])
    } else {
      #expect(try a.runner.read(Routine.scope) { try $0.repository(Routine.self).record(Self.routineId, in: .drawn) } == nil)
      #expect(try a.drawn(Routine.self).isEmpty)
      #expect(try a.notices(GymRefusal.self).isEmpty)
    }
  }

  @Test func clientFieldsExcludeServerMetadataAndPreserveProvenance() throws {
    let p = try Proposal(form: ["id": "proposal1", "fields": ["routineId": "routine1", "intent": "revise", "proposedName": "A", "changes": [],
      "door": "mcp", "connection": "connection", "agent": "agent", "baseRevision": 3, "baseName": "Original", "changeCount": 7,
      "threadId": "thread1", "state": "applied", "settledAt": 123]])
    #expect(p.baseRevision == 3 && p.baseName == "Original" && p.changeCount == 7 && p.settledAt == Instant(ms: 123))
    #expect(p.provenance == .mcp(connection: "connection", agent: "agent"))
    #expect(p.fields == ["routineId": "routine1", "intent": "revise", "proposedName": "A", "summary": "", "changes": [], "door": "mcp", "connection": "connection", "agent": "agent"])
    let legacy = try Proposal(form: ["id": "proposal1", "fields": ["routineId": "routine1", "intent": "remove", "changes": []]])
    #expect(legacy.baseRevision == nil && legacy.baseName == nil && legacy.changeCount == nil && legacy.state == "pending")
    #expect(legacy.provenance == .ask(threadId: nil))
  }

  @Test func routineCreationKeepsItsExactSnapshotWhenTheRoutineIsGone() throws {
    let snapshot: JSON = ["id": "routine1", "name": "Original", "position": 0, "revision": 1,
                          "entries": [["position": 1, "exerciseId": "bench-press"]]]
    let value = try RoutineCreation(form: ["id": "routine1", "fields": ["snapshot": snapshot]])
    #expect(value.id == ID("routine1") && value.snapshot == snapshot)
    #expect(try RoutineCreation(form: ["id": "routine1", "fields": [:]]).snapshot == nil)
    #expect(try RoutineCreation(form: ["id": "routine1", "fields": ["snapshot": .null]]).snapshot == nil)
  }

  @Test func everyProposalFieldAgreesWithTheCurrentRegistry() throws {
    let value = Proposal(id: ID("proposal1"), routineId: ID("routine1"), intent: "revise", proposedName: "Strength", summary: "A load change",
                         changes: [RoutineChange(kind: "added", exerciseId: ID("bench-press"), after: EntryTargets(sets: [SetTarget(reps: 5, weightKg: 80)]))])
    try RegistryCheck.entity(Proposal.self, sample: value, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.command(ApplyProposal.Command.self, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.command(DismissProposal.Command.self, book: GymRules.book, registry: SyncSchema.registry)
  }

  @Test(arguments: try Contract.vectors("gym/domain/proposals-actions.json"))
  func vector(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let result: JSON
    switch try vector.input.member("action").asString() {
    case "ProposeRoutine":
      let fields = try Fields(input)
      let value = ProposeRoutine(id: try fields.ref("id", Proposal.self), routineId: try fields.ref("routineId", Routine.self),
                                name: try fields.string("name", default: ""), entries: try fields.list("entries", of: RoutineEntry.self),
                                summary: try fields.string("summary", default: ""), removing: try fields.bool("removing", default: false))
      result = try corpus.decision(of: value, vector, result: \.json, refusal: \.form)
    case "ApplyProposal": result = try corpus.decision(of: ApplyProposal(ID(try RecordID(json: input.member("id")))), vector, result: { _ in .null }, refusal: \.form)
    case "DismissProposal": result = try corpus.decision(of: DismissProposal(ID(try RecordID(json: input.member("id")))), vector, result: { _ in .null }, refusal: \.form)
    case "Diff":
      let fields = try Fields(input)
      let changes = try ProposalRules.changesBetween(base: fields.list("base", of: RoutineEntry.self), proposed: fields.list("proposed", of: RoutineEntry.self))
      result = ["changes": .array(changes.map(\.json))]
    case "ChangeCount":
      let base = try Routine(form: input.member("base")), proposal = try Proposal(form: input.member("proposal"))
      result = ["changeCount": JSON(proposal.countChanges(comparedTo: base))]
    case "Metadata":
      let p = try Proposal(form: input)
      let provenance: JSON = switch p.provenance {
      case .ask(let threadId): ["door": "ask", "threadId": .of(threadId)]
      case .mcp(let connection, let agent): ["door": "mcp", "connection": .string(connection), "agent": .string(agent)]
      case .other(let door, let connection, let agent): ["door": .string(door), "connection": .string(connection), "agent": .string(agent)]
      }
      result = ["baseRevision": .of(p.baseRevision), "baseName": .of(p.baseName), "changeCount": .of(p.changeCount), "state": .string(p.state), "provenance": provenance]
    case "RoutineCreation": result = ["snapshot": try RoutineCreation(form: input).snapshot ?? .null]
    case "StateRefusal":
      let proposal = try input["proposal"].flatMap { $0.isNull ? nil : try Proposal(form: $0) }
      let routine = try input["routine"].flatMap { $0.isNull ? nil : try Routine(form: $0) }
      let moment = Moment(now: Instant(ms: try vector.input.member("now").asInteger()), zone: FixedZone(offsetSeconds: 0))
      let state = ProposalState(proposal: proposal, routine: routine, moment: moment)
      result = ["refusal": state.refusal(for: ID("proposal1"), applying: try input.member("applying").asBool())?.form ?? .null]
    case "ValidateProposal":
      let moment = Moment(now: Instant(ms: try vector.input.member("now").asInteger()), zone: FixedZone(offsetSeconds: 0))
      do { result = ["fields": .object(fields: try Valid(Proposal(form: input), at: moment).value.fields)] }
      catch let violation as Violation { result = ["violation": violation.form] }
    default: throw ContractError("unknown proposal vector \(vector)")
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}
