import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncCore

// Several of the Board's steps selected at once (Roadmap · iOS 02.10 to 02.12): the system's edit mode over the Board's
// list, started by Select in a row's menu or Select Steps in the Board's tool, and ended by the checkmark or by an act.
// Recolor moves every step chosen to one of the six kinds, as the web's `BulkRecolor`, and Delete N Steps asks once with
// what it costs and then holds the steps' delete, as the web's `BulkDelete`, each one gesture through the room's write
// door with its Undo in the band. A roadmap keeps a starting step: a selection that holds every one cannot be deleted,
// which the band says as it comes to, and can still be recolored. What is chosen is what the Board shows: a step the
// Board stops showing leaves the selection, as the web's selection drops it.
@Observable @MainActor
final class BoardSelection {
  // The gesture that started it, as its event names it: a row's long-press menu, or the Board's tool; and what ended it,
  // the checkmark, or an act on the steps chosen.
  enum Door: String {
    case menu, tool
  }

  enum Ending: String {
    case done, act
  }

  unowned let room: RoadmapModel
  // The roadmap whose steps are chosen.
  let tree: DomainKit.ID<RoadmapEntry>
  // The steps chosen, by their ids, as the list's edit mode holds them.
  var steps: Set<String> {
    didSet { if takesEveryStart && !(room.shown.map { $0.takesEveryStart(oldValue) } ?? false) { refuseDelete() } }
  }

  init(_ steps: Set<String>, of tree: DomainKit.ID<RoadmapEntry>, in room: RoadmapModel) {
    self.room = room
    self.tree = tree
    self.steps = steps
  }

  // The roadmap selected in, while it is the open one.
  var open: RoadmapModel.OpenRoadmap? {
    guard let open = room.shown, open.id == tree else { return nil }
    return open
  }

  // The steps chosen, in the roadmap's order.
  var rows: [RoadmapModel.Row] {
    guard let open else { return [] }
    return open.tree.index.ids.filter { steps.contains($0) }.compactMap { (step: String) -> RoadmapModel.Row? in open.step(step) }
  }

  // Delete is dimmed while the choice holds every step the roadmap starts from.
  var takesEveryStart: Bool { open?.takesEveryStart(steps) ?? false }

  // The steps the Board's query keeps, a folded group's too: what Select All takes, as 02.12 draws it taking a roadmap's
  // starting step from its folded Done.
  var kept: Set<String> {
    guard let open else { return [] }
    return Set(room.reading.shown(in: open).groups.flatMap { (group: RoadmapModel.Group) -> [String] in group.rows.map(\.id) })
  }

  // Every step the query keeps is chosen, so the bar offers Deselect All.
  var holdsEveryKept: Bool {
    let kept = kept
    return !kept.isEmpty && kept.isSubset(of: steps)
  }

  // Select All takes every step the query keeps; Deselect All chooses none.
  func selectAll() {
    steps = holdsEveryKept ? [] : kept
  }

  // The Board shows these steps now: a step it no longer shows is chosen no longer.
  func keep(_ shown: Set<String>) {
    if !steps.isSubset(of: shown) { steps.formIntersection(shown) }
  }

  // The band says why Delete is dimmed, once, as the choice comes to hold every starting step.
  func refuseDelete() {
    room.telemetry.event("roadmap_board_bulk", properties: ["step": "delete_refused", "reason": "last_root"])
    room.show(RoadmapModel.Band(refused: .keepsStartingStep))
  }

  // A kind chosen under Recolor: every step chosen wears its hue, in one gesture whose Undo the band holds for six
  // seconds, and the selection ends. A choice that changes no step writes nothing and stays.
  func recolor(_ hue: String) {
    let rows = rows
    guard let open, !rows.isEmpty else { return }
    let acts = rows.map { (row: RoadmapModel.Row) -> AnyActAction<RoadmapRefusal> in
      AnyActAction(ChangeStep(tree: open.id, step: DomainKit.ID(RecordID(row.id)), changes: RoadmapStep.Changes(color: hue)))
    }
    guard let written = room.write(acts, as: "BulkRecolor").committed else { return }
    room.telemetry.event("roadmap_board_bulk", properties: ["step": "recolor", "count": RoadmapModel.bucket(rows.count)])
    room.endSelecting(via: .act)
    room.show(RoadmapModel.Band(.recolored(count: rows.count), of: written.receipt, act: .step("recolor")))
  }

  // Delete N Steps asks once, on the button, with what the delete costs: the steps outside the choice that follow a step
  // in it, which are read past it once it is gone.
  func askDelete() {
    let rows = rows
    guard let open, !rows.isEmpty, !takesEveryStart else { return }
    let followers = Set(rows.flatMap { (row: RoadmapModel.Row) -> [String] in open.followers[Array(row.id.utf8)] ?? [] }).subtracting(steps)
    room.question = .steps(rows, followers: followers.count)
  }

  // The question answered Delete N Steps: every step chosen goes in one gesture the engine holds, with Undo for the
  // hold, and the selection ends.
  func delete(_ rows: [RoadmapModel.Row]) {
    guard let open, !rows.isEmpty, !open.takesEveryStart(Set(rows.map(\.id))) else { return }
    let acts = rows.map { (row: RoadmapModel.Row) -> AnyActAction<RoadmapRefusal> in
      AnyActAction(DeleteStep(tree: open.id, step: DomainKit.ID(RecordID(row.id))))
    }
    guard let written = room.write(acts, as: "BulkDelete").committed else { return }
    room.telemetry.event("roadmap_board_delete", properties: ["step": "held", "door": "bulk", "view": "board"])
    room.telemetry.event("roadmap_board_bulk", properties: ["step": "delete", "count": RoadmapModel.bucket(rows.count)])
    room.endSelecting(via: .act)
    let says = rows.count == 1 ? RoadmapModel.Band.Says.deleted(step: rows[0].step.label) : .deletedSteps(count: rows.count)
    room.show(RoadmapModel.Band(says, of: written.receipt, act: .step("delete")))
  }
}
