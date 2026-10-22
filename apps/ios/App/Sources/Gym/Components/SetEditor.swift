import SwiftUI
import Observation
import DomainKit
import GymDomain

struct SetKeypad {
  enum Field {
    case weight, reps
    var title: String { self == .weight ? "Weight" : "Reps" }
    var unit: String { self == .weight ? "kg" : "reps" }
    // Reps are whole and positive, so their pad leaves the sign's and the decimal point's slots empty.
    var keys: [String] { ["1", "2", "3", "4", "5", "6", "7", "8", "9"] + (self == .weight ? ["±", "0", "."] : ["", "0", ""]) }
  }
  let field: Field
  let keeping: Double
  var text: String
  var seeded = true

  init(_ field: Field, value: Double) {
    self.field = field; keeping = value; text = Readout.weight(value).replacingOccurrences(of: "−", with: "-")
  }
  mutating func press(_ key: String) {
    if field == .reps && ["±", ".", ","].contains(key) { return }
    if key == "⌫" { text = String(text.dropLast()); seeded = false; return }
    if key == "±" {
      if text.hasPrefix("-") { text.removeFirst() }
      else if text.count < 8 { text = "-" + text }
      seeded = false; return
    }
    let held = seeded ? "" : text
    guard held.count < 8 else { return }
    text = held + key; seeded = false
  }
  // The number Set would commit, or the refusal that keeps Set disabled.
  var reading: (value: Double?, refusal: String?) {
    let raw = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
    if raw.isEmpty || raw == "-" { return (nil, "Enter a number, or cancel to keep \(Readout.weight(keeping))") }
    if raw.filter({ $0 == "." }).count > 1 { return (nil, "One decimal point only.") }
    guard let number = Double(raw), number.isFinite else { return (nil, "That is not a number yet.") }
    if field == .weight {
      guard abs(number) <= 500 else { return (nil, "Over 500 kg — check the number.") }
      return (WeightLadder.round(number), nil)
    }
    guard number.rounded() == number && (1...99).contains(number) else { return (nil, "Whole reps, 1 to 99.") }
    return (number, nil)
  }
}

// The keypad's digits are instruments: they stop growing at the first accessibility size, as Phone's do, and the sheet
// takes the whole height there so every key and Set stay in reach. A refusal holds its line, so the keys never move.
struct SetKeypadSheet: View {
  @Environment(\.dismiss) var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
  @State var pad: SetKeypad
  let commit: (Double) -> Void
  let basis: MovementEquipment?
  init(field: SetKeypad.Field, value: Double, basis: MovementEquipment? = nil, commit: @escaping (Double) -> Void) {
    _pad = State(initialValue: SetKeypad(field, value: value)); self.commit = commit; self.basis = basis
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: RoomSpace.small) {
          NumeralAndUnit(unit: pad.field == .weight ? (basis ?? MovementEquipment("")).unit : pad.field.unit, identifier: "workout-keypad-unit") {
            Text(pad.text.isEmpty ? "—" : pad.text.replacingOccurrences(of: "-", with: "−"))
              .modifier(GymKeypadNumeral()).lineLimit(1).minimumScaleFactor(0.5)
              .accessibilityIdentifier("workout-keypad-value")
          }.frame(maxWidth: .infinity)
          if pad.field == .weight, let basis, !basis.value.isEmpty {
            Text(basis.help).font(.footnote).foregroundStyle(GymPalette.inkDim)
          }
          Text(pad.reading.refusal ?? " ").font(.subheadline).foregroundStyle(GymPalette.ink)
            .accessibilityHidden(pad.reading.refusal == nil).accessibilityIdentifier("workout-keypad-hint")
          LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: RoomSpace.small) {
            ForEach(Array(pad.field.keys.enumerated()), id: \.offset) { _, key in
              if key.isEmpty { Color.clear.frame(minHeight: RoomSpace.minimumTarget) }
              else {
                Button { pad.press(key) } label: { Text(key).font(.title2.monospacedDigit()).foregroundStyle(GymPalette.ink).frame(maxWidth: .infinity) }
                  .modifier(RoomSecondaryStyle()).frame(minHeight: RoomSpace.minimumTarget)
                  .accessibilityLabel(key == "±" ? "Flip the sign — band-assisted" : key)
                  .accessibilityIdentifier("workout-key-\(key)")
              }
            }
          }.dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }.padding(RoomSpace.inset)
      }.modifier(GymPage())
      .navigationTitle(pad.field.title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Delete", systemImage: "delete.left") { pad.press("⌫") }
            .labelStyle(.iconOnly).accessibilityIdentifier("workout-key-delete")
        }
      }.roomBar(.gym)
      .reachBand {
        ActionBand(title: "Set", room: .gym,
                   disabled: pad.reading.value == nil, actionIdentifier: "workout-keypad-set") {
          if let value = pad.reading.value { commit(value); dismiss() }
        }
      }
    }.modifier(GymPage()).presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.height(520), .large])
  }
}

// A numeral with its unit at its baseline, the unit dropping under it at accessibility sizes: the rack, Fix set and the
// keypad read a number the same way.
struct NumeralAndUnit<Numeral: View>: View {
  let unit: String
  let identifier: String
  let numeral: Numeral
  @Environment(\.dynamicTypeSize) private var typeSize

  init(unit: String, identifier: String, @ViewBuilder numeral: () -> Numeral) {
    self.unit = unit; self.identifier = identifier; self.numeral = numeral()
  }

  var body: some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    layout {
      numeral
      Text(unit).font(.title3).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier(identifier)
    }
  }
}

// One instrument wherever it is drawn (docs/design/ios/ios-redesign.md §5): the numeral opens the keypad and rolls to each
// new load, and the ladder steps by the load's own band with its keys in ink, whatever tint the host carries.
struct WeightInstrument: View {
  @Binding var weightKg: Double
  let identifier: String
  var basis = MovementEquipment("")
  let edit: () -> Void
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: RoomSpace.related) {
      NumeralAndUnit(unit: basis.unit, identifier: "\(identifier)-unit") {
        Button(action: edit) {
          Text(Readout.weight(weightKg)).modifier(GymNumeral()).lineLimit(1).minimumScaleFactor(0.5)
            .contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion, value: weightKg))
        }.buttonStyle(.plain).accessibilityLabel("Weight, \(Readout.weight(weightKg)) \(basis.unit)")
          .accessibilityIdentifier(identifier)
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
  var kind: String
  var rpe: Double?
  var note: String
  var completedAt: Instant
  var failure: String?
  var busy = false

  init(_ set: TrainingSet, account: String?) {
    original = set; self.account = account
    exerciseId = set.exerciseId; weightKg = set.weightKg; reps = set.reps; kind = set.kind; rpe = set.rpe; note = set.note
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
    TrainingSet(id: original.id, sessionId: original.sessionId, exerciseId: exerciseId, weightKg: weightKg, reps: reps, kind: kind,
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
  @State private var keypad: SetKeypad.Field?
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

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            WeightInstrument(weightKg: $draft.weightKg, identifier: "\(identifier)-weight", basis: MovementEquipment(gym.catalogue.find(draft.exerciseId))) { keypad = .weight }
            LabeledContent("Reps") {
              Button("\(draft.reps)") { keypad = .reps }.font(.title2.monospacedDigit()).accessibilityIdentifier("\(identifier)-reps")
            }
            Picker("Effort", selection: $draft.rpe) {
              Text("Not rated").tag(Optional<Double>.none)
              ForEach(Array(stride(from: 6.0, through: 10.0, by: 0.5)), id: \.self) { value in
                Text("RPE \(Readout.weight(value))").tag(Optional(value))
              }
            }.accessibilityIdentifier("\(identifier)-effort")
            Picker("Kind", selection: $draft.kind) {
              ForEach(SetKind.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0.rawValue) }
            }.pickerStyle(.segmented).accessibilityIdentifier("\(identifier)-kind")
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
            Button("Delete set", systemImage: "trash", role: .destructive) { delete() }
              .foregroundStyle(GymPalette.alarm).accessibilityIdentifier("\(identifier)-delete")
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
      .sheet(isPresented: Binding(get: { keypad != nil }, set: { if !$0 { keypad = nil } })) {
        if let keypad {
          SetKeypadSheet(field: keypad, value: keypad == .weight ? draft.weightKg : Double(draft.reps), basis: MovementEquipment(gym.catalogue.find(draft.exerciseId))) { value in
            if keypad == .weight { draft.weightKg = value } else { draft.reps = Int(value) }
          }
        }
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
