import Foundation
import DomainKit
import RoadmapDomain
import SyncCore

// A step that opens a roadmap (Roadmap on iOS §6; Roadmap · iOS 04.6, 07.1 to 07.12b): the roadmap its pointer opens or the
// subtree it owns, as the room shows it wherever the step stands; going into that roadmap and back on the room's one
// stack, each roadmap gone into a room of its own; and a roadmap attached to a step, changed and detached, each with Undo.
extension RoadmapModel {
  // The roadmap a step opens as the room shows it: which roadmap, whether the step owns it as its subtree, the one of the
  // web's faces (`Opening.face`) the domain's read of it comes to, its name and how many of its steps are done.
  struct Opened: Equatable {
    // A roadmap on its way, done, with no step, leading back to the roadmap it is opened from, one that cannot be found
    // (deleted, never on this phone, or not the person's), or one this phone has not read yet.
    enum Face: String {
      case open, complete, empty, loop, missing, unread
    }

    let tree: String
    let owned: Bool
    let face: Face
    // A subtree is named by its step; a roadmap by its title, none where it is not read or cannot be found.
    let title: String?
    let done: Int
    let total: Int

    // What the domain reads the step's opening to come to. A roadmap counted, read or told, shows how far it is; a subtree
    // nothing is known of yet is unread, and so is a roadmap the phone has yet to read; any other is missing.
    init(_ read: OpeningRead, in account: RoadmapAccount, of step: RoadmapDomain.Step) {
      tree = read.opening.tree
      owned = read.opening.kind == .subtree
      title = owned ? step.label : account.location(of: read.opening.tree).title
      (done, total) = (read.counts?.done ?? 0, read.counts?.total ?? 0)
      face = if read.opening.status == .dangling { .missing }
        else if read.counts == nil { owned || read.opening.status == .unread ? .unread : .missing }
        else if read.complete { .complete }
        else if read.loop { .loop }
        else if total == 0 { .empty }
        else { .open }
    }

    // Whether the step leads into the roadmap: not into one that cannot be found.
    var leads: Bool { face != .missing }
    var toGo: Int { total - done }

    // The roadmap's name where the room says it: the words for one that cannot be found, nothing for one unread.
    var name: String {
      if face == .missing { return String(localized: "Not found", comment: "A roadmap a step opens that cannot be found") }
      return owned ? RoadmapModel.Row.name(of: title ?? "") : title.map { ListedRoadmap.name(of: $0) } ?? ""
    }

    // The Board row's pill (07.1, 07.5d): the roadmap's name and its count, or the one thing in its way.
    var pill: String? {
      switch face {
      case .open, .complete:
        String(localized: "\(name) · \(done) of \(total)", locale: .copy, comment: "A Board row's pill: the roadmap a step opens, and how many of its steps are done, of how many")
      case .empty: String(localized: "\(name) · No steps", comment: "A Board row's pill: the roadmap a step opens, which has no steps")
      case .loop: String(localized: "Loops back", comment: "The roadmap a step opens leads back to the roadmap the step stands in")
      case .missing: name
      case .unread: title.map { RoadmapModel.Row.name(of: $0) }
      }
    }

    // How much of the roadmap is done, where a bar says it: on a roadmap that has steps and is on its way or done.
    var gauge: Double? {
      guard face == .open || face == .complete, total > 0 else { return nil }
      return Double(done) / Double(total)
    }

    // The Graph's line under the step's caption (04.6).
    var line: String? {
      switch face {
      case .open, .complete:
        String(localized: "\(done) of \(total)", locale: .copy, comment: "How many of a roadmap's steps are done, of how many, under its name in the title menu")
      case .empty: String(localized: "No steps", comment: "The roadmap a step opens has no steps")
      case .loop: String(localized: "Loops back", comment: "The roadmap a step opens leads back to the roadmap the step stands in")
      case .missing: name
      case .unread: nil
      }
    }

    // The step page's Roadmap row, under the roadmap's name (07.2, 07.5a to 07.5c, 07.11).
    var progress: String? {
      switch face {
      case .open, .complete: Counts(done: done, total: total).progress
      case .empty: owned ? String(localized: "No steps yet") : String(localized: "No steps", comment: "The roadmap a step opens has no steps")
      case .loop:
        String(localized: "\(done) of \(total) done · Loops back", locale: .copy,
               comment: "The step page's Roadmap row: how many of the roadmap's steps are done, of how many, and that it leads back")
      case .missing, .unread: nil
      }
    }

    // What the status row says of an Up next step in place of what it unlocks: how far the roadmap has to go, or what
    // stands in its way (07.2, 07.5a to 07.5c, 07.11). Nothing for a roadmap unread.
    var upNext: String? {
      switch face {
      case .open where owned:
        String(localized: "\(toGo) to go in its subtree", locale: .copy, comment: "An Up next step's status: how many steps the subtree it owns has to go")
      case .open:
        String(localized: "\(toGo) to go in \(name)", locale: .copy, comment: "An Up next step's status: how many steps the roadmap it opens has to go, and its name")
      case .empty, .missing: String(localized: "Can’t complete yet", comment: "An Up next step's status: the roadmap it opens has no steps or cannot be found")
      case .loop: String(localized: "Won’t complete by itself", comment: "An Up next step's status: the roadmap it opens leads back to this one")
      case .complete, .unread: nil
      }
    }

    // The foot's one filled control on an Up next step (07.2, 07.5c, 07.11): into the roadmap, or to choose another.
    var primary: String {
      if owned { return String(localized: "Open Subtree") }
      return face == .missing ? String(localized: "Choose Roadmap") : String(localized: "Open Roadmap")
    }

    // The Roadmap section's footer: what completes the step, the one thing in its way first, then what it still needs, then
    // its roadmap; where the person can detach, a loop and a roadmap not found say the way out. Nothing for one unread.
    func rule(of row: Row, in open: OpenRoadmap, detaches: Bool) -> String? {
      let roadmap = open.listed.name
      switch face {
      case .unread: return nil
      case .missing:
        return detaches ? String(localized: "This roadmap can’t be found. Choose another, or detach it.") : String(localized: "This roadmap can’t be found.")
      case .complete:
        if owned { return String(localized: "Done because every step in this subtree is done.") }
        return String(localized: "Done because every step in \(name) is done.", comment: "The Roadmap section's footer of a step its roadmap completed: the roadmap's name")
      case .loop:
        if detaches {
          return String(localized: "A loop with \(roadmap): this never completes. Detach one side.",
                        comment: "The Roadmap section's footer: the roadmap the step stands in, which the roadmap it opens leads back to")
        }
        return String(localized: "A loop with \(roadmap): this never completes.",
                      comment: "The Roadmap section's footer: the roadmap the step stands in, which the roadmap it opens leads back to")
      case .empty: return String(localized: "A roadmap with no steps isn’t done. Add its first.")
      case .open:
        guard let needs = row.card.needs else {
          if owned { return String(localized: "Done when every step in this subtree is done.") }
          return String(localized: "Done when every step in \(name) is done.", comment: "The Roadmap section's footer: the roadmap the step opens")
        }
        let first = RoadmapModel.Row.name(of: open.tree.step(needs.first)?.label ?? "")
        switch (owned, needs.extra) {
        case (true, 0):
          return String(localized: "Needs \(first), then every step in this subtree.", comment: "The Subtree section's footer of a Locked step: the step it still needs")
        case (true, _):
          return String(localized: "Needs \(first) +\(needs.extra), then every step in this subtree.", locale: .copy,
                        comment: "The Subtree section's footer of a Locked step: the first step it still needs, and how many more")
        case (false, 0):
          return String(localized: "Needs \(first), then every step in \(name).",
                        comment: "The Roadmap section's footer of a Locked step: the step it still needs, and the roadmap it opens")
        case (false, _):
          return String(localized: "Needs \(first) +\(needs.extra), then every step in \(name).", locale: .copy,
                        comment: "The Roadmap section's footer of a Locked step: the first step it still needs, how many more, and the roadmap it opens")
        }
      }
    }

    // What the footer adds where the step holds a Done mark its roadmap sets aside (07.8b): the mark is kept, and the steps
    // it opened alone lock again.
    static func markAside(relocks: Int) -> String {
      if relocks == 0 { return String(localized: "Your Done mark is set aside while it opens a roadmap.") }
      return String(localized: "Your Done mark is set aside while it opens a roadmap, so \(relocks) steps lock again.", locale: .copy,
                    comment: "The Roadmap section's footer of a step marked Done by hand: how many steps lock again while it opens a roadmap")
    }
  }

  // A screen as the room's one stack holds it: a visit made in the root's room or in a roadmap gone into, by how deep.
  struct Stacked: Hashable {
    let depth: Int
    let visit: Visit
  }

  // The rooms the person stands in, the root's first and each roadmap gone into after the one it was gone into from.
  var rooms: [RoadmapModel] { Array(sequence(first: self) { $0.inside }) }

  // The room's one stack: every room's visits, each room's after the visit that went into it. Set by the system, each
  // room takes its own back, so a room whose visit is gone leaves with it.
  var stack: [Stacked] {
    get { rooms.flatMap { room in room.path.map { Stacked(depth: room.depth, visit: $0) } } }
    set {
      var room: RoadmapModel? = self
      while let each = room {
        let visits = newValue.filter { $0.depth == each.depth }.map(\.visit)
        if visits != each.path { each.path = visits }
        room = each.inside
      }
    }
  }

  func stacked(_ visit: Visit) -> Stacked { Stacked(depth: depth, visit: visit) }

  func room(at depth: Int) -> RoadmapModel? { rooms.first { $0.depth == depth } }

  // The person's own room, which the rooms gone into stand over: where their list is read and links are followed.
  var root: RoadmapModel { outside?.root ?? self }

  // A roadmap a step may open, by its name as the person's list or the room's copy holds it.
  func name(of roadmap: String) -> String {
    ListedRoadmap.name(of: root.roadmaps.first { $0.id == roadmap }?.title ?? account.location(of: roadmap).title)
  }

  // Into the roadmap a step opens (07.1b, 07.2, 07.11): its room is pushed on the stack over the screen gone in from.
  func goIn(_ row: Row, by door: Visit.Door) {
    guard owns, let opening = row.opening, opening.leads else { return }
    path.append(.roadmap(opening.tree, by: door))
  }

  // A roadmap gone into: a room of its own over the copy this room reads, told as the web tells going in.
  func wentIn(_ tree: String, by door: Visit.Door) {
    let subtree = shown?.rows.values.contains { $0.opening.map { $0.owned && $0.tree.utf8.elementsEqual(tree.utf8) } == true } ?? false
    let room = RoadmapModel(records: records, runner: runner, phone: phone, telemetry: telemetry, wait: wait,
                            role: .inside(tree, subtree: subtree), depth: depth + 1)
    room.outside = self
    inside = room
    let view = shown.map { self.view(of: $0).rawValue } ?? Lens.board.rawValue
    if subtree { telemetry.event("roadmap_subtree_open", properties: ["door": door.rawValue, "view": view, "role": "owner"]) }
    else { telemetry.event("roadmap_tree_open", properties: ["door": door.rawValue, "view": view]) }
    room.observe()
  }

  // Back from a roadmap gone into: its room goes, a note open there saved and its band with it.
  func cameBack(from room: RoadmapModel) {
    room.flush()
    inside = nil
    guard case .inside(_, let subtree) = room.role else { return }
    if subtree { telemetry.event("roadmap_subtree_back", properties: ["role": "owner"]) }
    else { telemetry.event("roadmap_tree_back") }
  }

  // Attach a Roadmap or Change Roadmap (07.6, 07.6c, 07.8): the step opens the roadmap chosen, in the person's overlay, with
  // Undo for six seconds. A Done mark on the step is set aside, not lost. Answers whether it was written.
  @discardableResult
  func attach(_ roadmap: String, to row: Row) -> Bool {
    guard case .open(let open) = phase else { return false }
    let changing = row.opening != nil
    let pointer = PointStep.set(tree: open.id, step: ID(RecordID(row.id)), opens: ID(RecordID(roadmap)))
    guard let written = write(pointer, as: "pointer").committed else { return false }
    let marked = open.tree.mark(on: row.id)?.isComplete == true
    telemetry.event("roadmap_tree_attach", properties: ["step": changing ? "change" : "attach", "mark": marked ? "kept" : "none"])
    show(Band(.attached, of: written.receipt, act: .step(changing ? "change" : "attach")))
    return true
  }

  // Detach Roadmap, or None in the attach list (07.9, 07.10): the step opens no roadmap and is ordinary again, a Done mark
  // set aside back in force. It asks nothing, as the band offers Undo for six seconds.
  func detach(_ row: Row) {
    guard case .open(let open) = phase, row.opening?.owned == false else { return }
    guard let written = write(PointStep.clear(tree: open.id, step: ID(RecordID(row.id))), as: "pointer").committed else { return }
    let marked = open.tree.mark(on: row.id)?.isComplete == true
    telemetry.event("roadmap_tree_attach", properties: ["step": "detach", "mark": marked ? "kept" : "none"])
    show(Band(.detached(markBack: marked), of: written.receipt, act: .step("detach")))
  }
}
