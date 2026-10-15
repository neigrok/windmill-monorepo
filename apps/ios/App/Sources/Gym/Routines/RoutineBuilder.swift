import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncCore

@Observable @MainActor
final class RoutineEditingSession: Identifiable {
  enum Step: Hashable { case movements, creation, targets(DomainKit.ID<Exercise>) }
  let id: ID<Routine>
  let account: String?
  let anonymous: Bool
  var draft: Draft<Routine>
  var path: [Step] = []
  var query = ""
  var creation: MovementCreationDraft?
  var targetDraft = RoutineTargetDraft(sets: nil)
  var saving = false
  var saved = false
  var editMode = EditMode.inactive
  var failure: String?
  var removed: (index: Int, entry: RoutineEntry)?
  var removals = 0
  var appeared = false

  init(gym: GymModel, routine: Routine?) {
    account = gym.account; anonymous = gym.isAnonymous
    let initialDraft = routine.map { Draft(opening: $0) } ?? Draft(new: Routine(id: gym.runner.mint(Routine.self), position: (gym.routines.map(\.position).max() ?? -1) + 1))
    draft = initialDraft
    id = initialDraft.id
  }

  var refusal: String? {
    if let failure { return failure }
    return draft.isDirty && removed == nil ? RoutinePlanning.problem(draft.current) : nil
  }

  // The stack hands every link push here, so a targets screen opens on the scheme its movement holds now.
  func follow(_ next: [Step]) {
    if case .targets(let exerciseId)? = next.last, next.last != path.last {
      targetDraft = RoutineTargetDraft(sets: exerciseId == creation?.id ? creation?.sets : draft.current.entries.first { $0.exerciseId == exerciseId }?.sets)
    }
    path = next
  }
  func pickMovement() {
    query = ""; creation = nil; path = [.movements]
  }
  func createMovement(_ gym: GymModel) {
    if creation == nil { creation = MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: MovementName.capped(MovementName.trimmed(query))) }
    path.append(.creation)
  }
  func cancelTargets() {
    if case .targets? = path.last { path.removeLast() }
  }
  func setTargets(_ sets: [SetTarget]?) {
    guard case .targets(let exerciseId)? = path.last else { return }
    var transaction = Transaction(animation: nil); transaction.disablesAnimations = true
    withTransaction(transaction) {
      if exerciseId == creation?.id { creation?.sets = sets; creation?.refusal = nil }
      else if let index = draft.current.entries.firstIndex(where: { $0.exerciseId == exerciseId }) { draft.current.entries[index].sets = sets }
      path.removeLast()
    }
  }
  func select(_ entry: RoutineEntry) {
    guard draft.current.entries.count < 50, !draft.current.entries.contains(where: { $0.exerciseId == entry.exerciseId }) else { return }
    var transaction = Transaction(animation: nil); transaction.disablesAnimations = true
    withTransaction(transaction) {
      if removed?.entry.exerciseId == entry.exerciseId { removed = nil }
      draft.current.entries.append(entry); path = []
    }
  }
  func move(_ index: Int, by offset: Int) {
    let destination = index + offset
    guard draft.current.entries.indices.contains(index), draft.current.entries.indices.contains(destination) else { return }
    draft.current.entries.swapAt(index, destination)
  }
  func remove(_ index: Int) {
    guard draft.current.entries.indices.contains(index) else { return }
    removed = (index, draft.current.entries.remove(at: index)); removals += 1
  }
  func undoRemoval() {
    guard let (index, entry) = removed, draft.current.entries.count < 50 else { return }
    draft.current.entries.insert(entry, at: min(index, draft.current.entries.count)); removed = nil
  }
  @discardableResult func save(_ gym: GymModel) -> Bool {
    guard account == gym.account, anonymous == gym.isAnonymous else {
      failure = "The account changed while editing. Open the routine again."; return false
    }
    saving = true
    defer { saving = false }
    if gym.saveRoutine(&draft) { saved = true; return true }
    failure = gym.error ?? "This routine could not be saved. Try again."
    return false
  }
}

struct RoutineBuilder: View {
  let gym: GymModel
  @Bindable var editing: RoutineEditingSession
  let onSave: (ID<Routine>) -> Void
  @FocusState private var nameFocused: Bool
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack(path: Binding(get: { editing.path }, set: { editing.follow($0) })) {
      plan
        .navigationTitle(editing.draft.isNew ? "New routine" : "Edit routine").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
          GymTransient(gym: gym, message: editing.refusal,
                       held: editing.removed.map { _ in GymTransient.Held(text: "Movement removed", undo: editing.undoRemoval) },
                       errorIdentifier: "routine-refusal", undoIdentifier: "builder-undo")
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(editing.saving) }
          if editing.draft.current.entries.count > 1 {
            ToolbarItem(placement: .topBarTrailing) {
              Button(editing.editMode.isEditing ? "Done reordering" : "Reorder") { editing.editMode = editing.editMode.isEditing ? .inactive : .active }
                .accessibilityIdentifier("reorder-movements")
            }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(editing.saving ? "Saving…" : "Save") { save() }
              .disabled(editing.saving || gym.accountTransition || !editing.draft.isDirty || RoutinePlanning.problem(editing.draft.current) != nil).accessibilityIdentifier("save-routine")
          }
        }
        .navigationDestination(for: RoutineEditingSession.Step.self, destination: destination)
        .onAppear {
          if !editing.appeared { nameFocused = editing.draft.isNew; editing.appeared = true }
          gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_editor"])
        }
        .onChange(of: editing.path) { _, _ in nameFocused = false }
        .onChange(of: editing.draft.current) { _, _ in editing.failure = nil }
        // A removed movement's Undo lasts the room's nine seconds, like every other held change.
        .task(id: editing.removals) {
          guard editing.removed != nil else { return }
          try? await Task.sleep(for: .seconds(9))
          if !Task.isCancelled { editing.removed = nil }
        }
        .sensoryFeedback(.selection, trigger: editing.draft.current.entries.map(\.exerciseId))
        .sensoryFeedback(.success, trigger: editing.saved)
        .accessibilityIdentifier("routine-builder")
    }.modifier(GymPage()).presentationDetents([.large])
  }

  var plan: some View {
    List {
      Group {
        Section {
          TextField("Name", text: $editing.draft.current.name).focused($nameFocused)
            .onSubmit { nameFocused = false }.accessibilityIdentifier("routine-name")
          if let counter = MovementName.counter(editing.draft.current.name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
        }
        Section("Movements") {
          ForEach(Array(editing.draft.current.entries.enumerated()), id: \.element.exerciseId) { index, entry in
            let exercise = gym.catalogue.find(entry.exerciseId)
            NavigationLink(value: exercise.map { RoutineEditingSession.Step.targets($0.id) }) {
              GymRow(title: exercise?.name ?? "Movement unavailable", meta: Readout.target(entry.sets))
            }.accessibilityIdentifier("builder-movement-\(entry.exerciseId)")
              .swipeActions { Button("Remove", role: .destructive) { editing.remove(index) } }
              .contextMenu {
                Button("Move up") { editing.move(index, by: -1) }.disabled(index == 0)
                Button("Move down") { editing.move(index, by: 1) }.disabled(index == editing.draft.current.entries.count - 1)
                Button("Remove movement", role: .destructive) { editing.remove(index) }
              }
              .accessibilityAction(named: "Move up") { editing.move(index, by: -1) }
              .accessibilityAction(named: "Move down") { editing.move(index, by: 1) }
              .accessibilityAction(named: "Remove movement") { editing.remove(index) }
          }.onMove { source, destination in editing.draft.current.entries.move(fromOffsets: source, toOffset: destination) }
          Button("Add movement", systemImage: "plus.circle.fill") { nameFocused = false; editing.pickMovement() }
            .accessibilityIdentifier("add-movement").disabled(editing.draft.current.entries.count >= 50)
        }
        let history = gym.routineHistory(editing.draft.id).prefix(20)
        if !history.isEmpty {
          Section("History") {
            ForEach(history, id: \.id) { session in
              GymRow(title: RoutineLines.day(session.startedAt, now: gym.log?.moment.now ?? session.startedAt),
                          meta: RoutineLines.session(SessionReadout(session: session, sets: gym.sets)))
            }
          }
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).modifier(GymPage()).environment(\.editMode, $editing.editMode)
  }

  @ViewBuilder func destination(_ step: RoutineEditingSession.Step) -> some View {
    switch step {
    case .movements:
      MovementPicker(gym: gym, purpose: .routine, selected: Set(editing.draft.current.entries.map(\.exerciseId)), query: $editing.query,
                     onCreate: { editing.createMovement(gym) }, onCancel: { editing.follow([]) }) { editing.select($0) }
        .navigationBarBackButtonHidden()
    case .creation:
      if let creation = editing.creation {
        CreateMovementSheet(gym: gym, draft: Binding(get: { editing.creation ?? creation }, set: { editing.creation = $0 }), purpose: .routine,
                            account: editing.account, anonymous: editing.anonymous,
                            onCancel: { if editing.path.last == .creation { editing.follow(Array(editing.path.dropLast())) } }) { editing.select($0) }
          .navigationBarBackButtonHidden()
      }
    case .targets(let exerciseId):
      if let exercise = exerciseId == editing.creation?.id ? editing.creation?.exercise : gym.catalogue.find(exerciseId) {
        RoutineTargetsSheet(gym: gym, exercise: exercise, draft: $editing.targetDraft,
                            onCancel: { editing.cancelTargets() }, onCommit: { editing.setTargets($0) })
          .navigationBarBackButtonHidden()
      }
    }
  }

  private func save() {
    if editing.save(gym) { onSave(editing.id); dismiss() }
  }
}

enum RoutinePlanning {
  static func problem(_ routine: Routine) -> String? {
    if let problem = MovementName.problem(routine.name) { return problem }
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
