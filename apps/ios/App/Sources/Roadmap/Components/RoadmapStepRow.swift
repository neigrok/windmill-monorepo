import SwiftUI
import RoadmapDomain

// A step's row wherever the room lists steps (Roadmap · iOS 01.1, 03.1, 07.1): a link to the step's page, with its state's
// symbol on its first line, in its kind's colour and said by the kind's name, or by the hue's where no kind names it;
// the step's name; the line its list says under it; and on the Board the pill of the roadmap it opens and its excerpt.
struct RoadmapStepRow: View {
  let roadmap: RoadmapModel
  let row: RoadmapModel.Row
  let door: RoadmapModel.Visit.Door
  // On the Board, why the step stands in its group; on a step's page, the step's state.
  let line: String?
  var excerpt = false
  // The column the state symbols stand in, so every row's words start on one line down the list at any text size.
  @ScaledMetric(relativeTo: .body) var symbolColumn = 24.0

  var body: some View {
    NavigationLink(value: roadmap.stacked(.step(row.id, by: door))) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Image(systemName: row.card.column.symbol).imageScale(.large).foregroundStyle(RoadmapPalette.kind(row.step.color))
          .frame(width: symbolColumn).accessibilityLabel(row.colour ?? "").accessibilityHidden(row.colour == nil)
        VStack(alignment: .leading, spacing: 2) {
          Text(row.name).foregroundStyle(row.card.column == .locked ? RoadmapPalette.inkDim : RoadmapPalette.ink)
          if let line { Text(line).font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim) }
          if excerpt, let opening = row.opening { OpeningPill(opening: opening) }
          if excerpt && !row.step.description.isEmpty {
            Text(row.step.description).font(.subheadline).foregroundStyle(RoadmapPalette.inkDim).lineLimit(2)
          }
        }
      }
    }.listRowInsets(EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: 13))
      .accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-step")
  }
}

// The room's words for a step, the same on the Board, on a step's page and in the band.
extension RoadmapModel.Row {
  var name: String { Self.name(of: step.label) }
  // The kind's name, or the hue's own where no kind names it.
  var colour: String? { kind?.label.nilIfEmpty ?? Self.hue(step.color) }

  // A step is named by its label, and one without a label by these words.
  static func name(of label: String) -> String { label.nilIfEmpty ?? String(localized: "Untitled step") }

  // A hue's own name, said of a step whose colour no kind names; none for a hue this build does not know.
  static func hue(_ hue: String) -> String? {
    switch hue {
    case "terracotta": String(localized: "Terracotta", comment: "A step's colour, said where no kind names it")
    case "olive": String(localized: "Olive", comment: "A step's colour, said where no kind names it")
    case "gold": String(localized: "Gold", comment: "A step's colour, said where no kind names it")
    case "brick": String(localized: "Brick", comment: "A step's colour, said where no kind names it")
    case "sky": String(localized: "Sky", comment: "A step's colour, said where no kind names it")
    case "plum": String(localized: "Plum", comment: "A step's colour, said where no kind names it")
    default: nil
    }
  }
}

// A group of the Board is also the state its steps stand in: its name heads the group and a step's page, and its
// symbol leads every row of a step in it.
extension BoardRead.Column.Name {
  var title: String {
    switch self {
    case .upNext: String(localized: "Up next", comment: "The Board's group of steps that can be done now")
    case .locked: String(localized: "Locked", comment: "The Board's group of steps that still need another step")
    case .done: String(localized: "roadmap.board.done", defaultValue: "Done", comment: "The Board's group of completed steps")
    }
  }

  var symbol: String {
    switch self {
    case .upNext: "circle"
    case .locked: "lock.fill"
    case .done: "checkmark.circle.fill"
    }
  }
}

extension RoadmapModel.OpenRoadmap {
  // Why a step stands in its group, in the room's words over the domain's facts; a Done step says nothing.
  func reason(_ card: BoardRead.Card) -> String? {
    if let needs = card.needs {
      let first = RoadmapModel.Row.name(of: tree.step(needs.first)?.label ?? "")
      if needs.extra == 0 {
        return String(localized: "Needs \(first) · \(needs.toGo) to go", locale: .copy,
                      comment: "A Locked step's reason: the step it still needs, and how many steps stand before it")
      }
      return String(localized: "Needs \(first) +\(needs.extra) · \(needs.toGo) to go", locale: .copy,
                    comment: "A Locked step's reason: the first step it still needs, how many more it needs, and how many steps stand before it")
    }
    guard let unlocks = card.unlocks else { return nil }
    let first = RoadmapModel.Row.name(of: tree.step(unlocks.first)?.label ?? "")
    if unlocks.extra == 0 { return String(localized: "Unlocks \(first)", comment: "An Up next step's reason: the step that finishing it unlocks") }
    return String(localized: "Unlocks \(first) +\(unlocks.extra)", locale: .copy,
                  comment: "An Up next step's reason: the first step that finishing it unlocks, and how many more")
  }
}
