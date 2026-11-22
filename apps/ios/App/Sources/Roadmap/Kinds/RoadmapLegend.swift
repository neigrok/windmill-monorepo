import Foundation
import RoadmapDomain

// A roadmap's legend as the room shows it (Roadmap · iOS 02.7, 02.11, 05.2, 06.1 to 06.6, 10.6b), read once with the open
// roadmap, so the step form's Kind list, the Kinds sheet, the Board's filter and Recolor all show this one value. Its
// entries are the web room's (`deriveLegend` over the kinds `ReplicaRoadmap` keeps): each kind that owns its hue in the
// domain's legend, in the roadmap's order, then each hue steps wear that no kind claims, called by the hue, in the rule
// book's order, each with how many steps wear it. One entry a hue, so at most six: Add Kind takes the first hue no entry
// has, and a hue an entry has cannot be chosen for another.
struct RoadmapLegend {
  // What an entry is: a kind of the roadmap, by its id, or a hue steps wear that no kind names.
  enum Subject: Hashable {
    case kind(String)
    case hue(String)
  }

  struct Entry: Identifiable {
    let hue: String
    let kind: Kind?
    // How many of the roadmap's steps wear the entry's hue.
    let steps: Int

    var id: Subject { kind.map { .kind($0.id) } ?? .hue(hue) }
    // A kind is called by its name, and one with none, like a hue no kind names, by the hue's own.
    var name: String { kind?.label.nilIfEmpty ?? RoadmapModel.Row.hue(hue) ?? hue }
    var description: String { kind?.description ?? "" }
    // Only a kind no step wears can be removed.
    var removable: Bool { kind != nil && steps == 0 }
  }

  // One of the six kinds a step may wear, as the web lists them (`kindChoices`): its hue, the name the roadmap gives it
  // or the hue's own, and its description.
  struct Choice: Identifiable {
    let hue: String
    let name: String
    let description: String

    var id: String { hue }
  }

  let entries: [Entry]

  init(_ tree: RoadmapTree) {
    let legend = LegendRead(tree)
    var worn: [[UInt8]: Int] = [:]
    for step in tree.index.nodes { worn[Array(step.color.utf8), default: 0] += 1 }
    let owners = legend.kinds.filter { (kind: Kind) -> Bool in legend.hues.contains { $0.owner.utf8.elementsEqual(kind.id.utf8) } }
    let named = owners.map { (kind: Kind) -> Entry in Entry(hue: kind.hue, kind: kind, steps: worn[Array(kind.hue.utf8)] ?? 0) }
    let unclaimed = RoadmapRules.hues.filter { (hue: String) -> Bool in !legend.claims(hue) && worn[Array(hue.utf8)] != nil }
    entries = named + unclaimed.map { (hue: String) -> Entry in Entry(hue: hue, kind: nil, steps: worn[Array(hue.utf8)] ?? 0) }
  }

  func entry(_ subject: Subject) -> Entry? {
    switch subject {
    case .kind(let id): entries.first { $0.kind?.id == id }
    // A hue's entry is whatever now has it: the hue alone, or the kind a name made of it.
    case .hue(let hue): entries.first { $0.hue == hue }
    }
  }

  // The entry that has a hue, which a kind's Color list names as the one wearing it.
  func wearer(of hue: String) -> Entry? { entries.first { $0.hue == hue } }

  // The hue Add Kind takes: the first of the rule book's that no entry has; none once all six are had.
  var freeHue: String? { RoadmapRules.hues.first { (hue: String) -> Bool in wearer(of: hue) == nil } }

  // The six kinds a step may wear: the kinds the roadmap names, each the one that owns its hue, in the roadmap's order,
  // then the hues no named kind has, by the hue's own name in the rule book's order.
  var choices: [Choice] {
    let named = entries.filter { $0.kind?.label.isEmpty == false }
    let kinds = named.map { (entry: Entry) -> Choice in Choice(hue: entry.hue, name: entry.name, description: entry.description) }
    let hues = RoadmapRules.hues.filter { (hue: String) -> Bool in !named.contains { $0.hue == hue } }
      .compactMap { (hue: String) -> Choice? in RoadmapModel.Row.hue(hue).map { Choice(hue: hue, name: $0, description: "") } }
    return kinds + hues
  }

  // The kinds the Board's filter offers (`kindOptions`): the entries steps wear, and none where steps wear one hue alone.
  var inUse: [Entry] {
    let worn = entries.filter { $0.steps > 0 }
    return worn.count < 2 ? [] : worn
  }
}
