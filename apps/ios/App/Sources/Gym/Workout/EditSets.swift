import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncCore

// One movement's entry in this workout's plan as Edit sets drafts it (03.29): its planned sets, each keeping the place it
// opened at, and its rest. Saved, the draft becomes the operations that take the entry as it opened to the entry as drawn,
// one per act the lifter took: a set taken out, a target changed, a set added, the rest changed.
@Observable final class EditSetsDraft {
  struct Row: Identifiable, Equatable {
    let id: Int
    let origin: Int?
    var target: SetTarget
  }
  static let maxSets = 20
  static let zeroTarget = "A zero target is no target."
  // The rests a movement may take, 15 s to 15 min; nil is the lifter's rest preference.
  static let rests = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 720, 900]

  let opened: RoutineEntry
  var rows: [Row]
  var restSeconds: Int?
  var open: Int?
  var failure: String?
  private var minted: Int

  init(_ entry: RoutineEntry, opening set: Int?) {
    opened = entry
    let rows = (entry.sets ?? []).enumerated().map { Row(id: $0.offset, origin: $0.offset, target: $0.element) }
    self.rows = rows
    restSeconds = entry.restSeconds
    minted = rows.count
    open = set.flatMap { rows.indices.contains($0) ? $0 : nil }
  }

  var exerciseId: ID<Exercise> { opened.exerciseId }
  var entry: RoutineEntry {
    RoutineEntry(exerciseId: exerciseId, sets: rows.isEmpty ? nil : rows.map(\.target), restSeconds: restSeconds)
  }

  func toggle(_ row: Row) { open = open == row.id ? nil : row.id }
  // A new set copies the last target, and opens.
  func addSet() {
    guard rows.count < Self.maxSets else { return }
    rows.append(Row(id: minted, origin: nil, target: rows.last?.target ?? SetTarget()))
    open = minted; minted += 1
  }
  func delete(_ offsets: IndexSet) {
    rows.remove(atOffsets: offsets)
    if !rows.contains(where: { $0.id == open }) { open = nil }
  }
  func retarget(_ id: Int, _ edit: (inout SetTarget) -> Void) {
    guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
    edit(&rows[index].target)
  }

  // The first set whose target the plan would refuse: a zero, or a load that rounds to one.
  var problem: (row: Int, message: String)? {
    for row in rows {
      do throws(Violation) { _ = try row.target.validated(at: "sets") } catch {
        return (row.id, error.rule == "routine.zeroTarget" ? Self.zeroTarget : "Check this target.")
      }
    }
    return nil
  }

  // Sets taken out go last to first, so each earlier place stands; the sets that stayed keep their order, so each is
  // retargeted at its new place; added sets join at the end, each copying the last target before it is retargeted.
  func operations(at index: Int) -> [WorkoutPlan.Operation] {
    let opening = opened.sets ?? []
    let kept = Set(rows.compactMap(\.origin))
    var operations = opening.indices.reversed().filter { !kept.contains($0) }.map { WorkoutPlan.Operation.removeSet(index: index, set: $0) }
    for (place, row) in rows.enumerated() {
      if let origin = row.origin {
        if opening[origin] != row.target { operations.append(.retarget(index: index, set: place, target: row.target)) }
      } else {
        operations.append(.addSet(index: index))
        let copied = place == 0 ? SetTarget() : rows[place - 1].target
        if copied != row.target { operations.append(.retarget(index: index, set: place, target: row.target)) }
      }
    }
    if restSeconds != opened.restSeconds { operations.append(.setRest(index: index, restSeconds: restSeconds)) }
    return operations
  }
}

// Edit sets (03.29, 03.30): a movement with nothing logged, in this workout only. Each set opens in place on the load field
// and the reps wheel, swipes away, and Add set copies the last; then the rest, Swap movement and Remove from workout. ✓
// saves the whole entry once; Cancel leaves the plan as it was. A set logged on the movement while the sheet is open closes
// it, the plan unchanged.
struct EditSetsSheet: View {
  let gym: GymModel
  let workout: WorkoutState
  @State private var draft: EditSetsDraft
  @State private var plan: SessionPlan?
  @State private var typedLoad: Double?
  // What waits on a load still being typed: the field lands its value as it lets go, then this runs.
  @State private var afterLoad: (() -> Void)?
  @State private var swapping = false
  @FocusState private var loadFocused: Bool
  @Environment(\.dismiss) private var dismiss

  init(gym: GymModel, workout: WorkoutState, exerciseId: ID<Exercise>, opening set: Int?) {
    self.gym = gym; self.workout = workout
    let entry = workout.session?.plan?.entries.first { $0.exerciseId == exerciseId } ?? RoutineEntry(exerciseId: exerciseId)
    _draft = State(initialValue: EditSetsDraft(entry, opening: set))
    _plan = State(initialValue: workout.session?.plan)
  }

  var movement: Exercise? { gym.catalogue.find(draft.exerciseId) }
  var name: String { movement?.name ?? "Movement" }
  var basis: MovementEquipment { MovementEquipment(movement) }
  // A set the plan leaves open starts its field where the rack would: the movement's last load and reps.
  var opening: Prefill { Prefill.of(todaySets: [], planEntry: nil, lastTime: gym.log?.lastTime(for: draft.exerciseId)) }

  var body: some View {
    NavigationStack {
      List {
        Group {
          Section {
            ForEach(Array(draft.rows.enumerated()), id: \.element.id) { place, row in setRow(row, place: place) }
              .onDelete { draft.delete($0) }
            Button { landingLoad { draft.addSet() } } label: { Label("Add set", systemImage: "plus") }
              .foregroundStyle(GymPalette.accent).disabled(draft.rows.count >= EditSetsDraft.maxSets)
              .accessibilityIdentifier("edit-sets-add")
          }
          Section {
            Picker("Rest", selection: $draft.restSeconds) {
              Text("Default").tag(Int?.none)
              ForEach(EditSetsDraft.rests + (draft.restSeconds.map { EditSetsDraft.rests.contains($0) ? [] : [$0] } ?? []), id: \.self) { seconds in
                Text(WorkoutClocks.reading(Int64(seconds) * 1_000)).tag(Int?.some(seconds))
              }
            }.pickerStyle(.menu).tint(GymPalette.accent).foregroundStyle(GymPalette.ink).accessibilityIdentifier("edit-sets-rest")
          }
          Section {
            Button { swapping = true } label: {
              HStack {
                Text("Swap movement").foregroundStyle(GymPalette.ink)
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkFaint)
              }.contentShape(Rectangle())
            }.accessibilityIdentifier("edit-sets-swap")
            Button("Remove from workout", role: .destructive) {
              workout.remove(draft.exerciseId)
              if !workout.walk.order.contains(draft.exerciseId) { dismiss() } else { draft.failure = workout.message; workout.message = nil }
            }.foregroundStyle(GymPalette.destructive).accessibilityIdentifier("edit-sets-remove")
          }
        }.listRowBackground(GymPalette.card)
      }.listSectionSpacing(.compact).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .modifier(GymPage()).disabled(gym.accountTransition)
        .roomTitle("Edit sets", subtitle: "\(name) · this workout")
        .navigationBarTitleDisplayMode(.inline)
        .sheetCommit("Save", identifier: "edit-sets-save", dismissalIdentifier: "edit-sets-cancel", disabled: gym.accountTransition,
                     dismiss: { dismiss() }, commit: commit)
        .reachBand {
          GymTransient(gym: gym, message: draft.failure, dismiss: draft.failure == nil ? nil : { draft.failure = nil },
                       errorIdentifier: "edit-sets-failure")
        }
        .navigationDestination(isPresented: $swapping) {
          MovementPicker(gym: gym, purpose: .swap(name), selected: Set(workout.walk.order), onSelect: { entry in
            guard let index = workout.planIndex(draft.exerciseId) else { return }
            if workout.swap(draft.exerciseId, to: entry.exerciseId, after: draft.operations(at: index), against: plan) { dismiss() }
            else { swapping = false; draft.failure = workout.message; workout.message = nil }
          })
        }
    }.modifier(GymPage()).presentationDetents([.large])
      .onChange(of: workout.ledger(draft.exerciseId).sets.isEmpty) { _, nothingLogged in
        guard !nothingLogged else { return }
        workout.message = WorkoutState.loggedNow(name)
        dismiss()
      }
      .onChange(of: gym.account) { _, _ in dismiss() }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "edit_sets"]) }
  }

  @ViewBuilder func setRow(_ row: EditSetsDraft.Row, place: Int) -> some View {
    let current = place == 0, opened = draft.open == row.id
    VStack(spacing: 0) {
      Button { landingLoad { draft.toggle(row) } } label: {
        HStack(spacing: RoomSpace.related) {
          Text("\(place + 1)").font(.footnote.monospacedDigit()).foregroundStyle(current ? GymPalette.accent : GymPalette.inkFaint)
            .frame(minWidth: 20, alignment: .leading)
          Text(Readout.setTarget(row.target)).foregroundStyle(GymPalette.ink).monospacedDigit()
          Spacer(minLength: RoomSpace.related)
          if current { Image(systemName: "circle.fill").font(.system(size: RoomSpace.related)).foregroundStyle(GymPalette.accent) }
          else if !opened { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkFaint) }
        }.frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
      }.buttonStyle(.plain)
        .accessibilityLabel("Set \(place + 1), planned, \(WorkoutLedgerRow.asked(row.target) ?? "open target")")
        .accessibilityHint(opened ? "Closes this set." : "Opens this set.")
        .accessibilityIdentifier("edit-sets-set-\(place + 1)")
      if opened { editor(row) }
    }.listRowInsets(EdgeInsets(top: 0, leading: RoomSpace.inset, bottom: 0, trailing: RoomSpace.inset))
      .listRowBackground(GymPalette.card.overlay(opened ? GymPalette.accentSoft : .clear))
  }

  // The open set's numbers as Fix set draws them (03.30): its Load row over the reps wheel; a target the plan refuses says so
  // under the field.
  @ViewBuilder func editor(_ row: EditSetsDraft.Row) -> some View {
    let load = row.target.weightKg ?? opening.weightKg
    Divider().overlay(GymPalette.line)
    LoadRow(weightKg: Binding(get: { typedLoad ?? load }, set: { typedLoad = $0 }), basis: basis, focus: $loadFocused,
            identifier: "edit-sets-load", ended: {
              let value = typedLoad ?? load
              typedLoad = nil
              if value != load { draft.retarget(row.id) { $0.weightKg = value } }
              let next = afterLoad; afterLoad = nil; next?()
            }).frame(minHeight: RoomSpace.minimumTarget)
    if let problem = draft.problem, problem.row == row.id {
      Text(problem.message).font(.footnote).foregroundStyle(GymPalette.alarm).frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("edit-sets-problem")
    }
    RepsWheel(reps: Binding(get: { row.target.reps ?? opening.reps }, set: { reps in draft.retarget(row.id) { $0.reps = reps } }),
              identifier: "edit-sets-reps").frame(height: 140).clipped()
  }

  // A load still being typed lands before anything changes which set is open, and before the save.
  func landingLoad(_ action: @escaping () -> Void) {
    guard loadFocused else { action(); return }
    afterLoad = action; loadFocused = false
  }

  func commit() { landingLoad(save) }

  func save() {
    if let problem = draft.problem { draft.open = problem.row; return }
    guard let index = workout.planIndex(draft.exerciseId) else { dismiss(); return }
    guard workout.revise(draft.operations(at: index), against: plan) else { draft.failure = workout.message; workout.message = nil; return }
    dismiss()
  }
}
