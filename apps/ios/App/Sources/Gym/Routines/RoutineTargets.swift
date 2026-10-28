import Foundation
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
    case .weight: next = WeightLadder.bump(value, direction: direction)
    }
    guard next.isFinite else { return }
    type(next == 0 && field != .weight ? "" : Readout.weight(next), field: field)
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
    if field == .weight {
      let rounded = WeightLadder.round(value)
      return value != 0 && rounded == 0 ? .failure(NumberProblem(message: notANumber)) : .success(rounded)
    }
    if value == 0 { return .failure(NumberProblem(message: zeroTarget)) }
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
