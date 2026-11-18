import SyncCore

// The engine as a product sees it: the `Replica` port, and the readers valid inside one of its calls.

// A scope's views, read inside the call that passed the reader; using it after that call returns throws.
public protocol ScopeReader {
  var isAnonymous: Bool { get }
  // The folded record, visible or not; nil only when no confirmed row, delta or prediction names it.
  func drawn(_ type: String, _ id: RecordID) throws -> Record?
  func stored(_ type: String, _ id: RecordID) throws -> Record?
  // The visible records of a type.
  func drawn(_ type: String) throws -> [Record]
  func stored(_ type: String) throws -> [Record]
  // The visible records of a type whose top-level ref `field` names `id`, in id-byte order; any other field throws.
  func drawn(_ type: String, where field: String, is id: RecordID) throws -> [Record]
  func stored(_ type: String, where field: String, is id: RecordID) throws -> [Record]
  // A row of `device/<product>` of the scope's product.
  func device(_ key: String) throws -> JSON?
  // §7.9: the scope's first pull is complete, or the replica does not pull it.
  func firstPullComplete() throws -> Bool
  func freshness() throws -> SyncFreshness
  func confirmed(_ type: String, _ id: RecordID) throws -> Record?
  func checkpoint() throws -> ScopeCheckpoint
  func devices(prefix: String) throws -> JSON.Object
}

// The reader of a read-and-commit body (§7.1), inside the commit's own transaction.
public protocol CommitContext: ScopeReader {
  // physNow() for this commit; the same value fills a create's unset time fields.
  var now: Int64 { get }
  // The id of the replica the commit writes to, the active one (§7.12), which a record that names its writer carries.
  var replica: String { get }
  var actor: String { get }
  func commands() throws -> [QueuedCommand]
  func opaqueID() throws -> String
  // A CSPRNG id by the type's registry `mint`, never one taken in the views. A type that mints none, or a mint after the
  // call that passed the context returned, throws malformed.
  func mintID(_ type: String) throws -> RecordID
}

public protocol ActContext {
  var now: Int64 { get }
  var replica: String { get }
  var actor: String { get }
  var isAnonymous: Bool { get }
  func finishLoad() throws
  func inScope<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T
  func mintID(_ type: String, in scope: ScopeRef) throws -> RecordID
  func opaqueID() throws -> String
}

// §7.1 a commit that throws, before its transaction commits, throws this, of one of three kinds told apart by where it
// arises. A `Refused` outcome is a result, never a failure.
public struct CommitFailure: Error, Hashable, Sendable, CustomStringConvertible {
  public enum Kind: String, Hashable, Sendable {
    // Step 1: the replica's state forbids writes.
    case notWritable = "not-writable"
    // A programming error: a check before step 2, a throw of steps 2 to 10, or a misuse of the read-and-commit context.
    case malformed
    // Anything else: the transaction could not commit, and nothing is written.
    case storeFailure = "store-failure"
  }

  public let kind: Kind
  public let description: String

  public init(_ kind: Kind, _ description: String) {
    self.kind = kind
    self.description = description
  }

  public static func malformed(_ description: String) -> CommitFailure {
    CommitFailure(.malformed, description)
  }

  public static func == (lhs: CommitFailure, rhs: CommitFailure) -> Bool {
    lhs.kind == rhs.kind && lhs.description.utf8.elementsEqual(rhs.description.utf8)
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(kind)
    hasher.combine(Array(description.utf8))
  }
}

public protocol Replica: Sendable {
  // §7.1 read-and-commit: the body decides a gesture from the views, or nil to write nothing and tick no clock. Throws a
  // `CommitFailure`, or the body's own error as it threw it.
  func commit<T>(_ scope: ScopeRef, _ body: (any CommitContext) throws -> (Gesture?, T)) throws -> (outcome: CommitOutcome?, value: T)
  func commitAct<T>(_ prepare: (any ActContext) throws -> (ActRequest?, T),
                    segment: (T, Int, any CommitContext) throws -> Gesture) throws -> (outcome: ActCommitOutcome?, value: T)
  // §7.3: the held-only Undo, true iff every entry of the gesture was still held, and so removed.
  func cancelHeld(_ gestureId: String) throws -> Bool
  // §7.3 Undo of an act (K-3): the inverse of a journaled act, `slots` replacing its stored recipes whole by source
  // ordinal; the result as it stands; and the act's release from the product's stack, false when nothing held it.
  func requestInverse(_ actId: String, slots: [ActUndo.Segment]?) throws -> InverseResult
  func readInverseResult(_ requestId: String) throws -> InverseResult
  func releaseReversibleAct(_ actId: String) throws -> Bool
  func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T
  // A CSPRNG id by the type's registry `mint`; a type that mints none throws malformed.
  func mintID(_ type: String) throws -> RecordID
  // §10.2: the device wall clock plus the active replica's server offset.
  func physNow() throws -> Int64
  // D-17: hides a notice of the active replica, as its product does once it has told the person.
  func dismissNotice(_ id: String) throws
}

extension Replica {
  public func commitAct(_ segments: [ScopedGesture], gestureId: String? = nil) throws -> ActCommitOutcome? {
    try commitAct({ _ in
      (ActRequest(scopes: segments.map(\.scope), hold: segments.contains { $0.gesture.hold }, gestureId: gestureId), segments)
    }, segment: { segments, index, _ in segments[index].gesture }).outcome
  }

  public func commit(_ scope: ScopeRef, _ gesture: Gesture) throws -> CommitOutcome {
    let (outcome, _) = try commit(scope) { _ in (gesture, ()) }
    guard let outcome else { preconditionFailure("a commit of a gesture always has an outcome") }
    return outcome
  }
}

public struct ScopeCheckpoint: Sendable {
  public let epoch: String?
  public let cleanSeq: Int64?
  public init(epoch: String? = nil, cleanSeq: Int64? = nil) { self.epoch = epoch; self.cleanSeq = cleanSeq }
}

public struct QueuedCommand: Sendable {
  public let gestureId: String
  public let command: Command
  public let canSupersede: Bool
  public let isAdmitted: Bool
  public init(gestureId: String, command: Command, canSupersede: Bool, isAdmitted: Bool = false) {
    self.gestureId = gestureId; self.command = command; self.canSupersede = canSupersede; self.isAdmitted = isAdmitted
  }
}

public struct SyncFreshness: Sendable, Equatable {
  public let serverNow: Int64?
  public let live: Bool
  public init(serverNow: Int64? = nil, live: Bool = false) { self.serverNow = serverNow; self.live = live }
}

extension ScopeReader {
  public func freshness() throws -> SyncFreshness { SyncFreshness() }
}
