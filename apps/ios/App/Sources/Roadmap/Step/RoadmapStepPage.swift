import SwiftUI
import RoadmapDomain

// A step's page (Roadmap · iOS 03.1 to 03.8, 03.11, 03.14, 07.2 to 07.11): one scroll headed by the step's name, which the
// bar takes once it has scrolled away. The status row names the state, the kind and why the step stands there, on an Up
// next step that opens a roadmap how far that roadmap has to go, and on a Done step what Reset would do; then the
// description and the step's shared links, the roadmap the step opens or the subtree it owns, what the step requires and
// opens, each row opening its step, the person's workspace of it, and last the row that opens its History (03.12).
// Complete stands at the foot of an Up next step, and Open Roadmap, Open Subtree or Choose Roadmap at the foot of one that
// opens a roadmap, under the room's band; the foot is away while Add Subtask has the keyboard. Edit raises the step's form
// over the page, and the … menu holds Open in Graph, View Branch, Attach a Roadmap on a step that opens none, and Delete
// Step (03.7). On a reader's cover (09.5b) the page has no Edit, no Complete or Reset, no primary and no workspace, and its
// menu holds Open in Graph, View Branch and Copy Link.
struct RoadmapStepPage: View {
  typealias Read = (step: RoadmapModel.OpenStep, open: RoadmapModel.OpenRoadmap)

  // What the page last read of its step, which it goes on showing while it leaves the stack once the step is gone. A
  // generic class here crashes the Release optimizer of Swift 6.2, the compiler CI builds with.
  final class LastRead {
    private(set) var page: Read?

    func read(_ now: Read?) -> Read? {
      if let now { page = now }
      return page
    }
  }

  let roadmap: RoadmapModel
  let step: String
  // The cover the page stands on, for a reader; none in the person's own room.
  @Environment(RoadmapCover.self) private var cover: RoadmapCover?
  @State private var last = LastRead()
  @State private var nameHeight = 0.0
  @State private var nameScrolledAway = false
  @State private var addingLink = false
  @FocusState private var addingSubtask: Bool
  @ScaledMetric(relativeTo: .body) private var symbolColumn = 24.0

  var body: some View {
    let read = roadmap.shown.flatMap { (open: RoadmapModel.OpenRoadmap) -> Read? in open.page(of: step).map { (step: $0, open: open) } }
    return last.read(read).map { content($0.step, in: $0.open) }
  }

  func content(_ page: RoadmapModel.OpenStep, in open: RoadmapModel.OpenRoadmap) -> some View {
    let row = page.row
    let landed = roadmap.lines(on: row.id)
    let says = !row.step.description.allSatisfy(\.isWhitespace) || row.step.links.contains { LinkAddress($0.url) != nil }
    return List {
      Section {
        status(page, in: open)
        if landed.isEmpty { about(row) }
      } header: {
        Text(row.name).font(.largeTitle.bold()).foregroundStyle(RoadmapPalette.ink).textCase(nil)
          .onGeometryChange(for: Double.self) { $0.size.height } action: { nameHeight = $0 }
          .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 12, trailing: 4)).accessibilityIdentifier("roadmap-step-name")
      } footer: {
        // 10.3, 10.4: what the room tells once of the step stands under its status row, sentence after sentence, which
        // tells it where the band has not.
        if !landed.isEmpty {
          Text(landed.map(\.footer).joined(separator: " ")).foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-step-landed")
            .onAppear { roadmap.pageShows(landed) }
        }
      }.listRowBackground(RoadmapPalette.card)
      if !landed.isEmpty && says { Section { about(row) }.listRowBackground(RoadmapPalette.card) }
      if let opening = row.opening { OpenedSection(roadmap: roadmap, row: row, opening: opening, open: open) }
      if !page.requires.isEmpty {
        let done = page.requires.count { $0.card.column == .done }
        related(page.requires, under: "Requires",
                count: String(localized: "\(done) of \(page.requires.count) done", locale: .copy,
                              comment: "How many are done, of how many: a roadmap's steps under its name, and the steps a step requires"),
                identifier: "roadmap-step-requires")
      }
      if !page.opens.isEmpty {
        related(page.opens, under: "Opens",
                count: String(localized: "\(page.opens.count) steps", locale: .copy,
                              comment: "How many steps: beside Opens on a step's page, and Activity's row of the steps added within one minute"),
                identifier: "roadmap-step-opens")
      }
      if roadmap.owns {
        StepWorkspaceSections(roadmap: roadmap, step: row.id, workspace: page.workspace, addingSubtask: $addingSubtask, addingLink: $addingLink)
      }
      Section {
        NavigationLink(value: roadmap.stacked(.history(of: row.id))) {
          HStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(RoadmapPalette.accent).frame(width: symbolColumn).accessibilityHidden(true)
            Text("History").foregroundStyle(RoadmapPalette.ink)
          }
        }.accessibilityIdentifier("roadmap-step-history")
      }.listRowBackground(RoadmapPalette.card)
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).contentMargins(.top, 0, for: .scrollContent)
      .scrollDismissesKeyboard(.interactively)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .tint(RoadmapPalette.accent)
      // The name has scrolled away once the list has moved by the name's height.
      .onScrollGeometryChange(for: Bool.self) { nameHeight > 0 && $0.contentOffset.y + $0.contentInsets.top >= nameHeight } action: {
        nameScrolledAway = $1
      }
      .navigationTitle(row.name).navigationBarTitleDisplayMode(.inline).toolbar(removing: nameScrolledAway ? nil : .title)
      .toolbar {
        if roadmap.owns {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Edit") { roadmap.edit(page) }.fontWeight(.semibold).accessibilityIdentifier("roadmap-step-edit")
          }
          if #available(iOS 26.0, *) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        }
        // The menu lists what this build can do to the step: a Locked step is offered no View Branch, as the web offers
        // none, a step that opens a roadmap no Attach a Roadmap, which its Roadmap row's menu changes, and the kept step no
        // Delete. A reader's copies the step's share address. The owner's Copy Link waits for its screen.
        ToolbarItem(placement: .topBarTrailing) {
          Menu("More", systemImage: "ellipsis") {
            Button("Open in Graph", systemImage: "point.3.connected.trianglepath.dotted") { roadmap.openInGraph(row.id, from: .page) }
            if row.card.column != .locked {
              Button("View Branch", systemImage: "arrow.triangle.branch") { roadmap.viewBranch(of: row.id) }
            }
            if roadmap.owns && row.opening == nil {
              Button("Attach a Roadmap", systemImage: "square.stack.3d.up") { roadmap.path.append(.attach(to: row.id)) }
            }
            if let cover {
              Button("Copy Link", systemImage: "link") { cover.copyLink(of: row.id) }
            }
            if row.deletes {
              Divider()
              Button("Delete Step", systemImage: "trash", role: .destructive) { roadmap.askDelete(row, by: .page) }
            }
          }.modifier(DeleteQuestion(roadmap: roadmap, step: row.id, by: [.page])).accessibilityIdentifier("roadmap-step-more")
        }
      }.roomBar(.roadmap)
      // Cancel, or the form sent away, adds nothing; a link added closes it.
      .sheet(isPresented: Binding(get: { addingLink }, set: { shown in
        guard !shown else { return }
        addingLink = false
        roadmap.linkFormCancelled()
      })) {
        NewLink(title: RoadmapSpecs.linkTitle, address: RoadmapSpecs.url) { address, title in
          if roadmap.addLink(address, titled: title, to: row.id) { addingLink = false }
        }
      }
      .roadmapFoot(roadmap, away: addingSubtask || addingLink) {
        // 11.3: with Coach, an Up next page's Complete has the composer minimised to a Coach circle beside it, which opens it
        // about the step; any other page of the person's own has the composer itself.
        let coach = roadmap.owns ? roadmap.root.coach : nil
        if let coach, !coach.sheet, coach.focused || !row.completes {
          CoachComposer(coach: coach, entry: .step, room: roadmap, step: (row.id, row.step.label))
            .padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
        } else if row.completes {
          HStack(spacing: RoomSpace.related) {
            Button { roadmap.complete(row, by: .page) } label: { Text("Complete").frame(maxWidth: .infinity) }
              .buttonStyle(RoomPrimaryStyle(room: .roadmap)).accessibilityIdentifier("roadmap-complete")
            if let coach, !coach.sheet {
              Button("Ask Coach", systemImage: "bubble.left.and.bubble.right") { coach.open(in: roadmap, about: (row.id, row.step.label), from: .step) }
                .modifier(GlassCircle()).accessibilityIdentifier("roadmap-coach-circle")
            }
          }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
        } else if roadmap.owns, row.card.column == .upNext, let opening = row.opening {
          OpenedPrimary(roadmap: roadmap, row: row, opening: opening)
        }
      }
  }

  // What the step says of itself: its description, and each link it shares whose address is one the page opens. Under the
  // status row, or in a card of its own below a footer that stands there.
  @ViewBuilder func about(_ row: RoadmapModel.Row) -> some View {
    if !row.step.description.allSatisfy(\.isWhitespace) { Text(row.step.description).foregroundStyle(RoadmapPalette.ink) }
    ForEach(Array(row.step.links.enumerated()), id: \.offset) { link in
      if let address = LinkAddress(link.element.url) {
        StepLinkRow(title: link.element.label.nilIfEmpty ?? link.element.url, host: address.url.host(), opens: address.url)
          .accessibilityIdentifier("roadmap-step-link")
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

  // Requires or Opens: the steps under their count, each row saying its step's state and opening its page.
  func related(_ rows: [RoadmapModel.Row], under title: LocalizedStringResource, count: String, identifier: String) -> some View {
    Section {
      ForEach(rows) { row in RoadmapStepRow(roadmap: roadmap, row: row, door: .step, line: Self.state(row.card)) }
    } header: {
      StepSectionHeader(title: title, count: count).accessibilityIdentifier(identifier)
    }.listRowBackground(RoadmapPalette.card)
  }

  // The status row's second line: the kind's name, or the hue's where no kind names it, then why the step stands in its
  // group, on an Up next step that opens a roadmap how far that has to go, or on a Done step what Reset would return to
  // Locked.
  static func detail(of page: RoadmapModel.OpenStep, in open: RoadmapModel.OpenRoadmap) -> String {
    let opened = page.row.card.column == .upNext ? page.row.opening?.upNext : nil
    let reason = page.relocks == 0 ? opened ?? open.reason(page.row.card)
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
