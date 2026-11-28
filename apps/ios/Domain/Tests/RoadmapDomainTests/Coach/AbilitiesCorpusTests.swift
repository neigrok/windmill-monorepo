import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The runner of Roadmap Coach's ability vectors, `packages/api-contract/roadmap/abilities/`: each case's call through its
// ability over the case's roadmaps, its answer compared whole by canonical text. A direct write and a proposal draw their new
// ids from the case's `ids`, in order; a proposal's record is folded again over the case's roadmaps for what it leaves; and
// each context case through the context.
struct AbilitiesCorpusTests {
  static var claimed: [String] { RoadmapAbilities.names.map { "roadmap/abilities/\($0).json" } }
  static let proposals = "roadmap/abilities/\(RoadmapProposals.name).json"
  static let contextFile = "roadmap/abilities/context.json"

  @Test func everyAbilityOfTheCatalogRunsOrProposesOnTheCopyEveryReadAnswersWithinItsCapAndEveryFileIsClaimed() throws {
    let runs = Catalog.roadmap.abilities.filter { $0.agent == .runs }
    #expect(runs.map(\.name) == RoadmapAbilities.names)
    #expect(Catalog.roadmap.abilities.filter { $0.agent == .proposes }.map(\.name) == [RoadmapProposals.name])
    let reads = Catalog.roadmap.abilities.filter { $0.kind == .read }
    #expect(reads.map { $0.result["maxBytes"] } == reads.map { _ in 16384 })
    let files = try Contract.files(under: "roadmap/abilities")
    #expect(files.filter { Self.claimed.contains($0) } == Self.claimed.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) })
    #expect(files.filter { !Self.claimed.contains($0) && $0 != Self.proposals && $0 != Self.contextFile } == [], "every file is claimed")
    let bounds = try Contract.json("roadmap/limits.json").member("context")
    let pinned = try ["bytes", "steps", "recent", "frontier", "prerequisites"].map { Int(try bounds.member($0).member("max").asInteger()) }
    #expect([RoadmapContext.Bounds.bytes, RoadmapContext.Bounds.steps, RoadmapContext.Bounds.recent, RoadmapContext.Bounds.frontier,
             RoadmapContext.Bounds.prerequisites] == pinned, "the context's bounds are limits.json's")
  }

  // §5: each context case, its roadmaps given as records or as a table of them, read through the context.
  @Test(arguments: try Contract.json(contextFile).asArray().indices)
  func contextCase(_ index: Int) throws {
    let each = try Contract.json(Self.contextFile).asArray()[index]
    let given = try each.member("given")
    let spelled = { (records: JSON?) throws -> JSON in
      guard case .object(let table)? = records else { return records ?? .array([]) }
      let columns = try table.member("columns").asArray().map { try $0.asString() }
      return .array(try table.member("rows").asArray().map { row in
        .object(JSON.Object(uniqueKeysWithValues: zip(columns, try row.asArray())))
      })
    }
    let trees = try given.member("trees").asArray().map { tree -> RoadmapTree in
      var record = try tree.asObject()
      for key in ["nodes", "edges", "marks"] where record[key] != nil { record[key] = try spelled(record[key]) }
      return try RoadmapTree(form: .object(record))
    }
    let held = try (given["held"]?.asArray() ?? []).map {
      StandingRoadmaps.Held(tree: try $0.member("tree").asString(), step: try $0.member("step").asString())
    }
    let about = try each["about"].flatMap { $0.isNull ? nil : try $0.asString() }
    let step = try each["step"].flatMap { $0.isNull ? nil : try $0.asString() }
    let answer: JSON = switch RoadmapContext.read(StandingRoadmaps(trees: trees, held: held), about: about, step: step) {
    case .success(let context): ["result": context]
    case .failure(let refusal): ["refused": refusal.form]
    }
    let expect = try each.member("expect")
    let title = try each.member("case").asString()
    #expect(answer == expect, "\(title)\n  got    \(answer.jcsText.prefix(2000))\n  expect \(expect.jcsText.prefix(2000))")
  }

  @Test(arguments: try claimed.flatMap { try AbilityCase.all(in: $0) })
  func ability(_ each: AbilityCase) throws {
    var minted = each.ids
    var drawn = 0
    let answer = RoadmapAbilities.answer(each.name, each.input, over: each.standing, about: each.about) {
      drawn += 1
      return minted.isEmpty ? "" : minted.removeFirst()
    }
    #expect(drawn <= each.ids.count, "the call draws no more ids than the case gives")
    #expect(answer.form == each.expect, "\(each)\n  got    \(answer.form.jcsText)\n  expect \(each.expect.jcsText)")
    let result: JSON
    switch answer {
    case .result(let read): result = read
    case .writes(_, let written): result = written
    case .refused: return
    }
    let schema = try #require(Catalog.roadmap.ability(named: each.name)).result
    #expect(JSONSchema(schema).fault(in: result) == nil, "the answer stands inside the ability's result schema")
    #expect(result.jcs.count <= 16384)
  }

  @Test(arguments: try AbilityCase.all(in: proposals))
  func proposal(_ each: AbilityCase) throws {
    var minted = each.ids
    var drawn = 0
    let answer = RoadmapProposals.answer(each.input, over: each.standing, about: each.about, seen: each.seen) { _ in
      drawn += 1
      return minted.isEmpty ? "" : minted.removeFirst()
    }
    #expect(drawn <= each.ids.count, "the call draws no more ids than the case gives")
    let form: JSON
    switch answer {
    case .refused(let refusal): form = ["refused": refusal.form]
    case .minted(let proposal, let result):
      let treeId = try each.input.member("treeId").asString()
      let folded = try ProposalFold.over(each.standing, treeId: treeId, changes: proposal.changes).get().folded
      form = ["result": result, "proposal": ["changes": .array(proposal.changes), "base": .array(proposal.base.map(\.json))], "folded": folded]
      let schema = try #require(Catalog.roadmap.ability(named: RoadmapProposals.name)).result
      #expect(JSONSchema(schema).fault(in: result) == nil, "the answer stands inside the ability's result schema")
    }
    #expect(form == each.expect, "\(each)\n  got    \(form.jcsText)\n  expect \(each.expect.jcsText)")
  }
}

// One case of an ability's file: what the conversation is about, the standing roadmap it gives, the ids the tool host's
// source draws, the call, and what it must answer.
struct AbilityCase: Sendable, CustomTestStringConvertible {
  let file: String
  let name: String
  let about: String?
  let standing: StandingRoadmaps
  let seen: [RecordStamps]
  let ids: [String]
  let input: JSON
  let expect: JSON
  let title: String

  static func all(in file: String) throws -> [AbilityCase] {
    try Contract.json(file).asArray().map { each in
      let given = try each.member("given")
      let held = try (given["held"]?.asArray() ?? []).map {
        StandingRoadmaps.Held(tree: try $0.member("tree").asString(), step: try $0.member("step").asString())
      }
      let subtasks = try (given["subtasks"]?.asArray() ?? []).map {
        StandingRoadmaps.ChecklistItem(tree: try $0.member("tree").asString(), step: try $0.member("step").asString(),
                                       label: try $0.member("label").asString(), done: try $0.member("done").asBool())
      }
      let trees = try given.member("trees").asArray().map(RoadmapTree.init(form:))
      let stamps = { (key: String) throws -> [RecordStamps] in
        try (given[key]?.asArray() ?? []).map {
          RecordStamps(scope: try $0.member("scope").asString(), t: try $0.member("t").asString(), id: try $0.member("id"),
                       life: try $0.member("life").nullable { try $0.asString() },
                       f: Dictionary(uniqueKeysWithValues: try $0.member("f").asObject().members.map { ($0.key, try $0.value.asString()) }))
        }
      }
      let call = try each.member("call")
      return AbilityCase(file: file, name: try call.member("name").asString(), about: try each.optionalString("about"),
                         standing: StandingRoadmaps(trees: trees, held: held, subtasks: subtasks, stamps: try stamps("stamps")), seen: try stamps("seen"),
                         ids: try (given["ids"]?.asArray() ?? []).map { try $0.asString() }, input: try call.member("input"),
                         expect: try each.member("expect"), title: try each.member("case").asString())
    }
  }

  var testDescription: String { "\(file) · \(title)" }
}

extension AbilityResponse {
  // The answer in the form the vectors' `expect` states it.
  var form: JSON {
    switch self {
    case .result(let read): ["result": read]
    case .writes(let acts, let result): ["writes": .array(acts.map(\.form)), "result": result]
    case .refused(let refusal): ["refused": refusal.form]
    }
  }
}

extension CoachRefusal {
  var form: JSON {
    var refused: JSON.Object = ["code": .string(code.rawValue)]
    refused["id"] = id.map(JSON.string)
    refused["at"] = at.map { JSON($0) }
    return .object(refused)
  }
}

extension RoomAct {
  // The act as the domain corpus's cases name and shape it; a flag it raises that the room's control leaves down shows.
  var form: JSON {
    switch self {
    case .mark(let act):
      var input: JSON.Object = ["tree": act.tree.json, "step": act.step.json]
      if act.outOfOrder { input["outOfOrder"] = true }
      if act.opensStanding { input["opensStanding"] = true }
      return ["action": act.completes ? "Complete" : "Reset", "input": .object(input)]
    case .changeStep(let act): return ["action": "ChangeStep", "input": ["tree": act.tree.json, "step": act.step.json, "changes": act.changes.form]]
    case .addSubtask(let act):
      var input: JSON.Object = ["tree": act.tree.json, "step": act.step.json, "label": .of(act.item.label)]
      input["done"] = act.item.done.map(JSON.bool)
      input["id"] = act.id?.json
      return ["action": "AddSubtask", "input": .object(input)]
    case .createStep(let act):
      return ["action": "CreateStep", "input": ["tree": act.tree.json, "step": act.step.form, "prerequisites": .array(act.prerequisites.map(\.json)),
                                               "id": act.id?.json ?? .null]]
    case .changePrerequisites(let act):
      return ["action": "ChangePrerequisites", "input": ["tree": act.tree.json, "step": act.step.json, "add": .array(act.add.map(\.json)),
                                                        "remove": .array(act.remove.map(\.json))]]
    }
  }
}

extension RoadmapStep.Changes {
  // The fields the changes name.
  var form: JSON {
    var named = JSON.Object()
    named["label"] = label.map(JSON.string)
    named["icon"] = icon.map(JSON.string)
    named["color"] = color.map(JSON.string)
    named["description"] = description.map(JSON.string)
    named["links"] = links.map { .array($0.map(\.json)) }
    return .object(named)
  }
}
