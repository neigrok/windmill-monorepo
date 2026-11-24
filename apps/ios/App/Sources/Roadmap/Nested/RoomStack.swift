import Foundation

// The room's one stack (Roadmap on iOS §6; Roadmap · iOS 07.1b, 07.2, 07.3, 07.11b): the root's room and a room of its own
// for each roadmap gone into, each over the one it was gone into from. Every screen pushed stands on the one stack, the
// band is the stack's one band, and Back lets each room it passes go, the deepest first.
extension RoadmapModel {
  // A screen as the room's one stack holds it: a visit made in the root's room or in a roadmap gone into, by how deep.
  struct Stacked: Hashable {
    let depth: Int
    let visit: Visit
  }

  // How many roadmaps deep the room stands: the root's room and a cover's are 0, a roadmap gone into one deeper than the
  // room it was gone into from.
  var depth: Int { outside.map { $0.depth + 1 } ?? 0 }

  // The rooms the person stands in from this one, each roadmap gone into after the one it was gone into from.
  var rooms: [RoadmapModel] { Array(sequence(first: self) { $0.inside }) }

  // The person's own room, which the rooms gone into stand over: where their list is read, links are followed and the band
  // is kept.
  var root: RoadmapModel { outside?.root ?? self }

  // The room on top of the stack, whose screens alone the person can reach: the deepest roadmap gone into, else the root's.
  var deepest: RoadmapModel { inside?.deepest ?? self }

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

  func room(at depth: Int) -> RoadmapModel? { rooms.dropFirst(depth).first }

  // Whether a step's roadmap is gone into from this room: one that can be found and that no room on the stack shows
  // already, so a loop is gone round once and the stack is never deeper than the roadmaps it holds.
  func goesIn(to opening: Opened) -> Bool {
    opening.leads && !root.rooms.contains { $0.shown?.listed.id.utf8.elementsEqual(opening.tree.utf8) == true }
  }

  // Into the roadmap a step opens (07.1b, 07.2, 07.11): its room is pushed on the stack over the screen gone in from.
  func goIn(_ row: Row, by door: Visit.Door) {
    guard owns, let opening = row.opening, goesIn(to: opening) else { return }
    path.append(.roadmap(opening.tree, by: door))
  }

  // A roadmap gone into: a room of its own over the copy this room reads, told as the web tells going in.
  func wentIn(_ tree: String, by door: Visit.Door) {
    let subtree = shown?.rows.values.contains { $0.opening.map { $0.owned && $0.tree.utf8.elementsEqual(tree.utf8) } == true } ?? false
    let room = RoadmapModel(records: records, runner: runner, phone: phone, telemetry: telemetry, wait: wait, role: .inside(tree, subtree: subtree))
    room.outside = self
    inside = room
    let view = shown.map { self.view(of: $0).rawValue } ?? Lens.board.rawValue
    if subtree { telemetry.event("roadmap_subtree_open", properties: ["door": door.rawValue, "view": view, "role": "owner"]) }
    else { telemetry.event("roadmap_tree_open", properties: ["door": door.rawValue, "view": view]) }
    room.observe()
  }

  // Back from a roadmap gone into, however many rooms it passes: each room leaves with its screens, the deepest first, a
  // note open on one saved and its Back told once. The band is the root's, so it stands on with its Undo for its time.
  func cameBack(from room: RoadmapModel) {
    room.path = []
    inside = nil
    guard case .inside(_, let subtree) = room.role else { return }
    if subtree { telemetry.event("roadmap_subtree_back", properties: ["role": "owner"]) }
    else { telemetry.event("roadmap_tree_back") }
  }
}
