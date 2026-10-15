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
                GymRow(title: workout.gym.catalogue.find(id)?.name ?? "Movement",
                            meta: sets.isEmpty ? "Nothing logged yet" : GymCount.of(sets.count, "set") + " logged",
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
          }
          Section { Button("Add movement", systemImage: "plus", action: add).accessibilityIdentifier("workout-assembly-add") }
          Section {
            Button("Hide workout") { if workout.gym.hideWorkout() { dismiss() } }
              .disabled(workout.finishing || workout.gym.accountTransition).accessibilityIdentifier("workout-hide")
          } footer: { Text("Your sets stay saved. Restore this workout from Gym settings.") }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).navigationTitle("This session").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
          ToolbarItem(placement: .topBarTrailing) { EditButton() }
        }.roomBar(.gym)
        .reachBand {
          GymTransient(gym: workout.gym, message: workout.message, dismiss: { workout.message = nil }, noticeMessage: workout.gym.workoutNotice,
                       retry: { workout.retryRead() }, errorIdentifier: "workout-refusal", undoIdentifier: "workout-undo")
            .modifier(BoundedBand())
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
      MovementPicker(gym: gym, purpose: .workout, selected: Set(workout.walk.order),
                     onBuildRoutine: { if gym.hideWorkout() { workout.handoff = .writtenProgram } },
                     onSelect: { workout.add($0.exerciseId); dismiss() })
    }.modifier(GymPage()).presentationDetents([.large])
  }
}

// Heavier than the plan: one target asks once, in a dialog; a varied scheme opens its before and after rows in a sheet.
// Only the dialog's answers and the sheet's two bar actions resolve the offer.
struct WorkoutDeviationOffer: ViewModifier {
  @Bindable var workout: WorkoutState
  let held: Bool

  func body(content: Content) -> some View {
    let offer = held ? nil : workout.deviation
    content
      .confirmationDialog(offer.map { $0.saveLabel + "?" } ?? "", isPresented: .constant(offer.map { !$0.varied } ?? false),
                          titleVisibility: .visible, presenting: offer) { offer in
        Button("Save to \(offer.routine)") { workout.resolveDeviation(save: true) }
          .disabled(workout.gym.accountTransition).accessibilityIdentifier("workout-deviation-save")
        // iOS 26 hides a dialog's cancel and runs it on a tap outside, so Today only is drawn as an answer and kept as the cancel.
        if #available(iOS 26.0, *) {
          Button("Today only") { workout.resolveDeviation(save: false) }.accessibilityIdentifier("workout-deviation-today")
          Button("Today only", role: .cancel) { workout.resolveDeviation(save: false) }
        } else {
          Button("Today only", role: .cancel) { workout.resolveDeviation(save: false) }.accessibilityIdentifier("workout-deviation-today")
        }
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
                       noticeMessage: workout.gym.workoutNotice, errorIdentifier: "workout-refusal", undoIdentifier: "workout-undo")
        }
    }.modifier(GymPage()).presentationDetents([.medium])
  }
}
