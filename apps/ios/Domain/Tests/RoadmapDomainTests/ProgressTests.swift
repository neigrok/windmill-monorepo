import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A person's marks and an owner's pointers: each case of progress-actions.json by its complete decision.
struct ProgressTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/progress-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  static func decision(_ vector: Vector) throws -> JSON {
    let corpus = ProductCorpus(RoadmapRules.book)
    let input = try vector.input.member("input")
    let (tree, step): (ID<RoadmapEntry>, ID<RoadmapStep>) = (try input.id("tree"), try input.id("step"))
    switch try vector.input.member("action").asString() {
    case "Complete":
      let act = MarkStep.complete(tree: tree, step: step, outOfOrder: try input.optionalBool("outOfOrder") ?? false,
                                  opensStanding: try input.optionalBool("opensStanding") ?? false)
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "Reset": return try corpus.act(MarkStep.reset(tree: tree, step: step), vector, result: { .null }, refusal: \.form)
    case "SetPointer":
      return try corpus.act(PointStep.set(tree: tree, step: step, opens: input.id("opens")), vector, result: { .null }, refusal: \.form)
    case "ClearPointer": return try corpus.act(PointStep.clear(tree: tree, step: step), vector, result: { .null }, refusal: \.form)
    case let name: throw ContractError("no progress action \(name)")
    }
  }
}
