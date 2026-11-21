import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A roadmap's steps and links: each case of steps-actions.json by its complete decision.
struct StepsTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/steps-actions.json"))
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
    case "CreateStep":
      let act = CreateStep(tree: tree, step: try RoadmapStep.Changes(form: input.member("step")), prerequisites: try input.ids("prerequisites"),
                           id: try input.optionalID("id"))
      return try corpus.act(act, vector, result: \.json, refusal: \.form)
    case "ChangeStep":
      let act = ChangeStep(tree: tree, step: try input.id("step"), changes: try RoadmapStep.Changes(form: input.member("changes")))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "MoveStep":
      let act = MoveStep(tree: tree, step: try input.id("step"), below: try input.optionalID("below"), siblings: try input.ids("siblings"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "DeleteStep": return try corpus.act(DeleteStep(tree: tree, step: input.id("step")), vector, result: { .null }, refusal: \.form)
    case "ChangePrerequisites":
      let act = ChangePrerequisites(tree: tree, step: try input.id("step"), add: try input.ids("add"), remove: try input.ids("remove"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "ImportSteps":
      let act = ImportSteps(tree: tree, imported: try ImportedSteps(form: input.member("imported")), under: try input.optionalID("under"))
      return try corpus.act(act, vector, result: { (planted: [(key: String, id: ID<RoadmapStep>)]) -> JSON in
        .object(JSON.Object(uniqueKeysWithValues: planted.map { ($0.key, $0.id.json) }))
      }, refusal: \.form)
    case let name: throw ContractError("no step action \(name)")
    }
  }
}
