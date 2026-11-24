import Foundation
import Observation
import SwiftUI
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine

// Attach a Roadmap (Roadmap · iOS 07.6 to 07.7b, 07.12a, 07.12b), pushed from a step's page, by its … menu, its Roadmap
// row's Change Roadmap, or Choose Roadmap where its roadmap cannot be found, and from the step form's Roadmap row: the
// person's own roadmaps, found by name in the bar's drawer, the one the step opens checked and the one it stands in
// dimmed, since a step opens only another roadmap. A choice on the page is written at once and pops, with Undo in the
// band; in the form it sets the draft, which the form's save writes. None, first where the step opens one, makes it
// ordinary again, and its footer says what stays. A copied link can be pasted: to one of the person's roadmaps it chooses
// that one; to one they can only read, that roadmap stands above theirs, to be forked first, which needs a connection and
// an account; to none they can read, it says so where it was pasted.
struct AttachRoadmap: View {
  let roadmap: RoadmapModel
  let step: String
  // The form's draft where the list is the form's row's; none where a choice is written at once.
  var draft: StepDraft?
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var app: AppModel?
  @State private var query = ""
  @State private var pasted: PastedRoadmap?

  var body: some View {
    let rows = roadmap.root.roadmaps
    let sought = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let found = rows.filter { sought.isEmpty || ($0.title ?? "").lowercased().contains(sought) }
    let living = roadmap.shown?.listed.id
    let others = rows.contains { $0.id != living }
    return List {
      if let current, sought.isEmpty {
        Section {
          Button { chooseNone() } label: {
            Text(String(localized: "None", comment: "Nothing chosen: no step in the step form's Requires or Opens, and no roadmap in its Roadmap row or the attach list"))
              .foregroundStyle(RoadmapPalette.ink).frame(maxWidth: .infinity, alignment: .leading)
          }
            .accessibilityIdentifier("roadmap-attach-none")
        } footer: {
          Text(String(localized: "\(ListedRoadmap.name(of: name(of: current))) stays. This step becomes ordinary.",
                      comment: "The attach list's None: the roadmap the step opens now, which detaching leaves as it is"))
            .foregroundStyle(RoadmapPalette.inkDim)
        }.listRowBackground(RoadmapPalette.card)
      }
      if let pasted, case .readable(let title) = pasted.state, pasted.copy == nil {
        Section {
          HStack(spacing: 12) {
            Image(systemName: "globe").foregroundStyle(RoadmapPalette.accent).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
              Text(ListedRoadmap.name(of: title)).foregroundStyle(RoadmapPalette.ink)
              Text("Someone else’s · you can read it").font(.footnote).foregroundStyle(RoadmapPalette.inkDim)
            }
          }.accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-attach-pasted")
        } header: {
          StepSectionHeader(title: "Pasted link")
        } footer: {
          Text("Someone else’s roadmap? Fork it first — the copy is yours.").foregroundStyle(RoadmapPalette.inkDim)
        }.listRowBackground(RoadmapPalette.card)
      }
      Section {
        ForEach(found, id: \.id) { listed in row(listed, living: listed.id == living) }
      } header: {
        StepSectionHeader(title: "Your Roadmaps")
      } footer: {
        if !others && sought.isEmpty { Text("You have no other roadmaps yet.").foregroundStyle(RoadmapPalette.inkDim) }
      }.listRowBackground(RoadmapPalette.card)
      Section {
        LabeledContent {
          PasteButton(payloadType: URL.self) { urls in Task { @MainActor in paste(urls.first) } }
            .buttonBorderShape(.capsule).tint(RoadmapPalette.accent).labelStyle(.titleAndIcon).accessibilityIdentifier("roadmap-attach-paste")
        } label: {
          Text("A Copied Link").foregroundStyle(RoadmapPalette.ink)
        }
      } footer: {
        if let refusal = pasted?.refusal { Text(refusal).foregroundStyle(RoadmapPalette.ink).accessibilityIdentifier("roadmap-attach-refusal") }
      }.listRowBackground(RoadmapPalette.card)
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .tint(RoadmapPalette.accent)
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a roadmap")
      .navigationTitle("Roadmap").navigationBarTitleDisplayMode(.inline).roomBar(.roadmap)
      .modifier(ForkFirst(pasted: pasted, app: app))
      .onAppear {
        if draft != nil { roadmap.telemetry.event("roadmap_tree_attach", properties: ["step": "open", "door": "form"]) }
      }
      .onDisappear { pasted?.letGo() }
      .onChange(of: rows.map(\.id)) { _, ids in pasted?.listed(ids) }
  }

  // The roadmap the step opens now, by the draft where the form holds one; a subtree the step owns is none of these.
  var current: String? {
    if let draft { return draft.roadmap }
    guard let opening = roadmap.shown?.step(step)?.opening, !opening.owned else { return nil }
    return opening.tree
  }

  // A roadmap's name as the person's list or the room's copy holds it.
  func name(of tree: String) -> String? {
    roadmap.root.roadmaps.first { $0.id == tree }?.title ?? roadmap.account.location(of: tree).title
  }

  // A row of the person's own: its name over its progress, checked where the step opens it. The roadmap the step stands in
  // is dimmed and says so.
  func row(_ listed: ListedRoadmap, living: Bool) -> some View {
    Button { choose(listed.id) } label: {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(listed.name).foregroundStyle(living ? RoadmapPalette.inkFaint : RoadmapPalette.ink)
          if let counts = listed.counts { Text(counts.progress).font(.footnote).foregroundStyle(living ? RoadmapPalette.inkFaint : RoadmapPalette.inkDim) }
        }.frame(maxWidth: .infinity, alignment: .leading)
        if living { Text("This roadmap").font(.footnote).foregroundStyle(RoadmapPalette.inkFaint) }
        if listed.id == current { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(RoadmapPalette.accent).accessibilityHidden(true) }
      }.contentShape(Rectangle())
    }.buttonStyle(.plain).disabled(living)
      .listRowInsets(EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: RoomSpace.inset))
      .accessibilityElement(children: .combine).accessibilityAddTraits(listed.id == current ? .isSelected : [])
      .accessibilityIdentifier("roadmap-attach-row")
  }

  // A roadmap chosen: the draft takes it, or the step opens it at once; either pops. The one it opens already pops alone.
  func choose(_ tree: String) {
    if let draft {
      draft.roadmap = tree
      return dismiss()
    }
    guard tree != current else { return dismiss() }
    guard let row = roadmap.shown?.step(step), roadmap.attach(tree, to: row) else { return }
    dismiss()
  }

  // None: the draft lets go of its roadmap, or the step is detached at once; either pops.
  func chooseNone() {
    if let draft {
      draft.roadmap = nil
      return dismiss()
    }
    if let row = roadmap.shown?.step(step) { roadmap.detach(row) }
    dismiss()
  }

  // A link pasted: one to the person's own roadmap chooses it; any other is read through the engine, and a link that names
  // no roadmap is refused where it was pasted.
  func paste(_ url: URL?) {
    let tree = url.flatMap { ClaimedLink($0).address?.tree }
    pasted?.letGo()
    if let tree, roadmap.root.roadmaps.contains(where: { $0.id == tree }) {
      pasted = nil
      roadmap.telemetry.event("roadmap_tree_attach", properties: ["step": "paste", "outcome": "own"])
      return choose(tree)
    }
    pasted = PastedRoadmap(tree, room: roadmap.root)
  }
}

// What a pasted link to someone else's roadmap comes to (Roadmap · iOS 07.7, 07.7b, 07.12a, 07.12b): its tree scope followed
// through the engine while the list stands, as a cover follows one, and its name once the phone's copy holds its meta;
// nothing the person can read where the engine answers the scope gone, or its first pull ends with no meta; and with no
// connection and no copy, that it needs one. Forking it first is the server's, so it needs a connection and a session the
// phone can send as: with neither it says so in the band, signed out it asks for the shell's sign-in and forks once that
// ends signed in. The copy arrives by sync and heads the person's roadmaps.
@Observable @MainActor
final class PastedRoadmap {
  enum State: Equatable {
    case reading, readable(String?), unreadable, needsConnection
  }

  enum Forking: Equatable {
    case idle, running, failed, offline
  }

  // How long a copy a fork made is waited for before the list lets the fork go.
  static let arrivalWait = Duration.seconds(15)

  let tree: String?
  let room: RoadmapModel
  let sources: RoadmapCover.Sources?
  private(set) var state = State.reading
  private(set) var forking = Forking.idle
  // The copy a fork made, waited for until the person's list holds it.
  private(set) var copy: String?
  // A sign-in the fork asked for, which the list raises.
  var signingIn = false
  @ObservationIgnored var askedWith: SessionToken?
  @ObservationIgnored let request = UUID().uuidString.lowercased()
  @ObservationIgnored var view: RecordsView?
  @ObservationIgnored var followed = false
  @ObservationIgnored var told = false

  init(_ tree: String?, room: RoadmapModel) {
    self.tree = tree
    self.room = room
    sources = room.links?.sources
    guard let tree, let sources else {
      settle(.unreadable)
      return
    }
    followed = true
    do {
      guard try sources.follow(ID<RoadmapEntry>(RecordID(tree)).tree) != .gone else {
        settle(.unreadable)
        return
      }
    } catch {
      room.telemetry.failure("roadmap_subscribe", kind: "unexpected")
    }
    read()
  }

  // The scope's meta as the phone's copy holds it, read again as the view changes until the read settles.
  func read() {
    guard let tree, let sources, state == .reading || state == .needsConnection else { return }
    do {
      let view = try self.view ?? room.records(ID<RoadmapEntry>(RecordID(tree)).tree, RoadmapMeta.type)
      self.view = view
      if case .loaded(let snapshot) = view.state {
        if let meta = snapshot.records.first(where: { $0.id == RoadmapMeta.singleton.record }) {
          return settle(.readable((try? RoadmapMeta(Fields(meta)))?.title))
        }
        if snapshot.firstPullComplete { return settle(.unreadable) }
      }
      if !sources.online() { state = .needsConnection }
      withObservationTracking { _ = view.state } onChange: { [weak self] in
        Task { @MainActor [weak self] in self?.read() }
      }
    } catch {
      room.report(read: error)
      settle(.unreadable)
    }
  }

  // The read came to something the list shows, told once: one the person can read, or none.
  func settle(_ settled: State) {
    state = settled
    guard !told else { return }
    told = true
    let outcome = if case .readable = settled { "readable" } else { "unreadable" }
    room.telemetry.event("roadmap_tree_attach", properties: ["step": "paste", "outcome": outcome])
  }

  // What the Copied Link row's footer says, in the refusal's ink: no roadmap the person can read at the address, or no
  // connection to read one the phone holds no copy of.
  var refusal: String? {
    switch state {
    case .unreadable: String(localized: "No roadmap you can read is at that address.")
    case .needsConnection: String(localized: "Needs a connection")
    case .reading, .readable: nil
    }
  }

  // The band over Fork Roadmap once it was tapped with no connection, or the fork came to nothing.
  var forkLine: String? {
    switch forking {
    case .offline: String(localized: "Forking needs a connection.")
    case .failed: String(localized: "Couldn’t fork this roadmap. Try again.")
    case .idle, .running: nil
    }
  }

  // Fork Roadmap, or Sign In to Fork signed out (07.7, 07.12a, 07.12b).
  func fork() {
    guard let tree, let sources, forking != .running, copy == nil else { return }
    room.telemetry.event("roadmap_tree_attach", properties: ["step": "fork"])
    room.telemetry.event("fork_attempt", properties: ["mode": "instant"])
    guard sources.online() else {
      forking = .offline
      room.telemetry.event("fork_attempt", properties: ["mode": "instant", "outcome": "offline"])
      return
    }
    guard let credential = sources.credential() else {
      room.telemetry.event("fork_attempt", properties: ["mode": "instant", "outcome": "signed_out"])
      return ask(under: nil)
    }
    forking = .running
    Task { [requests = sources.requests, request, wait = room.wait] in
      do throws(SharingFailure) {
        let made = try await requests.fork(tree, request: request)
        room.telemetry.event("fork_claim", properties: ["mode": "instant"])
        copy = made
        listed(room.roadmaps.map(\.id))
        guard (try? await wait(Self.arrivalWait)) != nil, forking == .running else { return }
        forking = .idle
      } catch {
        forking = error == .signedOut ? .idle : .failed
        let outcome = switch error {
        case .offline: "offline"
        case .signedOut: "unauthenticated"
        case .refused: "refused"
        case .busy: "busy"
        case .failed, .cancelled: "failed"
        }
        room.telemetry.event("fork_attempt", properties: ["mode": "instant", "outcome": outcome])
        if error == .signedOut { ask(under: credential) }
      }
    }
  }

  func ask(under credential: SessionToken?) {
    (signingIn, askedWith) = (true, credential)
  }

  // The sign-in the fork asked for ended: a fresh session forks, and closed with none it ends the fork.
  func signInEnded() {
    guard signingIn else { return }
    signingIn = false
    guard let fresh = sources?.credential(), fresh != askedWith else { return }
    fork()
  }

  // The person's list as it now stands: the copy a fork made has arrived once it holds it.
  func listed(_ ids: [String]) {
    guard let copy, forking == .running, ids.contains(copy) else { return }
    forking = .idle
  }

  // The list went: what it followed is let go, so nothing of the roadmap is kept on the phone.
  func letGo() {
    guard followed, let tree, let sources else { return }
    followed = false
    do { try sources.letGo(ID<RoadmapEntry>(RecordID(tree)).tree) } catch { room.telemetry.failure("roadmap_subscribe", kind: "unexpected", properties: ["step": "close"]) }
  }
}

// Fork Roadmap at the attach list's foot (Roadmap · iOS 07.7, 07.12a, 07.12b), while a pasted link stands for a roadmap the
// person can only read: one glass button the width of the foot, *Sign In to Fork* signed out and a spinner while the
// server copies it. The shell's sign-in it asks for stands over the list, a sheet of its own.
struct ForkFirst: ViewModifier {
  let pasted: PastedRoadmap?
  let app: AppModel?

  func body(content: Content) -> some View {
    content.reachBand {
      if let pasted, case .readable = pasted.state, pasted.copy == nil || pasted.forking == .running {
        VStack(spacing: 0) {
          if let line = pasted.forkLine {
            RoomTransient(message: line, room: .roadmap, type: .subheadline).accessibilityIdentifier("roadmap-attach-fork-band")
          }
          glass(Button { pasted.fork() } label: {
            Group {
              if pasted.forking == .running { Label { Text("Forking…") } icon: { ProgressView() } }
              else if pasted.sources?.signedIn() == false { Text("Sign In to Fork") }
              else { Text("Fork Roadmap") }
            }.font(.body.weight(.semibold)).frame(maxWidth: .infinity)
          }).buttonBorderShape(.capsule).controlSize(.large).tint(RoadmapPalette.accent)
            .padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
            .accessibilityIdentifier("roadmap-attach-fork")
        }
      }
    }
    .onAppear { app?.roomSheetUp = true }
    .onDisappear { app?.roomSheetUp = false }
    .sheet(isPresented: Binding(get: { app?.sheet != nil }, set: { if !$0 { app?.cancelAuthentication(); app?.sheet = nil } }),
           onDismiss: { app?.dismissSheet() }) { if let app { AccountSheet(model: app) } }
    .onChange(of: pasted?.signingIn) { _, asked in if asked == true { app?.signIn(for: .fork) } }
    .onChange(of: app?.sheet == nil) { _, closed in if closed { pasted?.signInEnded() } }
  }

  @ViewBuilder func glass(_ button: some View) -> some View {
    if #available(iOS 26.0, *) { button.buttonStyle(.glass) }
    else { button.buttonStyle(.bordered) }
  }
}
