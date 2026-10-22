import DomainKit
import SyncCore

// A proposal as its card reads it: each change a block of field lines, in the card's order — a new name, movements that
// only moved, changed movements, removals, additions — and how many movements it leaves as they were. Moves are read
// against the routine while the proposal waits; once it settled, the routine no longer holds the order it replaced.
public struct ProposalDiff: Equatable, Sendable {
  public enum Kind: String, Sendable { case renamed, moved, changed, removed, added }
  public enum State: String, Sendable { case changed, same, new, gone }

  // One line of a block: *Load  82.5 kg → 90 kg*. A new line has no before, a gone line no after. Two sides that differ only in
  // Unicode form read the same, as Swift's string equality has it.
  public struct Field: Equatable, Sendable {
    public let label: String
    public let before: String?
    public let after: String?
    public var state: State {
      guard let before else { return .new }
      guard let after else { return .gone }
      return before == after ? .same : .changed
    }
    public init(_ label: String, before: String?, after: String?) { self.label = label; self.before = before; self.after = after }
  }

  public struct Block: Equatable, Sendable {
    public let kind: Kind
    public let exerciseId: ID<Exercise>?
    public let fields: [Field]
  }

  public let blocks: [Block]
  public let unchanged: Int

  public init(_ proposal: Proposal, routine: Routine?, units: GymUnits = .kg, each: Set<ID<Exercise>> = []) {
    guard proposal.intent != "remove" else { blocks = []; unchanged = 0; return }
    let pending = proposal.state == "pending"
    let moves = pending ? routine.map { Self.moves(proposal, base: $0) } ?? [:] : [:]
    var blocks: [Block] = []
    let rename = Field("Name", before: proposal.baseName ?? (pending ? routine?.name : nil), after: proposal.proposedName)
    if rename.state == .changed { blocks.append(Block(kind: .renamed, exerciseId: nil, fields: [rename])) }
    var unchanged = 0
    for (index, change) in proposal.changes.enumerated() {
      let order = moves[index].map { [Field("Order", before: Self.ordinal($0.from), after: Self.ordinal($0.to))] } ?? []
      let fields = Self.fields(before: change.before, after: change.after, units: units, each: each.contains(change.exerciseId))
      switch change.kind {
      case "kept" where order.isEmpty: unchanged += 1
      case "kept": blocks.append(Block(kind: .moved, exerciseId: change.exerciseId, fields: order))
      case "retargeted": blocks.append(Block(kind: .changed, exerciseId: change.exerciseId, fields: order + fields))
      case "removed": blocks.append(Block(kind: .removed, exerciseId: change.exerciseId, fields: fields))
      default: blocks.append(Block(kind: .added, exerciseId: change.exerciseId, fields: fields))
      }
    }
    let rank: [Kind] = [.renamed, .moved, .changed, .removed, .added]
    self.blocks = blocks.enumerated().sorted { a, b in
      let left = rank.firstIndex(of: a.element.kind)!, right = rank.firstIndex(of: b.element.kind)!
      return left != right ? left < right : a.offset < b.offset
    }.map(\.element)
    self.unchanged = unchanged
  }

  // A movement's targets, before and after, as lines: *Sets*, *Reps* and *Load* while every set is the same, one line per
  // set once they differ, *Target* when one side is open, and *Rest* when it changed. A side that is absent — an added or
  // a removed movement — leaves every line new or gone, its rest unsaid.
  public static func fields(before: EntryTargets?, after: EntryTargets?, units: GymUnits = .kg, each: Bool = false) -> [Field] {
    let sides = [before, after].compactMap { $0 }.map { $0.sets ?? [] }
    let line = { (label: String, read: (EntryTargets) -> String?) in Field(label, before: before.flatMap(read), after: after.flatMap(read)) }
    let load = { (kg: Double?) in kg.map { Readout.weight($0, units: units) + " " + units.rawValue + (each ? " each" : "") } }
    let set = { (target: SetTarget) in target.weightKg == nil ? reps(target.reps) + " reps" : reps(target.reps) + " × " + load(target.weightKg)! }
    var lines: [Field] = []
    if sides.contains(where: \.isEmpty) {
      if !(sides.count == 2 && sides.allSatisfy(\.isEmpty)) {
        lines.append(line("Target") { targets in
          guard let sets = targets.sets, !sets.isEmpty else { return "None" }
          guard uniform(sets) else { return sets.map(set).joined(separator: ", ") }
          return "\(sets.count) × " + reps(sets[0].reps) + (load(sets[0].weightKg).map { " at " + $0 } ?? "")
        })
      }
    } else if sides.allSatisfy(uniform) {
      lines.append(line("Sets") { $0.sets.map { String($0.count) } })
      lines.append(line("Reps") { $0.sets.map { reps($0[0].reps) } })
      if sides.contains(where: { $0[0].weightKg != nil }) { lines.append(line("Load") { $0.sets.map { load($0[0].weightKg) ?? "Last time" } }) }
    } else {
      for index in 0..<sides.map(\.count).max()! {
        let read = { (targets: EntryTargets?) in targets?.sets.flatMap { index < $0.count ? set($0[index]) : nil } }
        lines.append(Field("Set \(index + 1)", before: read(before), after: read(after)))
      }
    }
    if sides.count == 2, before?.restSeconds != after?.restSeconds {
      lines.append(line("Rest") { targets in targets.restSeconds.map { $0 >= 120 && $0 % 60 == 0 ? "\($0 / 60) min" : "\($0) s" } ?? "Default" })
    }
    return lines
  }

  static func reps(_ reps: Int?) -> String { reps.map(String.init) ?? "Max" }
  static func uniform(_ sets: [SetTarget]) -> Bool { sets.allSatisfy { $0 == sets[0] } }

  static func ordinal(_ place: Int) -> String {
    let suffix = (11...13).contains(place % 100) ? "th" : [1: "st", 2: "nd", 3: "rd"][place % 10] ?? "th"
    return "\(place)\(suffix)"
  }

  // The movements a pending proposal moves, by change index, each with its place in the routine and in the proposal. A
  // movement whose place is the same in both never moved; of the rest, those in the longest run that keeps the routine's
  // order stand — of equal runs, the one whose places come first — and every other one moved.
  static func moves(_ proposal: Proposal, base: Routine) -> [Int: (from: Int, to: Int)] {
    var unmatched = Array(base.entries.indices)
    var kept: [(change: Int, from: Int, to: Int)] = []
    for (to, (index, change)) in proposal.changes.enumerated().filter({ $0.element.kind != "removed" }).enumerated() {
      guard ["kept", "retargeted"].contains(change.kind),
            let at = unmatched.firstIndex(where: { base.entries[$0].exerciseId == change.exerciseId }) else { continue }
      let from = unmatched.remove(at: at)
      if from != to { kept.append((index, from, to)) }
    }
    var longest = Array(repeating: 1, count: kept.count)
    for i in kept.indices.reversed() {
      for j in kept.indices where j > i && kept[j].from > kept[i].from { longest[i] = max(longest[i], longest[j] + 1) }
    }
    var standing = Set<Int>(), previous = -1, length = longest.max() ?? 0
    var start = 0
    while length > 0 {
      let next = kept.indices.filter { $0 >= start && kept[$0].from > previous && longest[$0] == length }.min { kept[$0].from < kept[$1].from }!
      standing.insert(next); previous = kept[next].from; start = next + 1; length -= 1
    }
    var moves: [Int: (from: Int, to: Int)] = [:]
    for (index, entry) in kept.enumerated() where !standing.contains(index) { moves[entry.change] = (entry.from + 1, entry.to + 1) }
    return moves
  }
}
