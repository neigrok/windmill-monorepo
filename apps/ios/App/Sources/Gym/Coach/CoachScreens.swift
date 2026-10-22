import SwiftUI
import GymDomain
import DomainKit
import SyncEngine

// The shell can supply its existing You sheet without giving a product ownership of account UI.
private struct CoachAccountDoor: EnvironmentKey { static let defaultValue: (@MainActor () -> Void)? = nil }
private struct CoachKeepDoor: EnvironmentKey { static let defaultValue: (@MainActor () -> Void)? = nil }
private struct CoachRoutineDoor: EnvironmentKey { static let defaultValue: (@MainActor (String) -> Void)? = nil }
private struct CoachSessionDoor: EnvironmentKey { static let defaultValue: (@MainActor (String) -> Void)? = nil }
private struct CoachAskDoor: EnvironmentKey { static let defaultValue: (@MainActor (CoachHandoff) -> Void)? = nil }
extension EnvironmentValues {
  var coachKeepRoutines: (@MainActor () -> Void)? {
    get { self[CoachKeepDoor.self] }
    set { self[CoachKeepDoor.self] = newValue }
  }
  var coachOpenAccount: (@MainActor () -> Void)? {
    get { self[CoachAccountDoor.self] }
    set { self[CoachAccountDoor.self] = newValue }
  }
  var coachOpenRoutine: (@MainActor (String) -> Void)? {
    get { self[CoachRoutineDoor.self] }
    set { self[CoachRoutineDoor.self] = newValue }
  }
  var coachOpenSession: (@MainActor (String) -> Void)? {
    get { self[CoachSessionDoor.self] }
    set { self[CoachSessionDoor.self] = newValue }
  }
  // Opens Coach on a new chat with the question in the composer, sent or left for the lifter to send.
  var coachAsk: (@MainActor (CoachHandoff) -> Void)? {
    get { self[CoachAskDoor.self] }
    set { self[CoachAskDoor.self] = newValue }
  }
}

extension GymModel {
  var coachNoteCount: Int { personalCounts[Note.type] ?? notes.count }
  var coachAccountAvailable: Bool { !isAnonymous && account != nil && !accountTransition }
  func coachMoveNote(_ note: Note, to index: Int) -> Bool {
    guard coachAccountAvailable, let current = notes.firstIndex(where: { $0.id == note.id }) else { return false }
    var order = notes; order.remove(at: current); order.insert(note, at: min(max(0, index), order.count))
    let at = order.firstIndex { $0.id == note.id }!
    return run(MoveNote(note.id, below: at == 0 ? nil : order[at - 1].id))?.refusal == nil && error == nil
  }
}

// A room or screen that cannot open: its symbol and sentence, untitled since the bar names it, and Sign in when it can.
struct CoachUnavailable: View {
  let symbol: String
  let sentence: String
  var signIn: (@MainActor () -> Void)?
  var body: some View {
    ContentUnavailableView {
      Label { EmptyView() } icon: { Image(systemName: symbol) }
    } description: { Text(sentence) } actions: {
      if let signIn { Button("Sign in", action: signIn).modifier(RoomSecondaryStyle()).controlSize(.large).accessibilityIdentifier("coach-sign-in") }
    }.accessibilityElement(children: .contain)
  }
}

// A note reads and edits as one text, taken as the domain stores it: composed and trimmed, so blank lines before the first
// words fall away. A first line of up to 60 characters is the title and the rest the body. A longer first line keeps the
// whole text in the body under a title cut from that line: at its last space within 60 characters, or at 59 when no space
// falls there, then "…". The text reads back as the body whenever the title is that cut of the body's first line, so
// nothing the lifter did not type appears.
extension Note {
  var text: String {
    get {
      if let firstLine = body.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first,
         Note.title(cutting: firstLine) == title { return body }
      return body.isEmpty ? title : title + "\n" + body
    }
    set {
      let text = NoteRules.body.normalised(newValue)
      let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
      let firstLine = lines.first ?? ""
      if let cut = Note.title(cutting: firstLine) { title = cut; body = text; return }
      title = String(firstLine); body = lines.count > 1 ? String(lines[1]) : ""
    }
  }

  static func title(cutting line: Substring) -> String? {
    let scalars = Array(line.trimmingCharacters(in: .whitespaces).unicodeScalars)
    guard scalars.count > 60 else { return nil }
    let space = scalars.prefix(60).lastIndex(of: " ").flatMap { $0 > 0 ? $0 : nil }
    var cut = String.UnicodeScalarView(); cut.append(contentsOf: scalars.prefix(space ?? 59))
    return String(cut).trimmingCharacters(in: .whitespaces) + "…"
  }
}

struct NotesScreen: View {
  let gym: GymModel
  @State var editor: NoteEditorIdentity?
  @State var ordered = false
  @Environment(\.coachOpenAccount) var openAccount
  var body: some View {
    Group {
      if gym.coachAccountAvailable { notes }
      else { CoachUnavailable(symbol: "note.text", sentence: "Notes live with your account, so they need you signed in.", signIn: openAccount) }
    }.navigationTitle("Notes").modifier(GymPage()).accessibilityIdentifier("gym-notes")
      .gymTabBar()
      .toolbar { if gym.coachAccountAvailable, !gym.notes.isEmpty { EditButton().tint(GymPalette.ink) } }
      .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-coach-error") }
      .sheet(item: $editor) { identity in NoteEditor(gym: gym, identity: identity) }
      .sensoryFeedback(.selection, trigger: ordered)
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "notes"]) }
  }
  var notes: some View {
    List {
      Section {
        ForEach(gym.notes, id: \.id) { note in
          Button { editor = NoteEditorIdentity(note: note) } label: {
            GymRow(title: note.text, trailing: .door, lineLimit: 2)
          }
            .trashSwipe("Delete note") { _ = gym.run(DeleteNote(note.id)) }
            .contextMenu {
              Button("Edit") { editor = NoteEditorIdentity(note: note) }
              Button("Move up") { move(note, by: -1) }
              Button("Move down") { move(note, by: 1) }
              Button("Delete note", role: .destructive) { _ = gym.run(DeleteNote(note.id)) }
            }
            .accessibilityAction(named: "Move up") { move(note, by: -1) }
            .accessibilityAction(named: "Move down") { move(note, by: 1) }
            .accessibilityAction(named: "Delete note") { _ = gym.run(DeleteNote(note.id)) }
        }.onMove { source, destination in
          guard let from = source.first, source.count == 1 else { return }
          if gym.coachMoveNote(gym.notes[from], to: destination > from ? destination - 1 : destination) { ordered.toggle() }
        }.onDelete { offsets in
          let ids = offsets.map { gym.notes[$0].id }; for id in ids { _ = gym.run(DeleteNote(id)) }
        }
        if gym.coachNoteCount == 0 {
          ForEach(["How I want to be talked to", "What I am training for"], id: \.self) { hint in
            Button(hint) { editor = NoteEditorIdentity(note: Note(id: gym.runner.mint(Note.self)), hint: hint, isNew: true) }
              .foregroundStyle(GymPalette.inkDim)
          }
        }
      } header: {
        Text("Agents you connect can also read these.").font(.footnote).foregroundStyle(GymPalette.inkDim).textCase(nil)
      }.listRowBackground(GymPalette.card)
      Section {
        if gym.coachNoteCount < 10 {
          Button("Add a note") { editor = NoteEditorIdentity(note: Note(id: gym.runner.mint(Note.self)), isNew: true) }
            .foregroundStyle(GymPalette.accent).accessibilityIdentifier("coach-add-note")
        } else { Text("10 of 10 notes. Delete one to add another.").foregroundStyle(GymPalette.inkDim) }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).contentMargins(.top, RoomSpace.small, for: .scrollContent)
  }
  func move(_ note: Note, by step: Int) {
    guard let index = gym.notes.firstIndex(where: { $0.id == note.id }), gym.notes.indices.contains(index + step) else { return }
    if gym.coachMoveNote(note, to: index + step) { ordered.toggle() }
  }
}

struct NoteEditorIdentity: Identifiable {
  let note: Note
  var hint = "How I want to be talked to"
  var isNew = false
  var id: String { note.id.description }
}

// One note, its text focused on open and saved from the bar's checkmark; a swipe down the form puts the keyboard away. The
// field keeps what the lifter types and the draft takes it as the note stores it.
struct NoteEditor: View {
  let gym: GymModel
  let identity: NoteEditorIdentity
  let owner: String?
  @State var draft: Draft<Note>
  @State var typed: String
  @State var saved = false
  @FocusState var writing: Bool
  @Environment(\.dismiss) var dismiss
  init(gym: GymModel, identity: NoteEditorIdentity) {
    self.gym = gym; self.identity = identity; owner = gym.account
    _draft = State(initialValue: identity.isNew ? Draft(new: identity.note, placed: .bottom) : Draft(opening: identity.note))
    _typed = State(initialValue: identity.note.text)
  }
  var current: Bool { owner == gym.account && gym.coachAccountAvailable }
  var bytes: Int { NoteRules.body.measure(draft.current.body) }
  var savable: Bool {
    current && !draft.current.title.isEmpty && bytes <= 500 && (identity.isNew || draft.isDirty)
  }
  var body: some View {
    NavigationStack {
      Form {
        if !current {
          Text("The account changed. Open this note again.").listRowBackground(GymPalette.card)
        } else {
          Section {
            TextField(identity.hint, text: $typed, axis: .vertical).lineLimit(5...20)
              .focused($writing).accessibilityIdentifier("coach-note-text")
              .onChange(of: typed) { _, typed in draft.current.text = typed }
            if bytes > 500 {
              Text("This note runs past 500 bytes. Shorten it to save.").font(.caption).foregroundStyle(GymPalette.alarm)
                .accessibilityIdentifier("coach-note-refusal")
            } else if bytes >= 400 {
              Text("\(bytes) of 500 bytes").font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
            }
          }.listRowBackground(GymPalette.card)
          if !identity.isNew {
            Section {
              Button("Delete note", role: .destructive) {
                guard current else { return }
                if gym.run(DeleteNote(identity.note.id))?.refusal == nil, gym.error == nil { dismiss() }
              }
            }.listRowBackground(GymPalette.card)
          }
        }
      }.scrollDismissesKeyboard(.interactively).navigationTitle("Note").modifier(GymPage())
        .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-coach-error") }
        .sheetCommit("Save", identifier: "coach-note-save", disabled: !savable, dismiss: { dismiss() }) {
          guard current else { gym.error = "The account changed. Open this note again."; return }
          if case .saved = gym.save(&draft) { saved = true; dismiss() }
        }
        .sensoryFeedback(.success, trigger: saved)
    }.presentationDetents([.large])
      .onAppear { writing = current; gym.telemetry.event("gym_screen_viewed", properties: ["screen": "note"]) }
  }
}
