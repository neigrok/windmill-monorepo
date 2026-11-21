import SwiftUI
import RoadmapDomain

// A roadmap's Board (Roadmap · iOS 01.1): one list of the domain's groups, Up next first, Done folded at rest, none drawn empty.
struct RoadmapBoard: View {
  static let groups: [BoardRead.Column.Name] = [.upNext, .locked, .done]

  let open: RoadmapModel.OpenRoadmap
  @State var folded: Set<BoardRead.Column.Name> = [.done]

  var body: some View {
    let kinds = LegendRead(open.tree).kinds
    List {
      ForEach(Self.groups, id: \.self) { group in
        let steps = open.board.columns.first { $0.name == group }?.ids ?? []
        if !steps.isEmpty {
          Section(isExpanded: expanded(group)) {
            ForEach(steps, id: \.self) { id in
              if let card = open.board.cards.first(where: { $0.id.utf8.elementsEqual(id.utf8) }), let step = open.tree.step(id) {
                row(card, step, kind: kinds.first { $0.hue.utf8.elementsEqual(step.color.utf8) })
              }
            }
          } header: {
            header(group, count: steps.count)
          }.headerProminence(.increased)
        }
      }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden)
  }

  func expanded(_ group: BoardRead.Column.Name) -> Binding<Bool> {
    Binding(get: { !folded.contains(group) }, set: { if $0 { folded.remove(group) } else { folded.insert(group) } })
  }

  // The header is the control that folds its section: this list style draws none of its own.
  func header(_ group: BoardRead.Column.Name, count: Int) -> some View {
    let expanded = expanded(group)
    return Button { withAnimation { expanded.wrappedValue.toggle() } } label: {
      HStack(spacing: RoomSpace.related) {
        Text(Self.title(group))
        Text(verbatim: String(count))
        Spacer()
        Image(systemName: expanded.wrappedValue ? "chevron.down" : "chevron.right").font(.footnote.weight(.semibold))
          .foregroundStyle(RoadmapPalette.inkDim).accessibilityHidden(true)
      }.foregroundStyle(RoadmapPalette.ink).contentShape(Rectangle())
    }.buttonStyle(.plain)
      .accessibilityValue(expanded.wrappedValue ? Text("Expanded") : Text("Collapsed"))
      .accessibilityIdentifier("roadmap-group-" + group.rawValue)
  }

  // A step's row: its state's symbol in its kind's colour, said by the kind's name where the legend names the hue.
  func row(_ card: BoardRead.Card, _ step: RoadmapDomain.Step, kind: Kind?) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(name(step)).foregroundStyle(card.column == .locked ? RoadmapPalette.inkDim : RoadmapPalette.ink)
        if let reason = reason(card) { Text(reason).font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim) }
        if !step.description.isEmpty { Text(step.description).font(.subheadline).foregroundStyle(RoadmapPalette.inkDim).lineLimit(2) }
      }
    } icon: {
      Image(systemName: Self.symbol(card.column)).foregroundStyle(RoadmapPalette.kind(step.color))
        .accessibilityLabel(kind?.label ?? "").accessibilityHidden(kind == nil)
    }.listRowBackground(RoadmapPalette.card).accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-step")
  }

  func name(_ step: RoadmapDomain.Step?) -> String { step?.label.nilIfEmpty ?? String(localized: "Untitled step") }

  // Why a step stands in its group, in the Board's words over the domain's facts; a Done step says nothing.
  func reason(_ card: BoardRead.Card) -> String? {
    if let needs = card.needs {
      let first = name(open.tree.step(needs.first))
      if needs.extra == 0 {
        return String(localized: "Needs \(first) · \(needs.toGo) to go", locale: .copy,
                      comment: "A Locked step's reason: the step it still needs, and how many steps stand before it")
      }
      return String(localized: "Needs \(first) +\(needs.extra) · \(needs.toGo) to go", locale: .copy,
                    comment: "A Locked step's reason: the first step it still needs, how many more it needs, and how many steps stand before it")
    }
    guard let unlocks = card.unlocks else { return nil }
    let first = name(open.tree.step(unlocks.first))
    if unlocks.extra == 0 { return String(localized: "Unlocks \(first)", comment: "An Up next step's reason: the step that finishing it unlocks") }
    return String(localized: "Unlocks \(first) +\(unlocks.extra)", locale: .copy,
                  comment: "An Up next step's reason: the first step that finishing it unlocks, and how many more")
  }

  static func title(_ group: BoardRead.Column.Name) -> String {
    switch group {
    case .upNext: String(localized: "Up next", comment: "The Board's group of steps that can be done now")
    case .locked: String(localized: "Locked", comment: "The Board's group of steps that still need another step")
    case .done: String(localized: "roadmap.board.done", defaultValue: "Done", comment: "The Board's group of completed steps")
    }
  }

  static func symbol(_ group: BoardRead.Column.Name) -> String {
    switch group {
    case .upNext: "circle"
    case .locked: "lock.fill"
    case .done: "checkmark.circle.fill"
    }
  }
}
