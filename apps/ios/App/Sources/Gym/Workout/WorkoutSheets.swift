import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncCore

struct WorkoutKeypadSheet: View {
  @Environment(\.dismiss) var dismiss
  @State var pad: WorkoutKeypad
  let commit: (Double) -> Void
  init(field: WorkoutKeypad.Field, value: Double, commit: @escaping (Double) -> Void) {
    _pad = State(initialValue: WorkoutKeypad(field, value: value)); self.commit = commit
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 12) {
          Text(pad.text.isEmpty ? "—" : pad.text.replacingOccurrences(of: "-", with: "−"))
            .modifier(GymKeypadNumeral()).monospacedDigit()
            .lineLimit(1).minimumScaleFactor(0.5).frame(maxWidth: .infinity)
            .accessibilityIdentifier("workout-keypad-value")
          Text(pad.reading.message).font(.subheadline).foregroundStyle(pad.reading.value == nil ? GymPalette.ink : GymPalette.inkDim)
            .accessibilityIdentifier("workout-keypad-hint")
          LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 8) {
            ForEach(["1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", "."], id: \.self) { key in
              Button { pad.press(key) } label: { Text(key).font(.title2.monospacedDigit()).frame(maxWidth: .infinity, minHeight: 54) }
                .buttonStyle(.bordered).disabled(pad.field == .reps && ["±", "."].contains(key))
                .accessibilityLabel(key == "±" ? "Flip the sign — band-assisted" : key)
                .accessibilityIdentifier("workout-key-\(key)")
            }
          }
          Button("Delete", systemImage: "delete.left") { pad.press("⌫") }.frame(minHeight: 44)
            .accessibilityIdentifier("workout-key-delete")
        }.padding(16)
      }.modifier(GymPage())
      .navigationTitle(pad.field == .weight ? "Weight · kg" : "Reps")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
      .safeAreaInset(edge: .bottom) {
        Button { if let value = pad.reading.value { commit(value); dismiss() } } label: {
          Text("Set").frame(maxWidth: .infinity, minHeight: 44)
        }.buttonStyle(.borderedProminent).foregroundStyle(GymPalette.onAccent).disabled(pad.reading.value == nil)
          .padding(16).background(GymPalette.canvas).accessibilityIdentifier("workout-keypad-set")
      }
    }.modifier(GymPage()).presentationDetents([.large]).presentationDragIndicator(.visible)
  }
}

@Observable nonisolated final class WorkoutFixDraft {
  private(set) var original: TrainingSet
  var weightKg: Double
  var reps: Int
  var rpe: Double?
  var note: String
  var failure: String?
  var busy = false
  init(_ set: TrainingSet) {
    original = set; weightKg = set.weightKg; reps = set.reps; rpe = set.rpe; note = set.note
  }
  var noteBytes: Int { note.utf8.count }
  var noteCounter: String? { noteBytes >= 3_200 ? "\(noteBytes) of 4000 bytes" : nil }
  var valid: Bool { weightKg.isFinite && abs(weightKg) <= 500 && (1...99).contains(reps) && noteBytes <= 4_000 }
  var value: TrainingSet {
    var set = original; set.weightKg = weightKg; set.reps = reps; set.rpe = rpe; set.note = note; return set
  }
  @MainActor @discardableResult func save(_ gym: GymModel) -> Bool {
    guard !busy, valid else { return false }
    guard gym.sets.contains(where: { $0.id == original.id }) else { return true }
    busy = true; defer { busy = false }
    let result = gym.run(CorrectSet(value, original: original))
    guard let result, result.refusal == nil else {
      if case .gone = gym.refusal { return true }
      failure = result == nil ? "The log didn’t answer — that set wasn’t changed." : gym.error; return false
    }
    original = gym.sets.first { $0.id == original.id } ?? value
    failure = nil; return true
  }
}

struct WorkoutFixSheet: View {
  let gym: GymModel
  let routine: String?
  @Environment(\.dismiss) var dismiss
  @State var draft: WorkoutFixDraft
  @State var keypad: WorkoutKeypad.Field?
  @Environment(\.dynamicTypeSize) var typeSize
  init(gym: GymModel, set: TrainingSet, routine: String?) {
    self.gym = gym; self.routine = routine; _draft = State(initialValue: WorkoutFixDraft(set))
  }
  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            VStack(spacing: 8) {
              Button { keypad = .weight } label: {
                Text(Readout.weight(draft.weightKg)).modifier(GymKeypadNumeral())
                  .monospacedDigit().lineLimit(1).minimumScaleFactor(0.5).frame(maxWidth: .infinity)
              }.buttonStyle(.plain).accessibilityLabel("Weight, \(Readout.weight(draft.weightKg)) kilograms")
                .accessibilityIdentifier("workout-fix-weight")
              Text("kg").font(.subheadline).foregroundStyle(GymPalette.inkDim)
              LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: typeSize.isAccessibilitySize ? 2 : 4), spacing: 8) {
                ForEach(0..<4) { index in
                  Button(WeightLadder.labels(draft.weightKg)[index]) {
                    draft.weightKg = WeightLadder.bump(draft.weightKg, direction: index < 2 ? -1 : 1, big: index == 0 || index == 3)
                  }.buttonStyle(.bordered).frame(maxWidth: .infinity, minHeight: 44)
                }
              }.font(.body.monospacedDigit())
            }
            LabeledContent("Reps") {
              Button("\(draft.reps)") { keypad = .reps }.font(.title2.monospacedDigit()).accessibilityIdentifier("workout-fix-reps")
            }
            Picker("Effort", selection: $draft.rpe) {
              Text("Not rated").tag(Optional<Double>.none)
              ForEach(0...8, id: \.self) { at in
                let value = 6 + Double(at) / 2
                Text("RPE \(Readout.weight(value))").tag(Optional(value))
              }
            }.accessibilityIdentifier("workout-fix-effort")
          }
          Section {
            TextEditor(text: $draft.note).frame(minHeight: 100).accessibilityLabel("Set note")
              .accessibilityIdentifier("workout-fix-note")
            if !draft.note.isEmpty { Button("Clear note") { draft.note = "" } }
            if draft.noteBytes > 4_000 { Text("A set note runs to 4000 bytes.").foregroundStyle(.red) }
            if let counter = draft.noteCounter { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(draft.noteBytes > 4_000 ? .red : GymPalette.inkDim) }
          } header: { Text("Set note") } footer: { Text("A record for you — not an instruction to Coach.") }
          if let failure = draft.failure { Section { Text(failure).accessibilityIdentifier("workout-fix-failure") } }
          Section {
            Button("Delete set", role: .destructive) {
              guard let result = gym.run(DeleteSet(draft.original.id)), result.refusal == nil else { draft.failure = gym.error; return }
              dismiss()
            }.accessibilityIdentifier("workout-fix-delete")
          } footer: { if let routine { Text("\(routine) keeps its planned targets.") } }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).disabled(draft.busy || gym.accountTransition)
        .navigationTitle("Fix set").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
          Button { if draft.save(gym) { dismiss() } } label: {
            Text(draft.busy ? "Saving…" : "Save the fix").frame(maxWidth: .infinity, minHeight: 44)
          }.buttonStyle(.borderedProminent).foregroundStyle(GymPalette.onAccent).disabled(!draft.valid || draft.busy || gym.accountTransition)
            .padding(16).background(GymPalette.canvas).accessibilityIdentifier("workout-fix-save")
        }
    }.modifier(GymPage()).presentationDetents([.large]).presentationDragIndicator(.visible)
      .sheet(isPresented: Binding(get: { keypad != nil }, set: { if !$0 { keypad = nil } })) {
        if let keypad {
          WorkoutKeypadSheet(field: keypad, value: keypad == .weight ? draft.weightKg : Double(draft.reps)) { value in
            if keypad == .weight { draft.weightKg = value } else { draft.reps = Int(value) }
          }
        }
      }
      .onChange(of: gym.sets) { _, sets in if !sets.contains(where: { $0.id == draft.original.id }) { dismiss() } }
  }
}

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
                HStack {
                  VStack(alignment: .leading, spacing: 4) {
                    Text(workout.gym.catalogue.find(id)?.name ?? "Movement").foregroundStyle(GymPalette.ink)
                    let sets = workout.sets.filter { $0.exerciseId == id }
                    Text(sets.isEmpty ? "Nothing logged yet" : "\(sets.count) sets logged").font(.subheadline).foregroundStyle(GymPalette.inkDim)
                  }
                  Spacer()
                  if workout.selected == id { Image(systemName: "checkmark") }
                }.frame(minHeight: 44)
              }
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
          if let message = workout.message { Section { Text(message) } }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).navigationTitle("This session").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
          ToolbarItem(placement: .topBarTrailing) { EditButton() }
        }
    }.modifier(GymPage()).presentationDetents([.large]).presentationDragIndicator(.visible)
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
          if let message = workout.message { Section { Text(message) } }
          Section { Button("Today only") { workout.resolveDeviation(save: false) }.accessibilityIdentifier("workout-deviation-today") }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).navigationTitle("Heavier than the plan").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
          Button { workout.resolveDeviation(save: true) } label: { Text(offer.saveLabel).frame(maxWidth: .infinity, minHeight: 44) }
            .buttonStyle(.borderedProminent).foregroundStyle(GymPalette.onAccent).padding(16).background(GymPalette.canvas)
            .disabled(workout.gym.accountTransition).accessibilityIdentifier("workout-deviation-save")
        }
    }.modifier(GymPage()).presentationDetents([.large]).presentationDragIndicator(.visible)
  }
}
