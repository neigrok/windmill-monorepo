import SwiftUI
import DomainKit
import GymDomain

enum MovementName {
  static func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

  static func capped(_ value: String) -> String {
    String(String.UnicodeScalarView(value.unicodeScalars.prefix(60)))
  }

  static func problem(_ value: String) -> String? {
    let name = trimmed(value)
    if name.isEmpty { return "Name it to save it." }
    if name.unicodeScalars.count > 60 { return "Use 60 characters or fewer." }
    return nil
  }

  static func counter(_ value: String) -> String? {
    let count = value.unicodeScalars.count
    return count < 48 ? nil : "\(count)/60"
  }

  static func changed(from: String, to: String) -> Bool {
    problem(to) == nil && trimmed(to) != from
  }
}

extension GymModel {
  func renameMovement(_ exercise: Exercise, to name: String) -> Bool {
    if let problem = MovementName.problem(name) { error = problem; return false }
    guard MovementName.changed(from: exercise.name, to: name) else { return false }
    refresh()
    guard !readFailed else { return false }
    if let current = catalogue.find(exercise.id), current.name != exercise.name {
      error = "That movement changed. Review its name."; return false
    }
    if isAnonymous && SeedExercises.all.contains(where: { $0.id == exercise.id }) {
      error = "renaming a catalog movement needs your account — sign in first"
      return false
    }
    guard let outcome = run(RenameExercise(exercise.id, name: MovementName.trimmed(name))) else { return false }
    return outcome.refusal == nil
  }
}

struct RenameMovementSheet: View {
  let gym: GymModel
  let exercise: Exercise
  @Environment(\.dismiss) var dismiss
  @State var name: String
  @State var saving = false
  @State var refusal: String?
  @State private var editingAccount: String?
  @State private var editingAnonymous: Bool
  @FocusState var nameFocused: Bool

  init(gym: GymModel, exercise: Exercise) {
    self.gym = gym; self.exercise = exercise; _name = State(initialValue: exercise.name)
    _editingAccount = State(initialValue: gym.account); _editingAnonymous = State(initialValue: gym.isAnonymous)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name", text: $name).focused($nameFocused).autocorrectionDisabled().textInputAutocapitalization(.words)
            .disabled(saving).accessibilityIdentifier("gym-rename-movement-name")
          if let counter = MovementName.counter(name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
          if let refusal, !saving {
            Text(refusal).foregroundStyle(GymPalette.alarm).accessibilityIdentifier("gym-rename-movement-refusal")
          }
        } footer: { Text("Renames it everywhere; the old name still finds it.") }
          .listRowBackground(GymPalette.card)
      }
      .modifier(GymPage()).navigationTitle("Rename movement")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
        ToolbarItem(placement: .confirmationAction) {
          Button(saving ? "Renaming…" : "Rename") {
            guard editingAccount == gym.account, editingAnonymous == gym.isAnonymous else {
              refusal = "The account changed while renaming."; return
            }
            saving = true; nameFocused = false
            let account = gym.account, anonymous = gym.isAnonymous
            Task { @MainActor in
              await Task.yield()
              guard account == gym.account && anonymous == gym.isAnonymous else {
                refusal = "The account changed while renaming."; saving = false; return
              }
              let renamed = gym.renameMovement(exercise, to: name)
              saving = false
              if renamed { dismiss() } else { refusal = gym.error }
            }
          }
          .disabled(saving || gym.accountTransition || !MovementName.changed(from: exercise.name, to: name))
          .accessibilityIdentifier("gym-rename-movement-commit")
        }
      }
      .interactiveDismissDisabled(saving)
      .onAppear { nameFocused = true; gym.telemetry.event("gym_screen_viewed", properties: ["screen": "movement"]) }
      .onChange(of: name) { _, value in name = MovementName.capped(value); refusal = nil }
      .onChange(of: gym.account) { _, _ in dismiss() }
      .accessibilityIdentifier("gym-rename-movement")
    }
    .modifier(GymPage()).presentationDetents([.medium])
  }
}
