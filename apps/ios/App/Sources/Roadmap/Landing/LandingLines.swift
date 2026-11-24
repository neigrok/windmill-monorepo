import Foundation
import DomainKit
import RoadmapDomain
import SyncCore

// What the room tells once of the person's own changes that met another device's (Roadmap on the sync engine §6; Roadmap
// · iOS 10.2 to 10.4): a step they made or linked that now follows something else, through a step deleted elsewhere before
// their change landed, and a step their change brought back. Each line is the domain's `LandingRead` of the roadmap a room
// shows, in the boards' words, told once by the band, whose Show opens the step's page, or by that page's footer, whichever
// the person meets first. A line told stays under its step's status row for the rest of the visit, and the phone clears
// it from its note, out of the Undo stack, so a later visit is quiet. A line no board words, of a step that follows
// nothing past the deleted one or of a link from a step whose name the note never kept, stays in the note untold.
extension RoadmapModel {
  // The landing lines of one visit, kept by the root's room: those told, which their steps' pages go on saying, and those
  // read and waiting to be told.
  struct Landing {
    var told: [LandingLine] = []
    var waiting: [LandingLine] = []
  }

  struct LandingLine: Identifiable, Equatable {
    enum Rule: String {
      case follows, cameBack
    }

    let id: String
    let rule: Rule
    let tree: DomainKit.ID<RoadmapEntry>
    let step: String
    // The step's name as it stands, the steps deleted elsewhere by the names the note kept, and what it follows now.
    let name: String
    let removed: [String]
    let followed: [String]
    // When this phone made the step: none for a line of a link into a step made before, or of a step brought back.
    let made: Instant?
    // What saying the line clears from the phone's note.
    let clears: ClearLanding

    static func == (a: LandingLine, b: LandingLine) -> Bool { a.id == b.id }

    // The lines the phone's note says of the roadmap a room shows, those the boards word: its follows, then the steps
    // brought back. A step brought back that the phone knew only by its spent id holds no more than the change wrote until
    // the server's revival arrives with the rest, so its line waits for the step's name.
    static func lines(_ read: LandingRead, of open: OpenRoadmap) -> [LandingLine] {
      let follows = read.follows.compactMap { (line: LandingRead.Line) -> LandingLine? in
        let (removed, followed) = (line.removed.compactMap(\.name), line.followed.compactMap(\.name))
        guard let step = open.tree.step(line.node.description), step.present, !followed.isEmpty, removed.count == line.removed.count,
              followed.count == line.followed.count else { return nil }
        let made = read.note.nodes.contains(line.node)
        return LandingLine(id: "follows:\(open.listed.id):\(step.id):" + line.incoming.map(\.from.description).joined(separator: ","),
                           rule: .follows, tree: open.id, step: step.id, name: step.label, removed: removed, followed: followed,
                           made: made ? step.createdAt : nil,
                           clears: ClearLanding(tree: open.id, nodes: made ? [line.node] : [], edges: line.incoming))
      }
      let back = read.cameBack.compactMap { (brought: DomainKit.ID<RoadmapStep>) -> LandingLine? in
        guard let step = open.tree.step(brought.description), !step.label.isEmpty else { return nil }
        return LandingLine(id: "cameBack:\(open.listed.id):\(step.id)", rule: .cameBack, tree: open.id, step: step.id, name: step.label,
                           removed: [], followed: [], made: nil, clears: ClearLanding(tree: open.id, revived: [brought]))
      }
      return follows + back
    }

    // The band's words (10.2, 10.4).
    var band: String {
      let step = Row.name(of: name)
      guard rule == .follows else {
        return String(localized: "\(step) is back · you edited it while it was removed elsewhere",
                      comment: "The band once a step the person changed is back after another device removed it: the step's name")
      }
      return String(localized: "\(step) synced · it now follows \(followed.formatted(.list(type: .and)))",
                    comment: "The band once a step the person made or linked lands after a step it required was deleted elsewhere: the step's name, and the steps it follows now")
    }

    // The footer under the step's status row on its page (10.3): when this phone made it, what was deleted and what it
    // follows now; for a step brought back, the band's own sentence (10.4).
    var footer: String {
      guard rule == .follows else { return band }
      let after = followed.formatted(.list(type: .and))
      let deleted = removed.count == 1
        ? String(localized: "\(removed[0]) was deleted on another device before it synced, so this step now follows \(after).",
                 comment: "A step page's footer: the one step deleted elsewhere that this step was linked from, and the steps it follows now")
        : String(localized: "\(removed.formatted(.list(type: .and))) were deleted on another device before it synced, so this step now follows \(after).",
                 comment: "A step page's footer: the steps deleted elsewhere that this step was linked from, and the steps it follows now")
      guard let made else { return deleted }
      let day = made.date.formatted(.dateTime.day().month(.abbreviated))
      return String(localized: "Made on this phone on \(day). \(deleted)",
                    comment: "A step page's footer: the day this phone made the step, then what was deleted elsewhere and what it follows now")
    }
  }

  // The lines of the roadmap one room shows, read after each read of the phone's copy: those not heard this visit join the
  // root's room's waiting ones, and the next is told where it can be. A read that fails tells nothing, and reports once a
  // launch; the room reads on.
  func hearLanding(of open: OpenRoadmap) {
    guard owns else { return }
    let root = root
    do {
      let read = try runner.read(open.id.tree) { (scope: Reader) throws -> LandingRead in try LandingRead(of: open.id, in: scope) }
      let fresh = LandingLine.lines(read, of: open).filter { !root.landing.told.contains($0) && !root.landing.waiting.contains($0) }
      guard !fresh.isEmpty else { return }
      root.landing.waiting += fresh
      root.tellLanding()
    } catch {
      let kind = error is DecodeError ? "decode" : "unexpected"
      guard root.reportedFailures.insert("landing-\(kind)").inserted else { return }
      telemetry.failure("roadmap_landing", kind: kind)
    }
  }

  // The band tells the next line waiting of the roadmap on top of the stack, while the room faces the person and no band
  // stands, so no receipt loses its Undo to it.
  func tellLanding() {
    guard root === self else { return root.tellLanding() }
    guard faces, stackBand == nil, let shown = deepest.shown, let next = landing.waiting.first(where: { $0.tree == shown.id }) else { return }
    tell(next, at: "band")
    show(Band(landed: next))
  }

  // A line said, by the band or on its step's page: it stands for the rest of the visit, and the phone clears it from its
  // note, keeping no Undo of that.
  func tell(_ line: LandingLine, at place: String) {
    guard root === self else { return root.tell(line, at: place) }
    landing.waiting.removeAll { $0 == line }
    landing.told.append(line)
    telemetry.event("roadmap_landing", properties: ["rule": line.rule.rawValue, "place": place])
    if let written = write(line.clears, as: "clearLanding").committed { forget(written.receipt.gestureId) }
  }

  // The band's Show: the line's step's page, pushed on the room on top of the stack where it still shows the step.
  func showLanded(_ line: LandingLine) {
    guard root === self else { return root.showLanded(line) }
    endBand()
    let room = deepest
    guard room.shown?.id == line.tree, room.shown?.step(line.step) != nil else { return }
    if case .step(let open, _)? = room.path.last, open.utf8.elementsEqual(line.step.utf8) { return }
    room.path.append(.step(line.step, by: .band))
  }

  // The line a step's page says under its status row: one told this visit, or one waiting, which the page then tells.
  func landed(on step: String) -> LandingLine? {
    guard let shown else { return nil }
    let landing = root.landing
    return (landing.told + landing.waiting).last { $0.tree == shown.id && $0.step.utf8.elementsEqual(step.utf8) }
  }

  // A step's page showed a line still waiting: the page told it.
  func pageShows(_ line: LandingLine) {
    guard root.landing.waiting.contains(line) else { return }
    tell(line, at: "step")
  }
}
