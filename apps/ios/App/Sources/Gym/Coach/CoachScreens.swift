import SwiftUI
import GymDomain
import DomainKit
import SyncEngine

// The shell can supply its existing You sheet without giving a product ownership of account UI.
private struct CoachAccountDoor: EnvironmentKey { static let defaultValue: (@MainActor () -> Void)? = nil }
private struct CoachRoutineDoor: EnvironmentKey { static let defaultValue: (@MainActor (String) -> Void)? = nil }
private struct CoachSessionDoor: EnvironmentKey { static let defaultValue: (@MainActor (String) -> Void)? = nil }
private struct CoachAskDoor: EnvironmentKey { static let defaultValue: (@MainActor (CoachHandoff) -> Void)? = nil }
extension EnvironmentValues {
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

// A room or screen that cannot open: its one sentence in the middle band and, when the account opens it, one quiet Sign in.
struct CoachUnavailable: View {
  let sentence: String
  var signIn: (@MainActor () -> Void)?
  var body: some View {
    VStack(spacing: RoomSpace.related) {
      Text(sentence).foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.center)
      if let signIn {
        Button("Sign in", action: signIn).foregroundStyle(GymPalette.accent)
          .frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("coach-sign-in")
      }
    }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityElement(children: .contain)
  }
}

struct GymSettingsScreen: View {
  let gym: GymModel
  @State var connections: CoachConnections
  init(gym: GymModel) { self.gym = gym; _connections = State(initialValue: CoachConnections(gym: gym)) }
  var body: some View {
    List {
      Section {
        NavigationLink("Notes") { NotesScreen(gym: gym) }
        NavigationLink { ConnectedLogScreen(gym: gym) } label: { LabeledContent("Connected log", value: connections.summary) }
        if gym.workoutHidden, gym.openSession != nil {
          Button("Restore workout") { gym.restoreWorkout() }.accessibilityIdentifier("gym-restore-workout")
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).navigationTitle("Gym settings").modifier(GymPage())
      .toolbar(.hidden, for: .tabBar)
      .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo") }
      .accessibilityIdentifier("gym-settings")
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition)") { await connections.load() }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "settings"]) }
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
      else { CoachUnavailable(sentence: "Notes live with your account, so they need you signed in.", signIn: openAccount) }
    }.navigationTitle("Notes").modifier(GymPage()).accessibilityIdentifier("gym-notes")
      .toolbar(.hidden, for: .tabBar)
      .toolbar { if gym.coachAccountAvailable, !gym.notes.isEmpty { EditButton() } }
      .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo") }
      .sheet(item: $editor) { identity in NoteEditor(gym: gym, identity: identity) }
      .sensoryFeedback(.selection, trigger: ordered)
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "notes"]) }
  }
  var notes: some View {
    List {
      Section {
        Group {
          ForEach(gym.notes, id: \.id) { note in
            Button { editor = NoteEditorIdentity(note: note) } label: {
              GymRow(title: note.title, meta: note.body.split(whereSeparator: \.isNewline).first.map(String.init), lineLimit: 2)
            }
              .swipeActions { Button("Delete", role: .destructive) { _ = gym.run(DeleteNote(note.id)) } }
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
          if gym.coachNoteCount < 10 {
            Button { editor = NoteEditorIdentity(note: Note(id: gym.runner.mint(Note.self)), isNew: true) } label: { Label("Add a note", systemImage: "plus") }
              .accessibilityIdentifier("coach-add-note")
          } else { Text("10 of 10 notes. Delete one to add another.").foregroundStyle(GymPalette.inkDim) }
        }.listRowBackground(GymPalette.card)
      } header: {
        Text("Any agent you connect can read these too.").font(.subheadline).foregroundStyle(GymPalette.inkDim).textCase(nil)
      }
    }.listStyle(.insetGrouped)
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

struct NoteEditor: View {
  let gym: GymModel
  let identity: NoteEditorIdentity
  let owner: String?
  @State var draft: Draft<Note>
  @State var saved = false
  @Environment(\.dismiss) var dismiss
  @FocusState var focus: Bool
  init(gym: GymModel, identity: NoteEditorIdentity) {
    self.gym = gym; self.identity = identity; owner = gym.account
    _draft = State(initialValue: identity.isNew ? Draft(new: identity.note, placed: .bottom) : Draft(opening: identity.note))
  }
  var body: some View {
    NavigationStack {
      Form {
        Group {
          if owner != gym.account || !gym.coachAccountAvailable {
            Text("The account changed. Open this note again.")
          } else {
          Section {
            TextField(identity.hint, text: $draft.current.title, axis: .vertical).font(.title3.weight(.semibold)).focused($focus).accessibilityIdentifier("coach-note-title")
            let titleCount = draft.current.title.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
            if titleCount >= 48 { Text("\(titleCount) of 60 characters").font(.caption.monospacedDigit()).foregroundStyle(titleCount > 60 ? GymPalette.alarm : GymPalette.inkDim) }
            TextField("Write a note for Coach", text: $draft.current.body, axis: .vertical).lineLimit(8...20).accessibilityIdentifier("coach-note-body")
            let bytes = draft.current.body.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count
            if bytes >= 400 { Text("\(bytes) of 500 bytes").font(.caption.monospacedDigit()).foregroundStyle(bytes > 500 ? GymPalette.alarm : GymPalette.inkDim) }
        }.listRowBackground(GymPalette.card)
        if !identity.isNew {
          Section { Button("Delete note", role: .destructive) {
            guard owner == gym.account, gym.coachAccountAvailable else { return }
            if gym.run(DeleteNote(identity.note.id))?.refusal == nil, gym.error == nil { dismiss() }
          } }
        }
        }
        }.listRowBackground(GymPalette.card)
      }.navigationTitle("Note").modifier(GymPage())
        .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo") }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { Button("Save") {
            guard owner == gym.account, gym.coachAccountAvailable else { gym.error = "The account changed. Open this note again."; return }
            if case .saved = gym.save(&draft) { saved = true; dismiss() }
          }.disabled(owner != gym.account || !gym.coachAccountAvailable || draft.current.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("coach-note-save") }
        }
        .safeAreaInset(edge: .bottom) { if focus { KeyboardBar(doneIdentifier: "coach-note-keyboard-done") { focus = false } } }
        .sensoryFeedback(.success, trigger: saved)
    }.presentationDetents([.large])
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "note"]) }
  }
}
