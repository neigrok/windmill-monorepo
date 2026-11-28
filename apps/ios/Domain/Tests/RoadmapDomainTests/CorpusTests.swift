import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The runner of roadmap's shared vectors, `packages/api-contract/roadmap/domain/`: each read over the records a case states.
struct CorpusTests {
  static let reads = ["account", "activity", "board", "diagnostics", "effects", "graph", "guides", "landing", "legend", "pointers", "progress", "replica", "search"]

  // `rules.json` and `values.json` run in RoadmapRulesTests, each family's actions in its own tests (a turn's in
  // ConversationTests and TurnRecordsTests, a proposal's decisions in ApplyTests), and the scenes of `undo.json` in UndoTests.
  @Test func everyFileIsClaimed() throws {
    let actions = ["apply", "conversation", "kinds", "landing", "progress", "roadmaps", "steps", "turn-records", "workspace"].map { "\($0)-actions" }
    let claimed = (Self.reads + actions + ["rules", "undo", "values"]).map { "roadmap/domain/\($0).json" }
    #expect(try Contract.files(under: "roadmap/domain") == claimed.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) })
  }

  @Test(arguments: try reads.flatMap { try Contract.vectors("roadmap/domain/\($0).json") })
  func read(_ vector: Vector) throws {
    let actual = try Self.result(of: vector.input)
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  static func result(of input: JSON) throws -> JSON {
    let operation = try input.member("operation").asString()
    if operation == "roadmap" { return try RoadmapTree(replica: input).form }
    if let trees = input["trees"] {
      let told = try (input["told"]?.asArray() ?? []).map { (row: JSON) throws -> RoadmapAccount.Told in
        RoadmapAccount.Told(tree: try row.member("tree").asString(),
                            counts: Counts(done: Int(try row.member("done").asInteger()), total: Int(try row.member("total").asInteger())))
      }
      let account = RoadmapAccount(try trees.asArray().map(RoadmapTree.init(form:)), told: told)
      switch operation {
      case "account": return account.form
      case "list": return .array(account.list().map(\.form))
      case "listing": return account.listing(try input.member("tree").asString())?.form ?? .null
      default: break
      }
      let tree = try input.member("tree").asString()
      switch operation {
      case "activity": return try account.graph(tree).map { ActivityRead($0, step: try input.optionalString("step")).form } ?? .null
      case "effects":
        let (ids, links, attach) = try EffectsRead.asked(input)
        return account.graph(tree).map { EffectsRead($0, ids: ids, links: links, attach: attach).form } ?? .null
      case "progress": return account.progress(tree)?.form ?? .null
      case "guides": return .array(account.guides(tree).map(\.form))
      case "openings": return .array(account.openings(of: tree).map(\.form))
      case "pointers": return PointerDiagnostics(account, tree: tree).form
      default: throw ContractError("no roadmap read \(operation) over an account")
      }
    }
    let tree = try RoadmapTree(form: input.member("tree"))
    switch operation {
    case "legend": return LegendRead(tree).form
    case "search": return .strings(tree.selectNodes(try NodeFilter(form: input.member("query"))))
    case "graph": return FollowGraph(tree).form(subjects: try input.member("subjects").asArray().map { try $0.asString() })
    case "board": return BoardRead(FollowGraph(tree), try BoardQuery(form: input["query"] ?? [:])).form
    case "diagnostics": return Diagnostics(FollowGraph(tree)).form
    case "effects":
      let (ids, links, attach) = try EffectsRead.asked(input)
      return EffectsRead(FollowGraph(tree), ids: ids, links: links, attach: attach).form
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
