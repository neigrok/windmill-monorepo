import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A step's workspace: each case of workspace-actions.json by its complete decision, the note's by the save of the draft
// its editor opens over the case's overlay.
struct WorkspaceTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/workspace-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  static func decision(_ vector: Vector) throws -> JSON {
    let corpus = ProductCorpus(RoadmapRules.book)
    let input = try vector.input.member("input")
    let tree: ID<RoadmapEntry> = try input.id("tree")
    switch try vector.input.member("action").asString() {
    case "AddSubtask":
      let act = AddSubtask(tree: tree, step: try input.id("step"), item: try Subtask.Changes(form: input), id: try input.optionalID("id"))
      return try corpus.act(act, vector, result: \.json, refusal: \.form)
    case "ChangeSubtask":
      let act = ChangeSubtask(tree: tree, id: try input.id("subtask"), changes: try Subtask.Changes(form: input.member("changes")))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "MoveSubtask":
      let act = MoveSubtask(tree: tree, id: try input.id("subtask"), below: try input.optionalID("below"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "DeleteSubtask": return try corpus.act(DeleteSubtask(tree: tree, id: input.id("subtask")), vector, result: { .null }, refusal: \.form)
    case "AddStepLink":
      let act = AddStepLink(tree: tree, step: try input.id("step"), item: try WorkspaceLink.Changes(form: input.member("link")),
                            id: try input.optionalID("id"))
      return try corpus.act(act, vector, result: \.json, refusal: \.form)
    case "ChangeStepLink":
      let act = ChangeStepLink(tree: tree, id: try input.id("link"), changes: try WorkspaceLink.Changes(form: input.member("changes")))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "MoveStepLink":
      let act = MoveStepLink(tree: tree, id: try input.id("link"), below: try input.optionalID("below"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "DeleteStepLink": return try corpus.act(DeleteStepLink(tree: tree, id: input.id("link")), vector, result: { .null }, refusal: \.form)
    case "SaveStepNote":
      let (step, text): (ID<StepNote>, String) = (try input.id("step"), try input.member("text").asString())
      return try corpus.save(SaveStepNote.self, vector, opening: StepNote(id: step), in: tree.overlay, edit: { $0.text = text },
                             result: \.form, refusal: \.form)
    case let name: throw ContractError("no workspace action \(name)")
    }
  }
}

extension Subtask.Changes {
  // `{label?, done?}`: the fields a case names of a subtask.
  init(form: JSON) throws {
    self.init(label: try form.optionalString("label"), done: try form.optionalBool("done"))
  }
}

extension WorkspaceLink.Changes {
  // `{url?, title?}`: the fields a case names of a link.
  init(form: JSON) throws {
    self.init(url: try form.optionalString("url"), title: try form.optionalString("title"))
  }
}
