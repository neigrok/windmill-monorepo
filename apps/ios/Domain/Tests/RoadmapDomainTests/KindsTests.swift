import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import Testing

// A roadmap's legend: each case of kinds-actions.json by its complete decision, the recolour command against the registry,
// and its prediction against the model server holding the same records.
struct KindsTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/kinds-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  static func decision(_ vector: Vector) throws -> JSON {
    let corpus = ProductCorpus(RoadmapRules.book)
    let input = try vector.input.member("input")
    let tree: ID<RoadmapEntry> = try input.id("tree")
    switch try vector.input.member("action").asString() {
    case "CreateKind":
      return try corpus.act(CreateKind(tree: tree, kind: NewKind(form: input.member("kind"))), vector, result: \.json, refusal: \.form)
    case "ChangeKind":
      let changes = try input.member("changes")
      let act = ChangeKind(tree: tree, kind: try input.id("kind"), label: try changes.optionalString("label"),
                           description: try changes.optionalString("description"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "MoveKind":
      let below: ID<RoadmapKind>? = try input.member("below").nullable { ID(try RecordID(json: $0)) }
      return try corpus.act(MoveKind(tree: tree, kind: input.id("kind"), below: below), vector, result: { .null }, refusal: \.form)
    case "RecolourKind":
      let act = RecolourKind(tree: tree, kind: try input.id("kind"), hue: try input.member("hue").asString())
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "DeleteKind": return try corpus.act(DeleteKind(tree: tree, kind: input.id("kind")), vector, result: { .null }, refusal: \.form)
    case let name: throw ContractError("no kind action \(name)")
    }
  }

  @Test func theRecolourCommandMatchesTheRegistry() throws {
    try RegistryCheck.command(RecolourKindCommand.self, book: RoadmapRules.book, registry: SyncSchema.registry)
  }

  @Test func aRecolourIsDrawnOnTheKindAndItsStepsAsTheServerThenWritesIt() throws {
    let phone = RoadmapsTests.phone()
    let planted = ImportedSteps(steps: [ImportedStep(key: "a", label: "Basics", color: "olive"), ImportedStep(key: "b", label: "Tools", color: "gold")])
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
}
