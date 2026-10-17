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
                let ledger = workout.ledger(id)
                GymRow(title: workout.gym.catalogue.find(id)?.name ?? "Movement", meta: ledger.tally,
                       trailing: ledger.complete ? .check : nil).tint(GymPalette.done)
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
      }.modifier(GymPage()).navigationTitle("This workout").navigationBarTitleDisplayMode(.inline)
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
                       noticeMessage: workout.gym.workoutNotice, errorIdentifier: "workout-refusal", undoIdentifier: "workout-undo")
        }
    }.modifier(GymPage()).presentationDetents([.medium])
  }
}
