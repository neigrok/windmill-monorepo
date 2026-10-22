import SwiftUI
import DomainKit
import GymDomain
import SyncCore

// This workout: each movement's working sets against its plan, a gym/done check once every planned set is logged, Add movement
// as the list's last row, and Hide workout.
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
            ForEach(workout.walk.order, id: \.self) { id in
              HStack {
                Button {
                  workout.select(id)
                  if workout.selected == id { dismiss() }
                } label: {
                  let ledger = workout.ledger(id)
                  GymRow(title: workout.gym.catalogue.find(id)?.name ?? "Movement", meta: ledger.tally,
                         trailing: ledger.complete ? .check : nil).tint(GymPalette.done)
                }.buttonStyle(.borderless)
                if workout.canRemove(id) {
                  Button(role: .destructive) { workout.remove(id) } label: {
                    Image(systemName: "trash").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                  }.buttonStyle(.borderless)
                    .accessibilityLabel("Remove exercise").accessibilityIdentifier("workout-remove-\(id)")
                }
              }
              .contextMenu {
                if let exercise = workout.gym.catalogue.find(id) {
                  Button("Edit exercise", systemImage: "pencil") { exerciseToEdit = exercise }
                }
                if workout.canRemove(id) {
                  Button("Remove exercise", systemImage: "trash", role: .destructive) { workout.remove(id) }
                }
              }
              .accessibilityAddTraits(workout.selected == id ? .isSelected : [])
              .deleteDisabled(!workout.canRemove(id)).moveDisabled(workout.finishing)
              .accessibilityAction(named: "Move up") {
                if let index = workout.walk.order.firstIndex(of: id), index > 0 { workout.move(from: IndexSet(integer: index), to: index - 1) }
              }
              .accessibilityAction(named: "Move down") {
                if let index = workout.walk.order.firstIndex(of: id), index + 1 < workout.walk.order.count { workout.move(from: IndexSet(integer: index), to: index + 2) }
              }
            }.onMove { workout.move(from: $0, to: $1) }
            Button("Add movement", systemImage: "plus.circle.fill", action: add).accessibilityIdentifier("workout-assembly-add")
          }
          // The footer names the one way back: the tab bar's accessory on iOS 26, The log's Hidden row before it.
          Section {
            Button("Hide workout") { if workout.gym.hideWorkout() { dismiss() } }
              .disabled(workout.finishing || workout.gym.accountTransition).accessibilityIdentifier("workout-hide")
          } footer: {
            if #available(iOS 26, *) { Text("Your sets stay saved. Tap the workout above the tabs to return.") }
            else { Text("Your sets stay saved. Find it at the top of The log.") }
          }
        }.listRowBackground(GymPalette.card)
      }.environment(\.editMode, .constant(.active)).modifier(GymPage()).navigationTitle("This workout").navigationBarTitleDisplayMode(.inline)
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
