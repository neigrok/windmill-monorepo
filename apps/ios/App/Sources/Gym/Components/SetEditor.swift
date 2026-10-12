import SwiftUI
import Observation
import DomainKit
import GymDomain

struct SetKeypad {
  enum Field { case weight, reps }
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
  var reading: (value: Double?, message: String) {
    let raw = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
    if raw.isEmpty || raw == "-" { return (nil, "Enter a number, or cancel to keep \(Readout.weight(keeping))") }
    if raw.filter({ $0 == "." }).count > 1 { return (nil, "One decimal point only.") }
    guard let number = Double(raw), number.isFinite else { return (nil, "That is not a number yet.") }
    if field == .weight {
      guard abs(number) <= 500 else { return (nil, "Over 500 kg — check the number.") }
      return (WeightLadder.round(number), "kg")
    }
    guard number.rounded() == number && (1...99).contains(number) else { return (nil, "Whole reps, 1 to 99.") }
    return (number, "whole reps")
  }
}

struct SetKeypadSheet: View {
  @Environment(\.dismiss) var dismiss
  @State var pad: SetKeypad
  let commit: (Double) -> Void
  init(field: SetKeypad.Field, value: Double, commit: @escaping (Double) -> Void) {
    _pad = State(initialValue: SetKeypad(field, value: value)); self.commit = commit
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: RoomSpace.small) {
          Text(pad.text.isEmpty ? "—" : pad.text.replacingOccurrences(of: "-", with: "−"))
            .modifier(GymKeypadNumeral())
            .lineLimit(1).minimumScaleFactor(0.5).frame(maxWidth: .infinity)
            .accessibilityIdentifier("workout-keypad-value")
          Text(pad.reading.message).font(.subheadline).foregroundStyle(pad.reading.value == nil ? GymPalette.ink : GymPalette.inkDim)
            .accessibilityIdentifier("workout-keypad-hint")
          LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: RoomSpace.small) {
            ForEach(["1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", "."], id: \.self) { key in
              Button { pad.press(key) } label: { Text(key).font(.title2.monospacedDigit()).frame(maxWidth: .infinity) }
                .modifier(RoomSecondaryStyle()).frame(minHeight: RoomSpace.minimumTarget)
                .disabled(pad.field == .reps && ["±", "."].contains(key))
                .accessibilityLabel(key == "±" ? "Flip the sign — band-assisted" : key)
                .accessibilityIdentifier("workout-key-\(key)")
            }
          }
        }.padding(RoomSpace.inset)
      }.modifier(GymPage())
      .navigationTitle(pad.field == .weight ? "Weight · kg" : "Reps")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Delete", systemImage: "delete.left") { pad.press("⌫") }
            .labelStyle(.iconOnly).accessibilityIdentifier("workout-key-delete")
        }
      }
      .safeAreaInset(edge: .bottom) {
        ActionBand(title: "Set", room: .gym,
                   disabled: pad.reading.value == nil, actionIdentifier: "workout-keypad-set") {
          if let value = pad.reading.value { commit(value); dismiss() }
        }
      }
    }.modifier(GymPage()).presentationDetents([.height(440)])
  }
}

// The numeral opens the keypad; the ladder steps by the load's own band. At accessibility sizes the unit drops under the numeral.
struct WeightInstrument: View {
  @Binding var weightKg: Double
  let identifier: String
  let edit: () -> Void
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
        Button(action: edit) {
          Text(Readout.weight(weightKg)).modifier(GymNumeral()).lineLimit(1).minimumScaleFactor(0.5)
        }.buttonStyle(.plain).accessibilityLabel("Weight, \(Readout.weight(weightKg)) kilograms")
          .accessibilityIdentifier(identifier)
        if !typeSize.isAccessibilitySize { unit }
      }
      if typeSize.isAccessibilitySize { unit }
      LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: typeSize.isAccessibilitySize ? 2 : 4), spacing: RoomSpace.related) {
        ForEach(0..<4) { index in
          let label = WeightLadder.labels(weightKg)[index]
          Button(label) {
            weightKg = WeightLadder.bump(weightKg, direction: index < 2 ? -1 : 1, big: index == 0 || index == 3)
          }.modifier(RoomSecondaryStyle()).frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget)
            .accessibilityLabel("\(label) kilograms")
        }
      }.font(.body.monospacedDigit())
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  var unit: some View { Text("kg").font(.title3).foregroundStyle(GymPalette.inkDim) }
}

@Observable nonisolated final class SetFixDraft {
  private(set) var original: TrainingSet
  let account: String?
  var weightKg: Double
  var reps: Int
  var kind: String
  var rpe: Double?
  var note: String
  var failure: String?
  var busy = false

  init(_ set: TrainingSet, account: String?) {
    original = set; self.account = account
    weightKg = set.weightKg; reps = set.reps; kind = set.kind; rpe = set.rpe; note = set.note
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
    var set = original
    set.weightKg = weightKg; set.reps = reps; set.kind = kind; set.rpe = rpe; set.note = note
    return set
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

// The Fix set sheet for a live or a finished set; `identifier` prefixes each control's accessibility identifier.
struct SetEditor: View {
  let gym: GymModel
  let routine: String?
  let identifier: String
  @Environment(\.dismiss) private var dismiss
  @State private var draft: SetFixDraft
  @State private var keypad: SetKeypad.Field?
  @State private var saved = false

  init(gym: GymModel, set: TrainingSet, routine: String?, identifier: String) {
    self.gym = gym; self.routine = routine; self.identifier = identifier
    _draft = State(initialValue: SetFixDraft(set, account: gym.account))
  }

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            WeightInstrument(weightKg: $draft.weightKg, identifier: "\(identifier)-weight") { keypad = .weight }
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
          } header: { Text(gym.catalogue.find(draft.original.exerciseId)?.name ?? "Movement") }
          Section {
            TextEditor(text: $draft.note).frame(minHeight: 100).accessibilityLabel("Set note")
              .accessibilityIdentifier("\(identifier)-note")
            if !draft.note.isEmpty { Button("Clear note") { draft.note = "" } }
            if let counter = draft.noteCounter {
              Text(counter).font(.caption.monospacedDigit())
                .foregroundStyle(draft.noteBytes > 4_000 ? GymPalette.alarm : GymPalette.inkDim)
            }
          } header: { Text("Set note") } footer: { Text("A record for you — not an instruction to Coach.") }
          Section {
            Button("Delete set", systemImage: "trash", role: .destructive) { if draft.delete(gym) { dismiss() } }
              .foregroundStyle(GymPalette.alarm).accessibilityIdentifier("\(identifier)-delete")
          } footer: { if let routine { Text("\(routine) keeps its planned targets.") } }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).disabled(draft.busy || gym.accountTransition)
        .navigationTitle("Fix set")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(draft.busy) } }
        .safeAreaInset(edge: .bottom) {
          VStack(spacing: 0) {
            GymTransient(gym: gym, message: draft.failure ?? draft.problem,
                         dismiss: draft.failure == nil ? nil : { draft.failure = nil }, errorIdentifier: "\(identifier)-failure")
            ActionBand(title: "Save the fix", room: .gym, disabled: draft.problem != nil || gym.accountTransition,
                       busy: draft.busy, actionIdentifier: "\(identifier)-save") {
              if draft.save(gym) { saved = true; dismiss() }
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
      .sensoryFeedback(.success, trigger: saved)
      .onChange(of: draft.value) { _, _ in draft.failure = nil }
      .onChange(of: gym.sets) { _, sets in
        if !gym.readFailed && !sets.contains(where: { $0.id == draft.original.id }) { dismiss() }
      }
      .onChange(of: gym.account) { _, _ in dismiss() }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "fix_set"]) }
  }
}
