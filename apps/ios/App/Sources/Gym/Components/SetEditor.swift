import SwiftUI
import Observation
import DomainKit
import GymDomain

// Load and reps on two native wheels (03.2), committed together by the checkmark: the load in the movement's steps and
// labelled by its basis, bodyweight running from assistance through zero to added load. A value off the steps keeps its
// row, so opening the wheel never moves a number. The rack's ladder keys and the reps buttons edit the same draft.
struct SetWheelSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
  let title: String
  let movement: String
  let basis: MovementEquipment
  let loads: [Double]
  let repCounts: [Int]
  let commit: (Double, Int) -> Void
  @State private var weightKg: Double
  @State private var reps: Int

  init(title: String, movement: String, basis: MovementEquipment, weightKg: Double, reps: Int, commit: @escaping (Double, Int) -> Void) {
    self.title = title; self.movement = movement; self.basis = basis; self.commit = commit
    loads = Self.loads(around: weightKg, basis: basis); repCounts = Self.reps(around: reps)
    _weightKg = State(initialValue: weightKg); _reps = State(initialValue: reps)
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
    NavigationStack {
      HStack(spacing: 0) {
        wheel("Load", unit: basis.unit, selection: $weightKg, values: loads, reading: { Readout.weight($0) }, identifier: "set-wheel-load")
        wheel("Reps", unit: "reps", selection: $reps, values: repCounts, reading: { "\($0)" }, identifier: "set-wheel-reps")
      }.padding(.horizontal, RoomSpace.inset)
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

// One instrument wherever it is drawn (docs/design/ios/ios-redesign.md §5): the numeral, its unit at its baseline or under it
// at accessibility sizes, opens the wheel and rolls to each new load, and the ladder steps by the load's own band with its
// keys in ink, whatever tint the host carries.
struct WeightInstrument: View {
  @Binding var weightKg: Double
  let identifier: String
  var basis = MovementEquipment("")
  let edit: () -> Void
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let numeral = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    VStack(spacing: RoomSpace.related) {
      numeral {
        Button(action: edit) {
          Text(Readout.weight(weightKg)).modifier(GymNumeral()).lineLimit(1).minimumScaleFactor(0.5)
            .contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion, value: weightKg))
        }.buttonStyle(.plain).accessibilityLabel("Weight, \(Readout.weight(weightKg)) \(basis.unit)")
          .accessibilityIdentifier(identifier)
        Text(basis.unit).font(.title3).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("\(identifier)-unit")
      }.roomMotion(weightKg)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: typeSize.isAccessibilitySize ? 2 : 4), spacing: RoomSpace.related) {
        ForEach(0..<4) { index in
          let label = WeightLadder.labels(weightKg)[index]
          Button { weightKg = WeightLadder.bump(weightKg, direction: index < 2 ? -1 : 1, big: index == 0 || index == 3) } label: {
            Text(label).frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
          }.buttonStyle(GymInstrumentButtonStyle())
            .accessibilityLabel("\(label) \(basis.unit)").accessibilityIdentifier("\(identifier)-step-\(index)")
        }
      }.font(.body.monospacedDigit())
      if basis.value == "dumbbell" {
        Text("\(basis.loadCount == 1 ? "One dumbbell" : "Two dumbbells") · \(Readout.weight(max(0, weightKg) * Double(basis.loadCount))) kg total")
          .font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
      } else if basis.value == "bodyweight" {
        Text(weightKg < 0 ? "Assistance" : weightKg == 0 ? "Bodyweight only" : "Added weight only")
          .font(.caption).foregroundStyle(GymPalette.inkDim)
      }
    }.frame(maxWidth: .infinity)
  }
}

struct GymInstrumentButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(!enabled ? GymPalette.inkFaint : configuration.isPressed ? GymPalette.onAccent : GymPalette.ink)
      .background(configuration.isPressed && enabled ? GymPalette.accent : GymPalette.control,
                  in: RoundedRectangle(cornerRadius: RoomSpace.inset))
      .contentShape(Rectangle())
      .scaleEffect(configuration.isPressed && enabled && !reduceMotion ? 0.96 : 1)
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

// The Fix set sheet; `identifier` prefixes each control's accessibility identifier. A logged set's fix lands on the log;
// a saved workout's set returns to the caller's draft, and may take another movement and time, since a copy can carry
// either wrong.
struct SetEditor: View {
  enum Landing {
    case log(routine: String?)
    case draft((TrainingSet?) -> Void)
  }
  let gym: GymModel
  let landing: Landing
  let identifier: String
  @Environment(\.dismiss) private var dismiss
  @State private var draft: SetFixDraft
  @State private var wheel = false
  @State private var saved = false

  init(gym: GymModel, set: TrainingSet, routine: String?, identifier: String) {
    self.gym = gym; landing = .log(routine: routine); self.identifier = identifier
    _draft = State(initialValue: SetFixDraft(set, account: gym.account))
  }

  init(gym: GymModel, set: TrainingSet, identifier: String, commit: @escaping (TrainingSet?) -> Void) {
    self.gym = gym; landing = .draft(commit); self.identifier = identifier
    _draft = State(initialValue: SetFixDraft(set, account: gym.account))
  }

  var logged: Bool { if case .log = landing { true } else { false } }
  var movement: String { gym.catalogue.find(draft.exerciseId)?.name ?? (logged ? "Movement" : "Missing movement") }
  // The set's place among its movement's sets in its workout, as the ledger numbers it.
  var place: String {
    let siblings = gym.sets.filter { $0.sessionId == draft.original.sessionId && $0.exerciseId == draft.original.exerciseId }
    return siblings.contains { $0.id == draft.original.id } ? "Set " + SetRow.marker(draft.original, in: siblings) : "Set"
  }

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            WeightInstrument(weightKg: $draft.weightKg, identifier: "\(identifier)-weight", basis: MovementEquipment(gym.catalogue.find(draft.exerciseId))) { wheel = true }
            LabeledContent("Reps") {
              Button("\(draft.reps)") { wheel = true }.font(.title2.monospacedDigit()).accessibilityIdentifier("\(identifier)-reps")
            }
            Picker("Effort", selection: $draft.rpe) {
              Text("Not rated").tag(Optional<Double>.none)
              ForEach(Array(stride(from: 6.0, through: 10.0, by: 0.5)), id: \.self) { value in
                Text("RPE \(Readout.weight(value))").tag(Optional(value))
              }
            }.accessibilityIdentifier("\(identifier)-effort")
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
          } footer: { if case .log(let routine?) = landing { Text("\(routine) keeps its planned targets.") } }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).disabled(draft.busy || gym.accountTransition)
        .roomTitle("Fix set", subtitle: movement)
        .sheetCommit("Save", identifier: "\(identifier)-save", disabled: draft.problem != nil || gym.accountTransition,
                     busy: draft.busy, dismiss: { dismiss() }, commit: save)
        .reachBand {
          GymTransient(gym: gym, message: draft.failure ?? draft.problem,
                       dismiss: draft.failure == nil ? nil : { draft.failure = nil }, errorIdentifier: "\(identifier)-failure")
        }
    }.modifier(GymPage()).presentationDetents([.large])
      .sheet(isPresented: $wheel) {
        SetWheelSheet(title: place, movement: movement, basis: MovementEquipment(gym.catalogue.find(draft.exerciseId)),
                      weightKg: draft.weightKg, reps: draft.reps) { weightKg, reps in draft.weightKg = weightKg; draft.reps = reps }
      }
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
