import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A roadmap's steps and links: each case of steps-actions.json Swift's acts decide, by its complete decision.
struct StepsTests {
  static let decided = ["CreateStep", "ChangeStep", "MoveStep", "DeleteStep", "ChangePrerequisites"]

  @Test(arguments: try Contract.vectors("roadmap/domain/steps-actions.json").filter { decided.contains(try $0.input.member("action").asString()) })
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
    case let name: throw ContractError("no step action \(name)")
    }
  }
}
