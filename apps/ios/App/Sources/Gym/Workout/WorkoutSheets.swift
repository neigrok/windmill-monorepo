import SwiftUI
import DomainKit
import GymDomain
import SyncCore

// This workout (03.4): each movement's working sets against its plan, a gym/done check once every planned set is logged, Add
// movement as the list's last row, and Hide workout.
struct WorkoutAssembly: View {
  @Bindable var workout: WorkoutState
  let add: () -> Void
  @Environment(\.dismiss) var dismiss
  @State private var exerciseToEdit: Exercise?
  var body: some View {
    NavigationStack {
      List {
        Group {
          Section {
            ForEach(Array(workout.walk.order.enumerated()), id: \.element) { index, id in
              let ledger = workout.ledger(id), exercise = workout.gym.catalogue.find(id)
              OrderedMovementRow(exercise: exercise, index: index, count: workout.walk.order.count,
                                 removable: workout.canRemove(id), identifier: "workout-movement-\(id)",
                                 open: { workout.select(id); if workout.selected == id { dismiss() } },
                                 move: { move(index, by: $0) }, remove: { workout.remove(id) }, edit: { exerciseToEdit = $0 }) {
                GymRow(title: exercise?.name ?? "Movement", meta: ledger.tally, trailing: ledger.complete ? .check : nil)
                  .tint(GymPalette.done)
              }.accessibilityAddTraits(workout.selected == id ? .isSelected : [])
                .moveDisabled(workout.finishing)
            }.onMove { workout.move(from: $0, to: $1) }
            Button("Add movement", systemImage: "plus.circle.fill", action: add).accessibilityIdentifier("workout-assembly-add")
          }
          Section {
            Button("Hide workout") { if workout.gym.hideWorkout() { dismiss() } }
              .disabled(workout.finishing || workout.gym.accountTransition).accessibilityIdentifier("workout-hide")
          }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).navigationTitle("This workout").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        }.roomBar(.gym)
        .reachBand {
          GymTransient(gym: workout.gym, message: workout.message, dismiss: { workout.message = nil }, noticeMessage: workout.gym.workoutNotice,
                       retry: { workout.retryRead() }, errorIdentifier: "workout-refusal")
            .modifier(BoundedBand())
        }
    }.modifier(GymPage()).presentationDetents([.large])
      .sheet(isPresented: Binding(get: { exerciseToEdit != nil }, set: { if !$0 { exerciseToEdit = nil } })) {
        if let exerciseToEdit { RenameMovementSheet(gym: workout.gym, exercise: exerciseToEdit) }
      }
  }

  func move(_ index: Int, by offset: Int) {
    let target = index + offset
    guard workout.walk.order.indices.contains(target), !workout.finishing else { return }
    workout.move(from: IndexSet(integer: index), to: offset > 0 ? target + 1 : target)
  }
}

// The rack's load and reps on the wheels (03.2), committed together by the checkmark; Cancel keeps the rack.
struct SetWheelSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
  let title: String
  let movement: String
  let basis: MovementEquipment
  let commit: (Double, Int) -> Void
  @State private var weightKg: Double
  @State private var reps: Int

  init(title: String, movement: String, basis: MovementEquipment, weightKg: Double, reps: Int, commit: @escaping (Double, Int) -> Void) {
    self.title = title; self.movement = movement; self.basis = basis; self.commit = commit
    _weightKg = State(initialValue: weightKg); _reps = State(initialValue: reps)
  }

  var body: some View {
    NavigationStack {
      SetWheels(weightKg: $weightKg, reps: $reps, basis: basis)
        .padding(.horizontal, RoomSpace.inset)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(GymPalette.card.ignoresSafeArea())
        .modifier(GymPage())
        .roomTitle(title, subtitle: movement)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("set-wheel-cancel") }
          ToolbarItem(placement: .topBarTrailing) {
            Button("Done", systemImage: "checkmark") { commit(weightKg, reps); dismiss() }.accessibilityIdentifier("set-wheel-done")
          }
        }.roomBar(.gym)
    }.modifier(GymPage()).presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.height(380)])
  }
}

struct WorkoutMovementPicker: View {
  let gym: GymModel
  let workout: WorkoutState
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      MovementPicker(gym: gym, purpose: .workout, selected: Set(workout.walk.order),
                     onBuildRoutine: { if gym.hideWorkout() { workout.handoff = .writtenProgram } },
                     onSelect: { workout.add($0.exerciseId); dismiss() })
    }.modifier(GymPage()).presentationDetents([.large])
  }
}

// Heavier than the plan: leaving a movement raises it, so no control the lifter touched can anchor it, and one target asks
// once in an alert; a varied scheme opens its before and after rows in a sheet. Only the alert's answers and the sheet's two
// bar actions resolve the offer.
struct WorkoutDeviationOffer: ViewModifier {
  @Bindable var workout: WorkoutState
  let held: Bool

  func body(content: Content) -> some View {
    let offer = held ? nil : workout.deviation
    content
      .alert(offer.map { $0.saveLabel + "?" } ?? "", isPresented: .constant(offer.map { !$0.varied } ?? false), presenting: offer) { offer in
        Button("Save to \(offer.routine)") { workout.resolveDeviation(save: true) }
          .disabled(workout.gym.accountTransition).accessibilityIdentifier("workout-deviation-save")
        Button("Today only", role: .cancel) { workout.resolveDeviation(save: false) }.accessibilityIdentifier("workout-deviation-today")
      } message: { _ in Text("Today’s workout already has it.") }
      .sheet(isPresented: Binding(get: { offer?.varied == true }, set: { if !$0 { workout.resolveDeviation(save: false) } })) {
        if let offer { WorkoutDeviationSheet(workout: workout, offer: offer) }
      }
  }
}

struct WorkoutDeviationSheet: View {
  @Bindable var workout: WorkoutState
  let offer: WorkoutDeviation
  var body: some View {
    let offer = workout.deviation ?? self.offer
    NavigationStack {
      List {
        Section {
          ForEach(0..<max(offer.scheme.count, offer.proposed.count), id: \.self) { index in
            LabeledContent("Set \(index + 1)") {
              Text("\(index < offer.scheme.count ? Readout.setTarget(offer.scheme[index]) : "—") → \(index < offer.proposed.count ? Readout.setTarget(offer.proposed[index]) : "—")")
                .font(.body.monospacedDigit())
            }
          }
        } footer: { Text(offer.sentence(workout.gym.catalogue.find(offer.exerciseId)?.name ?? "movement")) }
          .listRowBackground(GymPalette.card)
      }.modifier(GymPage()).roomTitle("Heavier than the plan", subtitle: offer.routine)
        .sheetCommit("Save", identifier: "workout-deviation-save", dismissal: "Today only", dismissalIdentifier: "workout-deviation-today",
                     disabled: workout.gym.accountTransition, dismiss: { workout.resolveDeviation(save: false) },
                     commit: { workout.resolveDeviation(save: true) })
        .reachBand {
          GymTransient(gym: workout.gym, message: workout.message, dismiss: { workout.message = nil },
                       noticeMessage: workout.gym.workoutNotice, errorIdentifier: "workout-refusal")
        }
    }.modifier(GymPage()).presentationDetents([.medium])
  }
}
