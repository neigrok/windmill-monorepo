import SwiftUI
import Observation
import RoadmapDomain
import SyncEngine

// The public gallery (Roadmap on iOS §3, §4; Roadmap · iOS 09.12a, 09.12b), pushed from All Roadmaps as *Planted in Public*:
// the backend's public roadmaps, read a page at a time as the list scrolls and shown in the order it ranks them. It needs a
// connection and no account, and it is held by its screen alone, so nothing of it is kept on the phone. A row opens its
// roadmap as its link does, and offers what the person can do with it: nothing on a roadmap of their own, their copy where
// the phone holds one, else Fork, which is the cover's.
@Observable @MainActor
final class PublicGallery {
  // The first page being read, the rows read so far, a gallery with no row, or one that could not be reached.
  enum State: Equatable {
    case reading, rows, empty, unreachable
  }

  // What a row offers: *Listed by you*, *Open Your Copy* with the copy's id, or Fork.
  enum Offer: Equatable {
    case mine, copy(String), fork
  }

  // The person's own room, whose list says which copies they hold and where a row's roadmap and a copy open.
  unowned let room: RoadmapModel
  private(set) var state = State.reading
  private(set) var rows: [GalleryPage.Row] = []
  // A later page is being read, or the last read of one came to nothing.
  private(set) var paging = false
  private(set) var pageFailed = false
  // Each row's fork, made as it is first asked, and the copy each fork has answered.
  private(set) var forks: [String: RoadmapFork] = [:]
  private(set) var copies: [String: String] = [:]
  // The row whose fork waits for the sign-in it asked for, which the screen raises, and the session it was asked under.
  private(set) var signingIn: String?
  @ObservationIgnored var askedWith: SessionToken?
  // Where the next page starts; none once the last is read.
  @ObservationIgnored private(set) var next: String?
  @ObservationIgnored var reading: Task<Void, Never>?

  init(room: RoadmapModel) {
    self.room = room
  }

  var sources: RoadmapCover.Sources? { room.links?.sources }

  // The screen came up: the first page is read.
  func open() {
    guard reading == nil, rows.isEmpty else { return }
    read(after: nil)
  }

  // The list's last row came on screen: the next page, where there is one and none is being read.
  func more() {
    guard state == .rows, let next, !paging else { return }
    read(after: next)
  }

  // Try Again (09.12b), and under a later page that came to nothing.
  func retry() {
    room.telemetry.event("roadmap_gallery", properties: ["step": "retry"])
    guard rows.isEmpty else { return more() }
    state = .reading
    read(after: nil)
  }

  // One page, told as the web tells it: the first (`load`) or a later one (`page`), with what it came to.
  func read(after cursor: String?) {
    guard let requests = sources?.requests else {
      state = .unreachable
      return
    }
    let step = cursor == nil ? "load" : "page"
    (paging, pageFailed) = (cursor != nil, false)
    reading = Task {
      do throws(SharingFailure) {
        let page = try await requests.gallery(after: cursor)
        let shown = Set(rows.map(\.id))
        rows += page.rows.filter { !shown.contains($0.id) }
        next = page.next
        paging = false
        state = rows.isEmpty ? .empty : .rows
        room.telemetry.event("roadmap_gallery", properties: ["step": step, "outcome": page.rows.isEmpty ? "empty" : "available"])
      } catch {
        paging = false
        guard error != .cancelled else { return }
        if cursor == nil { state = .unreachable } else { pageFailed = true }
        room.telemetry.event("roadmap_gallery", properties: ["step": step, "outcome": "failed"])
      }
    }
  }

  // The screen went: a read under way stops.
  func close() {
    reading?.cancel()
  }

  // What a row offers. The person's copy is a roadmap of their list that stands and was forked from the row's roadmap, the
  // first in the list's order, or the copy a fork from the row has answered.
  func offer(for row: GalleryPage.Row) -> Offer {
    if row.mine { return .mine }
    if let copy = copies[row.id] ?? held[row.id] { return .copy(copy) }
    return .fork
  }

  // The person's copies of public roadmaps, each by the roadmap it was forked from: the first in their list's order.
  var held: [String: String] {
    let trees = Dictionary(room.account.trees.map { ($0.id, $0) }) { first, _ in first }
    var held: [String: String] = [:]
    for listed in room.account.list() {
      if let source = trees[listed.id]?.meta?.forkedFrom, held[source] == nil { held[source] = listed.id }
    }
    return held
  }

  // A row tapped: its roadmap opens as its link opens it, the person's own in the room and anyone else's on a cover.
  func open(_ row: GalleryPage.Row) {
    guard let links = room.links, let address = links.sources.address(of: row.id) else { return }
    room.telemetry.event("roadmap_gallery", properties: ["step": "row", "mine": row.mine ? "true" : "false"])
    links.follow(ClaimedLink(address), in: room, tells: false)
  }

  // Fork on a row (09.12a): the server copies the roadmap at once and the row offers the copy. Signed out it asks for a
  // sign-in, and the fork runs once that ends with a fresh session; with no connection, or a fork that came to nothing, the
  // band says so.
  func fork(_ row: GalleryPage.Row) {
    guard let sources, offer(for: row) == .fork else { return }
    let forking = forks[row.id] ?? RoadmapFork(row.id, mode: .browse, sources: sources, telemetry: room.telemetry)
    forks[row.id] = forking
    forking.run { [self] answer in
      switch answer {
      case .copy(let copy):
        copies[row.id] = copy
        forking.settle()
      case .signIn(let credential): (signingIn, askedWith) = (row.id, credential)
      case .nothing:
        if forking.state == .offline { room.show(RoadmapModel.Band(told: .unforked(offline: true))) }
        if forking.state == .failed { room.show(RoadmapModel.Band(told: .unforked(offline: false))) }
      }
    }
  }

  // The sign-in a row's fork asked for ended: a fresh session forks that row, and closed with none it ends the fork.
  func signInEnded() {
    guard let row = signingIn.flatMap({ asked in rows.first { $0.id == asked } }) else { return }
    signingIn = nil
    guard let fresh = sources?.credential(), fresh != askedWith else { return }
    fork(row)
  }

  // Open Your Copy: the copy on its Board, once the person's list holds it, which a copy just made waits for, as the cover's
  // Fork waits.
  func openCopy(_ copy: String) {
    room.telemetry.event("roadmap_gallery", properties: ["step": "copy"])
    if room.roadmaps.contains(where: { $0.id.utf8.elementsEqual(copy.utf8) }) { return room.open(copy, from: .gallery) }
    room.path = []
    room.links?.forked(copy, in: room)
  }
}

// Planted in Public (09.12a, 09.12b): a pushed list of the gallery's rows, each its roadmap's title over its step count with
// what it offers at its trailing edge, reading the next page as the last row comes on screen; or, before the first page, a
// spinner; a gallery that cannot be reached says so with Try Again, and an empty one says so with nothing to try. It stands on
// the room's band, and a sign-in a row's Fork asks for is the shell's.
struct PublicGalleryScreen: View {
  let roadmap: RoadmapModel
  let app: AppModel
  @State private var gallery: PublicGallery?

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .tint(RoadmapPalette.accent)
      .navigationTitle("Planted in Public").navigationBarTitleDisplayMode(.inline)
      .roomBar(.roadmap)
      .roadmapFoot(roadmap) {}
      .task {
        guard gallery == nil else { return }
        let opened = PublicGallery(room: roadmap)
        gallery = opened
        opened.open()
      }
      .onDisappear { if roadmap.path.last != .gallery { gallery?.close() } }
      .onChange(of: gallery?.signingIn) { _, asked in if asked != nil { app.signIn(for: .fork) } }
      .onChange(of: app.sheet == nil) { _, closed in if closed { gallery?.signInEnded() } }
  }

  @ViewBuilder var content: some View {
    switch gallery?.state {
    case nil, .reading?:
      ProgressView().controlSize(.large).tint(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-gallery-reading")
    case .unreachable?:
      ContentUnavailableView {
        Label { Text("Can’t reach the gallery just now.").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "globe").foregroundStyle(RoadmapPalette.inkDim) }
      } actions: {
        tryAgain
      }
    case .empty?:
      ContentUnavailableView {
        Label { Text("Nothing on the wall yet").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "globe").foregroundStyle(RoadmapPalette.inkDim) }
      }
    case .rows?:
      if let gallery { list(gallery) }
    }
  }

  var tryAgain: some View {
    glass(Button("Try Again") { gallery?.retry() }).tint(RoadmapPalette.accent).accessibilityIdentifier("roadmap-gallery-try-again")
  }

  func list(_ gallery: PublicGallery) -> some View {
    List {
      Section {
        ForEach(gallery.rows) { row in
          GalleryRow(gallery: gallery, row: row).onAppear { if row.id == gallery.rows.last?.id { gallery.more() } }
        }
      } footer: {
        if gallery.paging {
          ProgressView().tint(RoadmapPalette.inkDim).frame(maxWidth: .infinity)
        } else if gallery.pageFailed {
          VStack(spacing: RoomSpace.related) {
            Text("Can’t reach the gallery just now.").foregroundStyle(RoadmapPalette.inkDim)
            tryAgain
          }.frame(maxWidth: .infinity).padding(.top, RoomSpace.related)
        }
      }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
      .accessibilityIdentifier("roadmap-gallery")
  }

  @ViewBuilder func glass(_ button: some View) -> some View {
    if #available(iOS 26.0, *) { button.buttonStyle(.glass) }
    else { button.buttonStyle(.bordered) }
  }

  // One row: its roadmap's title over its step count, opening its roadmap, and at its trailing edge *Listed by you*, *Open
  // Your Copy* or Fork, bordered and small, since glass on a card does not read in Daylight. At the largest text sizes the
  // button drops under the title.
  struct GalleryRow: View {
    let gallery: PublicGallery
    let row: GalleryPage.Row
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
      let layout = size.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.related))
        : AnyLayout(HStackLayout(spacing: 12))
      layout {
        Button { gallery.open(row) } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(row.title).foregroundStyle(RoadmapPalette.ink)
            Text(String(localized: "\(row.steps) steps", locale: .copy, comment: "A gallery row: how many steps its roadmap holds"))
              .font(.footnote).foregroundStyle(RoadmapPalette.inkDim)
          }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("roadmap-gallery-row")
        offer
      }.listRowInsets(EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: RoomSpace.inset))
        .listRowBackground(RoadmapPalette.card)
    }

    @ViewBuilder var offer: some View {
      switch gallery.offer(for: row) {
      case .mine:
        Text("Listed by you").font(.footnote).foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-gallery-mine")
      case .copy(let copy):
        Button("Open Your Copy") { gallery.openCopy(copy) }.buttonStyle(.bordered).controlSize(.small).buttonBorderShape(.capsule)
          .tint(RoadmapPalette.accent).accessibilityIdentifier("roadmap-gallery-copy")
      case .fork:
        let running = gallery.forks[row.id]?.state == .running
        Button { gallery.fork(row) } label: {
          if running { Label { Text("Forking…") } icon: { ProgressView().controlSize(.mini) } }
          else { Text("Fork") }
        }.buttonStyle(.bordered).controlSize(.small).buttonBorderShape(.capsule).tint(RoadmapPalette.accent).disabled(running)
          .accessibilityIdentifier("roadmap-gallery-fork")
      }
    }
  }
}
