import SwiftUI
import RoadmapDomain

// A roadmap's Board (Roadmap · iOS 01.1, 01.12, 02.1 to 02.4, 02.13, 02.15, 05.7): one list of the domain's groups, Up
// next first, each folding under its header. A row opens its step's page, slides right for Complete and left for Delete,
// and a long press lists both. With no step yet, or with every step done, the Board says so. A step the form made is
// scrolled to once the list holds it.
struct RoadmapBoard: View {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap

  var body: some View {
    if open.board.overall.total == 0 {
      ContentUnavailableView {
        Label { Text("Your first step").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("Give your roadmap a place to start.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        Button("New Step") { roadmap.newStep(from: .empty) }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-first-step")
      }
    } else {
      let made = roadmap.band.flatMap { (band: RoadmapModel.Band) -> String? in
        guard case .created = band.says else { return nil }
        return band.arrived.first { open.step($0) != nil }
      }
      ScrollViewReader { list in
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
          .onChange(of: made, initial: true) { _, step in
            if let step { withAnimation { list.scrollTo(step, anchor: .center) } }
          }
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
        Text(group.title)
        Text(verbatim: String(count))
        Spacer()
        Image(systemName: expanded.wrappedValue ? "chevron.down" : "chevron.right").font(.footnote.weight(.semibold))
          .foregroundStyle(RoadmapPalette.inkDim).accessibilityHidden(true)
      }.foregroundStyle(RoadmapPalette.ink).contentShape(Rectangle())
    }.buttonStyle(.plain)
      .accessibilityValue(expanded.wrappedValue ? Text("Expanded") : Text("Collapsed"))
      .accessibilityIdentifier("roadmap-group-" + group.rawValue)
  }

  // A step's row, with why it stands in its group and its excerpt. A step the last act brought up next is washed while
  // the band says so.
  func row(_ row: RoadmapModel.Row) -> some View {
    let arrived = roadmap.band?.arrived.contains(row.id) == true
    return RoadmapStepRow(row: row, door: .card, line: open.reason(row.card), excerpt: true)
      .listRowBackground(ZStack { RoadmapPalette.card; if arrived { RoadmapPalette.accentSoft } }.roomMotion(arrived))
      .swipeActions(edge: .leading, allowsFullSwipe: false) {
        if row.completes { Button("Complete", systemImage: "checkmark") { roadmap.complete(row, by: .swipe) }.tint(RoadmapPalette.act) }
      }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        if row.deletes { Button("Delete", systemImage: "trash", role: .destructive) { roadmap.askDelete(row, by: .swipe) }.tint(nil) }
      }
      .contextMenu {
        if row.completes { Button("Complete", systemImage: "checkmark") { roadmap.complete(row, by: .menu) }.tint(RoadmapPalette.ink) }
        if row.completes && row.deletes { Divider() }
        if row.deletes { Button("Delete Step", systemImage: "trash", role: .destructive) { roadmap.askDelete(row, by: .menu) } }
      }
      .modifier(DeleteQuestion(roadmap: roadmap, step: row.id, by: [.swipe, .menu]))
  }
}
