import Foundation
import Observation
import RoadmapDomain

// A roadmap's address on the site that the system handed the app (Roadmap on iOS §4, R-4): the roadmap and step it names,
// none where it names no roadmap, and which of the two claimed forms it came in, the share's `/t/<id>` or the app's
// `/#/app/<id>`, which its event tells.
struct ClaimedLink: Equatable {
  enum Form: String {
    case share, app
  }

  let address: RoadmapAddress?
  let form: Form

  init(_ url: URL) {
    let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let (path, fragment) = (parts?.percentEncodedPath ?? "", parts?.percentEncodedFragment)
    address = RoadmapAddress(path: path, fragment: fragment)
    form = path.hasPrefix("/t/") && fragment?.hasPrefix("/") != true ? .share : .app
  }
}

// What a roadmap's link does to the person's own room (Roadmap on iOS §4), the owner's collaborator
// (`RoadmapModel.Role.owner`). A link is followed once the room has read the phone's copy and the person's list has
// arrived, or no connection can bring it, so the list can say whose the roadmap is. Their own roadmap opens in the room, on
// its Board or with the page of the step the address names, and a subtree of theirs on the roadmap it stands in; anyone
// else's raises a cover, closing the one that stands, which stays where it shows that same roadmap; and an address that
// names no roadmap opens All Roadmaps. A fork's copy opens with its band once the room's list holds it, and closes the
// cover that forked it.
@Observable @MainActor
final class RoadmapLinks {
  let sources: RoadmapCover.Sources
  // The cover a shared roadmap's link raised over the room, while it stands.
  var cover: RoadmapCover?
  // The link waiting to be followed, and whether it is told: one a cover follows again after a sign-in was told already.
  @ObservationIgnored var pending: (link: ClaimedLink, tells: Bool)?
  // The copy a fork made, which the room opens with the band once its list holds it; let go once another roadmap opens.
  @ObservationIgnored var forkArriving: String?

  init(sources: RoadmapCover.Sources) {
    self.sources = sources
  }

  func follow(_ link: ClaimedLink, in room: RoadmapModel, tells: Bool = true) {
    pending = (link, tells)
    followPending(in: room)
  }

  func followPending(in room: RoadmapModel) {
    guard let (link, tells) = pending else { return }
    if case .unread = room.phase { return }
    let list = try? room.snapshot(RoadmapEntry.scope, RoadmapEntry.type)
    guard list?.firstPullComplete == true || !sources.online() else { return }
    pending = nil
    let target = link.address.map { $0.step == nil ? "roadmap" : "step" } ?? "none"
    guard let address = link.address else {
      if tells { room.telemetry.event("roadmap_link_opened", properties: ["address": link.form.rawValue, "target": target]) }
      cover?.close(.replaced)
      room.path = [.roadmaps]
      return
    }
    let root = room.ownRoot(of: address.tree)
    if tells {
      room.telemetry.event("roadmap_link_opened", properties: ["address": link.form.rawValue, "target": target, "mine": root == nil ? "false" : "true"])
    }
    guard let root else {
      if let cover, cover.address.tree.utf8.elementsEqual(address.tree.utf8) { return cover.followedAgain() }
      cover?.close(.replaced)
      let raised = RoadmapCover(link, over: room, links: self)
      cover = raised
      raised.open()
      return
    }
    cover?.close(.replaced)
    room.path = []
    room.arriving = nil
    room.phone.set(root, forKey: RoadmapModel.lastOpen)
    room.observe()
    if let step = address.step, root.utf8.elementsEqual(address.tree.utf8), room.shown?.step(step) != nil { room.path = [.step(step, by: .link)] }
  }

  // A fork's copy, answered by the server: the room opens it once its list holds it.
  func forked(_ copy: String, in room: RoadmapModel) {
    forkArriving = copy
    room.arriving = copy
    room.observe()
  }

  // The room opened a roadmap: where it is the copy a fork made, the cover that forked it closes, and the band says so.
  func arrived(_ opened: String) -> Bool {
    guard let copy = forkArriving, copy.utf8.elementsEqual(opened.utf8) else { return false }
    forkArriving = nil
    cover?.close(.forked)
    return true
  }
}
