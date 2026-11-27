import Foundation
import Observation
import SyncEngine

// Fork (Roadmap on iOS §3; Roadmap · iOS 07.7, 09.7, 09.9a, 09.9b, 09.12a): the server copies a root someone shared, every
// step with its progress cleared, into the person's own list, where the copy arrives by sync. It needs a connection and a
// session the phone can send as, and asks for a sign-in otherwise: signed out, or under a session the server no longer
// takes. A reader's cover, the attach list's Fork Roadmap and a row of the public gallery each hold one for the roadmap
// they offer. Its events name where it was asked by the web's words, `instant` on a roadmap's own screen and `browse` in
// the gallery; its failed request's report names the door itself. One request a fork: asked again after an answer that
// was lost, the server answers the same copy.
@Observable @MainActor
final class RoadmapFork {
  // At rest; asked of the server and waiting for its copy, which whoever holds the fork ends; tapped with no connection; or
  // come to nothing.
  enum State: Equatable {
    case idle, running, offline, failed
  }

  // Where the fork was asked: a reader's cover, the attach list, or a row of the gallery.
  enum Mode: String {
    case cover, attach, browse

    // The web's word for it in the fork's events.
    var told: String { self == .browse ? "browse" : "instant" }
  }

  // What a run came to: the copy the server made, a sign-in it needs under the session it last ran with, none signed out,
  // or nothing.
  enum Outcome: Equatable {
    case copy(String)
    case signIn(SessionToken?)
    case nothing
  }

  let tree: String
  let mode: Mode
  let sources: RoadmapCover.Sources
  let telemetry: any Telemetry
  private(set) var state = State.idle
  @ObservationIgnored let request = UUID().uuidString.lowercased()

  init(_ tree: String, mode: Mode, sources: RoadmapCover.Sources, telemetry: any Telemetry) {
    self.tree = tree
    self.mode = mode
    self.sources = sources
    self.telemetry = telemetry
  }

  // One fork asked of the server, told as the web tells it: its attempt, and its claim or why it came to nothing. What it
  // comes to is answered at once where it asks nothing, with no connection or no session, and once the server answers
  // otherwise. A copy answered leaves the fork running until its holder sees the copy arrive.
  func run(then answered: @escaping @MainActor (Outcome) -> Void) {
    guard state != .running else { return }
    telemetry.event("fork_attempt", properties: ["mode": mode.told])
    guard sources.online() else {
      state = .offline
      telemetry.event("fork_attempt", properties: ["mode": mode.told, "outcome": "offline"])
      return answered(.nothing)
    }
    guard let credential = sources.credential() else {
      state = .idle
      telemetry.event("fork_attempt", properties: ["mode": mode.told, "outcome": "signed_out"])
      return answered(.signIn(nil))
    }
    state = .running
    Task { [requests = sources.requests, tree, request, mode] in
      do throws(SharingFailure) {
        let copy = try await requests.fork(tree, request: request, from: mode)
        telemetry.event("fork_claim", properties: ["mode": mode.told])
        answered(.copy(copy))
      } catch {
        // A request that found no connection says so, as a fork tapped with none does.
        state = switch error {
        case .signedOut: .idle
        case .offline: .offline
        default: .failed
        }
        let outcome = switch error {
        case .offline: "offline"
        case .signedOut: "unauthenticated"
        case .refused: "refused"
        case .busy: "busy"
        case .failed, .cancelled: "failed"
        }
        telemetry.event("fork_attempt", properties: ["mode": mode.told, "outcome": outcome])
        answered(error == .signedOut ? .signIn(credential) : .nothing)
      }
    }
  }

  // The copy arrived, or was waited for long enough: the fork is at rest again.
  func settle() {
    if state == .running { state = .idle }
  }
}
