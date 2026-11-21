import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The runner of roadmap's shared vectors, `packages/api-contract/roadmap/domain/`: each read over the records a case states.
struct CorpusTests {
  static let reads = ["account", "board", "graph", "guides", "landing", "legend", "progress", "search"]

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
    case "legend": return LegendRead(tree).form
    case "search": return .strings(tree.selectNodes(try NodeFilter(form: input.member("query"))))
    case "graph": return FollowGraph(tree).form(subjects: try input.member("subjects").asArray().map { try $0.asString() })
    case "board": return BoardRead(FollowGraph(tree), try BoardQuery(form: input["query"] ?? [:])).form
    case "landing":
      let own = try input.member("edges").asArray().map { link in
        let ends = try link.asArray().map { try $0.asString() }
        guard ends.count == 2 else { throw ContractError("a link is [from, to], found \(link)") }
        return RoadmapTree.Edge(from: ends[0], to: ends[1], present: true)
      }
      return .array(FollowGraph(tree).landingFacts(own: own).map(\.form))
    default: throw ContractError("no roadmap read \(operation)")
    }
  }
}
