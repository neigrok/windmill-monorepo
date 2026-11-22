import Foundation
import DomainKit
import RoadmapDomain
import SyncCore

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

// The Kinds sheet's acts (Roadmap · iOS 06.1 to 06.6), each one act of the domain through the room's write door, applied
// as it is made. Add, a name, a description and a colour keep no Undo, as the web's legend keeps none; a kind removed
// says so in the band with Undo for six seconds, since the engine does not hold a kind's removal. Each is told as the
// web tells a legend's edit, and refused or failed it changes nothing the sheet shows.
extension RoadmapModel {
  // Where the Kinds sheet was raised: the title menu over the Board, or Edit Kinds in the step form's Kind list.
  enum KindsDoor: String {
    case menu, form
  }

  func openKinds(from door: KindsDoor) {
    guard shown != nil else { return }
    kindsDoor = door
    telemetry.event("roadmap_kinds", properties: ["step": "open", "door": door.rawValue])
  }

  // The close button, or the sheet sent away.
  func closeKinds() {
    guard kindsDoor != nil else { return }
    kindsDoor = nil
    telemetry.event("roadmap_kinds", properties: ["step": "close"])
  }

  // A kind's page pushed inside the sheet.
  func kindOpened() {
    telemetry.event("roadmap_kinds", properties: ["step": "kind"])
  }

  // Add Kind: a kind at once, unnamed, on the first hue no entry has. It answers the kind, whose page opens.
  func addKind() -> RoadmapLegend.Subject? {
    guard let shown, let hue = shown.legend.freeHue,
          let written = write(CreateKind(tree: shown.id, kind: NewKind(hue: hue)), as: "AddKind").committed else { return nil }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "add"])
    return .kind(written.result.description)
  }

  // A name or a description as far as the domain takes it, written as the field leaves it. A hue no kind names becomes a
  // kind wearing it, with what was typed. It answers the entry the words now stand on.
  func name(_ entry: RoadmapLegend.Entry, _ typed: String) -> RoadmapLegend.Subject {
    word(entry, label: RoadmapSpecs.kindLabel.holding(typed), told: "rename")
  }

  func describe(_ entry: RoadmapLegend.Entry, _ typed: String) -> RoadmapLegend.Subject {
    word(entry, description: RoadmapSpecs.kindDescription.holding(typed), told: "describe")
  }

  // Words that change nothing write nothing.
  func word(_ entry: RoadmapLegend.Entry, label: String? = nil, description: String? = nil, told edit: String) -> RoadmapLegend.Subject {
    guard let shown, label.map({ $0 != entry.kind?.label ?? "" }) ?? true, description.map({ $0 != entry.description }) ?? true else { return entry.id }
    let name = edit == "rename" ? "RenameKind" : "DescribeKind"
    guard let kind = entry.kind else {
      let made = NewKind(hue: entry.hue, label: label ?? "", description: description ?? "")
      guard let written = write(CreateKind(tree: shown.id, kind: made), as: name).committed else { return entry.id }
      forget(written.receipt.gestureId)
      telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": edit])
      return .kind(written.result.description)
    }
    guard let written = write(ChangeKind(tree: shown.id, kind: ID(RecordID(kind.id)), label: label, description: description), as: name).committed else {
      return entry.id
    }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": edit])
    return entry.id
  }

  // A hue no entry has, chosen in a kind's Color list: the kind takes it and every step that wore the kind's hue with it,
  // the domain's `RecolourKind`; a hue no kind names moves its steps to the new hue in one gesture. Nothing says so in the
  // band: the steps' colour is the receipt (06.6). It answers the entry the colour now stands on.
  func recolour(_ entry: RoadmapLegend.Entry, to hue: String) -> RoadmapLegend.Subject {
    guard let shown, hue != entry.hue, shown.legend.wearer(of: hue) == nil else { return entry.id }
    if let kind = entry.kind {
      guard let written = write(RecolourKind(tree: shown.id, kind: ID(RecordID(kind.id)), hue: hue), as: "RecolorKind").committed else { return entry.id }
      forget(written.receipt.gestureId)
      telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "recolor"])
      return entry.id
    }
    let wearers = shown.tree.index.nodes.filter { $0.color.utf8.elementsEqual(entry.hue.utf8) }
    let acts = wearers.map { (step: RoadmapDomain.Step) -> AnyActAction<RoadmapRefusal> in
      AnyActAction(ChangeStep(tree: shown.id, step: ID(RecordID(step.id)), changes: RoadmapStep.Changes(color: hue)))
    }
    guard let written = write(acts, as: "RecolorKind").committed else { return entry.id }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "recolor"])
    return .hue(hue)
  }

  // Delete in the sheet's edit mode, or a row's swipe: a kind no step wears goes at once, with no question, and the band
  // at the sheet's foot holds Undo for six seconds (06.5b).
  func remove(_ entry: RoadmapLegend.Entry) {
    guard let shown, let kind = entry.kind, entry.removable,
          let written = write(DeleteKind(tree: shown.id, kind: ID(RecordID(kind.id))), as: "RemoveKind").committed else { return }
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "remove"])
    show(Band(.removedKind(entry.name), of: written.receipt, act: .step("removeKind")))
  }
}
