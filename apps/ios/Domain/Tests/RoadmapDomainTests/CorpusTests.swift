import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The runner of roadmap's shared vectors, `packages/api-contract/roadmap/domain/`: each read over the records a case states.
struct CorpusTests {
  static let reads = ["account", "graph", "guides", "progress"]

  @Test(arguments: try reads.flatMap { try Contract.vectors("roadmap/domain/\($0).json") })
  func read(_ vector: Vector) throws {
    let actual = try Self.result(of: vector.input)
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  // `replica.json` waits for the read of a replica's records; its `openings` and `list` cases take normalized trees and run here.
  @Test(arguments: try Contract.vectors("roadmap/domain/replica.json").filter { $0.input["operation"] != "roadmap" })
  func accountReadOfTheReplicaFile(_ vector: Vector) throws {
    let actual = try Self.result(of: vector.input)
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  static func result(of input: JSON) throws -> JSON {
    let operation = try input.member("operation").asString()
    if let trees = input["trees"] {
      let account = RoadmapAccount(try trees.asArray().map(RoadmapTree.init(form:)))
      switch operation {
      case "account": return account.form
      case "list": return .array(account.list().map(\.form))
      default: break
      }
      let tree = try input.member("tree").asString()
      switch operation {
      case "progress": return account.progress(tree)?.form ?? .null
      case "guides": return .array(account.guides(tree).map(\.form))
      case "openings": return .array(account.openings(of: tree).map(\.form))
      default: throw ContractError("no roadmap read \(operation) over an account")
      }
    }
    let tree = try RoadmapTree(form: input.member("tree"))
    switch operation {
    case "graph": return FollowGraph(tree).form(subjects: try input.member("subjects").asArray().map { try $0.asString() })
    default: throw ContractError("no roadmap read \(operation)")
    }
  }
}
