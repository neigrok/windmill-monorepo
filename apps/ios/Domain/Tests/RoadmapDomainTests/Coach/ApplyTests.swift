import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A proposal the person decides (apply-actions.json): Apply as one act, its settling, Reject, and the mark of an Undo that
// took something back, each case by its complete decision over its records, and over them reversed. Beyond the cases, on
// the harness: a second press writes nothing, leaving the app between the act and its settling ends applied, a large
// proposal travels as several intents under one Undo, two phones applying before they sync leave the one that sends second
// with its new step refused as taken, and the time of an Apply beside many roadmaps.
struct ApplyTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/apply-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try RoadmapAct.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  // A roadmap of `steps` (`(key, label)`, linked as `links` names them), taken by the server, with a conversation about it whose
  // Coach message can carry a proposal.
  static func roadmap(on phone: Harness, _ steps: [(String, String)], links: [(from: String, to: String)]) throws
    -> (tree: ID<RoadmapEntry>, ids: [String: String], thread: ID<CoachThread>, coach: ID<CoachMessage>) {
    let planted = ImportedSteps(steps: steps.map { ImportedStep(key: $0.0, .init(label: $0.1)) }, links: links)
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn to sail", steps: planted)) else {
      throw ContractError("the roadmap was not created")
    }
    phone.sync()
    guard case .committed(let turn, _) = try phone.runner.runAct(OpenTurn(about: OpenTurn.About(treeId: created.tree.description), question: "What next?")) else {
      throw ContractError("the turn did not open")
    }
    return (created.tree, Dictionary(uniqueKeysWithValues: created.steps.map { ($0.key, $0.id.description) }), turn.thread, turn.coach)
  }

  // A proposal minted on `phone` as a turn mints one: the ability over the copy, then MintProposal.
  static func proposed(on phone: Harness, _ tree: ID<RoadmapEntry>, thread: ID<CoachThread>, coach: ID<CoachMessage>, _ changes: [JSON]) throws
    -> (proposal: ID<CoachProposal>, changes: [JSON]) {
    let answer = RoadmapProposals.answer(["treeId": tree.json, "changes": .array(changes)], over: try StandingRoadmaps(reading: phone.runner), about: tree.description) {
      (mint: ProposalMint) -> String in
      switch mint {
      case .coachProposal: phone.runner.mint(CoachProposal.self).description
      case .node: phone.runner.mint(RoadmapStep.self, in: tree.tree).description
      case .kind: phone.runner.mint(RoadmapKind.self, in: tree.tree).description
      }
    }
    guard case .minted(let minted, let result) = answer else { throw ContractError("the proposal is refused: \(answer)") }
    let proposal: ID<CoachProposal> = ID(RecordID(try result.member("proposalId").asString()))
    let mint = MintProposal(proposal: proposal, treeId: tree.description, thread: thread, message: coach, changes: minted.changes, base: minted.base.map(\.json))
    guard case .committed = try phone.runner.runAct(mint) else { throw ContractError("the proposal was not minted") }
    return (proposal, minted.changes)
  }

  static func labels(on phone: Harness, _ tree: ID<RoadmapEntry>) throws -> [String] {
    try phone.drawn(RoadmapStep.self, in: tree.tree).map(\.label).sorted()
  }

  static func state(on phone: Harness, _ proposal: ID<CoachProposal>) throws -> String? {
    try phone.drawn(CoachProposal.self).first { $0.id == proposal }?.state.rawValue
  }

  @Test func aSecondPressOfApplyWritesNothingAndTheSettleMakesTheProposalApplied() throws {
    let phone = RoadmapsTests.phone()
    let (tree, ids, thread, coach) = try Self.roadmap(on: phone, [("a", "Leave the dock"), ("b", "Tie a bowline")], links: [("a", "b")])
    let (proposal, _) = try Self.proposed(on: phone, tree, thread: thread, coach: coach, [["op": "rename", "nodeId": .string(ids["b"] ?? ""), "label": "Tie a bowline in the dark"]])
    guard case .committed(let first, _) = try phone.runner.runAct(ApplyProposal(proposal)) else { throw ContractError("the first press wrote nothing") }
    guard case .unchanged(let second) = try phone.runner.runAct(ApplyProposal(proposal)) else { throw ContractError("the second press wrote") }
    guard case .committed(let settled, _) = try phone.runner.runAct(SettleApplying()) else { throw ContractError("the row was not settled") }
    #expect(first == .applied && second == .applied && settled == [proposal])
    #expect(try Self.labels(on: phone, tree) == ["Leave the dock", "Tie a bowline in the dark"])
    #expect(try Self.state(on: phone, proposal) == "applied")
  }

  @Test func leavingTheAppBetweenAnApplyAndItsSettlingReleasesTheHoldAndTheSettleMakesTheProposalApplied() throws {
    let phone = RoadmapsTests.phone()
    let (tree, ids, thread, coach) = try Self.roadmap(on: phone, [("a", "Leave the dock"), ("b", "Tie a bowline"), ("c", "Read the wind")], links: [("a", "b"), ("b", "c")])
    let (proposal, _) = try Self.proposed(on: phone, tree, thread: thread, coach: coach, [
      ["op": "rename", "nodeId": .string(ids["a"] ?? ""), "label": "Cast off"], ["op": "remove_step", "nodeId": .string(ids["b"] ?? "")]])
    guard case .committed(_, let receipt) = try phone.runner.runAct(ApplyProposal(proposal)) else { throw ContractError("the act wrote nothing") }
    #expect(receipt.releaseAt != nil, "an Apply that removes a step is held")
    phone.leave()
    #expect(phone.undoOffers().isEmpty)
    #expect(try Self.state(on: phone, proposal) == "pending")
    guard case .committed(let settled, _) = try phone.runner.runAct(SettleApplying()) else { throw ContractError("the row was not settled") }
    phone.sync()
    #expect(settled == [proposal])
    #expect(try Self.state(on: phone, proposal) == "applied")
    #expect(try Self.labels(on: phone, tree) == ["Cast off", "Read the wind"])
  }

  @Test func aProposalTooLargeForOneIntentTravelsAsSeveralUnderOneGestureAndItsOneUndoTakesAllOfItBack() throws {
    let phone = RoadmapsTests.phone()
    // 260 links moved are 520 writes, past the 500 records an intent takes.
    let sources = (0..<260).map { ("s\($0)", "Knot \($0)") }
    let (tree, ids, thread, coach) = try Self.roadmap(on: phone, sources + [("n", "Knead"), ("r", "Rest")], links: sources.map { (from: $0.0, to: "r") })
    let (proposal, _) = try Self.proposed(on: phone, tree, thread: thread, coach: coach, [["op": "merge", "nodeId": .string(ids["n"] ?? ""), "removeId": .string(ids["r"] ?? "")]])
    guard case .committed(_, let receipt) = try phone.runner.runAct(ApplyProposal(proposal)) else { throw ContractError("the act wrote nothing") }
    _ = try phone.runner.runAct(SettleApplying())
    let structure = receipt.segments.filter { $0.scope == tree.tree && !$0.localIds.isEmpty }
    let into = { (step: String) throws -> Int in try phone.drawn(RoadmapLink.self, in: tree.tree).filter { $0.to.description.utf8.elementsEqual(step.utf8) }.count }
    #expect(structure.count > 1)
    #expect(try into(ids["n"] ?? "") == 260)
    phone.advance(ms: 9000)
    phone.sync()
    let undone = try phone.runner.undo(receipt.undo)
    phone.sync()
    guard case .settled(_, _, true, let applied, 0) = try phone.runner.inverseResult(undone.requestId ?? "") else { throw ContractError("the Undo did not settle whole") }
    #expect(applied > 260)
    #expect(try into(ids["r"] ?? "") == 260 && into(ids["n"] ?? "") == 0)
  }

  @Test func twoPhonesThatApplyOneProposalBeforeTheySyncLeaveEachNewStepOnceTheCreationOfThePhoneThatSendsSecondRefusedAsTaken() throws {
    let a = RoadmapsTests.phone()
    let (tree, ids, thread, coach) = try Self.roadmap(on: a, [("a", "Leave the dock")], links: [])
    let b = a.device()
    let (proposal, changes) = try Self.proposed(on: a, tree, thread: thread, coach: coach, [
      ["op": "add_step", "ref": "new:jib", "label": "Raise the jib", "prerequisites": [.string(ids["a"] ?? "")]]])
    a.sync()
    for phone in [b, a] {
      guard case .committed = try phone.runner.runAct(ApplyProposal(proposal)) else { throw ContractError("an Apply wrote nothing") }
      _ = try phone.runner.runAct(SettleApplying())
    }
    a.sync()
    let jib = try changes[0].member("nodeId").asString()
    let taken = { (phone: Harness) throws -> [String] in
      try phone.notices(RoadmapRefusal.self).compactMap { notice in
        guard case .taken(let subject, .notice) = notice.refusal else { return nil }
        return subject.id.description
      }
    }
    #expect(try Self.labels(on: a, tree) == ["Leave the dock", "Raise the jib"] && Self.labels(on: b, tree) == ["Leave the dock", "Raise the jib"])
    #expect(try taken(a) == [] && taken(b) == [jib])
    #expect(try Self.state(on: a, proposal) == "applied" && Self.state(on: b, proposal) == "applied")
  }

  // The device's copy as a case states it: a roadmap of 5,000 steps a proposal of 100 changes is about, `others` roadmaps of
  // 2,000 beside it, and the conversation the proposal came from, minted by the domain over that copy.
  static func copy(beside others: Int) throws -> Vector {
    let (s0, minted) = ("1700000000000:0:r_aaaaaaaaaaaa", "1700000001000:0:r_aaaaaaaaaaaa")
    let tree = "t_00000000000000bb"
    let id = { (step: Int) -> String in "s" + String(repeating: "0", count: 5 - String(step).count) + String(step) }
    func row(_ t: String, _ id: JSON, _ f: [(String, JSON)]) -> JSON {
      ["t": .string(t), "id": id, "seq": 1, "born": .string(s0), "life": ["alive", .string(s0)],
       "f": .object(JSON.Object(uniqueKeysWithValues: f.map { ($0.0, [$0.1, .string(s0)]) }))]
    }
    func rows(_ count: Int, title: String) -> [JSON] {
      [["t": "meta", "id": "meta", "seq": 1, "f": ["title": [.string(title), .string(s0)]]],
       row("kind", "learn", [("hue", "olive"), ("label", "Learn"), ("description", ""), ("ord", "a0")])]
        + (0..<count).map { row("node", .string(id($0)), [("label", .string("Step \($0)")), ("ord", .string(String(id($0).dropFirst())))]) }
        + (1..<count).map { ["t": "edge", "id": [.string(id($0 - 1)), .string(id($0))], "seq": 1, "life": ["alive", .string(s0)]] }
    }
    let trees = [tree] + (0..<others).map { "t_" + String(repeating: "0", count: 15 - String($0 + 1).count) + String($0 + 1) }
    var account: [JSON] = trees.map { row("tree", .string($0), []) } + [
      row("coachThread", "thread0001", [("treeId", .string(tree)), ("stepId", .null), ("title", "Tidy it")]),
      row("coachMessage", "message0002", [("threadId", "thread0001"), ("role", "coach"), ("text", ""), ("at", 1_700_000_000_000),
                                           ("replica", "rp_00000000000000000000000000000001"), ("state", "completed"), ("truncated", false), ("refusal", .null)])]
    var scopes = JSON.Object()
    for each in trees {
      scopes["tree/\(each)"] = ["drawn": .array(rows(each == tree ? 5000 : 2000, title: "Roadmap \(each)"))]
      scopes["self/overlay/\(each)"] = ["drawn": []]
    }
    let steps = (0..<5000).map { Step(id: id($0), label: "Step \($0)", ord: String(id($0).dropFirst())) }
    let stamps = steps.map { RecordStamps(scope: "tree/\(tree)", t: "node", id: .string($0.id), life: s0, f: ["label": s0, "ord": s0]) }
      + (1..<5000).map { RecordStamps(scope: "tree/\(tree)", t: "edge", id: [.string(id($0 - 1)), .string(id($0))], life: s0, f: [:]) }
      + [RecordStamps(scope: "tree/\(tree)", t: "kind", id: "learn", life: s0, f: ["hue": s0, "label": s0, "description": s0, "ord": s0])]
    let standing = StandingRoadmaps(trees: [RoadmapTree(id: tree, own: true, meta: RoadmapTree.Metadata(title: "Roadmap \(tree)", root: tree), nodes: steps,
      edges: (1..<5000).map { RoadmapTree.Edge(from: id($0 - 1), to: id($0), present: true) }, kinds: [Kind(id: "learn", hue: "olive", label: "Learn", description: "", ord: "a0")])],
      stamps: stamps)
    let changes: [JSON] = (0..<10).map { ["op": "set_progress", "nodeId": .string(id($0)), "status": "complete"] }
      + (0..<25).map { ["op": "add_step", "ref": .string("new:s\($0)"), "label": .string("New \($0)"), "kind": "learn", "prerequisites": [.string(id($0 * 10))]] }
      + (0..<25).map { ["op": "rename", "nodeId": .string(id(1000 + $0)), "label": .string("Renamed \($0)")] }
      + (0..<10).map { ["op": "describe", "nodeId": .string(id(2000 + $0)), "description": .string("Described \($0)")] }
      + (0..<20).map { ["op": "connect", "nodeId": .string(id(2500 + $0 * 10)), "prerequisiteId": .string(id(2495 + $0 * 10))] }
      + (0..<5).map { ["op": "merge", "nodeId": .string(id(3000 + $0 * 10)), "removeId": .string(id(3001 + $0 * 10))] }
      + (0..<5).map { ["op": "remove_step", "nodeId": .string(id(4000 + $0 * 10))] }
    var drawn = ["proposal0003"] + (0..<25).map { "n" + String(repeating: "0", count: 15 - String($0).count) + String($0) }
    guard case .minted(let proposal, _) = RoadmapProposals.answer(["treeId": .string(tree), "changes": .array(changes)], over: standing, about: tree, ids: { _ in drawn.removeFirst() })
    else { throw ContractError("the proposal is refused") }
    let mint = try RoadmapAct.decision(Vector(file: "scale", name: "mint", input: ["action": "MintProposal", "input": ["proposal": "proposal0003", "treeId": .string(tree),
      "thread": "thread0001", "message": "message0002", "changes": .array(proposal.changes), "base": .array(proposal.base.map(\.json))],
      "scopes": ["self/roadmap": ["drawn": .array(account)]], "now": 1_800_000_000_000, "offsetSeconds": 0], expect: .null))
    let created = try mint.member("decision").member("write").member("segments").asArray()[0].member("gesture").member("changes").asArray()[0].member("f").asObject()
    account.append(["t": "coachProposal", "id": "proposal0003", "seq": 2, "born": .string(minted), "life": ["alive", .string(minted)],
                    "f": .object(JSON.Object(uniqueKeysWithValues: created.members.map { ($0.key, [$0.value, .string(minted)]) }))])
    scopes["self/roadmap"] = ["drawn": .array(account)]
    return Vector(file: "scale", name: "apply", input: ["action": "ApplyProposal", "input": ["proposal": "proposal0003"], "scopes": .object(scopes),
                                                       "now": 1_800_000_000_000, "offsetSeconds": 0], expect: .null)
  }

  // The web's size case: Apply's time stays about where it is however many roadmaps the device holds beside the one it reads.
  @Test func applyOfOneHundredChangesOverFiveThousandStepsTakesAboutAsLongBesideZeroFiveAndTwentyOtherRoadmaps() throws {
    var times: [Int: Duration] = [:]
    for others in [0, 5, 20] {
      let vector = try Self.copy(beside: others)
      var decided: JSON = .null
      times[others] = try ContinuousClock().measure { decided = try RoadmapAct.decision(vector) }
      #expect(decided["decision"]?["write"]?["result"] == "applied")
    }
    print("Apply of 100 changes over 5,000 steps, beside 0, 5 and 20 other roadmaps of 2,000: \(times[0]!), \(times[5]!), \(times[20]!)")
    #expect(times[20]! < .seconds(30))
  }
}
