import SwiftUI
import DomainKit
import GymDomain

// The room's two-line row, a title over one meta line; the caller wraps it in its Button or NavigationLink and says
// what stands at its trailing edge: a fact, the selection's check, work on its way, or the chevron of a door a Button
// opens (a sheet, another tab), which a NavigationLink gets from the system.
struct GymRow: View {
  enum Trailing: Equatable { case fact(String), check, progress, door }
  let title: String
  var meta: String?
  var trailing: Trailing?
  var lineLimit: Int?

  var body: some View {
    HStack(spacing: RoomSpace.related) {
      VStack(alignment: .leading, spacing: RoomSpace.small) {
        Text(title).font(meta == nil ? .body : .body.weight(.semibold)).foregroundStyle(GymPalette.ink).lineLimit(lineLimit)
        if let meta { Text(meta).font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim).lineLimit(lineLimit) }
      }.frame(maxWidth: .infinity, alignment: .leading)
      switch trailing {
      case .fact(let fact): Text(fact).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
      case .check: Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true)
      case .progress: ProgressView()
      case .door: DoorChevron(room: .gym)
      case nil: EmptyView()
      }
    }.frame(minHeight: RoomSpace.minimumTarget)
  }
}

// One set read back: its place, its numbers and, when present, a trailing caption and a second line of the time, the
// effort and the note. A warmup reads dimmer than the work.
struct SetRow: View {
  let marker: String
  let set: TrainingSet
  var caption: String?
  var time: String?
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    let second = [time, set.rpe.map { "RPE \(Readout.weight($0))" }, set.note.isEmpty ? nil : set.note].compactMap { $0 }
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      layout {
        Text("\(marker) · \(Readout.effort(weightKg: set.weightKg, reps: set.reps))").monospacedDigit()
          .foregroundStyle(set.kind == SetKind.warmup.rawValue ? GymPalette.inkDim : GymPalette.ink)
          .frame(maxWidth: .infinity, alignment: .leading)
        if let caption { Text(caption).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim) }
      }
      if !second.isEmpty {
        Text(second.joined(separator: " · ")).font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
  }

  // A working set by its place among the working sets so far, any other kind by its letter.
  nonisolated static func marker(_ set: TrainingSet, in sets: [TrainingSet]) -> String {
    guard set.kind == SetKind.working.rawValue else { return String(set.kind.prefix(1)).uppercased() }
    let through = sets.prefix { $0.id != set.id } + [set]
    return "\(through.filter { $0.kind == SetKind.working.rawValue }.count)"
  }

  // Each movement once, in the order its first set was logged.
  nonisolated static func movements(_ sets: [TrainingSet]) -> [ID<Exercise>] {
    var ids: [ID<Exercise>] = []
    for set in sets where !ids.contains(set.exerciseId) { ids.append(set.exerciseId) }
    return ids
  }
}

struct FactTiles: View {
  struct Fact {
    let value: String
    let label: String
    var record = false
    var identifier: String?
  }
  let facts: [Fact]
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.inset))
      : AnyLayout(HStackLayout(alignment: .top, spacing: RoomSpace.inset))
    layout {
      ForEach(Array(facts.prefix(3).enumerated()), id: \.offset) { _, fact in
        VStack(alignment: .leading, spacing: RoomSpace.small) {
          Text(fact.value).font(.title3.weight(.semibold)).monospacedDigit()
            .foregroundStyle(fact.record ? GymPalette.record : GymPalette.ink).lineLimit(1).minimumScaleFactor(0.5)
          Text(fact.label).font(.footnote).foregroundStyle(GymPalette.inkDim)
        }.frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier(fact.identifier ?? "")
      }
    }
  }
}
