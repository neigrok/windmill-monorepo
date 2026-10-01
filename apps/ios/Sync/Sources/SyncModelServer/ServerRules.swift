import SyncCore

// The product plug-in port, mirroring the server's `SyncType` and command ports (§2.3, §6.4): a product's replay rules,
// command handlers, checks on joined records and revision retention reach admission only through it. A product's
// rules here are a test double pinned by its product's corpus.

public protocol ServerRules: Sendable {
  func elsewhere(_ key: RecordKey, product: JSON.Object) -> Bool
  // §6.1 step 7: a command's replay, read from the locked rows and its stored arguments; a replay skips the guards.
  func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool

  // §6.4: the handler, deterministic given the locked rows, the arguments and `serverNow`.
  func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome

  // §6.1 step 10: the product's rules on the joined records; the deltas it appends pass steps 5, 6 and 9.
  func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta]

  // G6 and Appendix A: the superseded text heads a scope keeps once an admission has stored new ones.
  func keptRevisions(_ revisions: [Revision]) -> [Revision]
}

// A product with no rules of its own conforms with an empty body: no command replays, every command is invalid, a check
// appends nothing, and every superseded text head is kept.
extension ServerRules {
  public func elsewhere(_ key: RecordKey, product: JSON.Object) -> Bool { false }
  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool { false }

  public func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    throw Refusal(.invalid)
  }

  public func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] { [] }

  public func keptRevisions(_ revisions: [Revision]) -> [Revision] { revisions }
}

// What a handler or check may read: the locked rows of the intent's scope with this intent's joins over them, other
// scopes as their principal may read them, and the product's own server state.
public struct RuleContext: Sendable {
  public let registry: Registry
  public let scope: ScopeKey
  public let origin: IntentOrigin
  public let deltas: [PlannedDelta]
  public let guards: [Guard]
  public let serverNow: Int64
  // The product state this admission commits only after every check passes.
  public var product: JSON.Object
  let rules: any ServerRules
  let state: ServerState
  let joined: [RecordKey: Row]

  public var account: String { origin.account }

  // §4.2 the id state as admission locked it, before this intent.
  public func idState(of key: RecordKey) -> IdState {
    let stored = state.idState(of: key, in: scope, registry: registry)
    if case .none = stored, rules.elsewhere(key, product: product) { return .foreign }
    return stored
  }

  public func storedRecords(ofType type: String) -> [Row] {
    (state.rows[scope] ?? [:]).filter { $0.key.type == type }.sorted { $0.key < $1.key }.map(\.value)
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
