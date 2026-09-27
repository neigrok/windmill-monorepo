import SyncCore

// The product plug-in port, mirroring the server's `SyncType` and command ports (§2.3, §6.4): a product's replay rules,
// command handlers, checks on joined records and revision retention reach admission only through it. A product's
// rules here are a test double its own team writes; only the generic core is held to the server corpus.

public protocol ServerRules: Sendable {
  // §6.1 step 7: a command's replay, read from the locked rows and its stored arguments; a replay skips the guards.
  func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool

  // §6.4: the handler, deterministic given the locked rows, the arguments and `serverNow`.
  func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome

  // §6.1 step 10: the product's rules on the joined records; the deltas it appends pass steps 5, 6 and 9.
  func check(_ changes: [RecordChange], in context: RuleContext) throws(Refusal) -> [PlannedDelta]

  // G6 and Appendix A: the superseded text heads a scope keeps once an admission has stored new ones.
  func keptRevisions(_ revisions: [Revision]) -> [Revision]
}

// What a handler or check may read: the locked rows of the intent's scope with this intent's joins over them, other
// scopes as their principal may read them, and the product's own server state.
public struct RuleContext: Sendable {
  public let registry: Registry
  public let scope: ScopeKey
  public let origin: IntentOrigin
  public let serverNow: Int64
  let state: ServerState
  let joined: [RecordKey: Row]

  public var account: String { origin.account }

  // The product's own server state (receipts and the like), as this admission has it so far.
  public var product: JSON.Object { state.product }

  // §4.2 the id state as admission locked it, before this intent.
  public func idState(of key: RecordKey) -> IdState {
    state.idState(of: key, in: scope, registry: registry)
  }

  // A record's typed row as this intent has joined it so far: alive, or a kept dead row.
  public func record(_ key: RecordKey) -> Row? {
    joined[key] ?? state.rows[scope]?[key]
  }

  // Every typed row of a type in the intent's scope, as this intent has joined them so far, in record order.
  public func records(ofType type: String) -> [Row] {
    var byKey = (state.rows[scope] ?? [:]).filter { $0.key.type.utf8.elementsEqual(type.utf8) }
    for (key, row) in joined where key.type.utf8.elementsEqual(type.utf8) { byKey[key] = row }
    return byKey.sorted { $0.key < $1.key }.map(\.value)
  }

  // A tree is readable while it is alive and its owner is the caller or it is open (D-4, INV-7(e)).
  public func canRead(tree: String) -> Bool {
    switch state.access(ScopeKey(.tree(tree)), as: account, registry: registry) {
    case .readable, .writable: true
    case .notFound, .gone, .absent: false
    }
  }

  // A readable tree's typed rows, in record order.
  public func rows(ofTree tree: String) -> [Row] {
    guard canRead(tree: tree) else { return [] }
    return (state.rows[ScopeKey(.tree(tree))] ?? [:]).sorted { $0.key < $1.key }.map(\.value)
  }
}

// Where a delta of an admission comes from: the intent's own deltas, its command's handler (§6.1 step 8), or the
// product's check (step 10).
public enum ChangeSource: String, Sendable, Hashable {
  case intent, command, check
}

// One record an intent touches, in its scope or in one a command of it writes into: its state as locked, its joined row,
// and the source of each delta that creates it, in join order.
public struct RecordChange: Sendable, Hashable {
  public let scope: ScopeKey
  public let key: RecordKey
  public let before: IdState
  public let after: Row
  public let createdBy: [ChangeSource]

  public var diesHere: Bool { before.isAlive && !after.isAlive }
}

// A handler's answer (§6.4, D-20): server deltas for the intent's scope, the write map it claims, the writes into
// scopes this intent creates (§6.1 step 14), and the product's server state after it.
public struct CommandOutcome: Sendable, Hashable {
  public var deltas: [PlannedDelta]
  public var write: [WriteClaim]
  public var detail: JSON?
  public var product: JSON.Object
  public var created: [ScopeKey: [PlannedDelta]]

  public init(deltas: [PlannedDelta] = [], write: [WriteClaim] = [], detail: JSON? = nil, product: JSON.Object,
              created: [ScopeKey: [PlannedDelta]] = [:]) {
    self.deltas = deltas
    self.write = write
    self.detail = detail
    self.product = product
    self.created = created
  }
}

// One write-map entry before its stamps exist: a born minted by this admission or as stored, and the fields the
// command wrote, which carry the first pass's stamp (§6.1 step 9). A minted born is reported as the record holds it
// once joined (D-20: the record's born), which a same-intent client create can make the smaller.
public struct WriteClaim: Sendable, Hashable {
  public enum Born: Sendable, Hashable {
    case minted
    case stored(Stamp)
  }

  public let key: RecordKey
  public let from: RecordID?
  public let born: Born?
  public let fields: [String]

  public init(key: RecordKey, from: RecordID? = nil, born: Born? = nil, fields: [String] = []) {
    self.key = key
    self.from = from
    self.born = born
    self.fields = fields
  }

  func json(minted: Stamp?, born joined: Stamp?) -> JSON {
    var object: JSON.Object = ["t": .string(key.type), "id": key.id.json]
    object["from"] = from?.json
    switch born {
    case .minted?: object["born"] = (joined ?? minted)?.json
    case .stored(let stamp)?: object["born"] = stamp.json
    case nil: break
    }
    if !fields.isEmpty, let minted {
      object["f"] = .object(JSON.Object(uniqueKeysWithValues: fields.map { ($0, minted.json) }))
    }
    return .object(object)
  }
}
