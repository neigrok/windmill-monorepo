import SwiftUI
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncSchema

// Set Aside (Roadmap on the sync engine §6; Roadmap · iOS 10.5a to 10.5c): the one list of the person's changes the phone
// could not land, a change to a roadmap deleted elsewhere above all, read from roadmap's notices through the domain
// (`CannotLand`). Each change is named and its words kept: a step's, a kind's, a subtask's or a link's name and every word
// written, a note's text under its step's name. A change that holds no word of the person's, a mark, a pointer or a link
// between steps, is not listed, as the web lists none. The list groups the changes by roadmap and reason, the reason said
// once as the group's footer, and each stays on the phone until the person copies it out or discards it.
struct SetAside: Equatable {
  // What a change was made to, by the record type its subject is: the field that names it, and every field the person
  // writes words in, in reading order.
  enum Subject {
    case step, kind, roadmap, subtask, link, note

    static let types: [String: (subject: Subject, name: String?, words: [String])] = [
      RoadmapStep.type: (.step, "label", ["label", "description"]),
      RoadmapKind.type: (.kind, "label", ["label", "description"]),
      RoadmapMeta.type: (.roadmap, "title", ["title", "guide"]),
      Subtask.type: (.subtask, "label", ["label"]),
      WorkspaceLink.type: (.link, "title", ["title", "url"]),
      StepNote.type: (.note, nil, ["text"]),
    ]
  }

  struct Change: Identifiable, Equatable {
    // The engine's notice, which Discard dismisses.
    let id: String
    let roadmap: String
    let reason: CannotLand.Reason
    let title: String
    // What the change did, the row's second line.
    let line: String
    // Every word the person wrote, which Copy takes.
    let text: String
  }

  struct Group: Identifiable, Equatable {
    let roadmap: String
    // The roadmap's name as the room last read it; none for one it never read.
    let name: String?
    let reason: CannotLand.Reason
    var changes: [Change]

    var id: String { roadmap + "\n" + reason.rawValue }
  }

  let groups: [Group]

  init(groups: [Group] = []) {
    self.groups = groups
  }

  // The domain's list in the room's words: each change with words of its own, in the order the engine wrote them, under
  // the roadmap its notice's scope names. A name the change does not write is the one the room last read (`remembered`),
  // and where the room read none, a note goes by its first line.
  init(_ read: CannotLand, scopes: [String: ScopeRef], remembered: [String: RoadmapTree]) {
    var groups: [Group] = []
    for entry in read.listed {
      guard let subject = entry.subject, let roadmap = scopes[entry.id]?.tree, let words = Subject.types[subject.type] else { continue }
      let written = { (field: String) -> String in
        guard case .string(let text)? = entry.values[field] else { return "" }
        return TextSpec.trimmed(text)
      }
      let text = words.words.map(written).filter { !$0.isEmpty }.joined(separator: "\n\n")
      guard !text.isEmpty else { continue }
      let tree = remembered[roadmap]
      let read: String? = switch words.subject {
      case .step, .note: tree?.step(subject.id.description)?.label
      case .kind: tree?.kinds.first { $0.id.utf8.elementsEqual(subject.id.description.utf8) }?.label
      case .roadmap: tree?.meta?.title
      case .subtask, .link: nil
      }
      let title = words.name.map(written)?.nilIfEmpty ?? read?.nilIfEmpty ?? String(text.prefix { !$0.isNewline })
      let change = Change(id: entry.id, roadmap: roadmap, reason: entry.reason, title: title,
                          line: Self.line(words.subject, made: entry.made, guide: !written("guide").isEmpty), text: text)
      if let at = groups.firstIndex(where: { $0.roadmap == roadmap && $0.reason == entry.reason }) {
        groups[at].changes.append(change)
        continue
      }
      groups.append(Group(roadmap: roadmap, name: tree.map { ListedRoadmap.name(of: $0.meta?.title) }, reason: entry.reason, changes: [change]))
    }
    self.groups = groups
  }

  var changes: [Change] { groups.flatMap(\.changes) }

  // The list once these changes have left it.
  func leaving(_ gone: Set<String>) -> SetAside {
    SetAside(groups: groups.compactMap { (group: Group) -> Group? in
      var kept = group
      kept.changes.removeAll { gone.contains($0.id) }
      return kept.changes.isEmpty ? nil : kept
    })
  }

  // A row's second line: what the change made or changed (10.5b draws *New step* and *Note edited*).
  static func line(_ subject: Subject, made: Bool, guide: Bool) -> String {
    switch subject {
    case .step: made ? String(localized: "New step") : String(localized: "Step edited")
    case .kind: made ? String(localized: "New kind") : String(localized: "Kind edited")
    case .roadmap: guide ? String(localized: "Guide edited") : String(localized: "Roadmap renamed")
    case .subtask: made ? String(localized: "New subtask") : String(localized: "Subtask edited")
    case .link: made ? String(localized: "New link") : String(localized: "Link edited")
    case .note: String(localized: "Note edited")
    }
  }
}

extension CannotLand.Reason {
  // Why a group could not land, its footer (10.5b).
  var words: String {
    switch self {
    case .roadmapDeleted: String(localized: "The roadmap was deleted elsewhere.")
    case .capFilled: String(localized: "The roadmap reached its limit.")
    case .accessEnded: String(localized: "Editing access ended.")
    case .noteTooLong: String(localized: "The combined note is too long.")
    }
  }
}

extension RoadmapModel {
  // Where the phone keeps the ids of the notices it has told, never what they hold.
  static let toldNotices = "roadmapToldNotices"

  // Roadmap's notices read anew, after each change the room observes: the list as Set Aside shows it, which closes once
  // it holds nothing. A read that fails keeps the list as it stands and reports once a launch.
  func readSetAside() {
    let notices: [Notice]
    do { notices = try sync.notices() } catch {
      guard reportedFailures.insert("kept-read").inserted else { return }
      telemetry.failure("roadmap_kept", kind: "unexpected")
      return
    }
    let read = CannotLand(notices.map { DomainNotice<RoadmapRefusal>($0, registry: SyncSchema.registry) })
    // Each change that cannot land is told once on this phone, and a notice no rule lists reports once a launch, by its
    // code, `other` where the code is not one a refusal is spelled as. The phone keeps the ids of the notices the engine
    // still holds that it has told.
    let told = Set(phone.stringArray(forKey: Self.toldNotices) ?? [])
    for entry in read.listed where !told.contains(entry.id) {
      telemetry.event("roadmap_write_cannot_land", properties: ["reason": entry.reason.rawValue])
    }
    for notice in read.unexpected where !told.contains(notice.id) {
      let spelled = notice.code.text.wholeMatch(of: /[a-z][a-z0-9-]{0,63}/) != nil
      let code = spelled ? notice.code.text : "other"
      guard reportedFailures.insert("kept-\(code)").inserted else { continue }
      telemetry.failure("roadmap_kept", kind: "unexpected", properties: ["code": code])
    }
    let held = notices.map(\.id).sorted()
    if held != told.sorted() { phone.set(held, forKey: Self.toldNotices) }
    let listed = SetAside(read, scopes: Dictionary(notices.map { ($0.id, $0.scope) }) { first, _ in first }, remembered: remembered)
    if listed != setAside { setAside = listed }
    if listed.groups.isEmpty && setAsideOpen { setAsideOpen = false }
  }

  // 10.5a: the title menu's first row while a change is set aside opens the list.
  func openSetAside() {
    setAsideOpen = true
    telemetry.event("roadmap_kept", properties: ["step": "open", "count": Self.bucket(setAside.changes.count)])
  }

  // 10.5c: Copy, in a change's … menu or its swipe, puts every word the person wrote on the pasteboard.
  func copy(_ change: SetAside.Change, by door: Door) {
    clipboard.copy(change.text)
    telemetry.event("roadmap_kept", properties: ["step": "copy", "reason": change.reason.rawValue, "outcome": "copied", "door": door.rawValue])
  }

  // 10.5c: Discard, in a change's … menu or its swipe, asks nothing: the change leaves the phone.
  func discard(_ change: SetAside.Change, by door: Door) {
    guard dismiss([change]) else { return }
    telemetry.event("roadmap_kept", properties: ["step": "discard", "reason": change.reason.rawValue, "door": door.rawValue])
  }

  // 10.5b: Discard All asks once, on its row.
  func askDiscardAll() {
    asksDiscardAll = true
    telemetry.event("roadmap_kept", properties: ["step": "ask", "count": Self.bucket(setAside.changes.count)])
  }

  // The question's answer: Discard All takes every change listed from the phone; closed any other way, nothing goes.
  func answerDiscardAll(_ confirmed: Bool) {
    guard asksDiscardAll else { return }
    asksDiscardAll = false
    let changes = setAside.changes
    guard confirmed else { return telemetry.event("roadmap_kept", properties: ["step": "cancel"]) }
    guard dismiss(changes) else { return }
    telemetry.event("roadmap_kept", properties: ["step": "discardAll", "count": Self.bucket(changes.count)])
  }

  // The engine lets go of the changes' notices, and the list of them at once; it closes once it holds nothing. A dismissal
  // that fails keeps the list as it stands and reports.
  func dismiss(_ changes: [SetAside.Change]) -> Bool {
    do {
      for change in changes { _ = try sync.dismiss(change.id) }
    } catch {
      report(error, write: "dismissNotice")
      return false
    }
    setAside = setAside.leaving(Set(changes.map(\.id)))
    if setAside.groups.isEmpty { setAsideOpen = false }
    return true
  }
}

// Set Aside (10.5b, 10.5c): a large sheet over the room, the changes grouped by roadmap under its name with the reason as
// the group's footer. Each row's … menu, and its trailing swipe, offer Copy and Discard; Discard All, alone in its group,
// asks on itself. The sheet closes once the list holds nothing.
struct SetAsideSheet: View {
  let roadmap: RoadmapModel

  var body: some View {
    NavigationStack {
      List {
        ForEach(roadmap.setAside.groups) { group in
          Section {
            ForEach(group.changes) { change in row(change) }
          } header: {
            if let name = group.name { Text(name).font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil) }
          } footer: {
            Text(group.reason.words).foregroundStyle(RoadmapPalette.inkDim)
          }.listRowBackground(RoadmapPalette.card)
        }
        Section {
          Button("Discard All", role: .destructive) { roadmap.askDiscardAll() }.accessibilityIdentifier("roadmap-set-aside-discard-all")
            .confirmationDialog(String(localized: "Discard \(roadmap.setAside.changes.count) changes?", locale: .copy,
                                       comment: "The question Discard All asks in Set Aside: how many changes it discards"),
                                isPresented: Binding(get: { roadmap.asksDiscardAll }, set: { if !$0 { roadmap.answerDiscardAll(false) } }),
                                titleVisibility: .visible) {
              Button("Discard All", role: .destructive) { roadmap.answerDiscardAll(true) }
            } message: {
              Text("They’re removed from this iPhone.")
            }
        }.listRowBackground(RoadmapPalette.card)
      }.listStyle(.insetGrouped).scrollContentBackground(.hidden)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("Set Aside").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { close } }.roomBar(.roadmap)
    }.tint(RoadmapPalette.accent).presentationDetents([.large])
  }

  // The sheet's close, the system's on iOS 26.
  @ViewBuilder var close: some View {
    if #available(iOS 26.0, *) {
      Button(role: .close) { roadmap.setAsideOpen = false }.accessibilityIdentifier("roadmap-set-aside-close")
    } else {
      Button("Done") { roadmap.setAsideOpen = false }.accessibilityIdentifier("roadmap-set-aside-close")
    }
  }

  func row(_ change: SetAside.Change) -> some View {
    HStack(spacing: RoomSpace.related) {
      VStack(alignment: .leading, spacing: 2) {
        Text(change.title).foregroundStyle(RoadmapPalette.ink)
        Text(change.line).font(.subheadline).foregroundStyle(RoadmapPalette.inkDim)
      }.frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-set-aside-row")
      Menu {
        Button("Copy", systemImage: "doc.on.clipboard") { roadmap.copy(change, by: .menu) }
        Button("Discard", systemImage: "trash", role: .destructive) { roadmap.discard(change, by: .menu) }
      } label: {
        Image(systemName: "ellipsis").foregroundStyle(RoadmapPalette.accent)
          .frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
      }.accessibilityLabel(Text("More")).accessibilityIdentifier("roadmap-set-aside-more")
    }.swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button("Discard", systemImage: "trash", role: .destructive) { roadmap.discard(change, by: .swipe) }.tint(nil)
      Button("Copy", systemImage: "doc.on.clipboard") { roadmap.copy(change, by: .swipe) }.tint(RoadmapPalette.accent)
    }
  }
}
