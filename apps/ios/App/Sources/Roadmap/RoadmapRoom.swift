import SwiftUI
import UIKit
import RoadmapDomain

// The Roadmap room (Roadmap · iOS S.1, 11.22a): one stack, the open roadmap under its name with the switch row, its Board,
// and at the foot the one band over New step. A step's page is pushed on the stack. What the band says is announced and
// felt once, whichever screen stands over it.
struct RoadmapRoom: View {
  // The room's two views of a roadmap.
  enum Lens { case board, graph }

  @Bindable var roadmap: RoadmapModel
  let app: AppModel

  var body: some View {
    NavigationStack(path: $roadmap.path) {
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .tint(RoadmapPalette.accent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { RoomMenu(app: app) }
          ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: app.openYou).disabled(app.editorReadOnly) }
        }.roomBar(.roadmap)
        .navigationDestination(for: RoadmapModel.Visit.self) { visit in RoadmapStepPage(roadmap: roadmap, step: visit.step) }
    }.onAppear { roadmap.roomOpened() }
      .sensoryFeedback(trigger: roadmap.band) { _, band in
        switch band?.says {
        case .completed: .success
        case .reset: .impact
        default: nil
        }
      }
      .onChange(of: roadmap.band) { _, band in
        if let band { UIAccessibility.post(notification: .announcement, argument: band.says.words) }
      }
  }

  @ViewBuilder var content: some View {
    switch roadmap.phase {
    case .unread: Color.clear
    case .open(let open): board(open)
    // 01.5: New Roadmap is drawn and does nothing.
    case .empty:
      ContentUnavailableView {
        Label { Text("No roadmaps yet").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("Plan a goal as steps that unlock each other.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        Button("New Roadmap") {}.buttonStyle(RoomSecondaryStyle()).disabled(true).accessibilityIdentifier("roadmap-new")
      }
    // 10.9, for a read of the phone's copy that failed: the board's sentence speaks of a server, so it is not said here.
    case .failed:
      ContentUnavailableView {
        Label { Text("Couldn’t load this roadmap").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } actions: {
        Button("Try Again") { roadmap.retry() }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-try-again")
      }
    }
  }

  func board(_ open: RoadmapModel.OpenRoadmap) -> some View {
    let counts = open.board.overall
    let progress = counts.total == 0 ? String(localized: "No steps yet")
      : String(localized: "\(counts.done) of \(counts.total) done", locale: .copy, comment: "How many are done, of how many: a roadmap's steps under its name, and the steps a step requires")
    return pinnedUnderBar(RoadmapBoard(roadmap: roadmap, open: open))
      .roomTitle(open.listed.title?.nilIfEmpty ?? String(localized: "Untitled roadmap"), subtitle: progress)
      .roadmapFoot(roadmap) {
        HStack {
          Spacer()
          Button("New Step", systemImage: "plus") {}.modifier(GlassCircle()).disabled(true).accessibilityIdentifier("roadmap-new-step")
        }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
      }
  }

  // Graph, Find, and Sort and filter are drawn and do nothing: the row stands disabled.
  var switchRow: some View {
    HStack(spacing: RoomSpace.related) {
      Picker("View", selection: .constant(Lens.board)) {
        Text("Board").tag(Lens.board)
        Text("Graph").tag(Lens.graph)
      }.pickerStyle(.segmented)
      Button("Find", systemImage: "magnifyingglass") {}.modifier(GlassCircle())
      Menu("Sort and filter", systemImage: "line.3.horizontal.decrease.circle") {}.modifier(GlassCircle())
    }.padding(.horizontal, RoomSpace.inset).padding(.bottom, RoomSpace.related).disabled(true)
  }

  // The switch row stands in the bar's own safe area on iOS 26, and on the bar material over the list before it.
  @ViewBuilder func pinnedUnderBar(_ screen: some View) -> some View {
    if #available(iOS 26.0, *) { screen.safeAreaBar(edge: .top) { switchRow } }
    else { screen.safeAreaInset(edge: .top) { switchRow.background(.bar) } }
  }
}

// One symbol in a circle of the system's glass, bordered before iOS 26, in the room's ink: the switch row's tools and New step.
struct GlassCircle: ViewModifier {
  func body(content: Content) -> some View {
    shaped(content.labelStyle(.iconOnly)).buttonBorderShape(.circle).controlSize(.large).tint(RoadmapPalette.ink)
  }

  @ViewBuilder func shaped(_ control: some View) -> some View {
    if #available(iOS 26.0, *) { control.buttonStyle(.glass) }
    else { control.buttonStyle(.bordered) }
  }
}
