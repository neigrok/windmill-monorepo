import SwiftUI

// A movement's title over one meta line; the caller wraps it in the row's Button or NavigationLink and says when it is selected.
struct MovementRow: View {
  enum Trailing: Equatable { case fact(String), check }
  let title: String
  var meta: String?
  var trailing: Trailing?

  var body: some View {
    HStack(spacing: RoomSpace.related) {
      VStack(alignment: .leading, spacing: RoomSpace.small) {
        Text(title).font(meta == nil ? .body : .body.weight(.semibold)).foregroundStyle(GymPalette.ink)
        if let meta { Text(meta).font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim) }
      }.frame(maxWidth: .infinity, alignment: .leading)
      switch trailing {
      case .fact(let fact): Text(fact).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
      case .check: Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true)
      case nil: EmptyView()
      }
    }.frame(minHeight: RoomSpace.minimumTarget)
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
