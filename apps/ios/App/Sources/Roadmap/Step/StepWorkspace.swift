import Foundation
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore

// A step's private workspace as its page reads it (Roadmap · iOS 03.2, 03.3, 03.5): the person's subtasks and links of
// the step, each in the order of their overlay's list, and their note. It is read from the person's overlay of the
// roadmap on the phone's copy, as the web's room reads one (`HeldRoadmap.workspace`). What a subtask, a link and a note
// may hold is the domain's.
struct StepWorkspace {
  // A link the person keeps beside the step, with the address its row opens.
  struct Link: Identifiable {
    let link: WorkspaceLink
    let address: LinkAddress

    var id: ID<WorkspaceLink> { link.id }
    // The title the person gave it, or its host where they gave none (the web's `title || domain`).
    var title: String { link.title.nilIfEmpty ?? address.host ?? link.url }
  }

  var subtasks: [Subtask] = []
  // The links whose address the page opens: the web's page lists no other (`SAFE_URL`).
  var links: [Link] = []
  // The note the overlay draws: one that holds no text is not drawn.
  var note: StepNote?

  var done: Int { subtasks.count { $0.done } }
  // Every subtask is checked, which the list says under itself and which never completes the step.
  var allDone: Bool { !subtasks.isEmpty && done == subtasks.count }

  // Every step's workspace that one overlay holds, by its step.
  static func read(_ overlay: [Record]) throws(DecodeError) -> [ID<RoadmapStep>: StepWorkspace] {
    let records = { (type: String) -> [Record] in overlay.filter { $0.type.utf8.elementsEqual(type.utf8) } }
    var workspaces: [ID<RoadmapStep>: StepWorkspace] = [:]
    for subtask in try Repository<Subtask>.decode(records(Subtask.type)) {
      workspaces[subtask.step, default: StepWorkspace()].subtasks.append(subtask)
    }
    for link in try Repository<WorkspaceLink>.decode(records(WorkspaceLink.type)) {
      guard let address = LinkAddress(link.url) else { continue }
      workspaces[link.step, default: StepWorkspace()].links.append(Link(link: link, address: address))
    }
    for note in try Repository<StepNote>.decode(records(StepNote.type)) {
      workspaces[ID(note.id.record), default: StepWorkspace()].note = note
    }
    return workspaces
  }
}

// A link's address as the web's room reads one. A page opens an address that is http, https or mailto (`SAFE_URL`). An
// address a person types takes https where it names no scheme, and is a link once it is then a web address with a host
// (`workspaceLink`, and its link form's `valid`).
struct LinkAddress: Equatable {
  let url: URL

  // The address a link holds; none where no page opens it.
  init?(_ held: String) {
    guard let url = URL(string: held), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return nil }
    self.url = url
  }

  // An address as a person typed it; none until the phone can open it.
  init?(typed: String) {
    let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let schemed = trimmed.range(of: "^[a-z][a-z0-9+.-]*://", options: [.regularExpression, .caseInsensitive]) != nil
    guard !trimmed.isEmpty, let url = URL(string: schemed ? trimmed : "https://" + trimmed),
          ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host(), !host.isEmpty, !host.contains("%") else { return nil }
    self.url = url
  }

  // The host a link's row says under its title, without a leading www. (the web's `domain`); none for a mail address.
  var host: String? {
    guard let host = url.host(), !host.isEmpty else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }
}

// The workspace's acts, each one act of the domain in the person's overlay, through the room's write door. The band
// offers an Undo where the web's page does, on a subtask checked, and for the engine's hold of a removal; of every other
// act the engine keeps none, as the web's room keeps none (`ReplicaWorkspace`). An act is told as the web tells it.
extension RoadmapModel {
  // Return in Add Subtask adds the words typed, without the blanks around them, at the bottom of the step's list, and
  // answers whether they were taken: blanks alone add nothing.
  func addSubtask(_ typed: String, to step: String) -> Bool {
    let label = Self.name(typed: typed)
    guard let shown, !label.isEmpty else { return false }
    let add = AddSubtask(tree: shown.id, step: ID(RecordID(step)), item: Subtask.Changes(label: label))
    guard let written = write(add, as: "workspace").committed else { return false }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_workspace", properties: ["action": "subtaskAdd"])
    return true
  }

  // A tap on a subtask checks it or unchecks it in place. Checked, the band says so and holds Undo for six seconds, as
  // the web's page does; unchecked, the band that said it was checked leaves.
  func toggle(_ subtask: Subtask) {
    guard let shown else { return }
    let change = ChangeSubtask(tree: shown.id, id: subtask.id, changes: Subtask.Changes(done: !subtask.done))
    guard let written = write(change, as: "workspace").committed else { return }
    telemetry.event("roadmap_board_workspace", properties: ["action": "subtaskToggle"])
    guard subtask.done else {
      show(Band(.checked(subtask.id, label: subtask.label), of: written.receipt, act: .workspace("subtaskToggle")))
      return
    }
    forget(written.receipt.gestureId)
    if case .checked(subtask.id, _) = band?.says { endBand() }
  }

  // A subtask's swipe: it goes, held by the engine, and the band keeps Undo for the hold.
  func remove(_ subtask: Subtask) {
    guard let shown, let written = write(DeleteSubtask(tree: shown.id, id: subtask.id), as: "workspace").committed else { return }
    telemetry.event("roadmap_board_workspace", properties: ["action": "subtaskDelete"])
    show(Band(.deletedFromWorkspace(subtask.label), of: written.receipt, act: .workspace("subtaskDelete")))
  }

  // Add Link raised the form, and the form left with no link added.
  func linkFormOpened() {
    telemetry.event("roadmap_board_workspace", properties: ["action": "linkOpen"])
  }

  func linkFormCancelled() {
    telemetry.event("roadmap_board_workspace", properties: ["action": "linkCancel"])
  }

  // Add, in the link form: the address with its title, without the blanks around it, at the bottom of the step's links.
  // It answers whether the link was added, which closes the form.
  func addLink(_ address: LinkAddress, titled typed: String, to step: String) -> Bool {
    guard let shown else { return false }
    let link = WorkspaceLink.Changes(url: address.url.absoluteString, title: Self.name(typed: typed))
    guard let written = write(AddStepLink(tree: shown.id, step: ID(RecordID(step)), item: link), as: "workspace").committed else { return false }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_board_workspace", properties: ["action": "linkAdd"])
    return true
  }

  // A link's swipe: it goes, held by the engine, and the band keeps Undo for the hold.
  func remove(_ link: StepWorkspace.Link) {
    guard let shown, let written = write(DeleteStepLink(tree: shown.id, id: link.id), as: "workspace").committed else { return }
    telemetry.event("roadmap_board_workspace", properties: ["action": "linkDelete"])
    show(Band(.deletedFromWorkspace(link.title), of: written.receipt, act: .workspace("linkDelete")))
  }
}
