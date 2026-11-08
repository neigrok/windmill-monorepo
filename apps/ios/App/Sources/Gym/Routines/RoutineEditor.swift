import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncCore

// One visit to the routine editor: the routine as drafted, the movements it changes beside it, the picker pushed over it
// and the movement form stacked over both. Nothing is written until Save, one atomic write.
@Observable @MainActor
final class RoutineEditingSession: Identifiable {
  let id: DomainKit.ID<Routine>
  let account: String?
  let anonymous: Bool
  // A refusal answers an attempt — a Save, or leaving a name the owner changed — and the next edit clears it. A refused
  // name is the name field's; any other refusal is the band's.
  var draft: Draft<Routine> { didSet { if draft.current != oldValue.current { refusal = nil; nameRefusal = nil } } }
  var picking = false
  var form: MovementFormDraft? { didSet { if form != oldValue { refusal = nil } } }
  var movements: [DomainKit.ID<Exercise>: RoutineMovementChange] = [:]
  var saved = false
  var nameRefusal: String?
  var refusal: String?
  var appeared = false

  init(gym: GymModel, routine: Routine?) {
    account = gym.account; anonymous = gym.isAnonymous
    let initialDraft = routine.map { Draft(opening: $0) } ?? Draft(new: Routine(id: gym.runner.mint(Routine.self), position: (gym.routines.map(\.position).max() ?? -1) + 1))
    draft = initialDraft
    id = initialDraft.id
  }

  func leaveName() {
    guard draft.current.name != draft.base.name, let problem = NameField.routine.problem(draft.current.name) else { return }
    nameRefusal = problem
  }

  var isDirty: Bool { draft.isDirty || movements.values.contains(where: \.isDirty) }
  // No room for another movement: the routine holds the rule's most.
  var full: Bool { draft.current.entries.count >= RoutineRules.entries.max }

  func exercise(_ id: DomainKit.ID<Exercise>, in gym: GymModel) -> Exercise? {
    movements[id]?.current ?? gym.catalogue.find(id)
  }

  func pickMovement() { form = nil; picking = true }

  // A movement made here takes the search as its name and opens on the form over the picker.
  func createMovement(named query: String, gym: GymModel) {
    let equipment = Equipment.barbell
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: NameField.movement.taken(from: query),
                            pattern: "isolation", equipment: equipment, stepKg: ExerciseRules.defaultStepKg(equipment: equipment.rawValue))
    form = MovementFormDraft(exercise: exercise, base: nil, entry: nil)
  }

  func editMovement(_ id: DomainKit.ID<Exercise>, gym: GymModel) {
    guard let exercise = exercise(id, in: gym) else { return }
    let base = movements[id].map(\.base) ?? exercise
    form = MovementFormDraft(exercise: exercise, base: base, entry: draft.current.entries.first { $0.exerciseId == id })
  }

  func cancelMovement() { form = nil }

  @discardableResult func stageMovement(_ gym: GymModel) -> Bool {
    guard let form else { return false }
    guard account == gym.account, anonymous == gym.isAnonymous, !gym.accountTransition else {
      refusal = String(localized: "The account changed while editing. Open the routine again.")
      return false
    }
    guard form.problem == nil else { return false }
    if let index = draft.current.entries.firstIndex(where: { $0.exerciseId == form.id }) {
      draft.current.entries[index] = form.planned
    } else {
      guard !full else { return false }
      draft.current.entries.append(form.planned)
    }
    movements[form.id] = RoutineMovementChange(base: form.base, current: form.exercise)
    self.form = nil; picking = false
    gym.telemetry.event("gym_action", properties: ["screen": "routine_movement_editor", "action": "stage", "outcome": "ok"])
    return true
  }

  func move(from source: IndexSet, to destination: Int) { draft.current.entries.move(fromOffsets: source, toOffset: destination) }

  func remove(_ offsets: IndexSet) {
    for index in offsets where draft.current.entries.indices.contains(index) { movements.removeValue(forKey: draft.current.entries[index].exerciseId) }
    draft.current.entries.remove(atOffsets: offsets)
  }

  @discardableResult func save(_ gym: GymModel) -> Bool {
    guard account == gym.account, anonymous == gym.isAnonymous, !gym.accountTransition else {
      refusal = String(localized: "The account changed while editing. Open the routine again.")
      gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": "update", "outcome": "refused"])
      return false
    }
    if let problem = NameField.routine.problem(draft.current.name) {
      nameRefusal = problem
      gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": draft.isNew ? "create" : "update", "outcome": "refused"])
      return false
    }
    if let problem = RoutinePlanning.movementsProblem(draft.current.entries) {
      refusal = problem
      gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": draft.isNew ? "create" : "update", "outcome": "refused"])
      return false
    }
    let outcome = gym.run(SaveRoutinePlan(base: draft.base, current: draft.current, isNew: draft.isNew, movements: Array(movements.values)))
    gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": draft.isNew ? "create" : "update",
                                                 "outcome": outcome == nil ? "failed" : outcome?.refusal == nil ? "saved" : "refused"])
    if let outcome, outcome.refusal == nil {
      if outcome.receipt != nil { gym.telemetry.event("gym_routine_saved", properties: ["screen": "routine_editor", "action": draft.isNew ? "create" : "update"]) }
      saved = true; return true
    }
    refusal = gym.error ?? String(localized: "This routine could not be saved. Try again.")
    return false
  }

  @discardableResult func delete(_ gym: GymModel) -> Bool {
    guard account == gym.account, anonymous == gym.isAnonymous, !gym.accountTransition else {
      refusal = String(localized: "The account changed while editing. Open the routine again.")
      gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": "update", "outcome": "refused"])
      return false
    }
    guard let outcome = gym.run(DeleteRoutine(id)), outcome.refusal == nil else {
      refusal = gym.error ?? String(localized: "This routine could not be deleted. Try again."); return false
    }
    return true
  }
}

// The routine editor (02L.2, 02L.3): the name, the movements as Lift-shaped rows under their Edit button, with swipe to
// remove and Add movement at the section's end, the routine's History and Delete routine; Cancel and Save in the bar.
// Add movement pushes the picker (02L.4); a row, a pick or Create opens the movement form as a sheet (02L.5).
struct RoutineEditor: View {
  let gym: GymModel
  @Bindable var editing: RoutineEditingSession
  let onSave: (ID<Routine>) -> Void
  @State private var discardChanges = false
  @FocusState private var nameFocused: Bool
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      plan
        .navigationTitle(editing.draft.isNew ? "New routine" : "Edit routine").navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("routine-builder")
        .sheetCommit("Save", identifier: "save-routine", disabled: gym.accountTransition || !editing.isDirty, style: .word,
                     dismiss: cancel, commit: save)
        .reachBand { GymTransient(gym: gym, message: editing.refusal, errorIdentifier: "routine-refusal") }
        .navigationDestination(isPresented: $editing.picking) {
          MovementPicker(gym: gym, purpose: .routine, selected: Set(editing.draft.current.entries.map(\.exerciseId)),
                         onCreate: { editing.createMovement(named: $0, gym: gym) },
                         onCancel: { editing.picking = false; gym.telemetry.event("gym_action", properties: ["screen": "routine_movement", "action": "cancel", "outcome": "ok"]) },
                         onSelect: { editing.editMovement($0.exerciseId, gym: gym) })
            .navigationBarBackButtonHidden()
        }
        // The plan appears again each time the picker pops off it, so its first appearance is the visit.
        .onAppear {
          guard !editing.appeared else { return }
          editing.appeared = true; nameFocused = editing.draft.isNew
          gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_editor"])
        }
        .onChange(of: editing.picking) { _, _ in nameFocused = false }
        .onChange(of: nameFocused) { _, focused in if !focused { editing.leaveName() } }
        .sensoryFeedback(.selection, trigger: editing.draft.current.entries.map(\.exerciseId))
        .sensoryFeedback(.success, trigger: editing.saved)
    }.modifier(GymPage()).presentationDetents([.large])
      .interactiveDismissDisabled(editing.isDirty)
      .sheet(item: $editing.form) { form in
        MovementForm(gym: gym, draft: Binding(get: { editing.form ?? form }, set: { editing.form = $0 }), refusal: editing.refusal,
                     onCancel: { editing.cancelMovement() }, onCommit: { editing.stageMovement(gym) })
      }
      .confirmationDialog("Discard routine changes?", isPresented: $discardChanges, titleVisibility: .visible) {
        Button("Discard", role: .destructive) { discard() }
        Button("Keep editing", role: .cancel) {}
      }
  }

  var plan: some View {
    Form {
      Group {
        Section {
          TextField("Routine name", text: $editing.draft.current.name).focused($nameFocused).submitLabel(.done)
            .onSubmit { nameFocused = false }.accessibilityIdentifier("routine-name")
          if let counter = NameField.routine.counter(editing.draft.current.name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
        } footer: {
          if let refusal = editing.nameRefusal { Text(refusal).foregroundStyle(GymPalette.alarm).accessibilityIdentifier("routine-name-refusal") }
        }
        Section {
          ForEach(Array(editing.draft.current.entries.enumerated()), id: \.element.exerciseId) { index, entry in
            Button { nameFocused = false; editing.editMovement(entry.exerciseId, gym: gym) } label: {
              MovementRow(exercise: editing.exercise(entry.exerciseId, in: gym), entry: entry)
            }.accessibilityIdentifier("builder-movement-\(entry.exerciseId)")
              .trashSwipe("Remove movement") { editing.remove(IndexSet(integer: index)) }
          }.onDelete { editing.remove($0) }.onMove { editing.move(from: $0, to: $1) }
          Button("Add movement", systemImage: "plus.circle.fill") { nameFocused = false; editing.pickMovement() }
            .accessibilityIdentifier("add-movement").disabled(editing.full)
        } header: {
          HStack {
            Text("Movements")
            Spacer()
            if !editing.draft.current.entries.isEmpty { EditButton().font(.body).textCase(nil).accessibilityIdentifier("edit-movements") }
          }
        }
        let history = gym.routineHistory(editing.draft.id).prefix(20), dates = gym.dates
        if !history.isEmpty {
          Section("History") {
            ForEach(history, id: \.id) { session in
              GymRow(title: dates.subtitle(session.startedAt), meta: RoutineLines.session(SessionReadout(session: session, sets: gym.sets, catalogue: gym.catalogue)))
            }
          }
        }
        if !editing.draft.isNew {
          Section {
            Button("Delete routine", role: .destructive) { delete() }
              .disabled(gym.accountTransition).accessibilityIdentifier("delete-routine")
          }
        }
      }.listRowBackground(GymPalette.card)
    }.modifier(GymPage())
  }

  private func cancel() {
    nameFocused = false
    if editing.isDirty { discardChanges = true } else { discard() }
  }

  private func discard() {
    gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": "cancel", "outcome": "ok"])
    dismiss()
  }

  private func save() {
    nameFocused = false
    if editing.save(gym) { onSave(editing.id); dismiss() }
  }

  private func delete() {
    nameFocused = false
    if editing.delete(gym) { dismiss() }
  }
}

enum RoutinePlanning {
  static let belowFloor = String(localized: "Load, 0 or more.")

  // Why a routine cannot be saved, its name first.
  static func problem(_ routine: Routine) -> String? { NameField.routine.problem(routine.name) ?? movementsProblem(routine.entries) }

  // A routine holds at least one movement and at most the rule's most.
  static func movementsProblem(_ entries: [RoutineEntry]) -> String? {
    if entries.isEmpty { return String(localized: "A routine is at least one movement.") }
    if entries.count > RoutineRules.entries.max { return String(localized: "Use \(RoutineRules.entries.max) movements or fewer.", locale: .copy) }
    return nil
  }
}

extension GymModel {
  @discardableResult func saveRoutine(_ draft: inout Draft<Routine>) -> Bool {
    if let problem = RoutinePlanning.problem(draft.current) { error = problem; return false }
    let creating = draft.isNew
    guard case .saved(let receipt) = save(&draft) else { return false }
    if receipt != nil { telemetry.event("gym_routine_saved", properties: ["screen": "routine_editor", "action": creating ? "create" : "update"]) }
    return true
  }
}
