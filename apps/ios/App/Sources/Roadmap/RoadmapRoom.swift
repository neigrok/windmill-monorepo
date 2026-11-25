import SwiftUI
import UIKit
import RoadmapDomain

// The Roadmap room (Roadmap · iOS S.1, S.2, 01.3, 01.5, 01.5b, 01.5c, 02.10, 02.16, 04.5, 04.7, 07.3, 11.22a): one stack,
// the open roadmap under its name with the switch row, its Board or its Graph, and at the foot the one band over New step,
// whose long press also offers Paste Steps. All Roadmaps, Activity, a step's page, its note and its History, the list a
// roadmap is attached from, and each roadmap gone into with its own screens are pushed on the stack; New Roadmap, Paste
// Steps, the step form, Kinds and the Guide are its sheets, and a reader's cover of a roadmap someone else shared stands
// over it full screen. What the band says is announced and felt once, whichever screen stands over it. While the Graph's
// Fit stands, the bar, the switch row and the foot are away; while several steps are selected the bar and the bottom
// toolbar are the selection's.
struct RoadmapRoom: View {
  @Bindable var roadmap: RoadmapModel
  let app: AppModel

  var body: some View {
    NavigationStack(path: Binding(get: { roadmap.stack }, set: { roadmap.stack = $0 })) {
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
        .navigationDestination(for: RoadmapModel.Stacked.self) { stacked in RoadmapScreen(root: roadmap, stacked: stacked, app: app) }
    }.onAppear { roadmap.roomOpened() }
      .environment(app)
      .sheet(item: Binding(get: { roadmap.newRoadmap }, set: { if $0 == nil { roadmap.newRoadmap?.cancel() } })) { NewRoadmap(draft: $0) }
      .modifier(RoomSheets(roadmap: roadmap.deepest, app: app))
      .fullScreenCover(item: Binding(get: { roadmap.links?.cover }, set: { if $0 == nil { roadmap.links?.cover?.close(.closed) } })) { cover in
        RoadmapCoverScreen(cover: cover, app: app)
      }
  }

  @ViewBuilder var content: some View {
    switch roadmap.phase {
    case .unread: FirstRead(roadmap: roadmap)
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
    case .failed: FailedRead(roadmap: roadmap)
    }
  }

  // 01.5c: the read of the phone's own copy failed, which asks no server, so the sentence names the phone. Try Again asks
  // the root's room for every view anew, a roadmap gone into reading what the root's then holds.
  struct FailedRead: View {
    let roadmap: RoadmapModel

    var body: some View {
      ContentUnavailableView {
        Label { Text("Couldn’t load this roadmap").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("The copy on this iPhone couldn’t be read.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        Button("Try Again") { roadmap.root.retry() }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-try-again")
      }
    }
  }

  // 01.5b: before the first read of the phone's copy the room is its bar alone, and a large spinner shows only once the
  // read has run half a second, so a quick read never flashes one. A spinner shown is told, and how its wait ended. A
  // read that ends as the half second does takes the view away before its wait resumes, which then tells nothing.
  struct FirstRead: View {
    let roadmap: RoadmapModel
    @State private var waited = false

    var body: some View {
      ZStack {
        if waited { ProgressView().controlSize(.large).tint(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-first-read") }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
          guard (try? await Task.sleep(for: .milliseconds(500))) != nil, !Task.isCancelled else { return }
          waited = true
          roadmap.firstReadWaits()
        }
        .onDisappear { if waited { roadmap.firstReadEnded() } }
    }
  }

  func views(of open: RoadmapModel.OpenRoadmap) -> some View {
    RoadmapViews(roadmap: roadmap, open: open).modifier(RoadmapTitle(roadmap: roadmap, open: open))
  }
}

// One screen pushed on the room's stack, in the room it was pushed in, the root's or a roadmap's gone into, and for a
// roadmap gone into, that roadmap's own room. The screen keeps the room it last found, so one that leaves with its room,
// as Back lets a roadmap gone into go, shows that room's last read while it slides away.
struct RoadmapScreen: View {
  // The room the screen last found. A generic class here crashes the Release optimizer of Swift 6.2, the compiler CI
  // builds with, as the step page's `LastRead` says.
  final class LastRoom {
    private(set) var room: RoadmapModel?

    func read(_ now: RoadmapModel?) -> RoadmapModel? {
      if let now { room = now }
      return room
    }
  }

  let root: RoadmapModel
  let stacked: RoadmapModel.Stacked
  let app: AppModel
  @State private var last = LastRoom()

  var body: some View {
    let found = root.room(at: stacked.depth).flatMap { (room: RoadmapModel) -> RoadmapModel? in stacked.visit.roadmap == nil ? room : room.inside }
    if let roadmap = last.read(found) { screen(in: roadmap) }
  }

  @ViewBuilder func screen(in roadmap: RoadmapModel) -> some View {
    switch stacked.visit {
    case .roadmaps: RoadmapsList(roadmap: roadmap)
    case .activity: RoadmapActivity(roadmap: roadmap)
    case .step(let step, _): RoadmapStepPage(roadmap: roadmap, step: step)
    case .note: RoadmapNoteEditor(roadmap: roadmap)
    case .history(let step): StepHistory(roadmap: roadmap, step: step)
    case .attach(let step): AttachRoadmap(roadmap: roadmap, step: step)
    case .roadmap: RoadmapInside(roadmap: roadmap, app: app)
    }
  }
}

// The open roadmap in the view the room shows of it, the Board's first step for a roadmap with no step under either
// choice (04.7), in the root's room and in a roadmap gone into (07.3). On the Graph the band slot holds the selected step
// while no band stands there (04.2), and with none selected *Next* over the Up next steps, where there is one (04.1, 04.3).
// Fit leaves the Graph alone under the status bar (04.5). New step leaves the foot to Find's field while Find is up (02.5)
// and to the bottom toolbar while several steps are selected (02.10).
struct RoadmapViews: View {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap

  var body: some View {
    let graph = roadmap.view(of: open) == .graph
    let fitted = graph && roadmap.graph.fitted
    let footed = !roadmap.reading.finds && roadmap.selection == nil
    return Group {
      if graph { RoadmapGraphCanvas(roadmap: roadmap, progress: open.board.overall.progress) }
      else { RoadmapBoard(roadmap: roadmap, open: open) }
    }.underSwitchRow(roadmap, open: open, graph: graph, away: fitted)
      .toolbarVisibility(fitted ? .hidden : .automatic, for: .navigationBar)
      .roadmapFoot(roadmap, away: fitted) {
        if graph, roadmap.band == nil {
          if let selected = roadmap.selected.flatMap({ open.step($0) }) { GraphStepBar(roadmap: roadmap, row: selected) }
          else if !open.upNext.isEmpty { GraphNextBar(roadmap: roadmap, rows: open.upNext) }
        }
        if footed {
          HStack {
            Spacer()
            // 02.16: a tap is New Step, and a long press offers it above Paste Steps.
            Menu {
              Button("New Step", systemImage: "plus") { roadmap.newStep(from: .foot) }
              Button("Paste Steps", systemImage: "list.clipboard") { Task { await roadmap.pasteSteps() } }.accessibilityIdentifier("roadmap-paste-steps")
            } label: {
              Label("New Step", systemImage: "plus")
            } primaryAction: {
              roadmap.newStep(from: .foot)
            }.menuOrder(.fixed).modifier(GlassCircle()).accessibilityIdentifier("roadmap-new-step")
          }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
        }
      }
  }
}

// The sheets the room on top of the stack raises over its screens, the root's or the deepest roadmap's gone into: Paste
// Steps, the step form, Kinds and the Guide. They stand on the stack, not on a screen, so a screen pushed over a roadmap gone into raises
// them too. What the stack's one band says is announced and felt once, whichever screen stands over it.
struct RoomSheets: ViewModifier {
  let roadmap: RoadmapModel
  let app: AppModel

  func body(content: Content) -> some View {
    content
      .sheet(item: Binding(get: { roadmap.pasting }, set: { if $0 == nil { roadmap.pasting?.cancel() } })) { PasteStepsSheet(pasted: $0) }
      .sheet(item: Binding(get: { roadmap.draft }, set: { if $0 == nil { roadmap.draft?.cancel() } })) { draft in
        RoadmapStepForm(roadmap: roadmap, draft: draft).environment(app)
      }
      .sheet(isPresented: Binding(get: { roadmap.kindsDoor == .menu }, set: { if !$0 { roadmap.closeKinds() } })) { RoadmapKinds(roadmap: roadmap) }
      .sheet(item: Binding(get: { roadmap.guide }, set: { if $0 == nil { roadmap.closeGuide() } })) { guide in
        RoadmapGuide(roadmap: roadmap, sheet: guide, signedIn: app.account != nil)
      }
      .sensoryFeedback(trigger: roadmap.band) { _, band in
        switch band?.says {
        case .completed, .created, .planted, .added: .success
        case .reset: .impact
        case .unrestored: .warning
        default: nil
        }
      }
      .onChange(of: roadmap.band) { _, band in
        if let band { UIAccessibility.post(notification: .announcement, argument: band.says.words) }
      }
  }
}

// The switch row (Roadmap · iOS S.1, 09.4), the room's and a reader's cover's alike, chooses the roadmap's view, and carries
// Find and the view's one tool: the Board's Sort and filter (02.5, 02.7), and the Graph's Fit (04.5), which needs the Graph
// on screen with its camera. Find is the Board's: the Graph's waits for its screen. The row reads only whether the camera
// is there, never the camera, which a gesture or a glide changes every frame. While several steps are selected the switch
// waits.
struct SwitchRow: View {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap
  let graph: Bool

  var body: some View {
    HStack(spacing: RoomSpace.related) {
      // Each segment takes its lens from the ForEach's id: a `tag` here leaves the room's type holding SwiftUI's
      // client-emitted `tag`, which a Release test bundle cannot link against.
      Picker("View", selection: Binding(get: { roadmap.lens }, set: { roadmap.show($0) })) {
        ForEach(RoadmapModel.Lens.allCases, id: \.self) { lens in lens == .board ? Text("Board") : Text("Graph") }
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
}

extension View {
  // The switch row stands in the bar's own safe area on iOS 26, and on the bar material over the list before it. Away,
  // it leaves that area to the screen.
  @ViewBuilder func underSwitchRow(_ roadmap: RoadmapModel, open: RoadmapModel.OpenRoadmap, graph: Bool, away: Bool) -> some View {
    if #available(iOS 26.0, *) { safeAreaBar(edge: .top) { if !away { SwitchRow(roadmap: roadmap, open: open, graph: graph) } } }
    else { safeAreaInset(edge: .top) { if !away { SwitchRow(roadmap: roadmap, open: open, graph: graph).background(.bar) } } }
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
// Guide, which counts the guides from above (08.5), Kinds, Activity, Rename and Delete Roadmap. Rename is the system's:
// it turns the bar into one field, whose return key commits a name and leaves the old one where the field was emptied.
// Delete Roadmap asks under the title, on a view that stays on screen once the menu has closed. While several steps are
// selected the title counts them, with no progress, no menu and no rename (02.10). The title stands on a view of its own behind the screen, which changes with it, so the screen
// under the title is not made anew as a selection starts and ends.
struct RoadmapTitle: ViewModifier {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap

  func body(content: Content) -> some View {
    content.background { title }
      .overlay(alignment: .top) { Color.clear.frame(width: 1, height: 1).modifier(DeleteRoadmapQuestion(roadmap: roadmap, row: nil)) }
  }

  // The title's menu: the three most recent roadmaps, then this roadmap's verbs.
  @ViewBuilder var menu: some View {
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
    Button(GuideSheet.menuTitle(above: open.guidesAbove.count), systemImage: "book.closed") { roadmap.openGuide() }.tint(RoadmapPalette.ink)
    Button("Kinds", systemImage: "paintpalette") { roadmap.openKinds(from: .menu) }.tint(RoadmapPalette.ink)
    Button("Activity", systemImage: "clock.arrow.circlepath") { roadmap.showActivity() }.tint(RoadmapPalette.ink)
    RenameButton()
    Divider()
    Button("Delete Roadmap", systemImage: "trash", role: .destructive) { roadmap.askDelete(open.listed, from: .menu) }
  }

  // iOS 26 draws the progress under the inline title, whose menu and field are the system's; before it the name and
  // the progress stand in the bar's principal slot, as on every room's screen, with the same menu. The field starts from
  // the name the bar shows, so a name committed as it was shown writes nothing.
  @ViewBuilder var title: some View {
    let name = open.listed.name
    if let selection = roadmap.selection {
      SelectedTitle(selection: selection)
    } else if #available(iOS 26.0, *) {
      Color.clear.navigationTitle(Binding(get: { name }, set: { if $0 != name { roadmap.rename(to: $0) } }))
        .navigationSubtitle(open.board.overall.progress).toolbarTitleMenu { menu }
    } else {
      Color.clear.roomTitle(name, subtitle: open.board.overall.progress).toolbarTitleMenu { menu }
    }
  }

  // The title while several steps are selected, which reads the steps chosen on its own, so a tap on a row redraws it
  // alone.
  struct SelectedTitle: View {
    let selection: BoardSelection

    var body: some View {
      Color.clear.navigationTitle(String(localized: "\(selection.steps.count) Selected", locale: .copy,
                                         comment: "The bar while several steps are selected: how many"))
    }
  }
}
