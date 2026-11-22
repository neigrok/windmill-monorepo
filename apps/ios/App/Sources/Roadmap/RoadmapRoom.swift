import SwiftUI
import UIKit
import RoadmapDomain

// The Roadmap room (Roadmap · iOS S.1, S.2, 01.3, 01.5, 02.10, 04.5, 04.7, 11.22a): one stack, the open roadmap under its
// name with the switch row, its Board or its Graph, and at the foot the one band over New step. All Roadmaps, a step's
// page and its note are pushed on the stack, and New Roadmap, the step form and Kinds are its sheets. What the band says
// is announced and felt once, whichever screen stands over it. While the Graph's Fit stands, the bar, the switch row and
// the foot are away; while several steps are selected the bar and the bottom toolbar are the selection's.
struct RoadmapRoom: View {
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
          if let selection = roadmap.selection, let open = roadmap.shown {
            BoardSelectionBar(roadmap: roadmap, selection: selection, open: open)
          } else {
            ToolbarItem(placement: .topBarLeading) { RoomMenu(app: app) }
            ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: app.openYou).disabled(app.editorReadOnly) }
          }
        }.roomBar(.roadmap)
        .navigationDestination(for: RoadmapModel.Visit.self) { visit in
          switch visit {
          case .roadmaps: RoadmapsList(roadmap: roadmap)
          case .step(let step, _): RoadmapStepPage(roadmap: roadmap, step: step)
          case .note: RoadmapNoteEditor(roadmap: roadmap)
          }
        }
    }.onAppear { roadmap.roomOpened() }
      .sheet(isPresented: Binding(get: { roadmap.naming }, set: { if !$0 { roadmap.cancelNaming() } })) { NewRoadmap(roadmap: roadmap) }
      .sheet(item: Binding(get: { roadmap.draft }, set: { if $0 == nil { roadmap.draft?.cancel() } })) { draft in
        RoadmapStepForm(roadmap: roadmap, draft: draft)
      }
      .sheet(isPresented: Binding(get: { roadmap.kindsDoor == .menu }, set: { if !$0 { roadmap.closeKinds() } })) { RoadmapKinds(roadmap: roadmap) }
      .sensoryFeedback(trigger: roadmap.band) { _, band in
        switch band?.says {
        case .completed, .created: .success
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
    case .open(let open): views(of: open)
    // 01.5: the room with no roadmap, where the band still holds the Undo of the last one's delete.
    case .empty:
      ContentUnavailableView {
        Label { Text("No roadmaps yet").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("Plan a goal as steps that unlock each other.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        Button("New Roadmap") { roadmap.nameRoadmap(from: .empty) }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-new")
      }.roadmapFoot(roadmap) {}
    // 10.9, for a read of the phone's copy that failed: the board's sentence speaks of a server, so it is not said here.
    case .failed:
      ContentUnavailableView {
        Label { Text("Couldn’t load this roadmap").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } actions: {
        Button("Try Again") { roadmap.retry() }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-try-again")
      }
    }
  }

  // The open roadmap in the view the room shows of it, the Board's first step for a roadmap with no step under either
  // choice (04.7). On the Graph the band slot holds the selected step while no band stands there (04.2), and with none
  // selected *Next* over the Up next steps, where there is one (04.1, 04.3). Fit leaves the Graph alone under the
  // status bar (04.5). New step leaves the foot to Find's field while Find is up (02.5) and to the bottom toolbar while
  // several steps are selected (02.10).
  func views(of open: RoadmapModel.OpenRoadmap) -> some View {
    let graph = roadmap.view(of: open) == .graph
    let fitted = graph && roadmap.graph.fitted
    let footed = !roadmap.reading.finds && roadmap.selection == nil
    return pinnedUnderBar(Group {
      if graph { RoadmapGraphCanvas(roadmap: roadmap, progress: open.board.overall.progress) }
      else { RoadmapBoard(roadmap: roadmap, open: open) }
    }, of: open, graph: graph, away: fitted).modifier(RoadmapTitle(roadmap: roadmap, open: open))
      .toolbarVisibility(fitted ? .hidden : .automatic, for: .navigationBar)
      .roadmapFoot(roadmap, away: fitted) {
        if graph, roadmap.band == nil {
          if let selected = roadmap.selected.flatMap({ open.step($0) }) { GraphStepBar(row: selected) }
          else if !open.upNext.isEmpty { GraphNextBar(roadmap: roadmap, rows: open.upNext) }
        }
        if footed {
          HStack {
            Spacer()
            Button("New Step", systemImage: "plus") { roadmap.newStep(from: .foot) }.modifier(GlassCircle()).accessibilityIdentifier("roadmap-new-step")
          }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
        }
      }
  }

  // The switch chooses the roadmap's view, and carries Find and the view's one tool: the Board's Sort and filter (02.5,
  // 02.7), and the Graph's Fit (04.5), which needs the Graph on screen with its camera. Find is the Board's: the Graph's
  // waits for its screen. The room reads only whether the camera is there, never the camera, which a gesture or a glide
  // changes every frame. While several steps are selected the switch waits.
  func switchRow(_ open: RoadmapModel.OpenRoadmap, graph: Bool) -> some View {
    HStack(spacing: RoomSpace.related) {
      Picker("View", selection: Binding(get: { roadmap.lens }, set: { roadmap.show($0) })) {
        Text("Board").tag(RoadmapModel.Lens.board)
        Text("Graph").tag(RoadmapModel.Lens.graph)
      }.pickerStyle(.segmented).disabled(roadmap.selection != nil)
      Button("Find", systemImage: "magnifyingglass") { roadmap.reading.finds = true }.modifier(GlassCircle())
        .disabled(graph || open.board.overall.total == 0).accessibilityIdentifier("roadmap-find")
      if roadmap.lens == .board {
        BoardTool(roadmap: roadmap, open: open).disabled(open.board.overall.total == 0)
      } else {
        Button("Fit", systemImage: "arrow.up.left.and.arrow.down.right") { roadmap.fit() }.modifier(GlassCircle())
          .disabled(!graph || !roadmap.graph.framed).accessibilityIdentifier("roadmap-fit")
      }
    }.padding(.horizontal, RoomSpace.inset).padding(.bottom, RoomSpace.related)
  }

  // The switch row stands in the bar's own safe area on iOS 26, and on the bar material over the list before it. Away,
  // it leaves that area to the screen.
  @ViewBuilder func pinnedUnderBar(_ screen: some View, of open: RoadmapModel.OpenRoadmap, graph: Bool, away: Bool) -> some View {
    if #available(iOS 26.0, *) { screen.safeAreaBar(edge: .top) { if !away { switchRow(open, graph: graph) } } }
    else { screen.safeAreaInset(edge: .top) { if !away { switchRow(open, graph: graph).background(.bar) } } }
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

// The bar's title over the Board (Roadmap · iOS 01.3, 01.9, 01.10): the open roadmap's name over its progress. Its menu
// lists the three most recent roadmaps, each over its progress and the open one checked, then All Roadmaps…, New Roadmap,
// Kinds, Rename and Delete Roadmap. Rename is the system's: it turns the bar into one field, whose return key commits a name
// and leaves the old one where the field was emptied. Delete Roadmap asks under the title, on a view that stays on
// screen once the menu has closed.
struct RoadmapTitle: ViewModifier {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap

  func body(content: Content) -> some View {
    // The field starts from the name the bar shows, so a name committed as it was shown writes nothing.
    let name = open.listed.name
    titled(content, Binding(get: { name }, set: { if $0 != name { roadmap.rename(to: $0) } }))
      .toolbarTitleMenu {
        ForEach(roadmap.roadmaps.prefix(3), id: \.id) { listed in
          Toggle(isOn: Binding(get: { listed.id == open.listed.id }, set: { _ in roadmap.open(listed.id, from: .menu) })) {
            Text(listed.name)
            if let counts = listed.counts { Text(counts.tally) }
          }
        }
        Button("All Roadmaps…") { roadmap.path = [.roadmaps] }
        Divider()
        Button("New Roadmap", systemImage: "plus") { roadmap.nameRoadmap(from: .menu) }.tint(RoadmapPalette.ink)
        Divider()
        Button("Kinds", systemImage: "paintpalette") { roadmap.openKinds(from: .menu) }
        RenameButton()
        Divider()
        Button("Delete Roadmap", systemImage: "trash", role: .destructive) { roadmap.askDelete(open.listed, from: .menu) }
      }
      .overlay(alignment: .top) { Color.clear.frame(width: 1, height: 1).modifier(DeleteRoadmapQuestion(roadmap: roadmap, row: nil)) }
  }

  // iOS 26 draws the progress under the inline title, whose menu and field are the system's; before it the name and
  // the progress stand in the bar's principal slot, as on every room's screen.
  @ViewBuilder func titled(_ content: Content, _ name: Binding<String>) -> some View {
    if #available(iOS 26.0, *) { content.navigationTitle(name).navigationSubtitle(open.board.overall.progress) }
    else { content.roomTitle(name.wrappedValue, subtitle: open.board.overall.progress) }
  }
}
