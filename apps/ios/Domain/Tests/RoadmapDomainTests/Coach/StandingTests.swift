import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// The standing roadmap (Roadmap Coach D-2) read from a phone's engine, and read by the abilities as the room shows it.
struct StandingTests {
  @Test func aStepUnderADeleteThePersonCanStillUndoIsAbsentAndWhatWaitedOnItFollowsWhatItFollowed() throws {
    let phone = RoadmapsTests.phone()
    let planted = ImportedSteps(
      steps: [ImportedStep(key: "dock", .init(label: "Leave the dock")), ImportedStep(key: "knot", .init(label: "Tie a bowline")),
              ImportedStep(key: "sail", .init(label: "Sail with an instructor"))],
      links: [(from: "dock", to: "knot"), (from: "knot", to: "sail")])
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn to sail", steps: planted)) else {
      throw ContractError("the roadmap was not created")
    }
    let (tree, dock, knot, sail) = (created.tree, created.steps[0].id, created.steps[1].id, created.steps[2].id)
    phone.sync()
    for act in [AnyActAction<RoadmapRefusal>(MarkStep.complete(tree: tree, step: dock)), AnyActAction(DeleteStep(tree: tree, step: knot)),
                AnyActAction(AddSubtask(tree: tree, step: sail, item: .init(label: "Book a lesson"))),
                AnyActAction(AddSubtask(tree: tree, step: knot, item: .init(label: "Practise", done: true)))] {
      guard case .committed = try phone.runner.runComposed([act]) else { throw ContractError("the person's write was not taken") }
    }
    let standing = try StandingRoadmaps(reading: phone.runner)
    let marked = try phone.runner.read(tree.overlay) { try $0.repository(StepMark.self).record(ID(dock.record), in: .drawn)?.stamps["mark"]?.ms }
    let held = try phone.runner.read(tree.tree) { try $0.repository(RoadmapStep.self).record(ID(knot.record), in: .drawn) }
    #expect(standing.stamps.first { $0.t == RoadmapStep.type && $0.id == knot.json }?.life == held?.life?.stamp.text, "the step's life as the delete stamps it")
    #expect(standing.stamps.first { $0.t == RoadmapStep.type && $0.id == knot.json }?.f == held?.stamps.mapValues(\.text))
    #expect(standing.stamps.map { "\($0.scope) \($0.t)" }.sorted() == (["\(RoadmapEntry.scope) tree", "\(tree.overlay) progress"]
      + ["edge", "edge", "kind", "kind", "kind", "meta", "node", "node", "node"].map { "\(tree.tree) \($0)" }).sorted(),
      "the list record, every record of the tree scope and the overlay's mark")
    let read = { (name: String, input: JSON) -> JSON in
      RoadmapAbilities.answer(name, input, over: standing, about: tree.description, ids: { "" }).form
    }

    let kinds: [JSON] = RoadmapRules.genesisKinds.map {
      ["id": $0.id.json, "label": .string($0.label), "hue": .string($0.hue), "description": .string($0.description)]
    }
    #expect(read("get_tree", ["treeId": tree.json, "fields": ["label", "state", "prerequisites", "subtasks"]]) == ["result": [
      "tree": ["title": "Learn to sail", "kinds": .array(kinds), "guide": "", "stepCount": 2],
      "steps": [
        ["id": dock.json, "label": "Leave the dock", "state": "complete", "prerequisites": [], "subtasks": []],
        ["id": sail.json, "label": "Sail with an instructor", "state": "available", "prerequisites": [dock.json],
         "subtasks": [["label": "Book a lesson", "done": false]]],
      ],
    ]])
    #expect(read("get_nodes", ["treeId": tree.json, "nodeIds": [knot.json]]) == ["refused": ["code": "unknown-step", "id": knot.json]])
    #expect(read("set_progress", ["treeId": tree.json, "nodeId": knot.json, "status": "complete"])
      == ["refused": ["code": "roadmap-not-ready", "id": knot.json]], "a write that names it is not ready")
    #expect(read("list_trees", [:]) == ["result": ["trees": [[
      "id": tree.json, "title": "Learn to sail", "counts": ["total": 2, "done": 1, "available": 1, "locked": 0, "unknown": 0],
      "frontier": ["Sail with an instructor"], "lastCompletedAt": .of(marked.map { Instant(ms: $0) }),
    ]]]], "a mark the server has not received is dated by the phone")
  }
}
