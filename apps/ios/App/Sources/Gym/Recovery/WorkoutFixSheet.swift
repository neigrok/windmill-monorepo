import SwiftUI
import DomainKit
import GymDomain

// The phone's copy of a refused workout, corrected before one retry under the same identity. Nothing here reaches the
// account until Save and retry, which the phone holds while it would refuse the copy, saying why above it.
struct WorkoutFixSheet: View {
  let gym: GymModel
  let reason: WorkoutRecovery.Reason
  let landed: (String) -> Void
  @State var fix: WorkoutFix
  @State var editing: ID<TrainingSet>?
  @State var saved = false
  @Environment(\.dismiss) var dismiss

  init(gym: GymModel, fix: WorkoutFix, reason: WorkoutRecovery.Reason, landed: @escaping (String) -> Void) {
    self.gym = gym; self.reason = reason; self.landed = landed
    _fix = State(initialValue: fix)
  }

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section("Times") {
            DatePicker("Started", selection: $fix.startedAt.date)
            if let finished = Binding($fix.finishedAt) {
              DatePicker("Finished", selection: finished.date)
            } else {
              LabeledContent("Finished", value: "Not finished")
              Button("Mark finished") { fix.markFinished() }.accessibilityIdentifier("recovery-fix-mark-finished")
            }
          }
          if fix.hasRoutine, let routine = fix.original.session.name {
            Section { Toggle("Linked to \(routine)", isOn: $fix.keepsRoutine) }
          }
          let sets = fix.workout.sets
          ForEach(SetRow.movements(sets), id: \.self) { exercise in
            Section(gym.catalogue.find(exercise)?.name ?? "Missing movement") {
              let performed = sets.filter { $0.exerciseId == exercise }
              ForEach(performed, id: \.id) { set in
                let otherDay = !Calendar.current.isDate(fix.startedAt.date, inSameDayAs: set.completedAt.date)
                Button { editing = set.id } label: {
                  SetRow(marker: SetRow.marker(set, in: performed), set: set, time: SignedOutWorkout.time(set.completedAt, day: otherDay))
                }.accessibilityIdentifier("recovery-fix-set-\(set.id)")
              }
            }
          }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).disabled(gym.accountTransition)
        .navigationTitle("Fix workout")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .safeAreaInset(edge: .bottom) { band }
    }.modifier(GymPage()).presentationDetents([.large]).interactiveDismissDisabled(fix.isChanged)
      .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
        if let index = fix.sets.firstIndex(where: { $0.id == editing }) {
          SetEditor(gym: gym, set: fix.sets[index].set(in: fix.original.session.id), identifier: "recovery-set") { edited in
            if let edited { fix.sets[index] = WorkoutFix.SetFix(edited) } else { fix.sets.remove(at: index) }
          }
        }
      }
      .onDisappear { if !saved { gym.recorded(.fix, reason, outcome: "cancelled") } }
  }

  // What holds Save and retry is said in the band above it, as the Fix set sheet says its problem.
  var band: some View {
    let excess = fix.sets.count - 200
    let refusal = gym.fixRefusal(fix)
    let held = excess > 0 ? "Over 200 sets · remove \(excess)."
      : refusal.map { WorkoutRecovery.Reason($0).line(stranded: 0) } ?? (gym.canSendRecovery ? nil : gym.recoveryWait)
    return VStack(spacing: 0) {
      GymTransient(gym: gym, message: held, errorIdentifier: "recovery-fix-held")
      ActionBand(title: "Save and retry", room: .gym, disabled: held != nil || !gym.canSendRecovery,
                 actionIdentifier: "recovery-fix-save") { save() }
    }
  }

  // A refusal stays here with the draft, in the band; a queued retry closes the sheet and Inspect says so.
  func save() {
    guard gym.saveAndRetryWorkout(fix) else { return }
    saved = true
    landed("\(fix.workout.name) is on your log.")
    dismiss()
  }
}
