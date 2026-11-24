import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncCore

// The Guide sheet (Roadmap · iOS 08.1 to 08.5): the open roadmap's guide, read with the guides of the roadmaps above it,
// which the domain reads from the phone's copy, and written in the same sheet from one draft. The draft is saved once,
// by the domain's `WriteRoadmap` through the room's write door, and the band then holds its Undo. Saving a blank draft
// removes the guide.
@Observable @MainActor
final class GuideSheet: Identifiable {
  // The gesture that started a draft, as its event names it: the bar's Edit, or Add Guide on a roadmap with none.
  enum Via: String {
    case edit, add
  }

  unowned let room: RoadmapModel
  // The roadmap whose guide the sheet shows.
  let tree: DomainKit.ID<RoadmapEntry>
  // The draft while the sheet writes; none while it reads.
  private(set) var draft: GuideDraft?
  // The guide this sheet has just written, which it reads until the phone's copy is read again and holds it (the note's
  // screen keeps what it opened on the same way while it leaves).
  private var lastWrite: String?
  // Discard draft? stands over Cancel.
  var asksDiscard = false

  init(of tree: DomainKit.ID<RoadmapEntry>, room: RoadmapModel) {
    self.room = room
    self.tree = tree
  }

  // The roadmap, while the room has it open.
  var open: RoadmapModel.OpenRoadmap? {
    guard let shown = room.shown, shown.id == tree else { return nil }
    return shown
  }

  // The roadmap's own guide, as the phone's copy holds it or as this sheet has just written it.
  var text: String { lastWrite ?? open?.tree.meta?.guide ?? "" }

  // A guide of blanks alone is no guide.
  var written: Bool { !TextSpec.isBlank(text) }

  var above: [Guide] { open?.guidesAbove ?? [] }

  // Edit, or Add Guide: the sheet writes, from the guide as it stands.
  func edit(via gesture: Via) {
    guard open != nil, draft == nil else { return }
    draft = GuideDraft(text)
    room.telemetry.event("roadmap_guide", properties: ["step": "edit", "via": gesture.rawValue])
  }

  // What is typed, all of it: a draft that goes past the limit is refused there, as the footer then says, and told once
  // each time it goes over.
  func type(_ typed: String) {
    guard var draft, draft.text != typed else { return }
    let fitted = draft.fits
    draft.text = typed
    self.draft = draft
    if fitted && !draft.fits { room.telemetry.event("roadmap_guide", properties: ["step": "tooLong"]) }
  }

  // Save, offered on a changed draft that fits: the draft's one write. Written, the sheet reads what it wrote and the
  // band holds its Undo, and a draft begun from a guide another device has since replaced is told as a conflict, as the
  // web tells it; refused or failed, the draft stays as it was typed, told by why.
  func save() {
    guard let draft, draft.changed, draft.fits, open != nil else { return }
    let replaced = draft.base != text
    switch room.write(WriteRoadmap(tree: tree, guide: draft.saved), as: "guide") {
    case .committed(_, let receipt):
      (self.draft, lastWrite) = (nil, draft.saved)
      let cleared = draft.saved.isEmpty
      room.telemetry.event("roadmap_guide", properties: ["step": "save", "outcome": cleared ? "cleared" : "saved", "length": draft.lengthBucket])
      if replaced { room.telemetry.event("roadmap_guide", properties: ["step": "conflict"]) }
      room.show(RoadmapModel.Band(.savedGuide(cleared: cleared), of: receipt, act: .step("guide")))
    case .unchanged: self.draft = nil
    case .refused:
      room.telemetry.event("roadmap_guide", properties: ["step": "save", "outcome": "failed", "length": draft.lengthBucket, "reason": "refused"])
    case .failed:
      room.telemetry.event("roadmap_guide", properties: ["step": "save", "outcome": "failed", "length": draft.lengthBucket, "reason": "device"])
    }
  }

  // Cancel: a changed draft asks once, and an unchanged one goes with nothing written.
  func cancel() {
    guard let draft else { return }
    guard !draft.changed else {
      asksDiscard = true
      return
    }
    self.draft = nil
    room.telemetry.event("roadmap_guide", properties: ["step": "cancel"])
  }

  // Discard, the question's one answer: the draft goes with nothing written.
  func discard() {
    draft = nil
    room.telemetry.event("roadmap_guide", properties: ["step": "discard"])
  }

  // The phone's copy read the guide anew, a guide this sheet wrote included. A draft holding no change starts again from
  // it, so the field shows what another device wrote; one that holds a change keeps the person's words, which its save
  // writes over the guide.
  func follow() {
    lastWrite = nil
    guard let draft, !draft.changed, draft.base != text else { return }
    self.draft = GuideDraft(text)
  }

  // The title menu's item: the guide, and how many guides of the roadmaps above it apply here too.
  static func menuTitle(above: Int) -> String {
    guard above > 0 else { return String(localized: "Guide", comment: "The title menu's item that opens the roadmap's guide") }
    return String(localized: "Guide · +\(above) from above", locale: .copy,
                  comment: "The title menu's item that opens the roadmap's guide: how many guides of the roadmaps above it apply too")
  }
}

// A guide as its editor writes it (08.3, 08.4): the text typed over the guide it started from, every character kept but
// a NUL, which a guide cannot hold and which draws nothing (the web's `heldText` drops it too), counted as the domain
// counts a guide. The counter shows from 4,500 of the domain's 5,000 characters; past them it counts the excess, and
// nothing is written until the text fits. Blanks against no guide are no change, and a blank draft saves no guide.
struct GuideDraft: Equatable {
  static let countedFrom = 4_500

  let base: String
  var text: String {
    didSet {
      guard text.unicodeScalars.contains("\u{0}") else { return }
      text = String(String.UnicodeScalarView(text.unicodeScalars.filter { $0 != "\u{0}" }))
    }
  }

  init(_ base: String) {
    self.base = base
    text = base
  }

  var length: Int { RoadmapSpecs.guide.measure(text) }
  var fits: Bool { length <= RoadmapSpecs.guide.max }
  var changed: Bool { text != base && (!TextSpec.isBlank(text) || !TextSpec.isBlank(base)) }
  var saved: String { TextSpec.isBlank(text) ? "" : text }

  // What the footer counts, from 4,500 characters: what the guide may still hold, or how far past its limit the draft is.
  var count: String? {
    guard length >= Self.countedFrom else { return nil }
    let limit = RoadmapSpecs.guide.max
    if fits {
      return String(localized: "\(limit - length) left", locale: .copy, comment: "The guide's counter from 4,500 characters: how many more it may hold")
    }
    return String(localized: "\(length - limit) over", locale: .copy, comment: "The guide's counter past its 5,000 characters: how many too many")
  }

  // The saved guide's length as an event carries it, in the web's buckets (`guideLengthBucket`).
  var lengthBucket: String {
    let saved = TextSpec.isBlank(text) ? 0 : length
    if saved < 1 { return "0" }
    if saved <= 500 { return "1-500" }
    if saved <= 2_000 { return "501-2000" }
    return saved <= Self.countedFrom ? "2001-4500" : "4501-5000"
  }
}

extension RoadmapModel {
  // Guide, in the title menu: the sheet reads the open roadmap's guide, told with the view it rose over and whether guides
  // of the roadmaps above apply here too.
  func openGuide() {
    guard let shown else { return }
    guide = GuideSheet(of: shown.id, room: self)
    telemetry.event("roadmap_guide", properties: ["step": "open", "door": "menu", "view": view(of: shown).rawValue,
                                                  "above": shown.guidesAbove.isEmpty ? "none" : "some"])
  }

  // The close button, or the sheet sent away, which an unchanged draft lets it be: the draft goes with nothing written.
  func closeGuide() {
    guide?.cancel()
    guide = nil
  }
}

extension RoadmapModel.OpenRoadmap {
  // The guides of the roadmaps above this one, nearest first, so the guide the person writes stands first (08.5), and
  // equals in id byte order, as the domain orders them.
  var guidesAbove: [Guide] {
    guides.filter { $0.distance > 0 }.sorted { a, b in
      a.distance != b.distance ? a.distance < b.distance : a.tree.utf8.lexicographicallyPrecedes(b.tree.utf8)
    }
  }
}
