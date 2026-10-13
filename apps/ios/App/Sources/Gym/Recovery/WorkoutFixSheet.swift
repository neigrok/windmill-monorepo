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
            DatePicker("Started", selection: Self.date($fix.startedAt))
            if let finished = Binding($fix.finishedAt) {
              DatePicker("Finished", selection: Self.date(finished))
            } else {
              LabeledContent("Finished", value: "Not finished")
              Button("Mark finished") { fix.markFinished() }.accessibilityIdentifier("recovery-fix-mark-finished")
            }
          }
          if fix.hasRoutine, let routine = fix.original.session.name {
            Section { Toggle("Linked to \(routine)", isOn: $fix.keepsRoutine) }
          }
          let sets = fix.workout.sets
          ForEach(SavedSetRow.movements(sets), id: \.self) { exercise in
            Section(gym.catalogue.find(exercise)?.name ?? "Missing movement") {
              let performed = sets.filter { $0.exerciseId == exercise }
              ForEach(Array(performed.enumerated()), id: \.element.id) { index, set in
                Button { editing = set.id } label: {
                  SavedSetRow(set: set, ordinal: performed.prefix(index + 1).filter { $0.kind == "working" }.count,
                              timed: fix.startedAt)
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
          SavedSetEditor(gym: gym, set: fix.sets[index], session: fix.original.session.id) { edited in
            if let edited { fix.sets[index] = edited } else { fix.sets.remove(at: index) }
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
      GymTransient(gym: gym, message: held,
                   noticeMessage: gym.latestRecoveryNotice.flatMap { $0.id == fix.original.session.id ? $0.line : nil },
                   errorIdentifier: "recovery-fix-held")
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

  static func date(_ instant: Binding<Instant>) -> Binding<Date> {
    Binding(get: { LogPresentation.date(instant.wrappedValue) },
            set: { instant.wrappedValue = Instant(ms: Int64(($0.timeIntervalSince1970 * 1000).rounded())) })
  }
}

// The Fix set sheet over a saved copy's set: SetEditor's weight, reps, effort, kind and note on the phone's draft, plus
// the movement and the time a saved copy can carry wrong. Save the fix returns the set to the workout's draft.
struct SavedSetEditor: View {
  let gym: GymModel
  let original: WorkoutFix.SetFix
  let commit: (WorkoutFix.SetFix?) -> Void
  @State var draft: SetFixDraft
  @State var exerciseId: ID<Exercise>
  @State var completedAt: Instant
  @State var keypad: SetKeypad.Field?
  @Environment(\.dismiss) var dismiss

  init(gym: GymModel, set: WorkoutFix.SetFix, session: ID<Session>, commit: @escaping (WorkoutFix.SetFix?) -> Void) {
    self.gym = gym; original = set; self.commit = commit
    _draft = State(initialValue: SetFixDraft(set.set(in: session), account: gym.account))
    _exerciseId = State(initialValue: set.exerciseId)
    _completedAt = State(initialValue: set.completedAt)
  }

  var edited: WorkoutFix.SetFix {
    var set = original
    set.exerciseId = exerciseId; set.weightKg = draft.weightKg; set.reps = draft.reps; set.kind = draft.kind
    set.rpe = draft.rpe; set.note = draft.note; set.completedAt = completedAt
    return set
  }

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            WeightInstrument(weightKg: $draft.weightKg, identifier: "recovery-set-weight") { keypad = .weight }
            LabeledContent("Reps") {
              Button("\(draft.reps)") { keypad = .reps }.font(.title2.monospacedDigit()).accessibilityIdentifier("recovery-set-reps")
            }
            Picker("Effort", selection: $draft.rpe) {
              Text("Not rated").tag(Optional<Double>.none)
              ForEach(Array(stride(from: 6.0, through: 10.0, by: 0.5)), id: \.self) { value in
                Text("RPE \(Readout.weight(value))").tag(Optional(value))
              }
            }
            Picker("Kind", selection: $draft.kind) {
              ForEach(SetKind.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0.rawValue) }
            }.pickerStyle(.segmented).accessibilityIdentifier("recovery-set-kind")
          }
          Section {
            Picker("Movement", selection: $exerciseId) {
              if gym.catalogue.find(original.exerciseId) == nil { Text("Missing movement").tag(original.exerciseId) }
              ForEach(gym.catalogue.exercises, id: \.id) { Text($0.name).tag($0.id) }
            }.pickerStyle(.navigationLink).accessibilityIdentifier("recovery-set-movement")
            DatePicker("Time", selection: WorkoutFixSheet.date($completedAt))
          }
          Section {
            TextEditor(text: $draft.note).frame(minHeight: 100).accessibilityLabel("Set note")
            if !draft.note.isEmpty { Button("Clear note") { draft.note = "" } }
            if let counter = draft.noteCounter {
              Text(counter).font(.caption.monospacedDigit())
                .foregroundStyle(draft.noteBytes > 4_000 ? GymPalette.alarm : GymPalette.inkDim)
            }
          } header: { Text("Set note") }
          Section {
            Button("Delete set", systemImage: "trash", role: .destructive) { commit(nil); dismiss() }
              .foregroundStyle(GymPalette.alarm).accessibilityIdentifier("recovery-set-delete")
          }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage())
        .navigationTitle("Fix set")
        .modifier(RecoverySubtitle(text: gym.catalogue.find(exerciseId)?.name ?? "Missing movement"))
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .safeAreaInset(edge: .bottom) {
          VStack(spacing: 0) {
            GymTransient(gym: gym, message: draft.problem, errorIdentifier: "recovery-set-problem")
            ActionBand(title: "Save the fix", room: .gym, disabled: draft.problem != nil, actionIdentifier: "recovery-set-save") {
              commit(edited); dismiss()
            }
          }
        }
    }.modifier(GymPage()).presentationDetents([.large])
      .sheet(isPresented: Binding(get: { keypad != nil }, set: { if !$0 { keypad = nil } })) {
        if let keypad {
          SetKeypadSheet(field: keypad, value: keypad == .weight ? draft.weightKg : Double(draft.reps)) { value in
            if keypad == .weight { draft.weightKg = value } else { draft.reps = Int(value) }
          }
        }
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "fix_set"]) }
  }
}
