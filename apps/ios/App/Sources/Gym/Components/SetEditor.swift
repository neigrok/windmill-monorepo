import SwiftUI
import UIKit
import Observation
import DomainKit
import GymDomain

// A load as typed: decimal digits of any script, the point, the comma or the locale's separator, and a leading minus or its
// typographic sign where the basis is signed, rounded to the hundredth and within 500 kg of zero; nil for anything else, an
// empty field included.
nonisolated enum LoadText {
  static let bound = 500.0
  static let separators: Set<Character> = [".", ",", "٫"]
  static let directionMarks: Set<Character> = ["\u{200E}", "\u{200F}", "\u{061C}"]

  static func parse(_ text: String, signed: Bool, locale: Locale = .current) -> Double? {
    let separators = separators.union(locale.decimalSeparator.map { Set($0) } ?? [])
    var digits = String(text.trimmingCharacters(in: .whitespaces).compactMap { (character: Character) -> Character? in
      if directionMarks.contains(character) { return nil }
      if character == "−" { return "-" }
      if separators.contains(character) { return "." }
      if character.unicodeScalars.first?.properties.numericType == .decimal, let digit = character.wholeNumberValue {
        return Character(String(digit))
      }
      return character
    })
    let negative = digits.hasPrefix("-")
    if negative { digits.removeFirst() }
    let digit = { (character: Character) in ("0"..."9").contains(character) }
    guard !negative || signed, digits.contains(where: digit), digits.allSatisfy({ digit($0) || $0 == "." }),
          digits.filter({ $0 == "." }).count <= 1, let magnitude = Double(digits) else { return nil }
    let value = WeightLadder.round(negative ? -magnitude : magnitude)
    return abs(value) <= bound ? value : nil
  }

  // The field's text for a load, in the locale's decimal separator.
  static func typed(_ weightKg: Double, locale: Locale = .current) -> String {
    Readout.weight(weightKg).replacingOccurrences(of: ".", with: locale.decimalSeparator ?? ".")
  }
}

// One load on the system decimal pad (03.23, 03.25, 03.30). Editing selects its text, so the first key replaces it. While
// it is typed in, `weightKg` holds the load the field stands for: a readable value, else the load it opened on, which is
// what the field shows again when it lets go. Bodyweight and Other add ± to the keyboard row, the pad having no minus,
// unless the host draws its own; ± flips the load, whatever is typed. `focus` asks for the keyboard; whether the field is
// being typed in comes from the text field's own editing callback, SwiftUI's focus not reporting back from the rack's
// reach band.
struct LoadField: View {
  @Binding var weightKg: Double
  let basis: MovementEquipment
  let focus: FocusState<Bool>.Binding
  let identifier: String
  var signInKeyboardRow = true
  var ended: () -> Void = {}
  @State private var typed = ""
  @State private var opening = 0.0
  @State private var editing = false

  var standsFor: Double { LoadText.parse(typed, signed: basis.signed) ?? opening }

  var body: some View {
    TextField("Load", text: $typed, onEditingChanged: { editing = $0 })
      .keyboardType(.decimalPad)
      .focused(focus)
      .onAppear { typed = LoadText.typed(weightKg) }
      .onChange(of: editing) { _, began in
        if began {
          opening = weightKg; typed = LoadText.typed(weightKg)
          // Focus from code leaves the caret at the end; the editing field is the first responder, which selects its text.
          DispatchQueue.main.async { UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil) }
          return
        }
        weightKg = standsFor; typed = LoadText.typed(weightKg)
        ended()
      }
      .onChange(of: weightKg) { _, value in if !editing || value != standsFor { typed = LoadText.typed(value) } }
      .onChange(of: typed) { _, _ in if editing { weightKg = standsFor } }
      .toolbar {
        if editing, basis.signed, signInKeyboardRow {
          ToolbarItemGroup(placement: .keyboard) {
            Button("Flip the sign", systemImage: "plus.forwardslash.minus") { weightKg = -weightKg }
              .accessibilityIdentifier("\(identifier)-sign")
            Spacer()
          }
        }
      }
      .accessibilityLabel("Load, \(basis.unit)")
      .accessibilityIdentifier(identifier)
  }
}

// Reps on one native wheel over the logged band, 1 to 99, the unit beside the selected row as Clock's timer draws it. A
// count outside the band keeps its row, so the wheel never moves a number it opened on.
struct RepsWheel: View {
  @Binding var reps: Int
  let identifier: String
  @State private var counts: [Int]

  init(reps: Binding<Int>, identifier: String) {
    _reps = reps; self.identifier = identifier
    _counts = State(initialValue: Self.counts(around: reps.wrappedValue))
  }

  static func counts(around reps: Int) -> [Int] {
    SetRules.loggedReps.contains(reps) ? Array(SetRules.loggedReps) : (Array(SetRules.loggedReps) + [reps]).sorted()
  }

  var body: some View {
    Picker("Reps", selection: $reps) {
      ForEach(counts, id: \.self) { count in
        HStack(spacing: RoomSpace.related) {
          Text("\(count)").monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing)
          Text("reps").hidden().frame(maxWidth: .infinity, alignment: .leading)
        }.accessibilityElement(children: .ignore).accessibilityLabel(GymCount.of(count, "rep"))
      }
    }.pickerStyle(.wheel)
      .overlay {
        HStack(spacing: RoomSpace.related) {
          Color.clear.frame(maxWidth: .infinity)
          Text("reps").foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity, alignment: .leading)
        }.allowsHitTesting(false).accessibilityHidden(true)
      }
      .accessibilityIdentifier(identifier)
  }
}

// A set's Load row as Fix set and Edit sets draw it (03.25, 03.30): the load on the decimal pad in its well, outlined in
// the accent while it has focus, then its unit.
struct LoadRow: View {
  @Binding var weightKg: Double
  let basis: MovementEquipment
  let focus: FocusState<Bool>.Binding
  let identifier: String
  var ended: () -> Void = {}

  var body: some View {
    LabeledContent("Load") {
      HStack(spacing: RoomSpace.related) {
        LoadField(weightKg: $weightKg, basis: basis, focus: focus, identifier: identifier, ended: ended)
          .modifier(FieldWell(focused: focus.wrappedValue))
        Text(basis.unit).foregroundStyle(GymPalette.inkDim).fixedSize()
      }
    }.foregroundStyle(GymPalette.ink)
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

  var noteBytes: Int { SetRules.note.measure(note) }
  var noteCounter: String? { noteBytes >= SetRules.note.max * 4 / 5 ? "\(noteBytes) of \(SetRules.note.max) bytes" : nil }
  var problem: String? {
    guard weightKg.isFinite else { return "That is not a number yet." }
    guard SetRules.loggedReps.contains(reps) else { return "Whole reps, \(SetRules.loggedReps.lowerBound)–\(SetRules.loggedReps.upperBound)." }
    guard noteBytes <= SetRules.note.max else { return "A set note runs to \(SetRules.note.max) bytes." }
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
    if case .invalid(let violation) = outcome.refusal, violation.rule == SetRules.loadFloor {
      failure = "Enter 0 or more, or cancel to keep \(Readout.weight(original.weightKg))"; return false
    }
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

// Fix set (03.25): the set's place as the title over its movement, its load and reps, Effort and Note, and
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
  @State private var detent = PresentationDetent.height(470)
  @FocusState private var loadFocused: Bool

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
            Group {
              LoadRow(weightKg: $draft.weightKg, basis: MovementEquipment(gym.catalogue.find(draft.exerciseId)),
                      focus: $loadFocused, identifier: "\(identifier)-load")
              RepsWheel(reps: $draft.reps, identifier: "\(identifier)-reps").frame(height: 140).clipped()
            }.id(draft.exerciseId)
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
                .foregroundStyle(draft.noteBytes > SetRules.note.max ? GymPalette.alarm : GymPalette.inkDim)
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
                     busy: draft.busy, prominent: false, dismiss: { dismiss() }, commit: save)
        .reachBand {
          GymTransient(gym: gym, message: draft.failure ?? draft.problem,
                       dismiss: draft.failure == nil ? nil : { draft.failure = nil }, errorIdentifier: "\(identifier)-failure")
        }
    }.modifier(GymPage())
      .presentationDetents(logged && !typeSize.isAccessibilitySize ? [.height(470), .large] : [.large], selection: $detent)
      .onAppear { if !logged || typeSize.isAccessibilitySize { detent = .large } }
      .onChange(of: loadFocused) { _, focused in if focused { detent = .large } }
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
