import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The runner of roadmap's shared vectors, `packages/api-contract/roadmap/domain/`: each read over the records a case states.
struct CorpusTests {
  static let reads = ["graph"]

  @Test(arguments: try reads.flatMap { try Contract.vectors("roadmap/domain/\($0).json") })
  func read(_ vector: Vector) throws {
    let actual = try Self.result(of: vector.input)
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  static func result(of input: JSON) throws -> JSON {
    let tree = try RoadmapTree(form: input.member("tree"))
    switch try input.member("operation").asString() {
    case "graph": return FollowGraph(tree).form(subjects: try input.member("subjects").asArray().map { try $0.asString() })
    case let operation: throw ContractError("no roadmap read \(operation)")
    }
  }
}
