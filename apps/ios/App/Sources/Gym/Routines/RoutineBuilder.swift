import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncCore

@Observable @MainActor
final class RoutineEditingSession: Identifiable {
  enum Step: Hashable { case movements, creation, targets }
  let id: ID<Routine>
  let account: String?
  let anonymous: Bool
  var draft: Draft<Routine>
  var path: [Step] = []
  var query = ""
  var creation: MovementCreationDraft?
  var targetExercise: Exercise?
  var targetDraft = RoutineTargetDraft(sets: nil)
  var targetIsCreation = false
  var saving = false
  var saved = false
  var editMode = EditMode.inactive
  var failure: String?
  var removed: (Int, RoutineEntry)?
  var appeared = false

  init(gym: GymModel, routine: Routine?) {
    account = gym.account; anonymous = gym.isAnonymous
    let initialDraft = routine.map { Draft(opening: $0) } ?? Draft(new: Routine(id: gym.runner.mint(Routine.self), position: (gym.routines.map(\.position).max() ?? -1) + 1))
    draft = initialDraft
    id = initialDraft.id
  }
  func pickMovement() {
    query = ""; creation = nil; path = [.movements]
  }
  func createMovement(_ gym: GymModel) {
    if creation == nil { creation = MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: MovementName.capped(MovementName.trimmed(query))) }
    path.append(.creation)
  }
  func openTargets(exercise: Exercise, sets: [SetTarget]?, creation: Bool = false) {
    targetExercise = exercise; targetDraft = RoutineTargetDraft(sets: sets); targetIsCreation = creation
    path.append(.targets)
  }
  func cancelTargets() {
    let sets = targetIsCreation ? creation?.sets : draft.current.entries.first { $0.exerciseId == targetExercise?.id }?.sets
    targetDraft = RoutineTargetDraft(sets: sets)
    if path.last == .targets { path.removeLast() }
  }
  func setTargets(_ sets: [SetTarget]?) {
    guard path.last == .targets, let targetExercise else { return }
    var transaction = Transaction(animation: nil); transaction.disablesAnimations = true
    withTransaction(transaction) {
      if targetIsCreation { creation?.sets = sets; creation?.refusal = nil }
      else if let index = draft.current.entries.firstIndex(where: { $0.exerciseId == targetExercise.id }) { draft.current.entries[index].sets = sets }
      path.removeLast()
    }
  }
  func select(_ entry: RoutineEntry) {
    guard draft.current.entries.count < 50, !draft.current.entries.contains(where: { $0.exerciseId == entry.exerciseId }) else { return }
    var transaction = Transaction(animation: nil); transaction.disablesAnimations = true
    withTransaction(transaction) {
      if removed?.1.exerciseId == entry.exerciseId { removed = nil }
      draft.current.entries.append(entry); path = []
    }
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
    NavigationStack(path: $editing.path) {
      List {
        Group {
          Section("Name") {
            TextField("Routine name", text: $editing.draft.current.name).focused($nameFocused).submitLabel(.done)
              .onSubmit { nameFocused = false }.accessibilityIdentifier("routine-name")
            if editing.draft.current.name.unicodeScalars.count >= 48 { Text("\(editing.draft.current.name.unicodeScalars.count)/60").font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
          }
          Section("Movements") {
            ForEach(Array(editing.draft.current.entries.enumerated()), id: \.element.exerciseId) { index, entry in
              Button {
                nameFocused = false
                if let exercise = gym.catalogue.find(entry.exerciseId) { editing.openTargets(exercise: exercise, sets: entry.sets) }
              } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(gym.catalogue.find(entry.exerciseId)?.name ?? "Movement unavailable").foregroundStyle(GymPalette.ink)
                  Text(Readout.target(entry.sets)).font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
                }
              }.accessibilityIdentifier("builder-movement-\(entry.exerciseId)")
                .swipeActions { Button("Remove", role: .destructive) { remove(index) } }
                .contextMenu {
                  Button("Move up") { move(index, by: -1) }.disabled(index == 0)
                  Button("Move down") { move(index, by: 1) }.disabled(index == editing.draft.current.entries.count - 1)
                  Button("Remove movement", role: .destructive) { remove(index) }
                }
                .accessibilityAction(named: "Move up") { move(index, by: -1) }
                .accessibilityAction(named: "Move down") { move(index, by: 1) }
                .accessibilityAction(named: "Remove movement") { remove(index) }
            }.onMove { source, destination in editing.draft.current.entries.move(fromOffsets: source, toOffset: destination) }
            Button("Add movement", systemImage: "plus.circle.fill") { nameFocused = false; editing.pickMovement() }
              .accessibilityIdentifier("add-movement").disabled(editing.draft.current.entries.count >= 50)
          }
          if let removed = editing.removed, editing.draft.current.entries.count < 50 { Section { Button("Undo movement removal") {
            editing.draft.current.entries.insert(removed.1, at: min(removed.0, editing.draft.current.entries.count)); editing.removed = nil
          } } }
          if editing.draft.isDirty || editing.failure != nil, let problem = editing.failure ?? RoutinePlanning.problem(editing.draft.current) {
            Section { Text(problem).foregroundStyle(.red).accessibilityIdentifier("routine-refusal") }
          }
          RoutineNotice(gym: gym, excluding: editing.failure)
          if !editing.draft.isNew { Section("History") {
            ForEach(gym.routineHistory(editing.draft.id).prefix(20), id: \.id) { session in Text(Date(timeIntervalSince1970: Double(session.startedAt.ms) / 1000), style: .date) }
            if gym.readFailed { Text("The log didn’t answer — this routine’s history is out of reach.") }
          } }
        }.listRowBackground(GymPalette.card)
      }.listStyle(.insetGrouped).modifier(GymPage()).environment(\.editMode, $editing.editMode)
        .navigationTitle(editing.draft.isNew ? "New routine" : "Edit routine").navigationBarTitleDisplayMode(.inline)
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
        .navigationDestination(for: RoutineEditingSession.Step.self) { step in
          switch step {
          case .movements:
            MovementPicker(gym: gym, selected: Set(editing.draft.current.entries.map(\.exerciseId)), includesTargets: true, query: $editing.query,
                           onCreate: { editing.createMovement(gym) }, onCancel: { editing.path = [] }) { editing.select($0) }
              .navigationBarBackButtonHidden()
          case .creation:
            if let creation = editing.creation {
              CreateMovementSheet(gym: gym, draft: Binding(get: { editing.creation ?? creation }, set: { editing.creation = $0 }), includesTargets: true,
                                  account: editing.account, anonymous: editing.anonymous,
                                  onCancel: { if editing.path.last == .creation { editing.path.removeLast() } },
                                  onTargets: { if let creation = editing.creation { editing.openTargets(exercise: creation.exercise, sets: creation.sets, creation: true) } }) { editing.select($0) }
                .navigationBarBackButtonHidden()
            }
          case .targets:
            if let exercise = editing.targetExercise {
              RoutineTargetsSheet(gym: gym, exercise: exercise, draft: $editing.targetDraft,
                                  onCancel: { editing.cancelTargets() }, onCommit: { editing.setTargets($0) })
                .navigationBarBackButtonHidden()
            }
          }
        }
        .onAppear {
          if !editing.appeared { nameFocused = editing.draft.isNew; editing.appeared = true }
          gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_editor"])
        }
        .onChange(of: editing.draft.current) { _, _ in editing.failure = nil }
        .sensoryFeedback(.selection, trigger: editing.draft.current.entries.map(\.exerciseId))
        .sensoryFeedback(.success, trigger: editing.saved)
        .accessibilityIdentifier("routine-builder")
    }.modifier(GymPage())
  }
  private func remove(_ index: Int) {
    guard editing.draft.current.entries.indices.contains(index) else { return }
    editing.removed = (index, editing.draft.current.entries.remove(at: index))
  }
  private func move(_ index: Int, by offset: Int) {
    let destination = index + offset
    guard editing.draft.current.entries.indices.contains(destination) else { return }
    editing.draft.current.entries.swapAt(index, destination)
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
  var routinesByLastTraining: [Routine] {
    let latest = Dictionary(grouping: sessions.filter { !$0.isOpen && $0.historyRoutineId != nil }, by: { $0.historyRoutineId! })
      .mapValues { $0.map(\.startedAt.ms).max() ?? Int64.min }
    return routines.sorted {
      let a = latest[$0.id] ?? Int64.min, b = latest[$1.id] ?? Int64.min
      if a != b { return a > b }
      return $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position
    }
  }
  var waitingRoutineProposals: [Proposal] {
    let pending = proposals.filter { $0.state == "pending" && $0.supersededBy == nil }
    do {
      let born: [ID<Proposal>: Stamp] = try runner.read(Routine.scope) { read in
        try Dictionary(uniqueKeysWithValues: pending.map { ($0.id, try read.repository(Proposal.self).record($0.id, in: .drawn)?.born ?? .unset) })
      }
      return pending.sorted {
        let a = born[$0.id] ?? .unset, b = born[$1.id] ?? .unset
        return a == b ? $0.id < $1.id : a > b
      }
    } catch { report("gym_read", error); return pending }
  }
  func routineHistory(_ id: ID<Routine>) -> [Session] {
    sessions.filter { !$0.isOpen && $0.historyRoutineId == id }.sorted { $0.startedAt > $1.startedAt }
  }
  @discardableResult func saveRoutine(_ draft: inout Draft<Routine>) -> Bool {
    if let problem = RoutinePlanning.problem(draft.current) { error = problem; return false }
    let creating = draft.isNew
    guard case .saved(let receipt) = save(&draft) else { return false }
    if receipt != nil { telemetry.event("gym_routine_saved", properties: ["action": creating ? "create" : "update", "storage": "device"]) }
    return true
  }
}
