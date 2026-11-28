import DomainKit
import DomainKitTesting
@testable import RoadmapDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
import Synchronization
import Testing

// Roadmap Coach's tool host over a phone's engine: each direct write through the room's act runner, what the door wrote and
// did not, the Undo of each kind of write and what it came to, and what the host leaves the engine holding.
struct ToolHostTests {
  // What the host told of each Undo, in the order it told them: the ability it took back and what it came to.
  final class Heard {
    var told: [String] = []
  }

  // The person's roadmap on a phone, synced: `dock` and `knot` lead to `sail`; and a host of a conversation about it.
  static func planted(on runner: ActionRunner, syncing sync: () -> Void) throws -> (tree: String, steps: [String: String], host: RoadmapToolHost, heard: Heard) {
    let planted = ImportedSteps(
      steps: [ImportedStep(key: "dock", .init(label: "Leave the dock")), ImportedStep(key: "knot", .init(label: "Tie a bowline")),
              ImportedStep(key: "sail", .init(label: "Sail with an instructor"))],
      links: [(from: "dock", to: "sail"), (from: "knot", to: "sail")])
    guard case .committed(let created, _) = try runner.runAct(CreateRoadmap(title: "Learn to sail", steps: planted)) else {
      throw ContractError("the roadmap was not created")
    }
    sync()
    let heard = Heard()
    let host = RoadmapToolHost(runner: runner, about: created.tree.description) { heard.told.append("\($0.ability) \($1.rawValue)") }
    return (created.tree.description, Dictionary(uniqueKeysWithValues: created.steps.map { ($0.key, $0.id.description) }), host, heard)
  }

  static func sailing() throws -> (phone: Harness, tree: String, steps: [String: String], host: RoadmapToolHost, heard: Heard) {
    let phone = RoadmapsTests.phone()
    let (tree, steps, host, heard) = try planted(on: phone.runner, syncing: phone.sync)
    return (phone, tree, steps, host, heard)
  }

  // A phone whose act runner reaches its engine through a replica that keeps note of what it journals for Undo.
  static func notedPhone() -> (engine: SteppedEngine, replica: NotedReplica, runner: ActionRunner) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_800_000_000_000, rules: RoadmapServerRules())
    let replica = NotedReplica(engine.replica)
    return (engine, replica, ActionRunner(replica: replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)))
  }

  // Asks each Undo and answers what the host told of them once the engine has settled each: the server settles an Undo of a
  // write the phone sent, so the phone syncs and the host follows the copy until each has, a few rounds at most.
  static func undo(_ receipts: [WriteReceipt?], by host: RoadmapToolHost, _ heard: Heard, syncing sync: () -> Void) throws -> [String] {
    let start = heard.told.count
    for receipt in receipts { try host.undo(try #require(receipt)) }
    for _ in 0..<5 where heard.told.count < start + receipts.count {
      sync()
      try host.follow()
    }
    return Array(heard.told.dropFirst(start))
  }

  // The roadmap's steps as the phone's copy draws them, by label: each step's colour, words and web links, the labels of
  // the steps it follows, whether it is done, and its checklist.
  static func drawn(_ tree: String, on phone: Harness) throws -> JSON {
    let id = ID<RoadmapEntry>(RecordID(tree))
    let steps = try phone.drawn(RoadmapStep.self, in: id.tree)
    let links = try phone.drawn(RoadmapLink.self, in: id.tree)
    let marks = try phone.drawn(StepMark.self, in: id.overlay)
    let items = try phone.drawn(Subtask.self, in: id.overlay)
    let labels = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, $0.label) })
    return .object(JSON.Object(uniqueKeysWithValues: steps.map { (step: RoadmapStep) -> (String, JSON) in
      let after = links.filter { $0.to == step.id }.compactMap { labels[$0.from] }.sorted()
      let done = marks.contains { $0.id.record == step.id.record && $0.status == "complete" }
      return (step.label, ["color": .string(step.color), "description": .string(step.description), "links": .array(step.links.map(\.json)),
                           "after": .array(after.map(JSON.string)), "done": .bool(done),
                           "checklist": .array(items.filter { $0.step == step.id }.map { .string($0.label) })])
    }))
  }

  @Test func eachDirectWriteLandsThroughTheRoomsDoorAnswersWhatItsAbilityAnswersAndLeavesAReceipt() throws {
    let (phone, tree, steps, host, heard) = try Self.sailing()
    let (dock, knot) = (JSON.string(steps["dock"]!), JSON.string(steps["knot"]!))
    let created = try host.run("create_node", ["treeId": .string(tree), "label": "Hoist the sail", "kind": "learn", "prerequisites": [dock]])
    let minted = try #require(try created.answer.get()["nodeId"]?.asString())
    #expect(minted.wholeMatch(of: /[0-9a-z]{16}/) != nil)
    let runs = [
      created,
      try host.run("update_node", ["treeId": .string(tree), "nodeId": knot, "label": "Tie a cleat hitch"]),
      try host.run("update_node", ["treeId": .string(tree), "nodeId": knot, "description": "Round the post.", "links": [["url": " https://example.org/cleat "]]]),
      try host.run("connect", ["treeId": .string(tree), "nodeId": .string(minted), "prerequisiteId": knot]),
      try host.run("set_progress", ["treeId": .string(tree), "nodeId": dock, "status": "complete"]),
    ]
    #expect(runs.map { $0.answer } == [.success(["nodeId": .string(minted)]), .success([:]), .success([:]), .success([:]), .success([:])])
    #expect(runs.map { $0.receipt.map { [$0.ability, $0.treeId, $0.nodeId] } } == [
      ["create_node", tree, minted], ["update_node", tree, steps["knot"]!], ["update_node", tree, steps["knot"]!], ["connect", tree, minted],
      ["set_progress", tree, steps["dock"]!],
    ])
    #expect(try Self.drawn(tree, on: phone) == [
      "Leave the dock": ["color": "terracotta", "description": "", "links": [], "after": [], "done": true, "checklist": []],
      "Tie a cleat hitch": ["color": "terracotta", "description": "Round the post.", "links": [["url": "https://example.org/cleat", "label": ""]],
                            "after": [], "done": false, "checklist": []],
      "Sail with an instructor": ["color": "terracotta", "description": "", "links": [], "after": ["Leave the dock", "Tie a cleat hitch"],
                                  "done": false, "checklist": []],
      "Hoist the sail": ["color": "olive", "description": "", "links": [], "after": ["Leave the dock", "Tie a cleat hitch"], "done": false,
                         "checklist": []],
    ])
    #expect(heard.told.isEmpty, "the turn's engine tells each call; the host tells only an Undo")
  }

  @Test func anUpdateWritesTheStepsFieldsAndTheItemsItAddsAsOneActThatOneUndoTakesBackSparingThePersonsOwnItem() throws {
    let (phone, tree, steps, host, heard) = try Self.sailing()
    let knot = ID<RoadmapStep>(RecordID(steps["knot"]!))
    guard case .committed = try phone.runner.runAct(AddSubtask(tree: ID(RecordID(tree)), step: knot, item: .init(label: "Identify the halyard"))) else {
      throw ContractError("the person's item was not added")
    }
    let (answer, receipt) = try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(knot.description), "label": "Tie a cleat hitch",
                                                          "subtasks": ["Check the shackle", "Coil the line"]])
    #expect(answer == .success([:]))
    #expect(try Self.drawn(tree, on: phone)["Tie a cleat hitch"]?["checklist"] == ["Identify the halyard", "Check the shackle", "Coil the line"])
    #expect(try host.run("get_nodes", ["treeId": .string(tree), "nodeIds": [.string(knot.description), .string(steps["dock"]!)], "fields": ["subtasks"]]).answer
      == .success(["steps": [["id": .string(knot.description), "subtasks": [["label": "Identify the halyard", "done": false],
                                                                            ["label": "Check the shackle", "done": false],
                                                                            ["label": "Coil the line", "done": false]]],
                             ["id": .string(steps["dock"]!), "subtasks": []]]]), "Coach reads the checklist before adding to it")

    #expect(try Self.undo([receipt], by: host, heard, syncing: phone.sync) == ["update_node undone"])
    let knotNow = try Self.drawn(tree, on: phone)["Tie a bowline"]
    #expect(knotNow?["checklist"] == ["Identify the halyard"], "the name and both items it added go, and the person's own item stays")
  }

  @Test func undoTakesBackEachKindOfWriteSparingWhatWasWrittenSinceAndIsTakenOnce() throws {
    let (phone, tree, steps, host, heard) = try Self.sailing()
    let (dock, knot) = (JSON.string(steps["dock"]!), JSON.string(steps["knot"]!))
    let created = try host.run("create_node", ["treeId": .string(tree), "label": "Hoist the sail", "prerequisites": [dock]]).receipt
    let renamed = try host.run("update_node", ["treeId": .string(tree), "nodeId": knot, "label": "Tie a cleat hitch"]).receipt
    let annotated = try host.run("update_node", ["treeId": .string(tree), "nodeId": knot, "description": "Round the post."]).receipt
    let linked = try host.run("connect", ["treeId": .string(tree), "nodeId": knot, "prerequisiteId": dock]).receipt
    let completed = try host.run("set_progress", ["treeId": .string(tree), "nodeId": dock, "status": "complete"]).receipt

    #expect(try Self.undo([renamed, linked, created, completed], by: host, heard, syncing: phone.sync)
      == ["update_node undone", "connect undone", "create_node undone", "set_progress undone"])
    #expect(try Self.drawn(tree, on: phone) == [
      "Leave the dock": ["color": "terracotta", "description": "", "links": [], "after": [], "done": false, "checklist": []],
      "Tie a bowline": ["color": "terracotta", "description": "Round the post.", "links": [], "after": [], "done": false, "checklist": []],
      "Sail with an instructor": ["color": "terracotta", "description": "", "links": [], "after": ["Leave the dock", "Tie a bowline"], "done": false,
                                  "checklist": []],
    ], "the description written after the rename stands")
    #expect(try Self.undo([annotated], by: host, heard, syncing: phone.sync) == ["update_node undone"])
    #expect(try Self.drawn(tree, on: phone)["Tie a bowline"]?["description"] == "")
    #expect(try Self.undo([renamed, completed], by: host, heard, syncing: phone.sync) == ["update_node unavailable", "set_progress unavailable"],
            "each is taken back once")

    _ = try host.run("set_progress", ["treeId": .string(tree), "nodeId": dock, "status": "complete"])
    let reset = try host.run("set_progress", ["treeId": .string(tree), "nodeId": dock, "status": "none"]).receipt
    #expect(try Self.undo([reset], by: host, heard, syncing: phone.sync) == ["set_progress undone"])
    #expect(try Self.drawn(tree, on: phone)["Leave the dock"]?["done"] == true, "a Reset taken back marks the step done again")

    let forgotten = try host.run("update_node", ["treeId": .string(tree), "nodeId": knot, "label": "Tie a reef knot"]).receipt
    try host.forget(try #require(forgotten))
    #expect(try Self.undo([forgotten], by: host, heard, syncing: phone.sync) == ["update_node unavailable"],
            "a receipt whose Undo is offered no longer takes nothing back")
    #expect(try Self.drawn(tree, on: phone)["Tie a reef knot"] != nil)
  }

  @Test func anUndoTheServerSettlesIsToldOnceTheEngineHasSettledItAndAnUndoAskedAgainMeanwhileAsksNothing() throws {
    let (phone, tree, steps, host, heard) = try Self.sailing()
    let renamed = try #require(try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(steps["knot"]!), "label": "Tie a cleat hitch"]).receipt)
    phone.sync()
    try host.undo(renamed)
    try host.undo(renamed)
    try host.follow()
    #expect(heard.told.isEmpty, "the server settles the Undo of a write it holds")
    for _ in 0..<4 {
      phone.sync()
      try host.follow()
    }
    #expect(heard.told == ["update_node undone"])
    #expect(try Self.drawn(tree, on: phone)["Tie a bowline"] != nil)
  }

  @Test func aReleaseThatFailsLosesNoOutcomeAndLeavesItsActHeldForClose() throws {
    let (engine, replica, runner) = Self.notedPhone()
    let (tree, steps, host, heard) = try Self.planted(on: runner, syncing: engine.sync)
    let start = replica.journaled
    let renamed = try #require(try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(steps["knot"]!), "label": "Tie a cleat hitch"]).receipt)
    let marked = try #require(try host.run("set_progress", ["treeId": .string(tree), "nodeId": .string(steps["dock"]!), "status": "complete"]).receipt)
    engine.sync()
    try host.undo(renamed)
    try host.undo(marked)
    engine.sync()

    replica.failNextRelease()
    #expect(throws: CommitFailure.self) { try host.follow() }
    #expect(heard.told == ["update_node undone"], "an Undo is told before its act is let go of")
    try host.follow()
    try host.follow()
    #expect(heard.told == ["update_node undone", "set_progress undone"], "the Undo after the failed release stayed to be told, once")
    try host.close()
    #expect(try replica.stillHeld(since: start) == [], "the act the failed release left held goes at close")
  }

  @Test func aClosedConversationLeavesTheEngineHoldingNothingOfItsWritesOrTheirUndos() throws {
    let (engine, replica, runner) = Self.notedPhone()
    let (tree, steps, host, heard) = try Self.planted(on: runner, syncing: engine.sync)
    let start = replica.journaled
    _ = try host.run("create_node", ["treeId": .string(tree), "label": "Hoist the sail", "prerequisites": [.string(steps["dock"]!)]])
    let renamed = try #require(try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(steps["knot"]!), "label": "Tie a cleat hitch"]).receipt)
    _ = try host.run("set_progress", ["treeId": .string(tree), "nodeId": .string(steps["dock"]!), "status": "complete"])
    engine.sync()
    try host.undo(renamed)
    let open = RoadmapToolHost(runner: runner, about: tree) { _, _ in }
    _ = try open.run("update_node", ["treeId": .string(tree), "nodeId": .string(steps["sail"]!), "label": "Sail alone"])

    try host.close()
    engine.sync()
    try host.follow()
    #expect(heard.told.isEmpty, "an Undo still settling is told no more")
    #expect(try replica.stillHeld(since: start).count == 1, "only the write of a conversation still open stays held")
  }

  @Test func anUndoALaterWriteStandsInTheWayOfIsSkipped() throws {
    let (phone, tree, steps, host, heard) = try Self.sailing()
    let (dock, knot) = (ID<RoadmapStep>(RecordID(steps["dock"]!)), ID<RoadmapStep>(RecordID(steps["knot"]!)))
    let id = ID<RoadmapEntry>(RecordID(tree))
    let renamed = try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(knot.description), "label": "Coach's title"]).receipt
    let completed = try host.run("set_progress", ["treeId": .string(tree), "nodeId": .string(dock.description), "status": "complete"]).receipt
    for act in [AnyActAction<RoadmapRefusal>(ChangeStep(tree: id, step: knot, changes: .init(label: "The person's title"))),
                AnyActAction(MarkStep.reset(tree: id, step: dock)), AnyActAction(MarkStep.complete(tree: id, step: dock))] {
      guard case .committed = try phone.runner.runComposed([act]) else { throw ContractError("the person's write was not taken") }
    }
    phone.sync()

    #expect(try Self.undo([renamed, completed], by: host, heard, syncing: phone.sync) == ["update_node skipped", "set_progress skipped"])
    let drawn = try Self.drawn(tree, on: phone)
    #expect(drawn["The person's title"] != nil)
    #expect(drawn["Leave the dock"]?["done"] == true)
  }

  // Coach writes no kind, so this receipt is made here over the Undo the room's act runner answered for the room's delete of
  // one. The host asks it with the check the delete named, so while a kind made since wears the hue it takes nothing back,
  // as the room's own Undo does: the caller meets no throw, `told` hears it unavailable, and the delete's act is let go of.
  @Test func anUndoAKindsHueRefusesWhereItIsAskedTakesNothingBackAndIsToldUnavailable() throws {
    let (engine, replica, runner) = Self.notedPhone()
    let (tree, _, host, heard) = try Self.planted(on: runner, syncing: engine.sync)
    let id = ID<RoadmapEntry>(RecordID(tree))
    let start = replica.journaled
    guard case .committed(_, let deleted) = try runner.runAct(DeleteKind(tree: id, kind: ID("learn"))) else {
      throw ContractError("the kind was not deleted")
    }
    engine.sync()
    guard case .committed(_, let made) = try runner.runAct(CreateKind(tree: id, kind: NewKind(hue: "olive", label: "Weather"))) else {
      throw ContractError("the person's kind was not made")
    }
    let receipt = WriteReceipt(ability: "delete_kind", treeId: tree, nodeId: "", undo: deleted.undo)

    #expect(try Self.undo([receipt], by: host, heard, syncing: engine.sync) == ["delete_kind unavailable"])
    let legend = try runner.read(id.tree) { try $0.repository(RoadmapKind.self).all(in: .drawn) }.map { "\($0.label) \($0.hue)" }.sorted()
    #expect(legend == ["Build terracotta", "Milestone gold", "Weather olive"], "the deleted kind stays deleted and the new one keeps the hue")
    #expect(try replica.stillHeld(since: start) == [made.undo.actId], "of the two acts only the person's own stays held")
  }

  @Test func aDoorThatWroteNothingIsNoChangeOrNotReadyNeverASuccessAndLeavesNoReceipt() throws {
    let (phone, tree, steps, _, heard) = try Self.sailing()
    let id = ID<RoadmapEntry>(RecordID(tree))
    let (dock, knot, sail) = (ID<RoadmapStep>(RecordID(steps["dock"]!)), ID<RoadmapStep>(RecordID(steps["knot"]!)), ID<RoadmapStep>(RecordID(steps["sail"]!)))
    let before = try StandingRoadmaps(reading: phone.runner)
    let host = RoadmapToolHost(runner: phone.runner, about: tree, standing: { before }) { heard.told.append("\($0.ability) \($1.rawValue)") }
    for act in [AnyActAction<RoadmapRefusal>(ChangeStep(tree: id, step: knot, changes: .init(label: "Tie a cleat hitch"))),
                AnyActAction(MarkStep.complete(tree: id, step: dock)), AnyActAction(ChangePrerequisites(tree: id, step: knot, add: [dock]))] {
      guard case .committed = try phone.runner.runComposed([act]) else { throw ContractError("the person's write was not taken") }
    }

    let runs = [
      try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(knot.description), "label": "Tie a cleat hitch"]),
      try host.run("set_progress", ["treeId": .string(tree), "nodeId": .string(dock.description), "status": "complete"]),
      try host.run("connect", ["treeId": .string(tree), "nodeId": .string(dock.description), "prerequisiteId": .string(knot.description)]),
    ]
    #expect(runs.map { $0.answer } == [.failure(CoachRefusal(.noChange, knot.description)), .failure(CoachRefusal(.noChange, dock.description)),
                                  .failure(CoachRefusal(.roadmapNotReady, dock.description))])
    #expect(runs.allSatisfy { $0.receipt == nil })

    phone.failNextCommit()
    #expect(throws: CommitFailure.self, "a write the phone could not store throws out of the host, for the turn's engine to report") {
      try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(sail.description), "description": "With a skipper."])
    }
    #expect(try Self.drawn(tree, on: phone)["Sail with an instructor"]?["description"] == "")
  }

  @Test func aRefusalWritesNothingAndAnInputOutsideTheSchemaNeverReachesTheAbility() throws {
    let (phone, tree, steps, host, _) = try Self.sailing()
    let (before, offers) = (try Self.drawn(tree, on: phone), phone.undoOffers().count)
    let runs = [
      try host.run("set_progress", ["treeId": .string(tree), "nodeId": .string(steps["dock"]!), "status": "done"]),
      try host.run("set_progress", ["treeId": .string(tree), "nodeId": .string(steps["sail"]!), "status": "complete"]),
      try host.run("update_node", ["treeId": .string(tree), "nodeId": .string(steps["knot"]!), "label": "Tie a \u{0} bowline"]),
      try host.run("get_nodes", ["treeId": .string(tree), "nodeIds": [.string(steps["sail"]!)], "fields": ["state"]]),
    ]
    #expect(runs.map { $0.answer } == [
      .failure(CoachRefusal(.invalidInput)), .failure(CoachRefusal(.stepLocked, steps["sail"]!)), .failure(CoachRefusal(.invalidInput, steps["knot"]!)),
      .success(["steps": [["id": .string(steps["sail"]!), "state": "locked"]]]),
    ])
    #expect(runs.allSatisfy { $0.receipt == nil })
    #expect(try Self.drawn(tree, on: phone) == before)
    #expect(phone.undoOffers().count == offers, "nothing reached the engine")
  }
}

// A phone's replica that keeps note of each act it journals for Undo, the Undos' own among them, and fails the next release
// once armed: what a host leaves the engine holding, and a store that fails as an act is let go of.
final class NotedReplica: Replica {
  struct Noted {
    var journaled: [String] = []
    var failingRelease = false
  }

  let base: any Replica
  let noted = Mutex(Noted())

  init(_ base: any Replica) {
    self.base = base
  }

  var journaled: Int { noted.withLock { $0.journaled.count } }

  func failNextRelease() {
    noted.withLock { $0.failingRelease = true }
  }

  // The acts journaled after the first `start` that the engine still holds, each let go of now: a release still finds it.
  func stillHeld(since start: Int) throws -> [String] {
    try noted.withLock { $0.journaled }.dropFirst(start).filter { try base.releaseReversibleAct($0) }
  }

  func commit<T>(_ scope: ScopeRef, _ body: (any CommitContext) throws -> (Gesture?, T)) throws -> (outcome: CommitOutcome?, value: T) {
    try base.commit(scope, body)
  }

  func commitAct<T>(_ prepare: (any ActContext) throws -> (ActRequest?, T),
                    segment: (T, Int, any CommitContext) throws -> Gesture) throws -> (outcome: ActCommitOutcome?, value: T) {
    var undoable = false
    let committed = try base.commitAct({ (context: any ActContext) throws -> (ActRequest?, T) in
      let prepared = try prepare(context)
      undoable = prepared.0?.undo != nil
      return prepared
    }, segment: segment)
    if undoable, case .committed(let receipt)? = committed.outcome { noted.withLock { $0.journaled.append(receipt.gestureId) } }
    return committed
  }

  func cancelHeld(_ gestureId: String) throws -> Bool { try base.cancelHeld(gestureId) }

  func requestInverse(_ actId: String, slots: [ActUndo.Segment]?) throws -> InverseResult {
    let result = try base.requestInverse(actId, slots: slots)
    switch result {
    case .cancelled(_, let inverse, _), .pending(_, let inverse, _), .settled(_, let inverse, _, _, _): noted.withLock { $0.journaled.append(inverse) }
    case .unavailable: break
    }
    return result
  }

  func readInverseResult(_ requestId: String) throws -> InverseResult { try base.readInverseResult(requestId) }

  func releaseReversibleAct(_ actId: String) throws -> Bool {
    let failing = noted.withLock { (noted: inout Noted) -> Bool in
      defer { noted.failingRelease = false }
      return noted.failingRelease
    }
    if failing { throw CommitFailure(.storeFailure, "the release was not stored") }
    return try base.releaseReversibleAct(actId)
  }

  func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T { try base.read(scope, body) }
  func mintID(_ type: String) throws -> RecordID { try base.mintID(type) }
  func physNow() throws -> Int64 { try base.physNow() }
  @discardableResult func dismissNotice(_ id: String) throws -> Bool { try base.dismissNotice(id) }
}
