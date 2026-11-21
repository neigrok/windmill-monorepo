import SwiftUI
import RoadmapDomain

// A roadmap's Board (Roadmap · iOS 01.1, 01.12, 02.1 to 02.4, 02.13, 02.15): one list of the domain's groups, Up next
// first, each folding under its header. A row slides right for Complete and left for Delete, and a long press lists both.
// With no step yet, or with every step done, the Board says so.
struct RoadmapBoard: View {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap
  // The step whose delete is being asked.
  @State var asking: String?
  // The gesture that asked last, and how many steps follow the step it asked of.
  @State var asked: (door: RoadmapModel.Door, followers: Int) = (.swipe, 0)

  var body: some View {
    // 02.15: New Step is drawn and does nothing.
    if open.board.overall.total == 0 {
      ContentUnavailableView {
        Label { Text("Your first step").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("Give your roadmap a place to start.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        Button("New Step") {}.buttonStyle(RoomSecondaryStyle()).disabled(true).accessibilityIdentifier("roadmap-first-step")
      }
    } else {
      List {
        if open.everyStepDone { Section {} header: { everyStepDone } }
        ForEach(open.groups) { group in
          Section(isExpanded: expanded(group.id)) {
            ForEach(group.rows) { row in self.row(row) }
          } header: {
            header(group.id, count: group.rows.count)
          }.headerProminence(.increased)
        }
      }.listStyle(.insetGrouped).scrollContentBackground(.hidden)
        .roomMotion(open.groups.map { (group: RoadmapModel.Group) -> [String] in group.rows.map(\.id) })
        .sensoryFeedback(trigger: roadmap.band) { _, band in
          guard case .completed = band?.says else { return nil }
          return .success
        }
    }
  }

  // 01.12: what heads the list once nothing is Up next or Locked. Share is drawn and does nothing.
  var everyStepDone: some View {
    VStack(spacing: 0) {
      Image(systemName: "checkmark.circle.fill").font(.largeTitle).imageScale(.large).foregroundStyle(RoadmapPalette.act)
        .accessibilityHidden(true)
      Text("All \(open.board.overall.total) steps done").font(.title2.bold()).foregroundStyle(RoadmapPalette.ink).padding(.top, 12)
      Text("Add a step whenever you’re ready.").font(.subheadline).foregroundStyle(RoadmapPalette.inkDim).padding(.top, RoomSpace.small)
      Button("Share") {}.buttonStyle(RoomSecondaryStyle()).fontWeight(.semibold).disabled(true).padding(.top, RoomSpace.inset)
        .accessibilityIdentifier("roadmap-share")
    }.frame(maxWidth: .infinity).multilineTextAlignment(.center).textCase(nil)
  }

  func expanded(_ group: BoardRead.Column.Name) -> Binding<Bool> {
    Binding(get: { !roadmap.folded.contains(group) }, set: { if $0 { roadmap.folded.remove(group) } else { roadmap.folded.insert(group) } })
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

  // A step's row: its state's symbol on its first line, in its kind's colour and said by the kind's name, or by the
  // hue's where no kind names it. A step the last act brought up next is washed while the band says so.
  func row(_ row: RoadmapModel.Row) -> some View {
    let colour = row.kind?.label.nilIfEmpty ?? Self.hue(row.step.color)
    let arrived = roadmap.band?.arrived.contains(row.id) == true
    return HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(systemName: Self.symbol(row.card.column)).imageScale(.large).foregroundStyle(RoadmapPalette.kind(row.step.color))
        .frame(width: 24).accessibilityLabel(colour ?? "").accessibilityHidden(colour == nil)
      VStack(alignment: .leading, spacing: 2) {
        Text(name(row.step)).foregroundStyle(row.card.column == .locked ? RoadmapPalette.inkDim : RoadmapPalette.ink)
        if let reason = reason(row.card) { Text(reason).font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim) }
        if !row.step.description.isEmpty { Text(row.step.description).font(.subheadline).foregroundStyle(RoadmapPalette.inkDim).lineLimit(2) }
      }
    }.listRowInsets(EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: 13))
      .listRowBackground(ZStack { RoadmapPalette.card; if arrived { RoadmapPalette.accentSoft } }.roomMotion(arrived))
      .accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-step")
      .swipeActions(edge: .leading, allowsFullSwipe: false) {
        if row.completes { Button("Complete", systemImage: "checkmark") { roadmap.complete(row, by: .swipe) }.tint(RoadmapPalette.act) }
      }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        if row.deletes { Button("Delete", systemImage: "trash", role: .destructive) { ask(row, by: .swipe) }.tint(nil) }
      }
      .contextMenu {
        if row.completes { Button("Complete", systemImage: "checkmark") { roadmap.complete(row, by: .menu) }.tint(RoadmapPalette.ink) }
        if row.completes && row.deletes { Divider() }
        if row.deletes { Button("Delete Step", systemImage: "trash", role: .destructive) { ask(row, by: .menu) } }
      }
      // 03.8: the question stands on the row, the view that stays on screen once the swipe or the menu has closed.
      .confirmationDialog(String(localized: "Delete \(name(row.step))?", comment: "The question a step's delete asks, with the step's name"),
                          isPresented: Binding(get: { asking == row.id }, set: { if !$0 { asking = nil } }), titleVisibility: .visible) {
        Button("Delete Step", role: .destructive) { roadmap.delete(row, by: asked.door) }
      } message: {
        Text(Self.cost(followers: asked.followers))
      }
  }

  // The delete question counts the steps that follow the step once, when it is asked.
  func ask(_ row: RoadmapModel.Row, by door: RoadmapModel.Door) {
    asked = (door, open.followers(of: row.id))
    asking = row.id
  }

  func name(_ step: RoadmapDomain.Step?) -> String { Self.name(of: step?.label ?? "") }

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

  // A step is named by its label, and one without a label by these words.
  static func name(of label: String) -> String { label.nilIfEmpty ?? String(localized: "Untitled step") }

  // What a delete takes with it: the step alone, and each step that follows it is read through it.
  static func cost(followers: Int) -> String {
    if followers == 0 { return String(localized: "Removes this step") }
    return String(localized: "Removes this step · \(followers) branches resplice", locale: .copy,
                  comment: "A step's delete question: how many steps that follow the step are linked past it")
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
