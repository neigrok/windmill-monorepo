import SwiftUI
import DomainKit
import GymDomain
import SyncCore

struct WorkoutAssembly: View {
  @Bindable var workout: WorkoutState
  let add: () -> Void
  @Environment(\.dismiss) var dismiss
  var body: some View {
    NavigationStack {
      List {
        Group {
          Section {
            ForEach(workout.walk.order, id: \.self) { id in
              Button {
                workout.select(id)
                if workout.selected == id { dismiss() }
              } label: {
                let sets = workout.sets.filter { $0.exerciseId == id }
                MovementRow(title: workout.gym.catalogue.find(id)?.name ?? "Movement",
                            meta: sets.isEmpty ? "Nothing logged yet" : "\(sets.count) sets logged",
                            trailing: workout.selected == id ? .check : nil)
              }
              .accessibilityAddTraits(workout.selected == id ? .isSelected : [])
              .deleteDisabled(!workout.canRemove(id)).moveDisabled(workout.finishing)
              .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if workout.canRemove(id) { Button("Remove", role: .destructive) { workout.remove(id) } }
              }
              .accessibilityAction(named: "Move up") {
                if let index = workout.walk.order.firstIndex(of: id), index > 0 { workout.move(from: IndexSet(integer: index), to: index - 1) }
              }
              .accessibilityAction(named: "Move down") {
                if let index = workout.walk.order.firstIndex(of: id), index + 1 < workout.walk.order.count { workout.move(from: IndexSet(integer: index), to: index + 2) }
              }
            }.onMove { workout.move(from: $0, to: $1) }
          } header: { Text("\(workout.sets.count) sets logged") }
          Section { Button("Add movement", systemImage: "plus", action: add).accessibilityIdentifier("workout-assembly-add") }
          Section {
            Button("Hide workout") { if workout.gym.hideWorkout() { dismiss() } }
              .disabled(workout.finishing || workout.gym.accountTransition).accessibilityIdentifier("workout-hide")
          } footer: { Text("Your sets stay saved. Restore this workout from Gym settings.") }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).navigationTitle("This session").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
          GymTransient(gym: workout.gym, message: workout.message, dismiss: { workout.message = nil },
                       noticeMessage: workout.gym.workoutNotice, retry: { workout.retryRead() }, errorIdentifier: "workout-refusal", undoIdentifier: "workout-undo")
            .modifier(BoundedBand())
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
          ToolbarItem(placement: .topBarTrailing) { EditButton() }
        }
    }.modifier(GymPage()).presentationDetents([.large])
  }
}

struct WorkoutMovementPicker: View {
  let gym: GymModel
  let workout: WorkoutState
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      MovementPicker(gym: gym, selected: Set(workout.walk.order), includesTargets: false, onBuildRoutine: {
        if gym.hideWorkout() { workout.handoff = .writtenProgram }
      }) { workout.add($0.exerciseId); dismiss() }
    }.modifier(GymPage()).presentationDetents([.large])
  }
}

struct WorkoutDeviationSheet: View {
  @Bindable var workout: WorkoutState
  let offer: WorkoutDeviation
  var body: some View {
    let offer = workout.deviation ?? self.offer
    NavigationStack {
      List {
        Group {
          Section { Text(offer.sentence(workout.gym.catalogue.find(offer.exerciseId)?.name ?? "movement")) }
          if offer.varied {
            Section {
              ForEach(0..<max(offer.scheme.count, offer.proposed.count), id: \.self) { index in
                LabeledContent("Set \(index + 1)") {
                  Text("\(index < offer.scheme.count ? Readout.setTarget(offer.scheme[index]) : "—") → \(index < offer.proposed.count ? Readout.setTarget(offer.proposed[index]) : "—")")
                    .font(.body.monospacedDigit())
                }
              }
            }
          }
          Section { Button("Today only") { workout.resolveDeviation(save: false) }.accessibilityIdentifier("workout-deviation-today") }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).navigationTitle("Heavier than the plan").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { workout.resolveDeviation(save: false) } } }
        .safeAreaInset(edge: .bottom) {
          VStack(spacing: 0) {
            GymTransient(gym: workout.gym, message: workout.message, dismiss: { workout.message = nil },
                         noticeMessage: workout.gym.workoutNotice, errorIdentifier: "workout-refusal", undoIdentifier: "workout-undo")
            ActionBand(title: offer.saveLabel, room: .gym,
                       disabled: workout.gym.accountTransition, actionIdentifier: "workout-deviation-save") {
              workout.resolveDeviation(save: true)
            }
          }
        }
    }.modifier(GymPage()).presentationDetents([.large])
  }
}
