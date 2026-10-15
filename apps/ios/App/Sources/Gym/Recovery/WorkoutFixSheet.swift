import SwiftUI
import DomainKit
import GymDomain

// The phone's copy of a refused workout, corrected before one retry under the same identity: its times, routine link and
// sets, or a landed workout's stranded sets alone. Nothing here reaches the account until Save, which the phone holds
// while it would refuse the copy, saying why in the band below.
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
    let now = gym.log?.moment.now.date ?? Date()
    NavigationStack {
      Form {
        Group {
          if !fix.landed {
            Section("Times") {
              DatePicker("Started", selection: $fix.startedAt.date, in: ...now)
              if let finished = Binding($fix.finishedAt) {
                DatePicker("Finished", selection: finished.date, in: ...now)
              } else {
                LabeledContent("Finished", value: "Not finished")
                Button("Mark finished") { fix.markFinished() }.accessibilityIdentifier("recovery-fix-mark-finished")
              }
            }
            if fix.hasRoutine, let routine = fix.original.session.name {
              Section { Toggle("Linked to \(routine)", isOn: $fix.keepsRoutine) }
            }
          }
          let sets = fix.sets.map { $0.set(in: fix.original.session.id) }
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
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { saveButton }
        }
        .safeAreaInset(edge: .bottom) { GymTransient(gym: gym, message: held, errorIdentifier: "recovery-fix-held") }
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

  // The bar's commit: the system's prominent confirm on iOS 26, a bold Save before it.
  @ViewBuilder var saveButton: some View {
    let disabled = held != nil || !gym.canSendRecovery
    if #available(iOS 26, *) {
      Button("Save", role: .confirm) { save() }.disabled(disabled).accessibilityIdentifier("recovery-fix-save")
    } else {
      Button("Save") { save() }.bold().disabled(disabled).accessibilityIdentifier("recovery-fix-save")
    }
  }

  // What holds Save is said in the band below the form, as the Fix set sheet says its problem.
  var held: String? {
    let excess = fix.sets.count - 200
    if excess > 0 { return "Over 200 sets · remove \(excess)." }
    if let refusal = gym.fixRefusal(fix) { return WorkoutRecovery.Reason(refusal).line(stranded: 0) }
    return gym.canSendRecovery ? nil : gym.recoveryWait
  }

  // A refusal stays here with the draft, in the band; a queued retry closes the sheet and Inspect says it is on its way.
  func save() {
    guard gym.saveAndRetryWorkout(fix) else { return }
    saved = true
    landed("Adding \(fix.workout.name) to your log.")
    dismiss()
  }
}
