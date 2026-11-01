import SwiftUI
import DomainKit
import GymDomain

// The fields an edit changes; an unchanged field is never written, so a stale phone cannot revert another phone's edit.
struct MovementEdit: Equatable {
  let name: String?
  let equipment: String?
  let loadCount: Int?
  init(_ exercise: Exercise, name: String, equipment: String? = nil, loadCount: Int? = nil) {
    let nextEquipment = equipment.flatMap { $0 == exercise.equipment ? nil : $0 }
    self.name = NameField.movement.changed(from: exercise.name, to: name) ? NameField.movement.trimmed(name) : nil
    self.equipment = nextEquipment
    self.loadCount = Equipment(equipment ?? exercise.equipment) == .dumbbell ? loadCount.flatMap { nextEquipment != nil || $0 != exercise.loadCount ? $0 : nil } : nil
  }
  var isEmpty: Bool { name == nil && equipment == nil && loadCount == nil }
  var action: String { equipment != nil || loadCount != nil ? "equipment" : "rename" }
}

extension GymModel {
  func renameMovement(_ exercise: Exercise, to name: String, equipment: String? = nil, loadCount: Int? = nil) -> Bool {
    if let problem = NameField.movement.problem(name) { error = problem; return false }
    let edit = MovementEdit(exercise, name: name, equipment: equipment, loadCount: loadCount)
    guard !edit.isEmpty else { return false }
    refresh()
    guard !readFailed else { return false }
    if let current = catalogue.find(exercise.id), current.name != exercise.name || current.equipment != exercise.equipment || current.loadCount != exercise.loadCount {
      error = "That movement changed. Review its name."; return false
    }
    let outcome = run(UpdateExercise(exercise.id, name: edit.name, equipment: edit.equipment, loadCount: edit.loadCount))
    telemetry.event("gym_exercise_updated", properties: ["screen": "movement", "action": edit.action,
      "outcome": outcome == nil ? "failed" : outcome?.refusal == nil ? "ok" : "refused"])
    return outcome != nil && outcome?.refusal == nil
  }
}

struct RenameMovementSheet: View {
  let gym: GymModel
  let exercise: Exercise
  @Environment(\.dismiss) var dismiss
  @State var name: String
  @State var equipment: String
  @State var loadCount: Int
  @State var saving = false
  @State var refusal: String?
  @State var detent = PresentationDetent.large
  @State private var editingAccount: String?
  @State private var editingAnonymous: Bool
  @FocusState var nameFocused: Bool

  init(gym: GymModel, exercise: Exercise) {
    self.gym = gym; self.exercise = exercise; _name = State(initialValue: exercise.name)
    _equipment = State(initialValue: exercise.equipment)
    _loadCount = State(initialValue: Equipment(exercise.equipment) == .dumbbell ? exercise.loadCount : 2)
    _editingAccount = State(initialValue: gym.account); _editingAnonymous = State(initialValue: gym.isAnonymous)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name", text: $name).focused($nameFocused).autocorrectionDisabled().textInputAutocapitalization(.words)
            .disabled(saving).accessibilityIdentifier("gym-rename-movement-name")
          if let counter = NameField.movement.counter(name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
          if let refusal, !saving {
            Text(refusal).foregroundStyle(GymPalette.alarm).accessibilityIdentifier("gym-rename-movement-refusal")
          }
        }
          .listRowBackground(GymPalette.card)
        Section {
          MovementEquipmentPicker(equipment: $equipment, loadCount: $loadCount, identifier: "gym-rename-movement-equipment").disabled(saving)
        }
          .listRowBackground(GymPalette.card)
      }
      .modifier(GymPage()).navigationTitle("Edit movement")
      .sheetCommit("Save", identifier: "gym-rename-movement-commit",
                   disabled: gym.accountTransition || NameField.movement.problem(name) != nil || MovementEdit(exercise, name: name, equipment: equipment, loadCount: loadCount).isEmpty, busy: saving,
                   dismiss: { dismiss() }, commit: rename)
      .interactiveDismissDisabled(saving)
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "movement"]) }
      .onChange(of: name) { _, value in name = NameField.movement.capped(value); refusal = nil }
      .onChange(of: gym.account) { _, _ in dismiss() }
      .accessibilityIdentifier("gym-rename-movement")
    }
    .modifier(GymPage()).presentationDetents([.medium, .large], selection: $detent)
  }

  func rename() {
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
      let renamed = gym.renameMovement(exercise, to: name, equipment: equipment, loadCount: loadCount)
      saving = false
      if renamed { dismiss() } else { refusal = gym.error }
    }
  }
}
