import SwiftUI
import RoadmapDomain

// A shared roadmap's cover (Roadmap · iOS 09.4 to 09.11): a full-screen cover with its own stack, so another person's
// roadmap never enters the room's. Its bar holds the close button, the roadmap's name over *Shared roadmap* and its
// progress, and the share's address; under it the room's switch row, Board and Graph in the reader's role, a step's page
// and its History pushed on the cover's stack, and Fork at the foot. Before the roadmap is read the cover is its close
// button alone, with a spinner; a roadmap the phone can neither read nor hold, and one it holds no copy of with no
// connection, say so. A sign-in the cover opens stands over it, the shell's own sheet.
struct RoadmapCoverScreen: View {
  let cover: RoadmapCover
  let app: AppModel

  var body: some View {
    NavigationStack(path: Binding(get: { cover.room.path }, set: { cover.room.path = $0 })) {
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .tint(RoadmapPalette.accent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            if #available(iOS 26.0, *) { Button(role: .close) { cover.close() }.accessibilityIdentifier("roadmap-cover-close") }
            else { Button("Close", systemImage: "xmark") { cover.close() }.accessibilityIdentifier("roadmap-cover-close") }
          }
          if cover.state == .open, let link = cover.link {
            ToolbarItem(placement: .topBarTrailing) {
              ShareLink(item: link) { Label("Share", systemImage: "square.and.arrow.up") }.accessibilityIdentifier("roadmap-cover-share")
            }
          }
        }.roomBar(.roadmap)
        .navigationDestination(for: RoadmapModel.Visit.self) { visit in
          switch visit {
          case .step(let step, _): RoadmapStepPage(roadmap: cover.room, step: step)
          case .history(let step): StepHistory(roadmap: cover.room, step: step)
          case .roadmaps, .activity, .note: EmptyView()
          }
        }
    }
    // The shell's sign-in, which Fork and Sign In open signed out, stands over the cover while the room's waits.
    .onAppear { app.roomSheetUp = true }
    .onDisappear { app.roomSheetUp = false }
    .sheet(isPresented: Binding(get: { app.sheet != nil }, set: { if !$0 { app.cancelAuthentication(); app.sheet = nil } }),
           onDismiss: { app.dismissSheet() }) { AccountSheet(model: app) }
    .onChange(of: cover.forking == .signingIn) { _, asks in if asks { app.signIn(for: .fork) } }
    .onChange(of: app.sheet == nil) { _, closed in if closed { cover.signInEnded() } }
    // Another account, or none, reads another copy: the cover follows the roadmap in it; a roadmap it could not open is
    // asked of the room again, which may find it the person's own (09.10b).
    .onChange(of: cover.signedIn) { _, _ in
      if cover.state == .unopenable, let owner = cover.owner { owner.follow(ClaimedLink(cover.address, form: .share)) }
      else { cover.accountChanged() }
    }
    .onChange(of: cover.online) { _, online in if online && cover.state == .needsConnection { cover.retry() } }
  }

  @ViewBuilder var content: some View {
    switch cover.state {
    case .reading:
      ProgressView().controlSize(.large).tint(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-cover-reading")
    case .open:
      if let open = cover.room.shown { views(of: open) }
    // 09.10a, 09.10b: the roadmap is private, gone or never was; signed out it may be the person's own, so Sign In.
    case .unopenable:
      ContentUnavailableView {
        Label { Text("This roadmap can’t be opened").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("It may be private, or it may have moved.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        if !cover.signedIn {
          Button("Sign In") { app.signIn(for: .link) }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-cover-sign-in")
        }
      }
    // 09.11: no connection and no copy on the phone.
    case .needsConnection:
      ContentUnavailableView {
        Label { Text("Needs a connection").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "wifi.slash").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("This roadmap isn’t on this iPhone.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        Button("Try Again") { cover.retry() }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-cover-try-again")
      }
    }
  }

  // The roadmap in the reader's role (09.4, 09.5a): the room's switch row over its Board or Graph, a step selected on the
  // Graph standing in the band slot, and Fork at the foot. Fit leaves the Graph alone under the status bar.
  func views(of open: RoadmapModel.OpenRoadmap) -> some View {
    let room = cover.room
    let graph = room.view(of: open) == .graph
    let fitted = graph && room.graph.fitted
    return Group {
      if graph { RoadmapGraphCanvas(roadmap: room, progress: open.board.overall.progress) }
      else { RoadmapBoard(roadmap: room, open: open) }
    }.underSwitchRow(room, open: open, graph: graph, away: fitted)
      .modifier(SharedTitle(name: open.listed.name, progress: open.board.overall.progress))
      .toolbarVisibility(fitted ? .hidden : .automatic, for: .navigationBar)
      .roadmapFoot(room, away: fitted) {
        if graph, let selected = room.selected.flatMap({ open.step($0) }) { GraphStepBar(row: selected) }
      }
  }

  // The cover's title: the roadmap's name over *Shared roadmap* and its progress, with no menu and no rename.
  struct SharedTitle: ViewModifier {
    let name: String
    let progress: String

    @ViewBuilder func body(content: Content) -> some View {
      let subtitle = String(localized: "Shared roadmap · \(progress)", comment: "A shared roadmap's cover: under its name, how far its owner is")
      if #available(iOS 26.0, *) { content.navigationTitle(name).navigationSubtitle(subtitle) }
      else { content.roomTitle(name, subtitle: subtitle) }
    }
  }
}

// Fork at a reader's foot (Roadmap · iOS 09.4, 09.7, 09.9b): one glass button the width of the foot, its label a spinner and
// *Forking…* while the server copies the roadmap and the copy comes, when it takes no second tap. With no connection it is
// dimmed and the band slot says why; a fork that came to nothing says so there too.
struct ForkFoot: View {
  let cover: RoadmapCover

  var body: some View {
    VStack(spacing: 0) {
      if let line {
        RoomTransient(message: line, room: .roadmap, type: .subheadline).accessibilityIdentifier("roadmap-fork-band")
      }
      glass(Button { cover.fork() } label: {
        Group {
          if cover.forking == .running {
            Label { Text("Forking…") } icon: { ProgressView() }
          } else {
            Text("Fork Roadmap")
          }
        }.font(.body.weight(.semibold)).frame(maxWidth: .infinity)
      }).buttonBorderShape(.capsule).controlSize(.large).tint(RoadmapPalette.accent)
        .disabled(!cover.online || cover.forking == .running)
        .padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
        .accessibilityIdentifier("roadmap-fork")
    }
  }

  var line: String? {
    if !cover.online { return String(localized: "Forking needs a connection.") }
    if cover.forking == .failed { return String(localized: "Couldn’t fork this roadmap. Try again.") }
    return nil
  }

  @ViewBuilder func glass(_ button: some View) -> some View {
    if #available(iOS 26.0, *) { button.buttonStyle(.glass) }
    else { button.buttonStyle(.bordered) }
  }
}
