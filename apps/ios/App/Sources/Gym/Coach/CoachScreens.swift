import SwiftUI
import GymDomain
import DomainKit
import SyncEngine

// The shell can supply its existing You sheet without giving a product ownership of account UI.
private struct CoachAccountDoor: EnvironmentKey { static let defaultValue: (@MainActor () -> Void)? = nil }
private struct CoachRoutineDoor: EnvironmentKey { static let defaultValue: (@MainActor (String) -> Void)? = nil }
private struct CoachSessionDoor: EnvironmentKey { static let defaultValue: (@MainActor (String) -> Void)? = nil }
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
}

nonisolated enum CoachPalette {
  static let canvas = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 11/255, green: 17/255, blue: 17/255, alpha: 1) : .systemGroupedBackground })
  static let surface = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 22/255, green: 28/255, blue: 29/255, alpha: 1) : .secondarySystemGroupedBackground })
  static let onAccent = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 11/255, green: 17/255, blue: 17/255, alpha: 1) : .white })
  static let accent = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 95/255, green: 205/255, blue: 180/255, alpha: 1) : UIColor(red: 19/255, green: 122/255, blue: 108/255, alpha: 1) })
}

struct CoachPage: ViewModifier {
  func body(content: Content) -> some View {
    content.scrollContentBackground(.hidden).background(CoachPalette.canvas).tint(CoachPalette.accent)
      .foregroundStyle(.primary).navigationBarTitleDisplayMode(.inline)
  }
}

struct CoachNoticeBand: View {
  let gym: GymModel
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let error = gym.error {
        Text(error).font(.callout).accessibilityIdentifier("gym-coach-error")
        if gym.readFailed { Button("Try again") { gym.refresh() } }
      }
      ForEach(gym.notices, id: \.id) { notice in
        Button("Dismiss message") { gym.dismissNotice(notice.id) }
      }
      ForEach(gym.undoOffers.reversed(), id: \.id) { offer in
        Button("Undo") { _ = gym.undo(offer.id) }.accessibilityIdentifier("coach-engine-undo")
      }
    }.padding(gym.error == nil && gym.undoOffers.isEmpty ? 0 : 16).frame(maxWidth: .infinity, alignment: .leading)
      .background(CoachPalette.surface)
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
  func coachSaveUnits(_ units: String) {
    do {
      var draft = try runner.open(preferences.id, orNew: GymPreferences())
      draft.current.units = units; _ = save(&draft)
    } catch { self.error = "Your settings couldn’t be saved. Try again."; report("gym_action", error) }
  }
}

struct GymSettingsScreen: View {
  let gym: GymModel
  @Environment(\.coachOpenAccount) var openAccount
  @State var accountHint = false
  var body: some View {
    List {
      Section {
        Picker("Units", selection: Binding(get: { gym.preferences.units }, set: { gym.coachSaveUnits($0) })) {
          Text("kg").tag("kg"); Text("lb").tag("lb")
        }.pickerStyle(.segmented).accessibilityIdentifier("gym-units")
      } footer: { Text("This phone still draws kg.") }
      Section {
        NavigationLink("Notes") { NotesScreen(gym: gym) }
        NavigationLink("Connected log") { ConnectedLogScreen(gym: gym) }
        Button("Account") { if let openAccount { openAccount() } else { accountHint = true } }
        if gym.workoutHidden, gym.openSession != nil {
          Button("Restore workout") { gym.restoreWorkout() }.accessibilityIdentifier("gym-restore-workout")
        }
        if accountHint { Text("Open You and settings in the top bar.").font(.callout).foregroundStyle(.secondary) }
      }
    }.listStyle(.insetGrouped).navigationTitle("Gym settings").modifier(CoachPage())
      .toolbar(.hidden, for: .tabBar)
      .safeAreaInset(edge: .bottom) { CoachNoticeBand(gym: gym) }
      .accessibilityIdentifier("gym-settings")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "settings"]) }
  }
}

struct NotesScreen: View {
  let gym: GymModel
  @State var editor: NoteEditorIdentity?
  @State var ordered = false
  var body: some View {
    List {
      if !gym.coachAccountAvailable {
        Section { Text("Notes live with your account, so they need you signed in.") }
      } else {
        Section {
          Text("what you write for Coach").foregroundStyle(.secondary)
          Text("Any agent you connect can read these too.")
            .padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(CoachPalette.accent).frame(width: 3) }
        }.listRowBackground(Color.clear)
        Section {
          ForEach(gym.notes, id: \.id) { note in
            Button { editor = NoteEditorIdentity(note: note) } label: {
              VStack(alignment: .leading, spacing: 5) {
                Text(note.title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                if let line = note.body.split(whereSeparator: \.isNewline).first { Text(String(line)).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
              }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }.listRowBackground(CoachPalette.surface)
              .swipeActions { Button("Delete", role: .destructive) { _ = gym.run(DeleteNote(note.id)) } }
              .contextMenu {
                Button("Edit") { editor = NoteEditorIdentity(note: note) }
                Button("Move up") { if let i = gym.notes.firstIndex(where: { $0.id == note.id }), i > 0 { if gym.coachMoveNote(note, to: i - 1) { ordered.toggle() } } }
                Button("Move down") { if let i = gym.notes.firstIndex(where: { $0.id == note.id }), i < gym.notes.count - 1 { if gym.coachMoveNote(note, to: i + 1) { ordered.toggle() } } }
                Button("Delete note", role: .destructive) { _ = gym.run(DeleteNote(note.id)) }
              }
              .accessibilityAction(named: "Move up") { if let i = gym.notes.firstIndex(where: { $0.id == note.id }), i > 0 { if gym.coachMoveNote(note, to: i - 1) { ordered.toggle() } } }
              .accessibilityAction(named: "Move down") { if let i = gym.notes.firstIndex(where: { $0.id == note.id }), i < gym.notes.count - 1 { if gym.coachMoveNote(note, to: i + 1) { ordered.toggle() } } }
              .accessibilityAction(named: "Delete note") { _ = gym.run(DeleteNote(note.id)) }
          }.onMove { source, destination in
            guard let from = source.first, source.count == 1 else { return }
            if gym.coachMoveNote(gym.notes[from], to: destination > from ? destination - 1 : destination) { ordered.toggle() }
          }.onDelete { offsets in
            let ids = offsets.map { gym.notes[$0].id }; for id in ids { _ = gym.run(DeleteNote(id)) }
          }
          if gym.notes.isEmpty {
            ForEach(["How I want to be talked to", "What I am training for"], id: \.self) { hint in
              Button(hint) { editor = NoteEditorIdentity(note: Note(id: gym.runner.mint(Note.self)), hint: hint, isNew: true) }
                .foregroundStyle(.secondary).listRowBackground(CoachPalette.surface)
            }
          }
          if gym.coachNoteCount < 10 {
            Button { editor = NoteEditorIdentity(note: Note(id: gym.runner.mint(Note.self)), isNew: true) } label: { Label("Add a note", systemImage: "plus") }
              .accessibilityIdentifier("coach-add-note").listRowBackground(CoachPalette.surface)
          } else { Text("10 of 10 notes. Delete one to add another.").foregroundStyle(.secondary) }
        } footer: { Text("Top note wins.") }
      }
    }.listStyle(.insetGrouped).navigationTitle("Notes").modifier(CoachPage()).accessibilityIdentifier("gym-notes")
      .toolbar(.hidden, for: .tabBar)
      .toolbar { if gym.coachAccountAvailable, !gym.notes.isEmpty { EditButton() } }
      .safeAreaInset(edge: .bottom) { CoachNoticeBand(gym: gym) }
      .sheet(item: $editor) { identity in NoteEditor(gym: gym, identity: identity) }
      .sensoryFeedback(.selection, trigger: ordered)
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "notes"]) }
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
        if owner != gym.account || !gym.coachAccountAvailable {
          Text("The account changed. Open this note again.")
        } else {
        Section {
          TextField(identity.hint, text: $draft.current.title, axis: .vertical).font(.title3.weight(.semibold)).focused($focus).accessibilityIdentifier("coach-note-title")
          let titleCount = draft.current.title.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
          if titleCount >= 48 { Text("\(titleCount) of 60 characters").font(.caption.monospaced()).foregroundStyle(titleCount > 60 ? .red : .secondary) }
          TextField("Write a note for Coach", text: $draft.current.body, axis: .vertical).lineLimit(8...20).accessibilityIdentifier("coach-note-body")
          let bytes = draft.current.body.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count
          if bytes >= 400 { Text("\(bytes) of 500 bytes").font(.caption.monospaced()).foregroundStyle(bytes > 500 ? .red : .secondary) }
        }.listRowBackground(CoachPalette.surface)
        if !identity.isNew {
          Section { Button("Delete note", role: .destructive) {
            guard owner == gym.account, gym.coachAccountAvailable else { return }
            if gym.run(DeleteNote(identity.note.id))?.refusal == nil, gym.error == nil { dismiss() }
          } }
        }
        if let error = gym.error { Section { Text(error).foregroundStyle(.red) } }
        }
      }.navigationTitle("Note").modifier(CoachPage())
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { Button("Save") {
            guard owner == gym.account, gym.coachAccountAvailable else { gym.error = "The account changed. Open this note again."; return }
            if case .saved = gym.save(&draft) { saved = true; dismiss() }
          }.disabled(owner != gym.account || !gym.coachAccountAvailable || draft.current.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("coach-note-save") }
          ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focus = false } }
        }.sensoryFeedback(.success, trigger: saved)
    }.presentationDetents([.large])
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "note"]) }
  }
}
