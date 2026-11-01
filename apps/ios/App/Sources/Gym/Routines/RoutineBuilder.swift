import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncCore

@Observable @MainActor
final class RoutineEditingSession: Identifiable {
  enum Step: Hashable { case movements, editor }
  let id: DomainKit.ID<Routine>
  let account: String?
  let anonymous: Bool
  // A refusal answers an attempt — a Save, or leaving a name the owner changed — and the next edit clears it.
  var draft: Draft<Routine> { didSet { if draft.current != oldValue.current { refusal = nil } } }
  var path: [Step] = []
  var query = ""
  var editor: RoutineMovementDraft? { didSet { if editor != oldValue { refusal = nil } } }
  var movements: [DomainKit.ID<Exercise>: RoutineMovementChange] = [:]
  var saving = false
  var saved = false
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
    refusal = problem
  }

  var isDirty: Bool { draft.isDirty || movements.values.contains(where: \.isDirty) }

  func exercise(_ id: DomainKit.ID<Exercise>, in gym: GymModel) -> Exercise? {
    movements[id]?.current ?? gym.catalogue.find(id)
  }

  func pickMovement() {
    query = ""; editor = nil; path = [.movements]
  }

  func createMovement(_ gym: GymModel) {
    let equipment = Equipment.barbell
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: NameField.movement.taken(from: query),
                            pattern: "isolation", equipment: equipment, stepKg: ExerciseRules.defaultStepKg(equipment: equipment.rawValue))
    editor = RoutineMovementDraft(exercise: exercise, base: nil, entry: nil)
    path.append(.editor)
  }

  func editMovement(_ id: DomainKit.ID<Exercise>, gym: GymModel) {
    guard let exercise = exercise(id, in: gym) else { return }
    let base = movements[id].map(\.base) ?? exercise
    editor = RoutineMovementDraft(exercise: exercise, base: base,
                                  entry: draft.current.entries.first { $0.exerciseId == id })
    path.append(.editor)
  }

  func cancelMovement() {
    editor = nil
    if path.last == .editor { path.removeLast() }
  }

  @discardableResult func stageMovement(_ gym: GymModel) -> Bool {
    guard let editor else { return false }
    guard account == gym.account, anonymous == gym.isAnonymous, !gym.accountTransition else {
      refusal = "The account changed while editing. Open the routine again."
      return false
    }
    guard editor.problem == nil else { return false }
    let sets: [SetTarget]?
    switch editor.targets.reading {
    case .open: sets = nil
    case .scheme(let targets): sets = targets
    case .refused: return false
    }
    if let index = draft.current.entries.firstIndex(where: { $0.exerciseId == editor.id }) {
      draft.current.entries[index].sets = sets
    } else {
      guard draft.current.entries.count < 50 else { return false }
      draft.current.entries.append(RoutineEntry(exerciseId: editor.id, sets: sets))
    }
    movements[editor.id] = RoutineMovementChange(base: editor.base, current: editor.exercise)
    self.editor = nil; path = []
    gym.telemetry.event("gym_action", properties: ["screen": "routine_movement_editor", "action": "stage", "outcome": "ok"])
    return true
  }
  func move(_ index: Int, by offset: Int) {
    let destination = index + offset
    guard draft.current.entries.indices.contains(index), draft.current.entries.indices.contains(destination) else { return }
    draft.current.entries.swapAt(index, destination)
  }
  func remove(_ index: Int) {
    guard draft.current.entries.indices.contains(index) else { return }
    movements.removeValue(forKey: draft.current.entries[index].exerciseId)
    draft.current.entries.remove(at: index)
  }
  @discardableResult func save(_ gym: GymModel) -> Bool {
    guard account == gym.account, anonymous == gym.isAnonymous, !gym.accountTransition else {
      refusal = "The account changed while editing. Open the routine again."
      gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": "update", "outcome": "refused"])
      return false
    }
    if let problem = RoutinePlanning.problem(draft.current) {
      refusal = problem
      gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": draft.isNew ? "create" : "update", "outcome": "refused"])
      return false
    }
    saving = true
    defer { saving = false }
    let outcome = gym.run(SaveRoutinePlan(base: draft.base, current: draft.current, isNew: draft.isNew, movements: Array(movements.values)))
    gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": draft.isNew ? "create" : "update",
                                                 "outcome": outcome == nil ? "failed" : outcome?.refusal == nil ? "saved" : "refused"])
    if let outcome, outcome.refusal == nil {
      if outcome.receipt != nil { gym.telemetry.event("gym_routine_saved", properties: ["screen": "routine_editor", "action": draft.isNew ? "create" : "update"]) }
      saved = true; return true
    }
    refusal = gym.error ?? "This routine could not be saved. Try again."
    return false
  }
  @discardableResult func delete(_ gym: GymModel) -> Bool {
    guard account == gym.account, anonymous == gym.isAnonymous, !gym.accountTransition else {
      refusal = "The account changed while editing. Open the routine again."
      gym.telemetry.event("gym_action", properties: ["screen": "routine_editor", "action": "update", "outcome": "refused"])
      return false
    }
    guard let outcome = gym.run(DeleteRoutine(id)), outcome.refusal == nil else {
      refusal = gym.error ?? "This routine could not be deleted. Try again."; return false
    }
    return true
  }
}

struct RoutineBuilder: View {
  let gym: GymModel
  @Bindable var editing: RoutineEditingSession
  let onSave: (ID<Routine>) -> Void
  @State private var discardChanges = false
  @FocusState private var nameFocused: Bool
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack(path: $editing.path) {
      plan
        .navigationTitle(editing.draft.isNew ? "New routine" : "Edit routine").navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("routine-builder")
        .sheetCommit("Save", identifier: "save-routine", disabled: gym.accountTransition || !editing.isDirty, busy: editing.saving,
                     dismiss: cancel, commit: save)
        .reachBand {
          GymTransient(gym: gym, message: editing.refusal,
                       errorIdentifier: "routine-refusal")
        }
        .navigationDestination(for: RoutineEditingSession.Step.self, destination: destination)
        // The plan appears again each time a step pops off it, so its first appearance is the visit.
        .onAppear {
          guard !editing.appeared else { return }
          editing.appeared = true; nameFocused = editing.draft.isNew
          gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_editor"])
        }
        .onChange(of: editing.path) { _, _ in nameFocused = false }
        .onChange(of: nameFocused) { _, focused in if !focused { editing.leaveName() } }
        .sensoryFeedback(.selection, trigger: editing.draft.current.entries.map(\.exerciseId))
        .sensoryFeedback(.success, trigger: editing.saved)
    }.modifier(GymPage()).presentationDetents([.large])
      .interactiveDismissDisabled(editing.isDirty || editing.editor?.isDirty == true || editing.saving)
      .confirmationDialog("Discard routine changes?", isPresented: $discardChanges, titleVisibility: .visible) {
        Button("Discard", role: .destructive) { discard() }
        Button("Keep editing", role: .cancel) {}
      }

  }

  var plan: some View {
    List {
      Group {
        Section {
          TextField("Name", text: $editing.draft.current.name).focused($nameFocused)
            .onSubmit { nameFocused = false }.accessibilityIdentifier("routine-name")
          if let counter = NameField.routine.counter(editing.draft.current.name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
        }
        Section {
          ForEach(Array(editing.draft.current.entries.enumerated()), id: \.element.exerciseId) { index, entry in
            let exercise = editing.exercise(entry.exerciseId, in: gym)
            OrderedMovementRow(exercise: exercise, index: index, count: editing.draft.current.entries.count,
                               identifier: "builder-movement-\(entry.exerciseId)",
                               open: { editing.editMovement(entry.exerciseId, gym: gym) },
                               move: { editing.move(index, by: $0) }, remove: { editing.remove(index) }, edit: { editing.editMovement($0.id, gym: gym) }) {
              GymRow(title: "\(index + 1). \(exercise?.name ?? "Movement unavailable")",
                     meta: RoutineLines.movement(entry.sets, equipment: MovementEquipment(exercise)))
            }
          }.onMove { source, destination in editing.draft.current.entries.move(fromOffsets: source, toOffset: destination) }
          Button("Add movement", systemImage: "plus.circle.fill") { nameFocused = false; editing.pickMovement() }
            .accessibilityIdentifier("add-movement").disabled(editing.draft.current.entries.count >= 50)
        } header: { Text("Movements") }
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
    }.listStyle(.insetGrouped).modifier(GymPage())
  }

  @ViewBuilder func destination(_ step: RoutineEditingSession.Step) -> some View {
    switch step {
    case .movements:
      MovementPicker(gym: gym, purpose: .routine, selected: Set(editing.draft.current.entries.map(\.exerciseId)), query: $editing.query,
                     onCreate: { editing.createMovement(gym) }, onCancel: { editing.path = []; gym.telemetry.event("gym_action", properties: ["screen": "routine_movement", "action": "cancel", "outcome": "ok"]) }) { editing.editMovement($0.exerciseId, gym: gym) }
        .navigationBarBackButtonHidden()
    case .editor:
      if let editor = editing.editor {
        RoutineMovementEditor(gym: gym, draft: Binding(get: { editing.editor ?? editor }, set: { editing.editor = $0 }),
                              refusal: editing.refusal, onCancel: { editing.cancelMovement() },
                              onCommit: { editing.stageMovement(gym) })
          .navigationBarBackButtonHidden()
      }

    }
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
  static func problem(_ routine: Routine) -> String? {
    if let problem = NameField.routine.problem(routine.name) { return problem }
    if routine.entries.isEmpty { return "A routine is at least one movement." }
    if routine.entries.count > 50 { return "Use 50 movements or fewer." }
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
