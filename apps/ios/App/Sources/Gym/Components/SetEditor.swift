import SwiftUI
import Observation
import DomainKit
import GymDomain

// Load and reps on two native wheels, one beside the other: the load in the movement's steps and labelled by its basis,
// bodyweight running from assistance through zero to added load, the reps 1 to 99. A value off the steps keeps its row,
// so the wheels never move a number they were opened on. The rack's sheet (03.2) and Fix set (03.3) both draw them.
struct SetWheels: View {
  @Binding var weightKg: Double
  @Binding var reps: Int
  let basis: MovementEquipment
  @State private var loads: [Double]
  @State private var repCounts: [Int]

  init(weightKg: Binding<Double>, reps: Binding<Int>, basis: MovementEquipment) {
    _weightKg = weightKg; _reps = reps; self.basis = basis
    _loads = State(initialValue: Self.loads(around: weightKg.wrappedValue, basis: basis))
    _repCounts = State(initialValue: Self.reps(around: reps.wrappedValue))
  }

  static func loads(around weightKg: Double, basis: MovementEquipment) -> [Double] {
    var magnitudes: [Double] = [0]
    while let last = magnitudes.last, last < 500 { magnitudes.append(WeightLadder.round(last + WeightLadder.steps(magnitude: last).small)) }
    let grid = basis.value == "bodyweight" ? magnitudes.dropFirst().reversed().map { -$0 } + magnitudes : magnitudes
    return grid.contains(weightKg) || !weightKg.isFinite ? grid : (grid + [weightKg]).sorted()
  }

  static func reps(around reps: Int) -> [Int] {
    (1...99).contains(reps) ? Array(1...99) : (Array(1...99) + [reps]).sorted()
  }

  var body: some View {
    HStack(spacing: 0) {
      wheel("Load", unit: basis.unit, selection: $weightKg, values: loads, reading: { Readout.weight($0) }, identifier: "set-wheel-load")
      wheel("Reps", unit: "reps", selection: $reps, values: repCounts, reading: { "\($0)" }, identifier: "set-wheel-reps")
    }
  }

  // One wheel: its numbers end at the column's middle and the unit stands beside the selected one, as Clock's timer does.
  func wheel<Value: Hashable>(_ name: String, unit: String, selection: Binding<Value>, values: [Value], reading: @escaping (Value) -> String,
                              identifier: String) -> some View {
    Picker(name, selection: selection) {
      ForEach(values, id: \.self) { value in
        HStack(spacing: RoomSpace.related) {
          Text(reading(value)).monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing)
          Text(unit).hidden().frame(maxWidth: .infinity, alignment: .leading)
        }.accessibilityElement(children: .ignore).accessibilityLabel("\(reading(value)) \(unit)")
      }
    }.pickerStyle(.wheel)
      .overlay {
        HStack(spacing: RoomSpace.related) {
          Color.clear.frame(maxWidth: .infinity)
          Text(unit).foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity, alignment: .leading)
        }.allowsHitTesting(false).accessibilityHidden(true)
      }
      .accessibilityIdentifier(identifier)
  }
}

@Observable nonisolated final class SetFixDraft {
  private(set) var original: TrainingSet
  let account: String?
  var exerciseId: ID<Exercise>
  var weightKg: Double
  var reps: Int
  var rpe: Double?
  var note: String
  var completedAt: Instant
  var failure: String?
  var busy = false

  init(_ set: TrainingSet, account: String?) {
    original = set; self.account = account
    exerciseId = set.exerciseId; weightKg = set.weightKg; reps = set.reps; rpe = set.rpe; note = set.note
    completedAt = set.completedAt
  }

  var noteBytes: Int { note.utf8.count }
  var noteCounter: String? { noteBytes >= 3_200 ? "\(noteBytes) of 4000 bytes" : nil }
  var problem: String? {
    guard weightKg.isFinite else { return "That is not a number yet." }
    guard abs(weightKg) <= 500 else { return "Between −500 and 500 kg — check the number." }
    guard (1...99).contains(reps) else { return "Whole reps, 1–99." }
    guard noteBytes <= 4_000 else { return "A set note runs to 4000 bytes." }
    return nil
  }
  var value: TrainingSet {
    TrainingSet(id: original.id, sessionId: original.sessionId, exerciseId: exerciseId, weightKg: weightKg, reps: reps,
                rpe: rpe, note: note, completedAt: completedAt, setNumber: original.setNumber)
  }

  // A fix re-reads first, so it never lands on another account's log or over a log the phone failed to read.
  @MainActor func ready(_ gym: GymModel) -> Bool {
    gym.refresh()
    guard gym.account == account, !gym.accountTransition, !gym.readFailed else {
      failure = "The workout changed. Check the current set"; return false
    }
    return true
  }

  // True when the editor should close: the fix landed, or the set is already gone.
  @MainActor @discardableResult func save(_ gym: GymModel) -> Bool {
    guard !busy, problem == nil, ready(gym) else { return false }
    guard gym.sets.contains(where: { $0.id == original.id }) else { gym.error = "That set is no longer here."; return true }
    busy = true; defer { busy = false }
    guard let outcome = gym.run(CorrectSet(value, original: original)) else {
      failure = "The log didn’t answer — that set wasn’t changed."; return false
    }
    if case .gone = outcome.refusal { return true }
    guard outcome.refusal == nil else { failure = gym.error; return false }
    original = gym.sets.first { $0.id == original.id } ?? value
    failure = nil; return true
  }

  @MainActor func delete(_ gym: GymModel) -> Bool {
    guard ready(gym) else { return false }
    guard let outcome = gym.run(DeleteSet(original.id)), outcome.refusal == nil else { failure = gym.error; return false }
    return true
  }
}

// Fix set (03.3): the set's place as the title over its movement, the load and reps on the wheels, Effort and Note, and
// Delete set as the last row; `identifier` prefixes each control's accessibility identifier. A logged set's fix lands on
// the log; a saved workout's set returns to the caller's draft, and may take another movement and time, since a copy can
// carry either wrong.
struct SetEditor: View {
  enum Landing {
    case log
    case draft((TrainingSet?) -> Void)
  }
  let gym: GymModel
  let landing: Landing
  let identifier: String
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var draft: SetFixDraft
  @State private var saved = false

  init(gym: GymModel, set: TrainingSet, identifier: String) {
    self.gym = gym; landing = .log; self.identifier = identifier
    _draft = State(initialValue: SetFixDraft(set, account: gym.account))
  }

  init(gym: GymModel, set: TrainingSet, identifier: String, commit: @escaping (TrainingSet?) -> Void) {
    self.gym = gym; landing = .draft(commit); self.identifier = identifier
    _draft = State(initialValue: SetFixDraft(set, account: gym.account))
  }

  var logged: Bool { if case .log = landing { true } else { false } }
  var movement: String { gym.catalogue.find(draft.exerciseId)?.name ?? (logged ? "Movement" : "Missing movement") }
  // The set's place among its movement's sets in its workout, as the ledger numbers it; a saved workout's copy keeps the
  // number it was logged under.
  var place: String {
    let siblings = (gym.log?.sets(session: draft.original.sessionId) ?? []).filter { $0.exerciseId == draft.original.exerciseId }
    if siblings.contains(where: { $0.id == draft.original.id }) { return "Set " + SetRow.marker(draft.original, in: siblings) }
    return draft.original.setNumber.map { "Set \($0)" } ?? "Fix set"
  }

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            SetWheels(weightKg: $draft.weightKg, reps: $draft.reps, basis: MovementEquipment(gym.catalogue.find(draft.exerciseId)))
              .frame(height: 180).clipped().id(draft.exerciseId)
          }
          Section {
            Picker("Effort", selection: $draft.rpe) {
              Text("Not rated").tag(Optional<Double>.none)
              ForEach(Array(stride(from: 6.0, through: 10.0, by: 0.5)), id: \.self) { value in
                Text("RPE \(Readout.weight(value))").tag(Optional(value))
              }
            }.pickerStyle(.menu).accessibilityIdentifier("\(identifier)-effort")
            TextField("Note", text: $draft.note, axis: .vertical).lineLimit(1...6).accessibilityLabel("Set note")
              .accessibilityIdentifier("\(identifier)-note")
            if !draft.note.isEmpty { Button("Clear note") { draft.note = "" } }
            if let counter = draft.noteCounter {
              Text(counter).font(.caption.monospacedDigit())
                .foregroundStyle(draft.noteBytes > 4_000 ? GymPalette.alarm : GymPalette.inkDim)
            }
          }
          if !logged {
            Section {
              // Bound through the draft, not its state: a write back through the state leaves the picker's page open.
              Picker("Movement", selection: Bindable(draft).exerciseId) {
                if gym.catalogue.find(draft.original.exerciseId) == nil { Text("Missing movement").tag(draft.original.exerciseId) }
                ForEach(gym.catalogue.exercises, id: \.id) { Text($0.name).tag($0.id) }
              }.pickerStyle(.navigationLink).accessibilityIdentifier("\(identifier)-movement")
              DatePicker("Time", selection: $draft.completedAt.date)
            }
          }
          Section {
            Button("Delete set", role: .destructive) { delete() }.accessibilityIdentifier("\(identifier)-delete")
          }
        }.listRowBackground(GymPalette.card)
      }.listSectionSpacing(.compact).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .modifier(GymPage()).disabled(draft.busy || gym.accountTransition)
        .roomTitle(place, subtitle: movement)
        .sheetCommit("Save", identifier: "\(identifier)-save", dismissalIdentifier: "\(identifier)-cancel", disabled: draft.problem != nil || gym.accountTransition,
                     busy: draft.busy, dismiss: { dismiss() }, commit: save)
        .reachBand {
          GymTransient(gym: gym, message: draft.failure ?? draft.problem,
                       dismiss: draft.failure == nil ? nil : { draft.failure = nil }, errorIdentifier: "\(identifier)-failure")
        }
    }.modifier(GymPage()).presentationDetents(logged && !typeSize.isAccessibilitySize ? [.height(470), .large] : [.large])
      .sensoryFeedback(.success, trigger: saved)
      .onChange(of: draft.value) { _, _ in draft.failure = nil }
      .onChange(of: gym.sets) { _, sets in
        if logged, !gym.readFailed, !sets.contains(where: { $0.id == draft.original.id }) { dismiss() }
      }
      .onChange(of: gym.account) { _, _ in if logged { dismiss() } }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "fix_set"]) }
  }

  func save() {
    switch landing {
    case .log: guard draft.save(gym) else { return }
    case .draft(let commit): guard draft.problem == nil else { return }; commit(draft.value)
    }
    saved = true; dismiss()
  }

  func delete() {
    switch landing {
    case .log: guard draft.delete(gym) else { return }
    case .draft(let commit): commit(nil)
    }
    dismiss()
  }
}
