import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// What a device tells a person once (§6): each case of landing-actions.json by its complete result, the two reads and the
// note's clearing.
struct LandingTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/landing-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  static func decision(_ vector: Vector) throws -> JSON {
    let corpus = ProductCorpus(RoadmapRules.book)
    let input = try vector.input.member("input")
    switch try (vector.input["read"] ?? vector.input.member("action")).asString() {
    case "cannotLand": return ["result": CannotLand(try input.member("notices").asArray().map(Self.notice)).form]
    case "landing":
      let tree: ID<RoadmapEntry> = try input.id("tree")
      return try corpus.read(vector, in: tree.tree) { (read: Reader) throws -> JSON in try LandingRead(of: tree, in: read).form }
    case "ClearLanding":
      let told = try input.member("told")
      let act = ClearLanding(tree: try input.id("tree"), nodes: try told["nodes"].map { _ in try told.ids("nodes") } ?? [],
                             edges: try (told["edges"]?.asArray() ?? []).map(RoadmapLink.init(ends:)),
                             revived: try told["revived"].map { _ in try told.ids("revived") } ?? [])
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case let name: throw ContractError("no landing read or action \(name)")
    }
  }

  // The kit corpus's notice form, `{id, scope, code, detail?, content: {d, cmd?, dependents?}, at}`. The case states a
  // refused text as its text alone, which the web reads; the engine's delta holds what it was edited from too, here "".
  static func notice(_ json: JSON) throws -> DomainNotice<RoadmapRefusal> {
    func delta(_ json: JSON) throws -> Delta {
      var stated = try json.asObject()
      if case .object(let texts)? = stated["x"] {
        stated["x"] = .object(JSON.Object(uniqueKeysWithValues: texts.members.map { (name: String, write: JSON) -> (String, JSON) in
          guard case .object(var text) = write, text["base"] == nil else { return (name, write) }
          text["base"] = ["text": ""]
          return (name, .object(text))
        }))
      }
      return try Delta(json: .object(stated))
    }
    func content(_ json: JSON) throws -> NoticeContent {
      NoticeContent(deltas: try (json["d"]?.asArray() ?? []).map(delta), command: try json["cmd"].map { try Command(json: $0) },
                    dependents: try (json["dependents"]?.asArray() ?? []).map(content))
    }
    let notice = Notice(id: try json.member("id").asString(), product: "roadmap", scope: try ScopeRef(json.member("scope").asString()),
                        code: RefusalCode(try json.member("code").asString()), detail: json["detail"], content: try content(json.member("content")),
                        at: try json["at"]?.asInteger() ?? 0)
    return DomainNotice(notice, registry: SyncSchema.registry)
  }
}

extension RoadmapLink {
  // `[from, to]`.
  init(ends: JSON) throws {
    let steps = try ends.asArray().map { try $0.asString() }
    guard steps.count == 2 else { throw ContractError("a link is [from, to], found \(ends)") }
    self.init(from: ID(RecordID(steps[0])), to: ID(RecordID(steps[1])))
  }
}

extension LandingRead {
  var form: JSON {
    let lines: [JSON] = follows.map { (line: Line) -> JSON in
      let removed: [JSON] = line.removed.map { ["id": $0.id.json, "name": .of($0.name)] }
      let followed: [JSON] = line.followed.map { (entry: (step: Followed, name: String?)) -> JSON in
        ["id": .string(entry.step.id), "incoming": .array(entry.step.incoming.map(\.ends)), "throughAbsent": .bool(entry.step.throughAbsent),
         "name": .of(entry.name)]
      }
      return ["node": line.node.json, "incoming": .array(line.incoming.map(\.id.json)), "removed": .array(removed), "followed": .array(followed)]
    }
    return ["follows": .array(lines), "cameBack": .array(cameBack.map(\.json)), "note": note.json]
  }
}

extension CannotLand {
  var form: JSON {
    let listed: [JSON] = self.listed.map { (entry: Entry) -> JSON in
      ["id": .string(entry.id), "gestureId": .string(entry.gestureId), "reason": .string(entry.reason.rawValue),
       "subject": entry.subject?.form ?? .null, "values": .object(fields: entry.values)]
    }
    let unexpected: [JSON] = self.unexpected.map { ["id": .string($0.id), "code": $0.code.json] }
    return ["listed": .array(listed), "unexpected": .array(unexpected)]
  }
}
