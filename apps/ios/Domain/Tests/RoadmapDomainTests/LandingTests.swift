import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// What a device tells a person once (§6): each case of landing-actions.json by its complete result, the two reads and the
// note's clearing; and, over the real engine, a link from a step another phone deleted, as the web's harness tells it
// (harness.test.js).
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

  // The lines a phone says of a roadmap: each step, the steps removed and the steps it now follows, by name.
  static func lines(of tree: ID<RoadmapEntry>, on phone: Harness) throws -> [JSON] {
    try phone.runner.read(tree.tree) { (scope: Reader) throws -> [JSON] in
      try LandingRead(of: tree, in: scope).follows.map { (line: LandingRead.Line) -> JSON in
        let removed: [JSON] = line.removed.map { [$0.id.json, .of($0.name)] }
        let followed: [JSON] = line.followed.map { [.string($0.step.id), .of($0.name)] }
        return [line.node.json, .array(removed), .array(followed)]
      }
    }
  }

  // The server's order as a phone holds it: the `seq` of a link's confirmed row, and of the spent id of the step it comes from.
  static func order(of link: RoadmapLink, in tree: ID<RoadmapEntry>, on phone: Harness) throws -> (linked: Int64?, deleted: Int64?) {
    try phone.runner.read(tree.tree) { (scope: Reader) throws -> (linked: Int64?, deleted: Int64?) in
      (try scope.confirmed(RoadmapLink.self, link.id)?.seq, try scope.repository(RoadmapStep.self).spentSeq(link.from))
    }
  }

  // INV-1 and §6. The tablet deletes Lifetimes and leaves the app, so the server takes the delete while the phone still
  // holds the step; the phone links a new step from it and notes the step's name. The new link has not landed, so nothing
  // is said. Once it lands the phone holds nothing of Lifetimes but its spent id: the server took the delete before the
  // new link, whose line names the step as the note kept it, and after the link to Traits, which says nothing.
  @Test func aLinkFromAStepAnotherPhoneDeletedSaysItsLineNamedFromTheNoteOnceItLands() throws {
    let (phone, tablet, tree, steps) = try StepsTests.chained(["Basics", "Lifetimes", "Traits"])
    let (basics, lifetimes, traits) = (steps[0], steps[1], steps[2])
    guard case .committed = try tablet.runner.runAct(DeleteStep(tree: tree, step: lifetimes)) else {
      Issue.record("the step was not deleted")
      return
    }
    tablet.leave()
    guard case .committed(let generics, _) = try phone.runner.runAct(
      CreateStep(tree: tree, step: RoadmapStep.Changes(label: "Generics"), prerequisites: [lifetimes])) else {
      Issue.record("the step was not created")
      return
    }
    let named: JSON = [["id": lifetimes.json, "name": "Lifetimes"]]
    #expect(try StepsTests.note(of: tree, on: phone)["names"] == named)
    #expect(try Self.lines(of: tree, on: phone) == [])
    phone.sync()
    let line: JSON = [generics.json, [[lifetimes.json, "Lifetimes"]], [[basics.json, "Basics"]]]
    #expect(try Self.lines(of: tree, on: phone) == [line])
    let made = try Self.order(of: RoadmapLink(from: lifetimes, to: generics), in: tree, on: phone)
    let kept = try Self.order(of: RoadmapLink(from: lifetimes, to: traits), in: tree, on: phone)
    let (deleted, linked, before) = (try #require(made.deleted), try #require(made.linked), try #require(kept.linked))
    #expect(before < deleted && deleted < linked)
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty && tablet.notices(RoadmapRefusal.self).isEmpty)
  }

  // §6 A link that landed before another phone deleted its step tells nothing, and goes with the next write of the note.
  // The delete reaches the phone with no write of the note between, so the note still holds all it made. A link made
  // then, from the step it knows only by its spent id, lets go of everything that landed, keeps no name of the deleted
  // step, waits until it lands, and then says its line with no name for the step removed.
  @Test func aLinkThatLandedBeforeAnotherPhonesDeleteTellsNothingAndGoesWithTheNextWriteOfTheNote() throws {
    let (phone, tablet, tree, steps) = try StepsTests.chained(["Basics", "Lifetimes", "Traits"])
    let (basics, lifetimes, traits) = (steps[0], steps[1], steps[2])
    guard case .committed = try tablet.runner.runAct(DeleteStep(tree: tree, step: lifetimes)) else {
      Issue.record("the step was not deleted")
      return
    }
    phone.advance(ms: Constants.holdMs)
    phone.sync()
    let noted: JSON = [
      "nodes": [basics.json, lifetimes.json, traits.json], "edges": [[basics.json, lifetimes.json], [lifetimes.json, traits.json]], "revived": [],
      "names": [["id": basics.json, "name": "Basics"], ["id": lifetimes.json, "name": "Lifetimes"]],
    ]
    #expect(try StepsTests.note(of: tree, on: phone) == noted)
    #expect(try Self.lines(of: tree, on: phone) == [])
    guard case .committed(let generics, _) = try phone.runner.runAct(
      CreateStep(tree: tree, step: RoadmapStep.Changes(label: "Generics"), prerequisites: [lifetimes])) else {
      Issue.record("the step was not created")
      return
    }
    #expect(try StepsTests.note(of: tree, on: phone) == ["nodes": [generics.json], "edges": [[lifetimes.json, generics.json]], "revived": [], "names": []])
    #expect(try Self.lines(of: tree, on: phone) == [])
    phone.sync()
    let line: JSON = [generics.json, [[lifetimes.json, .null]], [[basics.json, "Basics"]]]
    #expect(try Self.lines(of: tree, on: phone) == [line])
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty && tablet.notices(RoadmapRefusal.self).isEmpty)
  }

  // §6 A roadmap built step by step keeps a note of its newest step alone: each write lets go of what landed before it.
  // Steps made with no connection stay noted until they land, and the next write then keeps only its own.
  @Test func aRoadmapBuiltStepByStepKeepsANoteOfItsNewestStepAlone() throws {
    let (phone, _, tree, steps) = try StepsTests.chained(["Basics"])
    let made = { (previous: ID<RoadmapStep>) throws -> ID<RoadmapStep> in
      let act = CreateStep(tree: tree, step: RoadmapStep.Changes(label: "Next"), prerequisites: [previous])
      guard case .committed(let step, _) = try phone.runner.runAct(act) else { throw ContractError("the step was not created") }
      return step
    }
    let newest = { (step: ID<RoadmapStep>, previous: ID<RoadmapStep>, name: String) -> JSON in
      ["nodes": [step.json], "edges": [[previous.json, step.json]], "revived": [], "names": [["id": previous.json, "name": .string(name)]]]
    }
    var previous = steps[0]
    for built in 1..<8 {
      let step = try made(previous)
      phone.sync()
      #expect(try StepsTests.note(of: tree, on: phone) == newest(step, previous, built == 1 ? "Basics" : "Next"))
      previous = step
    }
    var unsent: [JSON] = []
    for _ in 0..<4 {
      let step = try made(previous)
      unsent.append([previous.json, step.json])
      previous = step
    }
    #expect(try StepsTests.note(of: tree, on: phone)["edges"] == .array(unsent))
    phone.sync()
    let last = try made(previous)
    #expect(try StepsTests.note(of: tree, on: phone) == newest(last, previous, "Next"))
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
