import SwiftUI
import RoadmapDomain

// A step's page (Roadmap · iOS 03.1, 03.4 to 03.8): one scroll headed by the step's name, which the bar takes once it has
// scrolled away. The status row names the state, the kind and why the step stands there, and on a Done step what Reset
// would do; then the description and the step's shared links, and what the step requires and opens, each row opening
// its step. Complete stands at the foot of an Up next step, under the room's band; Edit raises the step's form over
// the page, and the … menu holds Delete Step.
struct RoadmapStepPage: View {
  // What the page last read of its step, which it goes on showing while it leaves the stack once the step is gone.
  final class LastRead {
    var page: (step: RoadmapModel.OpenStep, open: RoadmapModel.OpenRoadmap)?
  }

  let roadmap: RoadmapModel
  let step: String
  @State private var last = LastRead()
  @State private var nameHeight = 0.0
  @State private var nameScrolledAway = false
  @ScaledMetric(relativeTo: .body) private var symbolColumn = 24.0

  var body: some View {
    if case .open(let open) = roadmap.phase, let page = open.page(of: step) { last.page = (page, open) }
    return last.page.map { content($0.step, in: $0.open) }
  }

  func content(_ page: RoadmapModel.OpenStep, in open: RoadmapModel.OpenRoadmap) -> some View {
    let row = page.row
    return List {
      Section {
        status(page, in: open)
        if !row.step.description.allSatisfy(\.isWhitespace) { Text(row.step.description).foregroundStyle(RoadmapPalette.ink) }
        ForEach(Array(row.step.links.enumerated()), id: \.offset) { link in sharedLink(link.element) }
      } header: {
        Text(row.name).font(.largeTitle.bold()).foregroundStyle(RoadmapPalette.ink).textCase(nil)
          .onGeometryChange(for: Double.self) { $0.size.height } action: { nameHeight = $0 }
          .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 12, trailing: 4)).accessibilityIdentifier("roadmap-step-name")
      }.listRowBackground(RoadmapPalette.card)
      if !page.requires.isEmpty {
        let done = page.requires.count { $0.card.column == .done }
        related(page.requires, under: "Requires",
                count: String(localized: "\(done) of \(page.requires.count) done", locale: .copy,
                              comment: "How many are done, of how many: a roadmap's steps under its name, and the steps a step requires"),
                identifier: "roadmap-step-requires")
      }
      if !page.opens.isEmpty {
        related(page.opens, under: "Opens",
                count: String(localized: "\(page.opens.count) steps", locale: .copy, comment: "How many steps a step opens, beside Opens"),
                identifier: "roadmap-step-opens")
      }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).contentMargins(.top, 0, for: .scrollContent)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .tint(RoadmapPalette.accent)
      // The name has scrolled away once the list has moved by the name's height.
      .onScrollGeometryChange(for: Bool.self) { nameHeight > 0 && $0.contentOffset.y + $0.contentInsets.top >= nameHeight } action: {
        nameScrolledAway = $1
      }
      .navigationTitle(row.name).navigationBarTitleDisplayMode(.inline).toolbar(removing: nameScrolledAway ? nil : .title)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Edit") { roadmap.edit(page) }.fontWeight(.semibold).accessibilityIdentifier("roadmap-step-edit")
        }
        // The menu lists what this build can do to the step: the kept step, which no Delete is offered on, has none.
        if #available(iOS 26.0, *), row.deletes { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        if row.deletes {
          ToolbarItem(placement: .topBarTrailing) {
            Menu("More", systemImage: "ellipsis") {
              Button("Delete Step", systemImage: "trash", role: .destructive) { roadmap.askDelete(row, by: .page) }
            }.modifier(DeleteQuestion(roadmap: roadmap, step: row.id, by: [.page])).accessibilityIdentifier("roadmap-step-more")
          }
        }
      }.roomBar(.roadmap)
      .roadmapFoot(roadmap) {
        if row.completes {
          Button { roadmap.complete(row, by: .page) } label: { Text("Complete").frame(maxWidth: .infinity) }
            .buttonStyle(RoomPrimaryStyle(room: .roadmap)).padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
            .accessibilityIdentifier("roadmap-complete")
        }
      }
  }

  // The status row: the state's symbol in the kind's colour, the state over its second line, and Reset on a Done step.
  func status(_ page: RoadmapModel.OpenStep, in open: RoadmapModel.OpenRoadmap) -> some View {
    let row = page.row
    let detail = Self.detail(of: page, in: open)
    return HStack(spacing: 12) {
      Image(systemName: row.card.column.symbol).imageScale(.large).foregroundStyle(RoadmapPalette.kind(row.step.color))
        .frame(width: symbolColumn).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(row.card.column.title).fontWeight(.semibold).foregroundStyle(RoadmapPalette.ink)
        if !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(RoadmapPalette.inkDim) }
      }.frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-step-status")
      if row.resets {
        Button { roadmap.reset(page) } label: {
          Text("Reset").foregroundStyle(RoadmapPalette.accent).frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget)
            .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("roadmap-reset")
      }
    }.alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
  }

  // A link the step shares, which the page opens where its address is one the web's page opens too.
  @ViewBuilder func sharedLink(_ link: RoadmapDomain.Step.Link) -> some View {
    if let address = URL(string: link.url), ["http", "https", "mailto"].contains(address.scheme?.lowercased() ?? "") {
      Link(destination: address) {
        HStack(spacing: 12) {
          Image(systemName: "link").frame(width: symbolColumn).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            Text(link.label.nilIfEmpty ?? link.url)
            if let host = address.host() { Text(host).font(.footnote).foregroundStyle(RoadmapPalette.inkDim) }
          }
        }
      }.accessibilityIdentifier("roadmap-step-link")
    }
  }

  // Requires or Opens: the steps under their count, each row saying its step's state and opening its page.
  func related(_ rows: [RoadmapModel.Row], under title: LocalizedStringResource, count: String, identifier: String) -> some View {
    Section {
      ForEach(rows) { row in RoadmapStepRow(row: row, door: .step, line: Self.state(row.card)) }
    } header: {
      HStack(spacing: 6) {
        Text(title).fontWeight(.semibold)
        Text(count)
      }.font(.footnote).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
        .accessibilityElement(children: .combine).accessibilityIdentifier(identifier)
    }.listRowBackground(RoadmapPalette.card)
  }

  // The status row's second line: the kind's name, or the hue's where no kind names it, then why the step stands in its
  // group, or on a Done step what Reset would return to Locked.
  static func detail(of page: RoadmapModel.OpenStep, in open: RoadmapModel.OpenRoadmap) -> String {
    let reason = page.relocks == 0 ? open.reason(page.row.card)
      : String(localized: "Reset returns \(page.relocks) steps to Locked", locale: .copy,
               comment: "A Done step's status line: how many steps Reset would lock again")
    return [page.row.colour, reason].compactMap { $0 }.joined(separator: " · ")
  }

  // A step's state as a row of another step's page says it: a Done step says nothing, and a Locked one how far it is.
  static func state(_ card: BoardRead.Card) -> String? {
    switch card.column {
    case .done: nil
    case .upNext: card.column.title
    case .locked:
      card.needs.map { String(localized: "Locked · \($0.toGo) to go", locale: .copy, comment: "A Locked step on another step's page: how many steps stand before it") }
        ?? card.column.title
    }
  }
}
