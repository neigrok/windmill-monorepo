import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncCore

// What the room tells of the person's own changes that met another device's, and keeps of what could not land (Roadmap on
// the sync engine §6; Roadmap · iOS 10.2 to 10.5c), kept by the root's room. A line is a step they made or linked that now
// follows something else, through a step deleted elsewhere before their change landed, or a step their change brought
// back: the domain's `LandingRead` of the roadmap a room shows, in the boards' words. The band offers it, and it is told
// once the band is drawn on screen (`seen`), whose Show opens the step's page, or once that page's footer shows it,
// whichever the person meets first. A line told stays under its step's status row while its roadmap stands on the stack,
// and the phone clears it from its note, out of the Undo stack, so a later visit is quiet. A line no board words, of a
// step that follows nothing past the deleted one or of a link from a step whose name the note never kept, stays in the
// note untold. Set Aside's list, its sheet and its question stand here too (`SetAside.swift`).
extension RoadmapModel {
  @Observable @MainActor
  final class Landed {
    // The lines of the roadmaps on the stack: those told, which their steps' pages go on saying, and those read and
    // waiting to be told.
    var told: [Line] = []
    var waiting: [Line] = []
    // The one list of the changes that could not land, as roadmap's notices last read, its sheet standing open, and
    // Discard All's question standing on its row.
    var setAside = SetAside()
    var listOpen = false
    var asksDiscardAll = false
    // Every roadmap read since the account last changed, as last read: what names a change set aside in a roadmap since
    // deleted elsewhere, of which the phone keeps nothing.
    @ObservationIgnored var remembered: [String: RoadmapTree] = [:]

    struct Line: Identifiable, Equatable {
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

      static func == (a: Line, b: Line) -> Bool { a.id == b.id }

      // The lines the phone's note says of the roadmap a room shows, those the boards word: its follows, then the steps
      // brought back. A step brought back that the phone knew only by its spent id holds no more than the change wrote until
      // the server's revival arrives with the rest, so its line waits for the step's name.
      static func lines(_ read: LandingRead, of open: OpenRoadmap) -> [Line] {
        let follows = read.follows.compactMap { (line: LandingRead.Line) -> Line? in
          let (removed, followed) = (line.removed.compactMap(\.name), line.followed.compactMap(\.name))
          guard let step = open.tree.step(line.node.description), step.present, !followed.isEmpty, removed.count == line.removed.count,
                followed.count == line.followed.count else { return nil }
          let made = read.note.nodes.contains(line.node)
          return Line(id: "follows:\(open.listed.id):\(step.id):" + line.incoming.map(\.from.description).joined(separator: ","),
                      rule: .follows, tree: open.id, step: step.id, name: step.label, removed: removed, followed: followed,
                      made: made ? step.createdAt : nil,
                      clears: ClearLanding(tree: open.id, nodes: made ? [line.node] : [], edges: line.incoming))
        }
        let back = read.cameBack.compactMap { (brought: DomainKit.ID<RoadmapStep>) -> Line? in
          guard let step = open.tree.step(brought.description), !step.label.isEmpty else { return nil }
          return Line(id: "cameBack:\(open.listed.id):\(step.id)", rule: .cameBack, tree: open.id, step: step.id, name: step.label,
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

    // The lines of these roadmaps alone, as the web's room keeps its own roadmap's: a roadmap left keeps no footer, and its
    // lines not told yet are read from the phone's note again once it is back on the stack.
    func keep(_ trees: Set<DomainKit.ID<RoadmapEntry>>) {
      told.removeAll { !trees.contains($0.tree) }
      waiting.removeAll { !trees.contains($0.tree) }
    }

    // The account changed: nothing of the one before stays in memory.
    func forget() {
      (told, waiting, setAside, listOpen, asksDiscardAll, remembered) = ([], [], SetAside(), false, false, [:])
    }
  }

  // The lines of the roadmap one room shows, read after each read of the phone's copy: those not heard this visit join the
  // root's room's waiting ones, and the band is offered the next. A read that fails tells nothing, and reports once a
  // launch; the room reads on.
  func hearLanding(of open: OpenRoadmap) {
    guard owns else { return }
    let root = root
    defer { root.offerLanding() }
    do {
      let read = try runner.read(open.id.tree) { (scope: Reader) throws -> LandingRead in try LandingRead(of: open.id, in: scope) }
      root.landed.waiting += Landed.Line.lines(read, of: open).filter { !root.landed.told.contains($0) && !root.landed.waiting.contains($0) }
    } catch {
      let kind = error is DecodeError ? "decode" : "unexpected"
      guard root.reportedFailures.insert("landing-\(kind)").inserted else { return }
      telemetry.failure("roadmap_landing", kind: kind)
    }
  }

  // The one place the band is offered a line: whenever it frees, a line is heard, the room comes before the person or the
  // stack changes. A landing band of a roadmap no longer on top leaves, so its Show always finds its step; then, while the
  // room faces the person and no band stands, the next line waiting of the roadmap on top stands in the band, told only
  // once the band is drawn (`seen`).
  func offerLanding() {
    guard root === self else { return root.offerLanding() }
    let shown = deepest.shown
    if case .landed(let line)? = stackBand?.says, line.tree != shown?.id { return endBand() }
    guard faces, stackBand == nil, let shown, let next = landed.waiting.first(where: { $0.tree == shown.id }) else { return }
    show(Band(landed: next))
  }

  // The band of a line was drawn on screen: the line is told, and its time starts. Answers whether this telling was the
  // first, so the screen announces it once.
  @discardableResult
  func seen(_ line: Landed.Line) -> Bool {
    guard root === self else { return root.seen(line) }
    guard case .landed(let standing)? = stackBand?.says, standing == line, landed.waiting.contains(line) else { return false }
    tell(line, at: "band")
    if let band = stackBand { time(band) }
    return true
  }

  // A line said, by its band or on its step's page: it stands while its roadmap does, and the phone clears it from its note,
  // keeping no Undo of that. A band still offering the line a page told leaves.
  func tell(_ line: Landed.Line, at place: String) {
    guard root === self else { return root.tell(line, at: place) }
    landed.waiting.removeAll { $0 == line }
    landed.told.append(line)
    telemetry.event("roadmap_landing", properties: ["rule": line.rule.rawValue, "place": place])
    if let written = write(line.clears, as: "clearLanding").committed { forget(written.receipt.gestureId) }
    if case .landed(let standing)? = stackBand?.says, standing == line, place != "band" { endBand() }
  }

  // The band's Show: the line's step's page, pushed on the room on top of the stack, which shows the step.
  func showLanded(_ line: Landed.Line) {
    guard root === self else { return root.showLanded(line) }
    endBand()
    let room = deepest
    guard room.shown?.id == line.tree, room.shown?.step(line.step) != nil else { return }
    if case .step(let open, _)? = room.path.last, open.utf8.elementsEqual(line.step.utf8) { return }
    room.path.append(.step(line.step, by: .band))
  }

  // The lines a step's page says under its status row: those told while its roadmap stands, and those waiting, which the
  // page then tells.
  func lines(on step: String) -> [Landed.Line] {
    guard let shown else { return [] }
    return (root.landed.told + root.landed.waiting).filter { $0.tree == shown.id && $0.step.utf8.elementsEqual(step.utf8) }
  }

  // A step's page showed its lines: each still waiting is told there.
  func pageShows(_ lines: [Landed.Line]) {
    for line in lines where root.landed.waiting.contains(line) { tell(line, at: "step") }
  }
}
