import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The runner of Roadmap Coach's ability vectors, `packages/api-contract/roadmap/abilities/`: each case's call through its
// ability over the case's roadmaps, its answer compared whole by canonical text. A direct write draws its new ids from the
// case's `ids`, in order.
struct AbilitiesCorpusTests {
  static var claimed: [String] { RoadmapAbilities.names.map { "roadmap/abilities/\($0).json" } }

  @Test func everyAbilityThatRunsOnTheCopyRunsEveryReadAnswersWithinItsCapAndEveryFileButTheContextsAndTheProposalsIsClaimed() throws {
    let runs = Catalog.roadmap.abilities.filter { $0.agent == .runs }
    #expect(runs.map(\.name) == RoadmapAbilities.names)
    let reads = Catalog.roadmap.abilities.filter { $0.kind == .read }
    #expect(reads.map { $0.result["maxBytes"] } == reads.map { _ in 16384 })
    let files = try Contract.files(under: "roadmap/abilities")
    #expect(files.filter { Self.claimed.contains($0) } == Self.claimed.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) })
    #expect(files.filter { !Self.claimed.contains($0) } == ["roadmap/abilities/context.json", "roadmap/abilities/propose_roadmap_change.json"],
            "only the context and the proposal go unclaimed")
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
}

// One case of an ability's file: what the conversation is about, the standing roadmap it gives, the ids the tool host's
// source draws, the call, and what it must answer.
struct AbilityCase: Sendable, CustomTestStringConvertible {
  let file: String
  let name: String
  let about: String?
  let standing: StandingRoadmaps
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
      let call = try each.member("call")
      return AbilityCase(file: file, name: try call.member("name").asString(), about: try each.optionalString("about"),
                         standing: StandingRoadmaps(trees: trees, held: held, subtasks: subtasks),
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
