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

// The fields an edit changes; an unchanged field is never written, so a stale phone cannot revert another phone's edit.
struct MovementEdit: Equatable {
  let name: String?
  let equipment: String?
  let loadCount: Int?
  init(_ exercise: Exercise, name: String, equipment: String? = nil, loadCount: Int? = nil) {
    let nextEquipment = equipment.flatMap { $0 == exercise.equipment ? nil : $0 }
    self.name = MovementName.changed(from: exercise.name, to: name) ? MovementName.trimmed(name) : nil
    self.equipment = nextEquipment
    self.loadCount = (equipment ?? exercise.equipment) == "dumbbell" ? loadCount.flatMap { nextEquipment != nil || $0 != exercise.loadCount ? $0 : nil } : nil
  }
  var isEmpty: Bool { name == nil && equipment == nil && loadCount == nil }
  var action: String { equipment != nil || loadCount != nil ? "equipment" : "rename" }
}

extension GymModel {
  func renameMovement(_ exercise: Exercise, to name: String, equipment: String? = nil, loadCount: Int? = nil) -> Bool {
    if let problem = MovementName.problem(name) { error = problem; return false }
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
  @State private var editingAccount: String?
  @State private var editingAnonymous: Bool
  @FocusState var nameFocused: Bool

  init(gym: GymModel, exercise: Exercise) {
    self.gym = gym; self.exercise = exercise; _name = State(initialValue: exercise.name)
    _equipment = State(initialValue: exercise.equipment)
    _loadCount = State(initialValue: exercise.equipment == "dumbbell" ? exercise.loadCount : 2)
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
        } footer: { Text("The name updates in your routines and history. The old name still finds it.") }
          .listRowBackground(GymPalette.card)
        Section {
          MovementEquipmentPicker(equipment: $equipment, loadCount: $loadCount, identifier: "gym-rename-movement-equipment").disabled(saving)
        } footer: { Text(MovementEquipment(equipment, loadCount: loadCount).help + " Equipment changes recalculate your history’s volume; logged weights stay as entered.") }
          .listRowBackground(GymPalette.card)
      }
      .modifier(GymPage()).navigationTitle("Edit exercise")
      .sheetCommit("Save", identifier: "gym-rename-movement-commit",
                   disabled: gym.accountTransition || MovementName.problem(name) != nil || MovementEdit(exercise, name: name, equipment: equipment, loadCount: loadCount).isEmpty, busy: saving,
                   dismiss: { dismiss() }, commit: rename)
      .interactiveDismissDisabled(saving)
      .onAppear { nameFocused = true; gym.telemetry.event("gym_screen_viewed", properties: ["screen": "movement"]) }
      .onChange(of: name) { _, value in name = MovementName.capped(value); refusal = nil }
      .onChange(of: gym.account) { _, _ in dismiss() }
      .accessibilityIdentifier("gym-rename-movement")
    }
    .modifier(GymPage()).presentationDetents([.medium, .large])
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

// A movement's equipment and the basis of its entered load: a pair of dumbbells per dumbbell, one dumbbell as itself.
struct MovementEquipment {
  let value: String
  let loadCount: Int
  init(_ value: String, loadCount: Int = 2) { self.value = value; self.loadCount = value == "dumbbell" ? loadCount : 1 }
  init(_ exercise: Exercise?) { self.init(exercise?.equipment ?? "", loadCount: exercise?.loadCount ?? 2) }
  static let choices = ["barbell", "dumbbell", "bodyweight", "machine", "cable", "kettlebell"]
  var title: String { value == "dumbbell" ? loadCount == 1 ? "One dumbbell" : "Dumbbells" : value.capitalized }
  var symbol: String {
    switch value {
    case "barbell": "figure.strengthtraining.traditional"
    case "dumbbell": "dumbbell.fill"
    case "bodyweight": "figure.strengthtraining.functional"
    case "machine", "cable": "figure.strengthtraining.functional"
    default: "dumbbell"
    }
  }
  var unit: String {
    switch value {
    case "dumbbell": loadCount == 1 ? "kg" : "kg each"
    case "bodyweight": "kg added"
    case "barbell": "kg total"
    default: "kg"
    }
  }
  var help: String {
    switch value {
    case "dumbbell": loadCount == 1 ? "Enter the dumbbell’s weight. Volume counts one dumbbell." : "Enter each dumbbell’s weight. Volume counts both."
    case "bodyweight": "Enter added weight, or a negative number for assistance. Zero means bodyweight only. Volume counts added weight only."
    case "barbell": "Enter the total weight, including the bar."
    default: "Enter the external weight you lift."
    }
  }
}

struct MovementEquipmentPicker: View {
  @Binding var equipment: String
  @Binding var loadCount: Int
  let identifier: String
  var body: some View {
    Group {
      Picker(selection: $equipment) {
        ForEach(MovementEquipment.choices, id: \.self) { value in
          Label(value == "dumbbell" ? "Dumbbells" : MovementEquipment(value).title, systemImage: MovementEquipment(value).symbol).tag(value)
        }
      } label: {
        Label("Equipment", systemImage: MovementEquipment(equipment).symbol)
      }.pickerStyle(.menu).accessibilityIdentifier(identifier)
      if equipment == "dumbbell" {
        Picker("Dumbbells lifted", selection: $loadCount) {
          Text("One").tag(1)
          Text("Two").tag(2)
        }.pickerStyle(.segmented).accessibilityIdentifier("\(identifier)-count")
      }
    }
  }
}
