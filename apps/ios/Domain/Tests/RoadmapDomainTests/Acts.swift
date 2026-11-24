import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore

// Each act of roadmap's corpus as a case names it (the corpus README's Actions table), built from its `action` and `input`:
// decided over a case's records, or run on a phone of the harness, its result in the form the corpus states it.
struct RoadmapAct {
  let decide: (Vector) throws -> JSON
  let run: (ActionRunner) throws -> ActOutcome<JSON, RoadmapRefusal>

  init<A: ActAction>(_ act: A, result: @escaping (A.Result) -> JSON) where A.Refusal == RoadmapRefusal {
    decide = { vector in try ProductCorpus(RoadmapRules.book).act(act, vector, result: result, refusal: \.form) }
    run = { runner in
      switch try runner.runAct(act) {
      case .committed(let value, let receipt): .committed(result(value), receipt)
      case .unchanged(let value): .unchanged(result(value))
      case .refused(let refusal): .refused(refusal)
      }
    }
  }

  // A case's complete decision over its records.
  static func decision(_ vector: Vector) throws -> JSON {
    try RoadmapAct(try vector.input.member("action").asString(), try vector.input.member("input")).decide(vector)
  }

  // Every act but a roadmap's creation names its roadmap.
  init(_ action: String, _ input: JSON) throws {
    if action == "CreateRoadmap" {
      let steps = try input["steps"].map(ImportedSteps.init(form:)) ?? ImportedSteps()
      let kinds = try input.optional("kinds") { try $0.asArray().map(NewKind.init(form:)) }
      self.init(CreateRoadmap(title: try input.member("title").asString(), steps: steps, kinds: kinds), result: \.form)
      return
    }
    let tree: ID<RoadmapEntry> = try input.id("tree")
    switch action {
    case "DeleteRoadmap": self.init(DeleteRoadmap(tree: tree), result: { .null })
    case "SetVisibility": self.init(SetVisibility(tree: tree, visibility: try input.member("visibility").asString()), result: { .null })
    case "CreateSubtree": self.init(CreateSubtree(tree: tree, step: try input.id("step")), result: \.form)
    case "WriteRoadmap":
      self.init(WriteRoadmap(tree: tree, title: try input.optionalString("title"), guide: try input.optionalString("guide")), result: { .null })
    case "CreateStep":
      let act = CreateStep(tree: tree, step: try RoadmapStep.Changes(form: input.member("step")), prerequisites: try input.ids("prerequisites"),
                           id: try input.optionalID("id"))
      self.init(act, result: \.json)
    case "ChangeStep":
      self.init(ChangeStep(tree: tree, step: try input.id("step"), changes: try RoadmapStep.Changes(form: input.member("changes"))), result: { .null })
    case "MoveStep":
      self.init(MoveStep(tree: tree, step: try input.id("step"), below: try input.optionalID("below"), siblings: try input.ids("siblings")),
                result: { .null })
    case "DeleteStep": self.init(DeleteStep(tree: tree, step: try input.id("step")), result: { .null })
    case "ChangePrerequisites":
      self.init(ChangePrerequisites(tree: tree, step: try input.id("step"), add: try input.ids("add"), remove: try input.ids("remove")), result: { .null })
    case "ImportSteps":
      let act = ImportSteps(tree: tree, imported: try ImportedSteps(form: input.member("imported")), under: try input.optionalID("under"))
      self.init(act) { (planted: [(key: String, id: ID<RoadmapStep>)]) -> JSON in
        .object(JSON.Object(uniqueKeysWithValues: planted.map { ($0.key, $0.id.json) }))
      }
    case "CreateKind": self.init(CreateKind(tree: tree, kind: try NewKind(form: input.member("kind"))), result: \.json)
    case "ChangeKind":
      let changes = try input.member("changes")
      let act = ChangeKind(tree: tree, kind: try input.id("kind"), label: try changes.optionalString("label"),
                           description: try changes.optionalString("description"))
      self.init(act, result: { .null })
    case "MoveKind": self.init(MoveKind(tree: tree, kind: try input.id("kind"), below: try input.optionalID("below")), result: { .null })
    case "RecolourKind": self.init(RecolourKind(tree: tree, kind: try input.id("kind"), hue: try input.member("hue").asString()), result: { .null })
    case "DeleteKind": self.init(DeleteKind(tree: tree, kind: try input.id("kind")), result: { .null })
    case "Complete":
      let act = MarkStep.complete(tree: tree, step: try input.id("step"), outOfOrder: try input.optionalBool("outOfOrder") ?? false,
                                  opensStanding: try input.optionalBool("opensStanding") ?? false)
      self.init(act, result: { .null })
    case "Reset": self.init(MarkStep.reset(tree: tree, step: try input.id("step")), result: { .null })
    case "SetPointer": self.init(PointStep.set(tree: tree, step: try input.id("step"), opens: try input.id("opens")), result: { .null })
    case "ClearPointer": self.init(PointStep.clear(tree: tree, step: try input.id("step")), result: { .null })
    case "AddSubtask":
      self.init(AddSubtask(tree: tree, step: try input.id("step"), item: try Subtask.Changes(form: input), id: try input.optionalID("id")),
                result: \.json)
    case "ChangeSubtask":
      self.init(ChangeSubtask(tree: tree, id: try input.id("subtask"), changes: try Subtask.Changes(form: input.member("changes"))), result: { .null })
    case "MoveSubtask": self.init(MoveSubtask(tree: tree, id: try input.id("subtask"), below: try input.optionalID("below")), result: { .null })
    case "DeleteSubtask": self.init(DeleteSubtask(tree: tree, id: try input.id("subtask")), result: { .null })
    case "AddStepLink":
      let act = AddStepLink(tree: tree, step: try input.id("step"), item: try WorkspaceLink.Changes(form: input.member("link")),
                            id: try input.optionalID("id"))
      self.init(act, result: \.json)
    case "ChangeStepLink":
      self.init(ChangeStepLink(tree: tree, id: try input.id("link"), changes: try WorkspaceLink.Changes(form: input.member("changes"))), result: { .null })
    case "MoveStepLink": self.init(MoveStepLink(tree: tree, id: try input.id("link"), below: try input.optionalID("below")), result: { .null })
    case "DeleteStepLink": self.init(DeleteStepLink(tree: tree, id: try input.id("link")), result: { .null })
    case "ClearLanding":
      let told = try input.member("told")
      let act = ClearLanding(tree: tree, nodes: try told.ids("nodes"), edges: try (told["edges"]?.asArray() ?? []).map(RoadmapLink.init(ends:)),
                             revived: try told.ids("revived"))
      self.init(act, result: { .null })
    case let name: throw ContractError("no roadmap act \(name)")
    }
  }
}
