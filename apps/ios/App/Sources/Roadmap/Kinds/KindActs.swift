import Foundation
import DomainKit
import RoadmapDomain
import SyncCore

// The Kinds sheet's acts (Roadmap · iOS 06.1 to 06.6), each one act of the domain through the room's write door, applied
// as it is made. Each acts on an entry by its subject, as the open roadmap's legend holds it when the act is made, so an
// act from a screen drawn a moment before reads what stands now: a kind a step has come to wear is not removed, as the
// web's legend reads its live steps against a stale click. Add, a name, a description and a colour keep no Undo, as the
// web's legend keeps none; a kind removed says so in the band with Undo for six seconds, since the engine does not hold a
// kind's removal. Each is told as the web tells a legend's edit, and refused or failed it changes nothing the sheet shows.
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

  // Add Kind: a kind at once, unnamed, on the first hue no entry has. The band standing over the sheet goes first with its
  // Undo, so a kind removed a moment before cannot come back onto the hue this one takes. It answers the kind, whose page
  // opens.
  func addKind() -> RoadmapLegend.Subject? {
    guard let shown, let hue = shown.legend.freeHue else { return nil }
    endBand()
    guard let written = write(CreateKind(tree: shown.id, kind: NewKind(hue: hue)), as: "AddKind").committed else { return nil }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "add"])
    return .kind(written.result.description)
  }

  // A name or a description as far as the domain takes it, written as the field leaves it. A hue no kind names becomes a
  // kind wearing it, with what was typed. It answers the subject the words now stand on.
  func name(_ subject: RoadmapLegend.Subject, _ typed: String) -> RoadmapLegend.Subject {
    word(subject, label: RoadmapSpecs.kindLabel.holding(typed), told: "rename")
  }

  func describe(_ subject: RoadmapLegend.Subject, _ typed: String) -> RoadmapLegend.Subject {
    word(subject, description: RoadmapSpecs.kindDescription.holding(typed), told: "describe")
  }

  // Words that change nothing write nothing.
  func word(_ subject: RoadmapLegend.Subject, label: String? = nil, description: String? = nil, told edit: String) -> RoadmapLegend.Subject {
    guard let shown, let entry = shown.legend.entry(subject), label.map({ $0 != entry.kind?.label ?? "" }) ?? true,
          description.map({ $0 != entry.description }) ?? true else { return subject }
    let name = edit == "rename" ? "RenameKind" : "DescribeKind"
    guard let kind = entry.kind else {
      let made = NewKind(hue: entry.hue, label: label ?? "", description: description ?? "")
      guard let written = write(CreateKind(tree: shown.id, kind: made), as: name).committed else { return subject }
      forget(written.receipt.gestureId)
      telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": edit])
      return .kind(written.result.description)
    }
    guard let written = write(ChangeKind(tree: shown.id, kind: ID(RecordID(kind.id)), label: label, description: description), as: name).committed else {
      return subject
    }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": edit])
    return subject
  }

  // A hue no entry has, chosen in a kind's Color list: the kind takes it and every step that wore the kind's hue with it,
  // the domain's `RecolourKind`; a hue no kind names moves its steps to the new hue in one gesture. Nothing says so in the
  // band: the steps' colour is the receipt (06.6). It answers the subject the colour now stands on.
  func recolour(_ subject: RoadmapLegend.Subject, to hue: String) -> RoadmapLegend.Subject {
    guard let shown, let entry = shown.legend.entry(subject), hue != entry.hue, shown.legend.wearer(of: hue) == nil else { return subject }
    if let kind = entry.kind {
      guard let written = write(RecolourKind(tree: shown.id, kind: ID(RecordID(kind.id)), hue: hue), as: "RecolorKind").committed else { return subject }
      forget(written.receipt.gestureId)
      telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "recolor"])
      return subject
    }
    let wearers = shown.tree.index.nodes.filter { $0.color.utf8.elementsEqual(entry.hue.utf8) }
    let acts = wearers.map { (step: RoadmapDomain.Step) -> AnyActAction<RoadmapRefusal> in
      AnyActAction(ChangeStep(tree: shown.id, step: ID(RecordID(step.id)), changes: RoadmapStep.Changes(color: hue)))
    }
    guard let written = write(acts, as: "RecolorKind").committed else { return subject }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "recolor"])
    return .hue(hue)
  }

  // Delete in the sheet's edit mode, or a row's swipe: a kind no step wears goes at once, with no question, and the band
  // at the sheet's foot holds Undo for six seconds (06.5b). It answers whether the kind went; only then does the sheet let
  // its row go.
  @discardableResult
  func remove(_ subject: RoadmapLegend.Subject) -> Bool {
    guard let shown, let entry = shown.legend.entry(subject), let kind = entry.kind, entry.removable,
          let written = write(DeleteKind(tree: shown.id, kind: ID(RecordID(kind.id))), as: "RemoveKind").committed else { return false }
    removedKinds[subject] = written.receipt.gestureId
    telemetry.event("roadmap_board_edit", properties: ["step": "saved", "legend": "remove"])
    show(Band(.removedKind(entry.name), of: written.receipt, act: .step("removeKind")))
    return true
  }
}
