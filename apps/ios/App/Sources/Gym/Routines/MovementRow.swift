import SwiftUI
import DomainKit
import GymDomain

// What a planned movement's row says under its name (02L.2): an open plan; a straight scheme as its sets, reps and load,
// each behind its symbol; or a varied scheme as its sets in sequence, *16×10 › 18×8 › 20×6*; then the rest, when the
// movement sets one. The load reads in the movement's basis, and bodyweight with nothing added reads *bodyweight*.
struct MovementPlanLine: Equatable {
  struct Fact: Equatable {
    let symbol: String
    let text: String
  }
  let facts: [Fact]
  let sequence: [String]
  let restSeconds: Int?

  init(_ sets: [SetTarget]?, restSeconds: Int?, equipment: MovementEquipment) {
    self.restSeconds = restSeconds
    guard let sets, let first = sets.first else { facts = []; sequence = []; return }
    if SetTarget.straight(sets) {
      facts = [Fact(symbol: "repeat", text: GymCount.of(sets.count, .set)),
               Fact(symbol: "number", text: first.reps.map { GymCount.of($0, .rep) } ?? String(localized: "Max reps")),
               Self.load(first.weightKg, equipment: equipment).map { Fact(symbol: "scalemass", text: $0) }].compactMap { $0 }
      sequence = []
    } else {
      facts = []
      sequence = sets.map(Readout.shortSetTarget)
    }
  }

  static func load(_ weightKg: Double?, equipment: MovementEquipment) -> String? {
    guard let weightKg else { return nil }
    if equipment.kind == .bodyweight, weightKg == 0 { return String(localized: "bodyweight", comment: "A bodyweight movement's load with nothing added") }
    return "\(Readout.weight(weightKg)) \(equipment.unit)"
  }

  var isOpen: Bool { facts.isEmpty && sequence.isEmpty }
  var rest: String? { restSeconds.map { WorkoutClocks.reading(Int64($0) * 1_000) } }

  // The line in one breath for VoiceOver: *3 sets, 8 reps, 60 kg total, rest 2 minutes*.
  var spoken: String {
    let plan = isOpen ? [String(localized: "Open plan")] : facts.isEmpty ? [sequence.joined(separator: String(localized: ", then ", comment: "Between two sets of a varied scheme read aloud"))] : facts.map(\.text)
    return (plan + [restSeconds.map { String(localized: "rest \(WorkoutClocks.spoken(Int64($0) * 1_000))") }].compactMap { $0 }).joined(separator: ", ")
  }
}

// A movement as the routine editor, the picker's return and the summary draw it (02L.2, 02L.7): its name beside its
// equipment, its plan line beneath, and in the summary its place before the name.
struct MovementRow: View {
  let exercise: Exercise?
  let entry: RoutineEntry
  var ordinal: Int?

  var name: String { exercise?.name ?? String(localized: "Movement unavailable") }
  var equipment: MovementEquipment { MovementEquipment(exercise) }
  var line: MovementPlanLine { MovementPlanLine(entry.sets, restSeconds: entry.restSeconds, equipment: equipment) }

  var body: some View {
    let line = line
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
        Text(ordinal.map { "\($0). \(name)" } ?? name).font(.headline).foregroundStyle(GymPalette.ink)
        if exercise != nil { Text(equipment.title).font(.subheadline).foregroundStyle(GymPalette.inkDim) }
      }
      HStack(spacing: 12) {
        if line.isOpen { Text("Open plan") }
        ForEach(Array(line.facts.enumerated()), id: \.offset) { _, fact in self.fact(fact.text, symbol: fact.symbol) }
        if !line.sequence.isEmpty {
          HStack(spacing: RoomSpace.small) {
            ForEach(Array(line.sequence.enumerated()), id: \.offset) { index, set in
              if index > 0 { Image(systemName: "chevron.right").font(.system(size: 7)).foregroundStyle(GymPalette.inkFaint) }
              Text(set).monospacedDigit()
            }
          }
        }
        if let rest = line.rest { fact(rest, symbol: "timer") }
      }.font(.caption).foregroundStyle(GymPalette.inkDim).lineLimit(1).minimumScaleFactor(0.7)
    }.frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel([ordinal.map { "\($0). \(name)" } ?? name, exercise == nil ? nil : equipment.title, line.spoken].compactMap { $0 }.joined(separator: ", "))
  }

  // One fact behind its symbol, the two set tight as Lift draws them.
  func fact(_ text: String, symbol: String) -> some View {
    HStack(spacing: 4) {
      Image(systemName: symbol)
      Text(text).monospacedDigit()
    }
  }
}
