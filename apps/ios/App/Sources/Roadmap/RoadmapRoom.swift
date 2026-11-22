import SwiftUI
import UIKit
import RoadmapDomain

// The Roadmap room (Roadmap · iOS S.1, 01.3, 01.5, 11.22a): one stack, the open roadmap under its name with the switch
// row, its Board, and at the foot the one band over New step. All Roadmaps and a step's page are pushed on the stack, and
// New Roadmap and the step form are its two sheets. What the band says is announced and felt once, whichever screen
// stands over it.
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
        .navigationDestination(for: RoadmapModel.Visit.self) { visit in
          switch visit {
          case .roadmaps: RoadmapsList(roadmap: roadmap)
          case .step(let step, _): RoadmapStepPage(roadmap: roadmap, step: step)
          }
        }
    }.onAppear { roadmap.roomOpened() }
      .sheet(isPresented: Binding(get: { roadmap.naming }, set: { if !$0 { roadmap.cancelNaming() } })) { NewRoadmap(roadmap: roadmap) }
      .sheet(item: Binding(get: { roadmap.draft }, set: { if $0 == nil { roadmap.draft?.cancel() } })) { draft in
        RoadmapStepForm(roadmap: roadmap, draft: draft)
      }
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
    case .open(let open): board(open)
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

  func board(_ open: RoadmapModel.OpenRoadmap) -> some View {
    pinnedUnderBar(RoadmapBoard(roadmap: roadmap, open: open))
      .modifier(RoadmapTitle(roadmap: roadmap, open: open))
      .roadmapFoot(roadmap) {
        HStack {
          Spacer()
          Button("New Step", systemImage: "plus") { roadmap.newStep(from: .foot) }.modifier(GlassCircle()).accessibilityIdentifier("roadmap-new-step")
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

// The bar's title over the Board (Roadmap · iOS 01.3, 01.9, 01.10): the open roadmap's name over its progress. Its menu
// lists the three most recent roadmaps, each over its progress and the open one checked, then All Roadmaps…, New Roadmap,
// Rename and Delete Roadmap. Rename is the system's: it turns the bar into one field, whose return key commits a name
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
