import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import Testing

// A roadmap's legend: each case of kinds-actions.json by its complete decision, the recolour command against the registry,
// its prediction against the model server holding the same records, and a change to a kind another phone deleted (INV-1),
// as the web's harness tells it (harness.test.js).
struct KindsTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/kinds-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try RoadmapAct.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  // The corpus's recolour case holds present wearers and a spent id. A step the device deleted itself and has not yet
  // settled, dead in `drawn`, wears its hue as before: the web's module decides the case with step `b` made dead as it
  // decides the case itself, `b` predicted and restored beside `c`, and Swift is held to that decision.
  @Test func aRecolourPredictsAndRestoresAStepTheDeviceHoldsDeleted() throws {
    let recolour = "recolouring a kind runs the command and predicts its hue and every step the device holds that wears it"
    let vector = try #require(try Contract.vectors("roadmap/domain/kinds-actions.json").first { $0.name.hasPrefix(recolour) })
    let scope = "tree/t_0000000000000001"
    var input = try vector.input.asObject()
    var scopes = try input.member("scopes").asObject()
    var records = try scopes.member(scope).asObject()
    records["drawn"] = .array(try records.member("drawn").asArray().map { (row: JSON) throws -> JSON in
      guard row["t"] == "node", row["id"] == "b" else { return row }
      var deleted = try row.asObject()
      deleted["life"] = ["dead", "2000:0:r_bbbbbbbbbbbb"]
      return .object(deleted)
    })
    scopes[scope] = .object(records)
    input["scopes"] = .object(scopes)
    let scene = Vector(file: vector.file, name: vector.name, input: .object(input), expect: vector.expect)
    for decided in [scene, scene.withRecordsReversed] {
      let actual = try RoadmapAct.decision(decided)
      #expect(actual == vector.expect, "got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  // Over the real engine: a step whose delete is still held wears its kind's hue in `drawn`, dead, and takes the new one
  // with the step that is present; once the hold ends the delete stands and the recolour lands with no refusal.
  @Test func aRecolourReachesAStepWhoseDeleteIsStillHeld() throws {
    let phone = RoadmapsTests.phone()
    let planted = ImportedSteps(steps: [ImportedStep(key: "a", .init(label: "Basics", color: "olive")), ImportedStep(key: "b", .init(label: "Tools", color: "olive"))])
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn Rust", steps: planted)) else {
      Issue.record("the roadmap was not created")
      return
    }
    phone.sync()
    let (deleted, kept) = (created.steps[0].id, created.steps[1].id)
    guard case .committed = try phone.runner.run(Remove<RoadmapStep, RoadmapRefusal>(deleted, in: created.tree.tree)),
          case .committed = try phone.runner.runAct(RecolourKind(tree: created.tree, kind: ID("learn"), hue: "plum")) else {
      Issue.record("the step was not deleted or the kind not recoloured")
      return
    }
    let worn = { () throws -> [[JSON]] in
      try phone.runner.read(created.tree.tree) { (scope: Reader) throws -> [[JSON]] in
        try scope.repository(RoadmapStep.self).records(in: .drawn).map { (record: Record) -> [JSON] in
          [record.id.json, .bool(record.isVisible), record.values["color"] ?? .null]
        }
      }
    }
    let held = [deleted, kept].sorted().map { (step: ID<RoadmapStep>) -> [JSON] in [step.json, .bool(step == kept), "plum"] }
    #expect(try worn() == held)
    phone.advance(ms: Constants.holdMs)
    phone.sync()
    #expect(try worn() == [[kept.json, true, "plum"]])
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty)
  }

  @Test func theRecolourCommandMatchesTheRegistry() throws {
    try RegistryCheck.command(RecolourKindCommand.self, book: RoadmapRules.book, registry: SyncSchema.registry)
  }

  @Test func aRecolourIsDrawnOnTheKindAndItsStepsAsTheServerThenWritesIt() throws {
    let phone = RoadmapsTests.phone()
    let planted = ImportedSteps(steps: [ImportedStep(key: "a", .init(label: "Basics", color: "olive")), ImportedStep(key: "b", .init(label: "Tools", color: "gold"))])
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn Rust", steps: planted)) else {
      Issue.record("the roadmap was not created")
      return
    }
    phone.sync()
    guard case .committed = try phone.runner.runAct(RecolourKind(tree: created.tree, kind: ID("learn"), hue: "plum")) else {
      Issue.record("the kind was not recoloured")
      return
    }
    let worn = { () throws -> [[String]] in
      [try phone.drawn(RoadmapKind.self, in: created.tree.tree).map(\.hue), try phone.drawn(RoadmapStep.self, in: created.tree.tree).map(\.color)]
    }
    let steps = created.steps.map(\.id).sorted().map { $0 == created.steps[0].id ? "plum" : "gold" }
    #expect(try worn() == [["terracotta", "plum", "gold"], steps])
    phone.sync()
    #expect(try worn() == [["terracotta", "plum", "gold"], steps])
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty)
  }

  // INV-1: once the tablet's delete of a kind has reached the phone, the phone holds only its spent id. A change revives
  // the kind with the field it names, and the server's revival keeps the words the phone no longer held.
  @Test func aChangeToAKindAnotherPhoneDeletedBringsItBackWithTheWordsTheServerKept() throws {
    let phone = RoadmapsTests.phone()
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn Rust")) else {
      Issue.record("the roadmap was not created")
      return
    }
    phone.sync()
    let tablet = phone.device()
    phone.sync()
    let tree = created.tree
    guard case .committed = try tablet.runner.runAct(DeleteKind(tree: tree, kind: ID("learn"))) else {
      Issue.record("the kind was not deleted")
      return
    }
    phone.sync()
    let kinds = { (device: Harness) throws -> [[String]] in
      try device.drawn(RoadmapKind.self, in: tree.tree).map { [$0.id.description, $0.label, $0.description] }
    }
    #expect(try kinds(phone).map { $0[0] } == ["build", "milestone"])
    guard case .committed = try phone.runner.runAct(ChangeKind(tree: tree, kind: ID("learn"), description: "What you study")) else {
      Issue.record("the kind was not changed")
      return
    }
    phone.sync()
    let legend = [["build", "Build", "Things you make"], ["learn", "Learn", "What you study"], ["milestone", "Milestone", "Moments that matter"]]
    #expect(try kinds(phone) == legend)
    #expect(try kinds(tablet) == legend)
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty && tablet.notices(RoadmapRefusal.self).isEmpty)
  }
}
