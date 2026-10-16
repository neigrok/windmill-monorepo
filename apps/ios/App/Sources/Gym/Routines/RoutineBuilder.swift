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
  // A refusal answers an attempt — a Save, or leaving a name the owner changed — and the next edit clears it.
  var draft: Draft<Routine> { didSet { if draft.current != oldValue.current { refusal = nil } } }
  var path: [Step] = []
  var query = ""
  var creation: MovementCreationDraft?
  var targetDraft = RoutineTargetDraft(sets: nil)
  var saving = false
  var saved = false
  var editMode = EditMode.inactive
  var refusal: String?
  var removed: (index: Int, entry: RoutineEntry)?
  var removals = 0
  var appeared = false

  init(gym: GymModel, routine: Routine?) {
    account = gym.account; anonymous = gym.isAnonymous
    let initialDraft = routine.map { Draft(opening: $0) } ?? Draft(new: Routine(id: gym.runner.mint(Routine.self), position: (gym.routines.map(\.position).max() ?? -1) + 1))
    draft = initialDraft
    id = initialDraft.id
  }

  func leaveName() {
    guard draft.current.name != draft.base.name, let problem = MovementName.problem(draft.current.name) else { return }
    refusal = problem
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
    var draft = creation ?? MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: "")
    draft.takeQuery(query)
    creation = draft; path.append(.creation)
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
      refusal = "The account changed while editing. Open the routine again."; return false
    }
    if let problem = RoutinePlanning.problem(draft.current) { refusal = problem; return false }
    saving = true
    defer { saving = false }
    if gym.saveRoutine(&draft) { saved = true; return true }
    refusal = gym.error ?? "This routine could not be saved. Try again."
    return false
  }
  // A routine's delete keeps the room's nine-second Undo, so it asks nothing and happens at once.
  @discardableResult func delete(_ gym: GymModel) -> Bool {
    guard account == gym.account, anonymous == gym.isAnonymous else {
      refusal = "The account changed while editing. Open the routine again."; return false
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
  @FocusState private var nameFocused: Bool
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    NavigationStack(path: Binding(get: { editing.path }, set: { editing.follow($0) })) {
      plan
        .navigationTitle(editing.draft.isNew ? "New routine" : "Edit routine").navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("routine-builder")
        .sheetCommit("Save", identifier: "save-routine", disabled: gym.accountTransition || !editing.draft.isDirty, busy: editing.saving,
                     dismiss: { dismiss() }, commit: save)
        .reachBand {
          GymTransient(gym: gym, message: editing.refusal,
                       held: editing.removed.map { _ in GymTransient.Held(text: "Movement removed", undo: editing.undoRemoval) },
                       errorIdentifier: "routine-refusal", undoIdentifier: "builder-undo")
        }
        .navigationDestination(for: RoutineEditingSession.Step.self, destination: destination)
        .onAppear {
          if !editing.appeared { nameFocused = editing.draft.isNew; editing.appeared = true }
          gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_editor"])
        }
        .onChange(of: editing.path) { _, _ in nameFocused = false }
        .onChange(of: nameFocused) { _, focused in if !focused { editing.leaveName() } }
        // A removed movement's Undo lasts the room's nine seconds, like every other held change.
        .task(id: editing.removals) {
          guard editing.removed != nil else { return }
          try? await Task.sleep(for: .seconds(9))
          if !Task.isCancelled { editing.removed = nil }
        }
        .sensoryFeedback(.selection, trigger: editing.draft.current.entries.map(\.exerciseId))
        .sensoryFeedback(.success, trigger: editing.saved)
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
        Section {
          ForEach(Array(editing.draft.current.entries.enumerated()), id: \.element.exerciseId) { index, entry in
            let exercise = gym.catalogue.find(entry.exerciseId)
            NavigationLink(value: exercise.map { RoutineEditingSession.Step.targets($0.id) }) {
              GymRow(title: "\(index + 1). \(exercise?.name ?? "Movement unavailable")", meta: Readout.target(entry.sets))
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
        } header: {
          // At accessibility sizes Reorder stands under the header, so the header's one word never breaks.
          let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small)) : AnyLayout(HStackLayout())
          layout {
            Text("Movements").frame(maxWidth: .infinity, alignment: .leading)
            if editing.draft.current.entries.count > 1 {
              Button(editing.editMode.isEditing ? "Done" : "Reorder") { editing.editMode = editing.editMode.isEditing ? .inactive : .active }
                .font(.subheadline).textCase(nil).accessibilityIdentifier("reorder-movements")
            }
          }
        }
        let history = gym.routineHistory(editing.draft.id).prefix(20), dates = gym.log.map { GymDate($0.moment) } ?? GymDate()
        if !history.isEmpty {
          Section("History") {
            ForEach(history, id: \.id) { session in
              GymRow(title: dates.subtitle(session.startedAt), meta: RoutineLines.session(SessionReadout(session: session, sets: gym.sets)))
            }
          }
        }
        if !editing.draft.isNew {
          Section {
            Button("Delete routine", systemImage: "trash", role: .destructive) { delete() }
              .foregroundStyle(GymPalette.alarm).disabled(gym.accountTransition).accessibilityIdentifier("delete-routine")
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
