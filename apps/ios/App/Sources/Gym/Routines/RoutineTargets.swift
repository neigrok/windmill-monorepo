import Foundation
import SwiftUI
import UIKit
import GymDomain

nonisolated struct RoutineTargetDraft: Equatable, Sendable {
  enum Field: Equatable, Sendable { case sets, reps, weight }

  struct Row: Equatable, Sendable {
    var reps: String
    var weight: String

    init(reps: String = "", weight: String = "") {
      self.reps = reps
      self.weight = weight
    }

    init(_ set: SetTarget) {
      reps = set.reps.map(String.init) ?? ""
      weight = set.weightKg.map { Readout.weight($0) } ?? ""
    }
  }

  struct Refusal: Equatable, Sendable {
    let row: Int?
    let field: Field
    let message: String
  }

  enum Reading: Equatable, Sendable {
    case open
    case scheme([SetTarget])
    case refused(Refusal)
  }

  static let onePoint = "One decimal point only."
  static let notANumber = "That is not a number yet."
  static let overWeight = "Over 500 kg — check the number."
  static let outsideReps = "Whole reps, 1 to 100."
  static let outsideSets = "Sets, 1 to 20."
  static let zeroTarget = "A zero target is no target — clear the field instead."

  private(set) var rows: [Row]
  private(set) var countText: String
  var varyBySet: Bool
  private(set) var atSetCeiling = false

  init(sets: [SetTarget]?) {
    rows = (sets ?? []).map(Row.init)
    countText = rows.isEmpty ? "" : String(rows.count)
    varyBySet = sets.map { sets in sets.dropFirst().contains { $0 != sets.first } } ?? false
  }

  var isOpen: Bool { countText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  var visibleRows: [Row] {
    guard !isOpen else { return [] }
    guard case .success(let value) = Self.number(countText, field: .sets), let value else { return rows }
    return Array(rows.prefix(Int(value)))
  }

  var reading: Reading {
    if isOpen { return .open }
    let count: Int
    switch Self.number(countText, field: .sets) {
    case .failure(let problem): return .refused(Refusal(row: nil, field: .sets, message: problem.message))
    case .success(let value):
      guard let value else { return .open }
      count = Int(value)
    }
    let last = rows.last ?? Row()
    let shown = rows.count >= count ? Array(rows.prefix(count)) : rows + Array(repeating: last, count: count - rows.count)
    var sets: [SetTarget] = []
    for (index, row) in shown.enumerated() {
      let reps: Int?
      switch Self.number(row.reps, field: .reps) {
      case .failure(let problem): return .refused(Refusal(row: index, field: .reps, message: problem.message))
      case .success(let value): reps = value.map(Int.init)
      }
      switch Self.number(row.weight, field: .weight) {
      case .failure(let problem): return .refused(Refusal(row: index, field: .weight, message: problem.message))
      case .success(let value): sets.append(SetTarget(reps: reps, weightKg: value))
      }
    }
    return .scheme(sets)
  }

  var refusal: Refusal? {
    guard case .refused(let refusal) = reading else { return nil }
    return refusal
  }

  var headRefusal: Refusal? {
    guard let refusal else { return nil }
    return refusal.field == .sets || !shared(refusal.field).isEmpty ? refusal : nil
  }

  var canEditTargets: Bool { !isOpen && refusal?.field != .sets && !visibleRows.isEmpty }

  var canChangeVariation: Bool {
    !isOpen && (!varyBySet || refusal == nil || headRefusal != nil)
  }

  var commitLabel: String {
    switch reading {
    case .open: return "Set · open"
    case .refused: return "Set"
    case .scheme(let sets):
      let straight = sets.dropFirst().allSatisfy { $0 == sets.first }
      return "Set · " + (straight ? Readout.target(sets) : "\(sets.count) sets")
    }
  }

  func shared(_ field: Field) -> String {
    if field == .sets { return countText }
    let values = visibleRows.map { (field == .reps ? $0.reps : $0.weight).trimmingCharacters(in: .whitespacesAndNewlines) }
    return Set(values).count == 1 ? values.first ?? "" : ""
  }

  func varies(_ field: Field) -> Bool {
    Set(visibleRows.map { (field == .reps ? $0.reps : $0.weight).trimmingCharacters(in: .whitespacesAndNewlines) }).count > 1
  }

  mutating func type(_ text: String, field: Field, row: Int? = nil) {
    atSetCeiling = false
    if field == .sets {
      countText = text
      if case .success(let value) = Self.number(text, field: .sets), let value { grow(to: Int(value)) }
      return
    }
    for index in rows.indices where row == nil || row == index {
      if field == .reps { rows[index].reps = text }
      else { rows[index].weight = text }
    }
  }

  mutating func step(_ field: Field, direction: Int) {
    let typed = shared(field).trimmingCharacters(in: .whitespacesAndNewlines)
    guard let value = typed.isEmpty ? 0 : Double(Self.normalized(typed)), value.isFinite else { return }
    if field != .weight && value != floor(value) { return }
    let next: Double
    switch field {
    case .sets: next = min(20, max(0, value + Double(direction)))
    case .reps: next = min(100, max(0, value + Double(direction)))
    case .weight: next = min(500, max(-500, WeightLadder.bump(value, direction: direction)))
    }
    type(next == 0 ? "" : Readout.weight(next), field: field)
  }

  mutating func flipSign(row: Int? = nil) {
    let text: String
    if let row, rows.indices.contains(row) { text = rows[row].weight.trimmingCharacters(in: .whitespacesAndNewlines) }
    else { text = shared(.weight) }
    guard !text.isEmpty else { return }
    type(text.hasPrefix("−") || text.hasPrefix("-") ? String(text.dropFirst()) : "−" + text, field: .weight, row: row)
  }

  mutating func addSet() {
    let count = visibleRows.count
    guard count < 20 else { atSetCeiling = true; return }
    type(String(count + 1), field: .sets)
  }

  mutating func deleteSet(_ index: Int) {
    guard visibleRows.indices.contains(index) else { return }
    let count = visibleRows.count
    rows.remove(at: index)
    countText = count == 1 ? "" : String(count - 1)
    atSetCeiling = false
  }

  mutating func matchFirst() {
    guard let first = visibleRows.first else { return }
    for index in visibleRows.indices { rows[index] = first }
    atSetCeiling = false
  }

  var canRamp: Bool {
    guard case .scheme(let sets) = reading, sets.count >= 3, let first = sets.first, let last = sets.last else { return false }
    return first != last
  }

  mutating func rampUp() {
    guard canRamp, let firstRow = visibleRows.first, let lastRow = visibleRows.last,
          let first = Self.set(firstRow), let last = Self.set(lastRow) else { return }
    let steps = visibleRows.count - 1
    for index in 1..<steps {
      let along = Double(index) / Double(steps)
      let current = Self.set(rows[index]) ?? SetTarget()
      let reps: Int?
      if let start = first.reps, let end = last.reps { reps = Int(floor(Double(start) + Double(end - start) * along + 0.5)) }
      else { reps = current.reps }
      let load: Double?
      if let start = first.weightKg, let end = last.weightKg { load = WeightLadder.onGrid(start + (end - start) * along) }
      else { load = current.weightKg }
      rows[index] = Row(SetTarget(reps: reps, weightKg: load))
    }
    varyBySet = true
    atSetCeiling = false
  }

  private mutating func grow(to count: Int) {
    guard count > rows.count else { return }
    rows.append(contentsOf: Array(repeating: rows.last ?? Row(), count: count - rows.count))
  }

  private struct NumberProblem: Error { let message: String }

  private static func normalized(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "−", with: "-").replacingOccurrences(of: ",", with: ".")
  }

  private static func number(_ text: String, field: Field) -> Result<Double?, NumberProblem> {
    let normalized = normalized(text)
    if normalized.isEmpty { return .success(nil) }
    if normalized.filter({ $0 == "." }).count > 1 { return .failure(NumberProblem(message: onePoint)) }
    guard let value = Double(normalized), value.isFinite else { return .failure(NumberProblem(message: notANumber)) }
    if field == .weight && abs(value) > 500 { return .failure(NumberProblem(message: overWeight)) }
    if value == 0 { return .failure(NumberProblem(message: zeroTarget)) }
    if field == .weight {
      let rounded = WeightLadder.round(value)
      return rounded == 0 ? .failure(NumberProblem(message: zeroTarget)) : .success(rounded)
    }
    let band: ClosedRange<Double> = field == .sets ? 1...20 : 1...100
    guard value == floor(value), band.contains(value) else {
      return .failure(NumberProblem(message: field == .sets ? outsideSets : outsideReps))
    }
    return .success(value)
  }

  private static func set(_ row: Row) -> SetTarget? {
    guard case .success(let reps) = number(row.reps, field: .reps),
          case .success(let weight) = number(row.weight, field: .weight) else { return nil }
    return SetTarget(reps: reps.map(Int.init), weightKg: weight)
  }
}

struct RoutineTargetsSheet: View {
  let gym: GymModel
  let exercise: Exercise
  let onCommit: ([SetTarget]?) -> Void
  let onCancel: () -> Void
  @Binding private var draft: RoutineTargetDraft
  @State private var feedback = 0
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @FocusState private var focus: Focus?

  private enum Focus: Hashable { case sets, reps, weight, rowReps(Int), rowWeight(Int) }

  init(gym: GymModel, exercise: Exercise, draft: Binding<RoutineTargetDraft>, onCancel: @escaping () -> Void, onCommit: @escaping ([SetTarget]?) -> Void) {
    self.gym = gym; self.exercise = exercise; _draft = draft
    self.onCancel = onCancel; self.onCommit = onCommit
  }

  var body: some View {
    List {
      Group {
        Section {
          if draft.isOpen && draft.refusal == nil {
            Text("You decide the numbers at the rack.").foregroundStyle(GymPalette.inkDim)
          }
          headField("Sets", field: .sets, placeholder: "open", focus: .sets)
          headField("Reps", field: .reps, placeholder: draft.varies(.reps) ? "varies" : "max", focus: .reps)
          headField("kg", field: .weight, placeholder: draft.varies(.weight) ? "varies" : "last time", focus: .weight)
          Toggle("Vary by set", isOn: $draft.varyBySet)
            .disabled(!draft.canChangeVariation)
        } footer: {
          Text("kg blank: pick it at the rack the first time; after that, last time fills it.")
        }
        if !draft.isOpen && draft.varyBySet {
          Section("Each set") {
            fillMenu
            ForEach(draft.visibleRows.indices, id: \.self) { index in
              targetRow(index)
                .swipeActions(edge: .trailing) { Button("Delete", role: .destructive) { delete(index) } }
                .accessibilityAction(named: "Delete") { delete(index) }
                .contextMenu {
                  fillActions
                  Button("Delete", systemImage: "trash", role: .destructive) { delete(index) }
                }
            }
            Button { draft.addSet(); feedback += 1 } label: { Label("Add set", systemImage: "plus") }
              .accessibilityIdentifier("gym-target-add-set")
            if draft.atSetCeiling && draft.refusal == nil { refusalLine(RoutineTargetDraft.outsideSets) }
          }
        } else if !draft.isOpen {
          Section { fillMenu }
        }
      }.listRowBackground(GymPalette.card)
    }
    .accessibilityIdentifier("gym-routine-targets")
    .navigationTitle(exercise.name)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Next") { nextField() }.frame(minWidth: 44, minHeight: 44).disabled(focus == nil || focus == lastFocus)
        Button("Done") { focus = nil }.frame(minWidth: 44, minHeight: 44).accessibilityIdentifier("gym-target-keyboard-done")
      }
    }
    .safeAreaInset(edge: .bottom) {
      Button {
        switch draft.reading {
        case .open: onCommit(nil)
        case .scheme(let sets): onCommit(sets)
        case .refused: return
        }
      } label: { Text(draft.commitLabel).foregroundStyle(GymPalette.onAccent).frame(maxWidth: .infinity) }
      .modifier(RoomPrimaryStyle(accent: GymPalette.accent, onAccent: GymPalette.onAccent)).controlSize(.large).frame(maxWidth: .infinity)
      .disabled(draft.refusal != nil).accessibilityIdentifier("gym-target-set")
      .padding().background(.bar)
    }
    .sensoryFeedback(.selection, trigger: feedback)
    .onChange(of: draft.refusal) { _, refusal in
      if let refusal {
        if draft.headRefusal == nil { draft.varyBySet = true }
        UIAccessibility.post(notification: .announcement, argument: refusal.message)
      }
    }
    .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_editor"]) }
    .modifier(GymPage())
  }
  private func headField(_ label: String, field: RoutineTargetDraft.Field, placeholder: String, focus target: Focus) -> some View {
    let refused = draft.headRefusal?.field == field
    let enabled = field == .sets || draft.canEditTargets
    return VStack(alignment: .leading, spacing: 8) {
      if dynamicTypeSize.isAccessibilitySize { Text(label) }
      HStack {
        if !dynamicTypeSize.isAccessibilitySize { Text(label); Spacer(minLength: 12) }
        Button { draft.step(field, direction: -1); feedback += 1 } label: { Image(systemName: "minus").frame(minWidth: 44, minHeight: 44) }
          .accessibilityLabel("Decrease \(label)")
        TextField(placeholder, text: Binding(get: { draft.shared(field) }, set: { draft.type($0, field: field) }))
          .keyboardType(field == .weight ? .decimalPad : .numberPad)
          .multilineTextAlignment(.center)
          .monospacedDigit()
          .frame(minWidth: 72, maxWidth: .infinity, minHeight: 44)
          .focused($focus, equals: target)
          .accessibilityLabel(field == .weight ? "Weight target" : "\(label) target")
          .accessibilityHint(refused ? draft.headRefusal?.message ?? "" : "")
          .accessibilityIdentifier("gym-target-\(field)")
          .onSubmit { nextField() }
        Button { draft.step(field, direction: 1); feedback += 1 } label: { Image(systemName: "plus").frame(minWidth: 44, minHeight: 44) }
          .accessibilityLabel("Increase \(label)")
        if field == .weight && exercise.equipment == "bodyweight" { signButton(row: nil) }
      }
      .buttonStyle(.borderless)
      .disabled(!enabled)
      if refused, let refusal = draft.headRefusal { refusalLine(refusal.message) }
    }
  }

  private func targetRow(_ index: Int) -> some View {
    let refusal = draft.headRefusal == nil && draft.refusal?.row == index ? draft.refusal : nil
    return VStack(alignment: .leading, spacing: 8) {
      Text("Set \(index + 1)").font(.subheadline).foregroundStyle(GymPalette.inkDim)
      if dynamicTypeSize.isAccessibilitySize {
        rowField("Reps", field: .reps, index: index, placeholder: "max", focus: .rowReps(index), refusal: refusal)
        HStack {
          rowField("kg", field: .weight, index: index, placeholder: "last time", focus: .rowWeight(index), refusal: refusal)
          if exercise.equipment == "bodyweight" { signButton(row: index) }
        }
      } else {
        HStack(spacing: 16) {
          rowField("Reps", field: .reps, index: index, placeholder: "max", focus: .rowReps(index), refusal: refusal)
          rowField("kg", field: .weight, index: index, placeholder: "last time", focus: .rowWeight(index), refusal: refusal)
          if exercise.equipment == "bodyweight" { signButton(row: index) }
        }
      }
      if let refusal { refusalLine(refusal.message) }
    }
  }

  private func rowField(_ label: String, field: RoutineTargetDraft.Field, index: Int, placeholder: String, focus target: Focus,
                        refusal: RoutineTargetDraft.Refusal?) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption).foregroundStyle(GymPalette.inkDim)
      TextField(placeholder, text: Binding(get: {
        guard draft.rows.indices.contains(index) else { return "" }
        return field == .reps ? draft.rows[index].reps : draft.rows[index].weight
      }, set: { draft.type($0, field: field, row: index) }))
        .keyboardType(field == .weight ? .decimalPad : .numberPad)
        .disabled(!draft.canEditTargets)
        .textFieldStyle(.roundedBorder)
        .monospacedDigit()
        .focused($focus, equals: target)
        .accessibilityLabel("Set \(index + 1) \(field == .reps ? "reps" : "load")")
        .accessibilityHint(refusal?.field == field ? refusal?.message ?? "" : "")
        .accessibilityIdentifier("gym-target-row-\(index + 1)-\(field)")
        .onSubmit { nextField() }
    }
  }

  private func signButton(row: Int?) -> some View {
    Button { draft.flipSign(row: row); feedback += 1 } label: { Image(systemName: "plusminus") }
      .buttonStyle(.borderless)
      .frame(minWidth: 44, minHeight: 44)
      .disabled(!draft.canEditTargets)
      .accessibilityLabel("Flip the sign — band-assisted")
  }

  @ViewBuilder private var fillActions: some View {
    Button("Ramp up") { draft.rampUp(); feedback += 1 }.disabled(!draft.canRamp)
    Button("Match set 1") { draft.matchFirst(); feedback += 1 }.disabled(!draft.canEditTargets)
  }

  private var fillMenu: some View {
    Menu { fillActions } label: {
      Text("Fill").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }.accessibilityIdentifier("gym-target-fill")
      .simultaneousGesture(TapGesture().onEnded { focus = nil })
  }

  private func refusalLine(_ message: String) -> some View {
    Text(message).font(.subheadline).foregroundStyle(.red).accessibilityIdentifier("gym-target-refusal")
  }

  private func delete(_ index: Int) {
    focus = nil
    draft.deleteSet(index)
    feedback += 1
  }

  private var focusOrder: [Focus] {
    var fields: [Focus] = [.sets]
    if draft.canEditTargets {
      fields += [.reps, .weight]
      if draft.varyBySet { fields += draft.visibleRows.indices.flatMap { [Focus.rowReps($0), .rowWeight($0)] } }
    }
    return fields
  }

  private var lastFocus: Focus? { focusOrder.last }

  private func nextField() {
    guard let focus, let index = focusOrder.firstIndex(of: focus), index + 1 < focusOrder.count else { self.focus = nil; return }
    self.focus = focusOrder[index + 1]
  }
}
