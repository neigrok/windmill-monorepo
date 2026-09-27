import SyncCore

// The engine as a product sees it: the `Replica` port, and the readers valid inside one of its calls.

// A scope's views, read inside the call that passed the reader; using it after that call returns throws.
public protocol ScopeReader {
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
}

// The reader of a read-and-commit body (§7.1), inside the commit's own transaction.
public protocol CommitContext: ScopeReader {
  // physNow() for this commit; the same value fills a create's unset time fields.
  var now: Int64 { get }
  // A CSPRNG id by the type's registry `mint`, never one taken in the views.
  func mintID(_ type: String) -> RecordID
}

public protocol Replica: Sendable {
  // §7.1 read-and-commit: the body decides a gesture from the views, or nil to write nothing and tick no clock.
  func commit<T>(_ scope: ScopeRef, _ body: (any CommitContext) throws -> (Gesture?, T)) throws -> (outcome: CommitOutcome?, value: T)
  // §7.3: true iff every entry of the gesture was still held, and so removed.
  func undo(_ gestureId: String) throws -> Bool
  func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T
  func mintID(_ type: String) -> RecordID
  // §10.2: the device wall clock plus the active replica's server offset.
  func physNow() throws -> Int64
}

extension Replica {
  public func commit(_ scope: ScopeRef, _ gesture: Gesture) throws -> CommitOutcome {
    let (outcome, _) = try commit(scope) { _ in (gesture, ()) }
    guard let outcome else { preconditionFailure("a commit of a gesture always has an outcome") }
    return outcome
  }
}
