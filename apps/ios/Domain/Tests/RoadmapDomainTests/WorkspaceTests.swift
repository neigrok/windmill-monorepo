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

  // The note's case is a draft's save, every other an act.
  static func decision(_ vector: Vector) throws -> JSON {
    guard try vector.input.member("action").asString() == "SaveStepNote" else { return try RoadmapAct.decision(vector) }
    let input = try vector.input.member("input")
    let (tree, step): (ID<RoadmapEntry>, ID<StepNote>) = (try input.id("tree"), try input.id("step"))
    let text = try input.member("text").asString()
    return try ProductCorpus(RoadmapRules.book).save(SaveStepNote.self, vector, opening: StepNote(id: step), in: tree.overlay,
                                                     edit: { $0.text = text }, result: \.form, refusal: \.form)
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
