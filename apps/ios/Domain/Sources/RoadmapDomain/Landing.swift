import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// §6 What a device tells a person once, read in a roadmap's tree scope from its note and the roadmap as it now stands:
// each of its own new steps and links that follows through a step whose delete the server took before the link, with the
// steps removed and the steps it now follows, each by name; and each step its change brought back. A link whose write has
// not landed tells nothing yet.
public struct LandingRead: Sendable {
  // A step as a line names it: one the device still holds by its label as it stands; one deleted elsewhere, of which it
  // keeps nothing (engine §7.5), by the name its note took when it made the link, and by none where the note holds none.
  public struct Named: Sendable {
    public let id: ID<RoadmapStep>
    public let name: String?
  }

  // One step that follows something else than the person linked: its links that bridge an absence, the absent steps they
  // come from, and the steps it follows through them.
  public struct Line: Sendable {
    public let node: ID<RoadmapStep>
    public let incoming: [RoadmapLink]
    public let removed: [Named]
    public let followed: [(step: Followed, name: String?)]
  }

  public let follows: [Line]
  // The steps the device's changes brought back that are present now.
  public let cameBack: [ID<RoadmapStep>]
  public let note: LandingNote

  // A device with no note tells nothing, so its roadmap's steps go unread: a room reads this after every change.
  public init(of tree: ID<RoadmapEntry>, in read: Reader) throws {
    let note = try LandingNote(of: tree, in: read)
    guard !note.isEmpty else {
      (follows, cameBack, self.note) = ([], [], note)
      return
    }
    let steps = try DrawnSteps(of: tree, in: read)
    let roadmap = steps.roadmap
    let name = { (step: String) -> String? in roadmap.step(step)?.label ?? note.name(of: ID(RecordID(step))) }
    let said = try note.saying(by: LandingOrder(read, over: steps)).map { (link: RoadmapLink) -> RoadmapTree.Edge in
      RoadmapTree.Edge(from: link.from.description, to: link.to.description, present: true)
    }
    follows = FollowGraph(roadmap).landingFacts(own: said).map { (fact: LandingFact) -> Line in
      Line(node: ID(RecordID(fact.node)), incoming: fact.incoming.map(\.link),
           removed: fact.incoming.map { (edge: RoadmapTree.Edge) -> Named in Named(id: edge.link.from, name: name(edge.from)) },
           followed: fact.followed.map { (step: Followed) -> (step: Followed, name: String?) in (step, name(step.id)) })
    }
    cameBack = note.revived.filter { roadmap.step($0.description)?.present == true }
    self.note = note
  }
}

// §6 Once told, the device clears what it told from its note, and with it each entry that has landed and can say nothing
// more. The note of a roadmap gone from the person's list, deleted there or no longer in it once the device has read the
// list, goes whole: nothing of it is told again. The note is the device's, not the roadmap's, so the act writes it through
// the account's scope, which a roadmap's end leaves writable.
public struct ClearLanding: ActAction {
  public let tree: ID<RoadmapEntry>
  // What the person was told: the device's steps and links, and the steps its changes brought back.
  public let nodes: [ID<RoadmapStep>]
  public let edges: [RoadmapLink]
  public let revived: [ID<RoadmapStep>]

  public init(tree: ID<RoadmapEntry>, nodes: [ID<RoadmapStep>] = [], edges: [RoadmapLink] = [], revived: [ID<RoadmapStep>] = []) {
    self.tree = tree
    self.nodes = nodes
    self.edges = edges
    self.revived = revived
  }

  // The note the device holds, and the note as a write of it takes it, nil where the roadmap is gone from the person's list.
  public func load(_ read: ActReader) throws -> (held: LandingNote, settled: LandingNote?) {
    let listed = try read.inScope(RoadmapEntry.scope) { (account: Reader) throws -> (held: LandingNote, gone: Bool) in
      (try LandingNote(of: tree, in: account),
       try account.firstPullComplete() && account.repository(RoadmapEntry.self).record(tree, in: .drawn)?.life?.isAlive != true)
    }
    guard !listed.gone else { return (listed.held, nil) }
    return (listed.held, try read.inScope(tree.tree) { (scope: Reader) throws -> LandingNote in
      try LandingNote(settledOver: DrawnSteps(of: tree, in: scope), in: scope)
    })
  }

  public func decide(_ loaded: (held: LandingNote, settled: LandingNote?), ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    let left = loaded.settled?.clearing(nodes: nodes, edges: edges, revived: revived) ?? LandingNote()
    guard left.json != loaded.held.json else { return .unchanged(()) }
    var plan = Plan()
    plan.note(left, of: tree)
    return .write(plan, in: RoadmapEntry.scope, ())
  }
}

// §6 The one list of what cannot land, from the engine's notices of roadmap: each with its reason, whether it made its
// subject or changed one that stood, and what the person wrote, to copy or discard. Every other notice is no refusal a
// person is shown; `unexpected` names it for the failure report.
public struct CannotLand: Sendable {
  public enum Reason: String, Sendable {
    case roadmapDeleted, capFilled, accessEnded, noteTooLong
  }

  public struct Entry: Sendable {
    public let id: String
    public let gestureId: String
    public let reason: Reason
    // The refused content creates its subject, its life made alive at its own birth, in its own writes or a dependent's.
    public let made: Bool
    public let subject: RecordRef?
    // What the refused content wrote to its subject.
    public let values: [String: JSON]
  }

  public let listed: [Entry]
  public let unexpected: [(id: String, code: RefusalCode)]

  public init(_ notices: [DomainNotice<RoadmapRefusal>]) {
    var listed: [Entry] = []
    var unexpected: [(id: String, code: RefusalCode)] = []
    for notice in notices {
      let reason: Reason
      switch notice.refusal {
      case .roadmapGone: reason = .roadmapDeleted
      case .full: reason = .capFilled
      case .unreachable: reason = .accessEnded
      case .tooLarge(let subject, _) where subject.type.utf8.elementsEqual(StepNote.type.utf8): reason = .noteTooLong
      default:
        unexpected.append((notice.id, notice.notice.code))
        continue
      }
      listed.append(Entry(id: notice.id, gestureId: notice.gestureId, reason: reason,
                          made: notice.subject.map { Self.creates($0.key, in: notice.notice.content) } ?? false,
                          subject: notice.subject, values: notice.subject.map(notice.values(of:)) ?? [:]))
    }
    self.listed = listed
    self.unexpected = unexpected
  }

  static func creates(_ record: RecordKey, in content: NoticeContent) -> Bool {
    content.deltas.contains { $0.key == record && $0.creates } || content.dependents.contains { creates(record, in: $0) }
  }
}
