import Foundation
import Observation
import UIKit
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncReplica

// A shared roadmap's cover (Roadmap on iOS §3, §4; Roadmap · iOS 09.4 to 09.11): the roadmap a link names that is not the
// person's own, never entering the room's list. It holds a room of its own in the reader's role, which its read
// (`SharedRead`) reads the roadmap into and whose acts all refuse, so the room's Board, Graph, step pages and History show
// it; the screens find the cover in their environment for Fork at their foot and Copy Link. Fork needs a connection and a
// session the phone can send as; it asks for a sign-in otherwise, and a sign-in that ends with no fresh session ends it.
@Observable @MainActor
final class RoadmapCover: Identifiable {
  // What a cover reads a shared roadmap through: the engine, which follows a scope while the cover stands and lets it go,
  // and says whether the phone has a connection and is signed in, which the screens read as it changes; the session the
  // phone can send as now, none signed out or while the session waits to be renewed; the backend's sharing requests; and
  // the site whose address the cover hands out.
  struct Sources {
    let follow: (ScopeRef) throws -> SubscribeOutcome
    let letGo: (ScopeRef) throws -> Void
    let online: () -> Bool
    let signedIn: () -> Bool
    let credential: () -> SessionToken?
    let requests: any RoadmapSharing
    let site: URL?
  }

  // Fork at the foot (09.7): at rest, asked of the server and waiting for its copy to arrive, or come to nothing, which the
  // band slot says.
  enum Forking: Equatable {
    case idle, running, failed
  }

  // What a sign-in the cover asked for is for: Fork (09.9a), or Sign In on a link it could not open (09.10b).
  enum SignIn {
    case fork, link
  }

  // Why a cover went, as its close tells it: its close button, its fork's copy opening, the wait for that copy ended, or
  // another link, or the same one become the person's own.
  enum Closing: String {
    case closed, forked, copyLate = "copy_late", replaced
  }

  // How long the cover waits for a fork's copy to arrive by sync before it closes on the room, which opens the copy once
  // it lands.
  static let arrivalWait = Duration.seconds(15)

  let link: ClaimedLink
  let address: RoadmapAddress
  let read: SharedRead
  // The room the cover's screens draw, in the reader's role.
  let room: RoadmapModel
  let sources: Sources
  // The person's own room, and what links raise over it, where the copy a fork made opens.
  weak var owner: RoadmapModel?
  weak var links: RoadmapLinks?
  private(set) var forking = Forking.idle
  // The sign-in the cover asked for, which the screen raises, and the session it was asked under.
  private(set) var signingIn: SignIn?
  @ObservationIgnored var askedWith: SessionToken?
  // A fork a fresh sign-in asked for, which runs once the link, followed again, finds the roadmap still someone else's.
  @ObservationIgnored var forksOnceFollowed = false
  // One fork a cover: asked again after a failure, the server answers the same copy.
  @ObservationIgnored let forkRequest = UUID().uuidString.lowercased()
  @ObservationIgnored var arrival: Task<Void, Never>?
  @ObservationIgnored private(set) var closed = false

  init(_ link: ClaimedLink, over owner: RoadmapModel, links: RoadmapLinks) {
    guard let address = link.address else { preconditionFailure("a cover is raised for a link that names a roadmap") }
    self.link = link
    self.address = address
    self.owner = owner
    self.links = links
    sources = links.sources
    read = SharedRead(address, sources: links.sources, telemetry: owner.telemetry)
    room = RoadmapModel(records: owner.records, runner: owner.runner, phone: owner.phone, telemetry: owner.telemetry, wait: owner.wait,
                        graph: RoadmapGraph(telemetry: owner.telemetry), role: .reader(read))
  }

  var state: SharedRead.State { read.state }
  var online: Bool { sources.online() }
  var signedIn: Bool { sources.signedIn() }

  // A subtree has no Fork, as the web offers none: the server forks a root alone.
  var forks: Bool { room.shown?.tree.parent == nil }

  // The roadmap's address the cover hands out, the share's, on the site, whatever step the link named.
  var shared: URL? {
    guard let roadmap = RoadmapAddress(tree: address.tree), let site = sources.site else { return nil }
    return URL(string: roadmap.shared, relativeTo: site)?.absoluteURL
  }

  // The cover rose: its owner's progress is asked for, and its roadmap followed and read.
  func open() {
    read.askProgress(for: room)
    room.observe()
  }

  // Try Again (09.11, 01.5c), and a connection come back while the cover waits for one: the roadmap is read anew from
  // views asked for anew, and the owner's progress where the last read of it failed.
  func retry() {
    read.retry(for: room)
    room.retry()
  }

  // The phone signed in or out under the cover: the engine reads another replica, which follows the roadmap anew.
  func accountChanged() {
    read.followAgain()
    room.observe()
  }

  // The link, followed again after a sign-in, still names someone else's roadmap: a fork the sign-in was for runs now.
  func followedAgain() {
    guard forksOnceFollowed else { return }
    forksOnceFollowed = false
    fork()
  }

  // Fork Roadmap (09.7, 09.9a): the server copies the roadmap, every step with its progress cleared, into the person's own
  // list, so it needs a connection and a session the phone can send as, and it asks for a sign-in otherwise. The copy
  // arrives by sync and opens on its Board, and the cover closes once it has, or once it has waited for it long enough.
  func fork() {
    guard online, forks, forking != .running else { return }
    room.telemetry.event("fork_attempt", properties: ["mode": "instant"])
    guard let credential = sources.credential() else {
      room.telemetry.event("fork_attempt", properties: ["mode": "instant", "outcome": "signed_out"])
      return ask(.fork, under: nil)
    }
    forking = .running
    Task { [requests = sources.requests, tree = address.tree, request = forkRequest] in
      do throws(SharingFailure) {
        let copy = try await requests.fork(tree, request: request)
        room.telemetry.event("fork_claim", properties: ["mode": "instant"])
        guard !closed, let owner, let links else { return }
        links.forked(copy, in: owner)
        arrival = Task { [wait = room.wait] in
          guard (try? await wait(Self.arrivalWait)) != nil else { return }
          close(.copyLate)
        }
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
        if error == .signedOut { ask(.fork, under: credential) }
      }
    }
  }

  // Sign In on a link the phone could not open, which may be the person's own (09.10b).
  func signInToOpen() {
    ask(.link, under: sources.credential())
  }

  func ask(_ purpose: SignIn, under credential: SessionToken?) {
    (signingIn, askedWith) = (purpose, credential)
  }

  // The sign-in the cover asked for ended. A fresh session follows the link again, as the person's own list may now hold
  // the roadmap, and a fork it was for runs once the roadmap is still someone else's; closed with no fresh session, it
  // ends what asked for it.
  func signInEnded() {
    guard let purpose = signingIn else { return }
    signingIn = nil
    guard let fresh = sources.credential(), fresh != askedWith, let owner, let links else { return }
    forksOnceFollowed = purpose == .fork
    links.follow(link, in: owner, tells: false)
  }

  // Copy Link in a step's … menu (09.5b): the step's share address on the pasteboard.
  func copyLink(of step: String) {
    guard let address = RoadmapAddress(tree: address.tree, step: step), let site = sources.site,
          let url = URL(string: address.shared, relativeTo: site)?.absoluteURL else { return }
    UIPasteboard.general.url = url
    room.telemetry.event("roadmap_board_step_action", properties: ["surface": "document", "action": "copyLink"])
  }

  // The cover goes. What it followed is let go, so nothing of the roadmap is kept on the phone.
  func close(_ reason: Closing) {
    guard !closed else { return }
    closed = true
    arrival?.cancel()
    read.letGo()
    room.telemetry.event("roadmap_cover", properties: ["step": "close", "reason": reason.rawValue])
    if links?.cover === self { links?.cover = nil }
  }
}

// What a reader's room reads of one roadmap someone else shared (`RoadmapModel.Role.reader`): the roadmap and each roadmap
// above it as the phone's copy holds them, each followed as the read comes to it, the open one with its owner's marks as
// the server read them, which the phone holds none of, or the steps' own seeds where that read failed, as the web's room
// falls back, and each subtree its steps own counted as that read tells it, since the phone follows none of them; and what
// the read came to, which the cover shows. A step the link names opens on the cover once, as the web opens it on a share.
@Observable @MainActor
final class SharedRead {
  // What the cover shows: the roadmap, once the phone's copy holds it and its owner's progress has answered; why it cannot,
  // where the phone with a connection can neither read nor hold it (09.10a, 09.10b) or has no connection and no copy
  // (09.11), or where the phone's copy could not be read (01.5c); and nothing while it reads.
  enum State: String {
    case reading, open, unopenable, needsConnection, failed
  }

  let address: RoadmapAddress
  let sources: RoadmapCover.Sources
  let telemetry: any Telemetry
  private(set) var state = State.reading
  // The owner's progress as the server read it, nil until that read has settled, and whether it failed.
  @ObservationIgnored var owners: OwnersProgress?
  @ObservationIgnored var seeded = false
  @ObservationIgnored var progress: Task<Void, Never>?
  // The scopes the read follows, and one the engine answered gone, which no pull brings back (INV-13).
  @ObservationIgnored var followed: [ScopeRef] = []
  @ObservationIgnored var gone = false
  @ObservationIgnored var told = false
  @ObservationIgnored var stepOpened = false

  init(_ address: RoadmapAddress, sources: RoadmapCover.Sources, telemetry: any Telemetry) {
    self.address = address
    self.sources = sources
    self.telemetry = telemetry
  }

  func askProgress(for room: RoadmapModel) {
    progress?.cancel()
    (owners, seeded) = (nil, false)
    progress = Task { [weak self, weak room, requests = sources.requests, tree = address.tree] in
      let read = try? await requests.progress(of: tree)
      guard let self, !Task.isCancelled else { return }
      (owners, seeded) = (read ?? OwnersProgress(marks: []), read == nil)
      room?.observe()
    }
  }

  func retry(for room: RoadmapModel) {
    if seeded { askProgress(for: room) }
    state = .reading
    followAgain()
  }

  // The roadmap as the phone's copy holds it and each roadmap above it, which its standing reads through; while a view is
  // still loading, what shows stays. A read that throws says the cover could not read the copy.
  func read(into room: RoadmapModel) throws {
    do {
      var trees: [RoadmapTree] = []
      var scopes: Set<ScopeRef> = []
      var next: String? = address.tree
      while let id = next, !trees.contains(where: { $0.id.utf8.elementsEqual(id.utf8) }) {
        let scope = ID<RoadmapEntry>(RecordID(id)).tree
        follow(scope)
        scopes.insert(scope)
        let views = try RoadmapModel.treeTypes.compactMap { try room.snapshot(scope, $0) }
        guard views.count == RoadmapModel.treeTypes.count else { return }
        let held = try RoadmapTree(id: ID(RecordID(id)), listed: nil, tree: views.flatMap(\.records), overlay: nil,
                                   read: views.allSatisfy(\.firstPullComplete))
        let seeds = held.nodes.filter { $0.status == "complete" }.map {
          RoadmapTree.Mark(node: $0.id, status: "complete", outOfOrder: false, recordedAt: nil, deviceAt: nil)
        }
        trees.append(trees.isEmpty ? RoadmapTree(held, marks: seeded ? seeds : owners?.marks ?? []) : held)
        next = held.parent?.tree
      }
      room.views = room.views.filter { scopes.contains($0.key.scope) }
      room.account = RoadmapAccount(trees, told: owners?.subtrees ?? [])
      let standing = room.account.listing(address.tree)
      if let listed = standing, owners != nil, let open = RoadmapModel.OpenRoadmap(listed, in: room.account, owned: false) {
        room.present(open, in: .graph)
        settle(.open)
        guard !stepOpened, let step = address.step, open.step(step) != nil else { return }
        stepOpened = true
        room.path = [.step(step, by: .link)]
        return
      }
      if standing == nil && !sources.online() { return settle(.needsConnection) }
      if standing == nil && (gone || trees.first?.read == .loaded) { return settle(.unopenable) }
      state = .reading
    } catch {
      settle(.failed)
      throw error
    }
  }

  // The read came to something the cover shows, told the first time: the roadmap with the owner's progress or with the
  // steps' seeds, missing, offline, or a copy that could not be read.
  func settle(_ state: State) {
    self.state = state
    guard !told, state != .reading else { return }
    told = true
    let read = switch state {
    case .open: seeded ? "seeds" : "loaded"
    case .needsConnection: "offline"
    case .failed: "failed"
    default: "missing"
    }
    telemetry.event("roadmap_cover", properties: ["step": "open", "read": read])
  }

  // A scope followed while the cover stands; one the engine answers gone the person may not read. A subscription that fails
  // for any other reason is reported, and the read goes on with what the phone holds.
  func follow(_ scope: ScopeRef) {
    guard !followed.contains(scope) else { return }
    followed.append(scope)
    subscribe(scope)
  }

  // Each scope followed asked for again: after a sign-in, which reads another replica, or a Try Again.
  func followAgain() {
    for scope in followed { subscribe(scope) }
  }

  func subscribe(_ scope: ScopeRef) {
    do {
      if try sources.follow(scope) == .gone { gone = true }
    } catch {
      telemetry.failure("roadmap_subscribe", kind: "unexpected")
    }
  }

  // The cover went: what the read followed is let go, and a progress read under way stops.
  func letGo() {
    progress?.cancel()
    for scope in followed {
      do { try sources.letGo(scope) } catch { telemetry.failure("roadmap_subscribe", kind: "unexpected", properties: ["step": "close"]) }
    }
  }
}

extension RoadmapTree {
  // A roadmap someone else owns as its reader sees it: its records as the phone's copy holds them, with its owner's marks,
  // which the server reads and the phone holds none of.
  init(_ held: RoadmapTree, marks: [Mark]) {
    self.init(id: held.id, present: held.present, read: held.read, own: held.own, updatedAt: held.updatedAt, parent: held.parent,
              meta: held.meta, nodes: held.nodes, edges: held.edges, kinds: held.kinds, marks: marks, pointers: held.pointers)
  }
}
