import SyncCore

// §2.1 the generic platform tables and the typed rows of every scope, as one value; `json` is the corpus's
// canonical server state, so a copy is a transaction and dropping it is a rollback.

public struct ServerState: Sendable, Hashable {
  public var epoch: String
  public var clock: HLC
  public var accounts: [String: String]
  public var scopes: [ScopeKey: ScopeRecord]
  public var rows: [ScopeKey: [RecordKey: Row]]
  public var spent: [ScopeKey: [RecordKey: SpentRow]]
  public var revisions: [ScopeKey: [Revision]]
  public var replicas: [String: ReplicaBinding]
  public var results: [String: [Int64: StoredResult]]
  public var requests: [RequestKey: RequestRecord]
  public var product: JSON.Object

  public init(epoch: String, clock: HLC = HLC(), accounts: [String: String] = [:]) {
    self.epoch = epoch
    self.clock = clock
    self.accounts = accounts
    scopes = [:]
    rows = [:]
    spent = [:]
    revisions = [:]
    replicas = [:]
    results = [:]
    requests = [:]
    product = JSON.Object()
  }

  public init(json: JSON) throws {
    let root = try json.asObject()
    try root.expectKeys(
      required: ["epoch", "clock"],
      optional: ["accounts", "scopes", "rows", "spent", "revisions", "replicas", "results", "requests", "product"])
    self.init(epoch: try root.member("epoch").asString(), clock: try HLC(json: root.member("clock")))
    accounts = try JSON.map(root["accounts"]) { try $0.member("name").asString() }
    for (text, scope) in try root["scopes"]?.asObject().members ?? [] {
      let key = try ScopeKey(parsing: text)
      scopes[key] = try ScopeRecord(json: scope, key: key)
    }
    for (text, list) in try root["rows"]?.asObject().members ?? [] {
      let rowsOfScope = try list.asArray().map { try Row(json: $0) }
      rows[try ScopeKey(parsing: text)] = Dictionary(uniqueKeysWithValues: rowsOfScope.map { ($0.key, $0) })
    }
    for (text, list) in try root["spent"]?.asObject().members ?? [] {
      let entries = try list.asArray().map { entry in (try SpentRow.key(json: entry), try SpentRow(json: entry)) }
      spent[try ScopeKey(parsing: text)] = Dictionary(uniqueKeysWithValues: entries)
    }
    for (text, list) in try root["revisions"]?.asObject().members ?? [] {
      revisions[try ScopeKey(parsing: text)] = try list.asArray().map { try Revision(json: $0) }.sorted()
    }
    replicas = try JSON.map(root["replicas"]) { try ReplicaBinding(json: $0) }
    results = try JSON.map(root["results"]) { list in
      Dictionary(uniqueKeysWithValues: try list.asArray().map { (try $0.member("n").asInteger(), try StoredResult(json: $0)) })
    }
    for (account, list) in try root["requests"]?.asObject().members ?? [] {
      for entry in try list.asArray() {
        requests[RequestKey(account: account, requestId: try entry.member("requestId").asString())] = try RequestRecord(json: entry)
      }
    }
    product = try root["product"]?.asObject() ?? JSON.Object()
  }

  // Empty parts are left out; every list is in the corpus's order.
  public var json: JSON {
    var root: JSON.Object = ["epoch": .string(epoch), "clock": clock.json]
    root["accounts"] = JSON.object(from: accounts) { ["name": .string($0)] }
    root["scopes"] = Self.byScope(scopes) { key, record in record.json(kind: key.kindName) }
    root["rows"] = Self.byScope(rows) { _, byKey in
      byKey.isEmpty ? nil : .array(byKey.sorted { $0.key < $1.key }.map(\.value.json))
    }
    root["spent"] = Self.byScope(spent) { _, byKey in
      byKey.isEmpty ? nil : .array(byKey.sorted { $0.key < $1.key }.map { $0.value.json(for: $0.key) })
    }
    root["revisions"] = Self.byScope(revisions) { _, list in list.isEmpty ? nil : .array(list.sorted().map(\.json)) }
    root["replicas"] = JSON.object(from: replicas) { $0.json }
    root["results"] = JSON.object(from: results.filter { !$0.value.isEmpty }) { byN in
      .array(byN.sorted { $0.key < $1.key }.map { $0.value.json(n: $0.key) })
    }
    var requestsByAccount = JSON.Object()
    for (key, record) in requests.sorted(by: { $0.key < $1.key }) {
      let listed = (try? requestsByAccount[key.account]?.asArray()) ?? []
      requestsByAccount[key.account] = .array(listed + [record.json(requestId: key.requestId)])
    }
    root["requests"] = requestsByAccount.isEmpty ? nil : .object(requestsByAccount)
    root["product"] = product.isEmpty ? nil : .object(product)
    return .object(root)
  }

  // A part keyed by scope key text; a scope whose value encodes to nil is left out, and so is an empty part.
  static func byScope<Value>(_ map: [ScopeKey: Value], _ encode: (ScopeKey, Value) -> JSON?) -> JSON? {
    let entries = map.compactMap { key, value in encode(key, value).map { (key.text, $0) } }
    return entries.isEmpty ? nil : .object(JSON.Object(uniqueKeysWithValues: entries))
  }
}

// MARK: - Reading the tables

// §4.2 the state of an id in a scope, as admission locks it; a dead row of a spent type reads back thin.
public enum IdState: Sendable, Hashable {
  case none
  case foreign
  case alive(Row)
  case dead(Row)

  public var row: Row? {
    switch self {
    case .alive(let row), .dead(let row): row
    case .none, .foreign: nil
    }
  }

  public var isAlive: Bool {
    if case .alive = self { return true }
    return false
  }
}

// What a principal may do with a scope (D-4), and how an unreadable one answers (§6.1 step 3, §6.7 step 1).
public enum ScopeAccess: Sendable, Hashable {
  case notFound
  case gone
  case absent
  case readable
  case writable
}

extension ServerState {
  public func idState(of key: RecordKey, in scope: ScopeKey, registry: Registry) -> IdState {
    if let row = rows[scope]?[key] { return row.isAlive ? .alive(row) : .dead(row) }
    if let entry = spent[scope]?[key] { return .dead(entry.row(for: key)) }
    guard let type = registry.type(key.type), let id = key.id.string else { return .none }
    if type.governsTree, let governed = scopes[ScopeKey(.tree(id))],
       !ScopeRecord.governor(scope: scope, key: key).isSameID(as: governed.governedBy) {
      return .foreign
    }
    if type.idSpace == .global, scopes.keys.contains(where: { $0 != scope && (rows[$0]?[key] != nil || spent[$0]?[key] != nil) }) {
      return .foreign
    }
    return .none
  }

  public func access(_ scope: ScopeKey, as account: String?, registry: Registry) -> ScopeAccess {
    switch scope.kind {
    case .product(let owner, _):
      guard owner.isSameID(as: account) else { return .notFound }
      return scopes[scope] == nil ? .absent : .writable
    case .tree(let tree):
      guard let record = scopes[scope] else { return .notFound }
      if record.state == .dead { return record.owner.isSameID(as: account) ? .gone : .notFound }
      if record.owner.isSameID(as: account) { return .writable }
      return isOpen(tree: tree, registry: registry) ? .readable : .notFound
    case .overlay(let owner, let tree):
      guard owner.isSameID(as: account) else { return .notFound }
      switch access(ScopeKey(.tree(tree)), as: account, registry: registry) {
      case .notFound, .absent: return .notFound
      case .gone: return .gone
      case .readable, .writable: return scopes[scope] == nil ? .absent : .writable
      }
    }
  }

  public func canRead(_ scope: ScopeKey, as account: String?, registry: Registry) -> Bool {
    switch access(scope, as: account, registry: registry) {
    case .readable, .writable, .absent: true
    case .notFound, .gone: false
    }
  }

  // D-4: a tree is open to every reader while a server-written field of its singleton holds an `opens` value.
  func isOpen(tree: String, registry: Registry) -> Bool {
    let meta = rows[ScopeKey(.tree(tree))] ?? [:]
    for type in registry.types where type.scope == .tree && type.identity == .singleton {
      guard let id = type.singletonId, let row = meta[RecordKey(type.name, RecordID(id))] else { continue }
      for field in type.fields {
        guard let opens = field.opens, case .string(let value)? = row.lattice.fields[field.name]?.value else { continue }
        if opens.contains(where: { $0.utf8.elementsEqual(value.utf8) }) { return true }
      }
    }
    return false
  }

  // Every record of a scope in the page form (§9.1): alive rows whole, dead ones thin, spent ids included.
  func feedRows(of scope: ScopeKey) -> [Row] {
    let typed = (rows[scope] ?? [:]).values.map(\.pageForm)
    let thin = (spent[scope] ?? [:]).map { $0.value.row(for: $0.key) }
    return typed + thin
  }

  func revisionText(of key: RecordKey, field: String, rev: Int64, in scope: ScopeKey) -> String? {
    revisions[scope]?.first { $0.key == key && $0.field == field && $0.rev == rev }?.text
  }
}

extension Row {
  // `{t, id, life, born?, seq}`: how a dead row travels.
  var thin: Row {
    Row(key: key, lattice: Lattice(life: lattice.life, born: lattice.born), seq: seq)
  }

  // The content admission compares: the row without its seq and receipt times.
  var content: Row {
    Row(key: key, lattice: lattice, texts: texts, serials: serials, seq: 0)
  }
}

// MARK: - Scopes

// A scope's server key (D-4): `acct:<A>/<product>`, `tree:<T>` or `acct:<A>/overlay/<T>`, ordered by its bytes.
public struct ScopeKey: Sendable, Hashable, Comparable, CustomStringConvertible {
  public enum Kind: Sendable, Hashable {
    case product(account: String, name: String)
    case tree(String)
    case overlay(account: String, tree: String)
  }

  public let kind: Kind
  public let text: String

  public init(_ kind: Kind) {
    self.kind = kind
    text = switch kind {
    case .product(let account, let name): "acct:\(account)/\(name)"
    case .tree(let tree): "tree:\(tree)"
    case .overlay(let account, let tree): "acct:\(account)/overlay/\(tree)"
    }
  }

  public init(parsing text: String) throws {
    if text.hasPrefix("tree:") {
      self.init(.tree(String(text.dropFirst("tree:".count))))
      return
    }
    let parts = text.dropFirst("acct:".count).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    switch (text.hasPrefix("acct:"), parts.count) {
    case (true, 2): self.init(.product(account: parts[0], name: parts[1]))
    case (true, 3) where parts[1] == "overlay": self.init(.overlay(account: parts[0], tree: parts[2]))
    default: throw JSONError.shape("\(text) is not a scope key")
    }
  }

  // `self` resolves to the principal's account; a device scope has no key.
  public init?(_ ref: ScopeRef, account: String?) {
    switch ref.kind {
    case .tree(let tree): self.init(.tree(tree))
    case .product(let name):
      guard let account else { return nil }
      self.init(.product(account: account, name: name))
    case .overlay(let tree):
      guard let account else { return nil }
      self.init(.overlay(account: account, tree: tree))
    case .device: return nil
    }
  }

  // The wire reference its owner, or any reader of a tree, names it by.
  public var ref: ScopeRef {
    switch kind {
    case .product(_, let name): .product(name)
    case .tree(let tree): .tree(tree)
    case .overlay(_, let tree): .overlay(tree)
    }
  }

  public var tree: String? {
    switch kind {
    case .tree(let tree), .overlay(_, let tree): tree
    case .product: nil
    }
  }

  var kindName: String {
    switch kind {
    case .product: "product"
    case .tree: "tree"
    case .overlay: "overlay"
    }
  }

  public var description: String { text }

  public static func == (lhs: ScopeKey, rhs: ScopeKey) -> Bool { lhs.text.utf8.elementsEqual(rhs.text.utf8) }
  public func hash(into hasher: inout Hasher) { hasher.combine(Array(text.utf8)) }
  public static func < (lhs: ScopeKey, rhs: ScopeKey) -> Bool { lhs.text.utf8.lexicographicallyPrecedes(rhs.text.utf8) }
}

// D-5 and §8.3: a scope is absent, alive or dead, and a dead scope never lives again.
public enum ScopeLife: String, Sendable, CaseIterable {
  case absent, alive, dead

  public enum Event: String, Sendable, CaseIterable {
    case firstWrite = "first-write"
    case governingCreate = "governing-create"
    case governingDelete = "governing-delete"
    case horizon
  }

  public func after(_ event: Event) -> ScopeLife? {
    switch (self, event) {
    case (.absent, .firstWrite), (.absent, .governingCreate): .alive
    case (.alive, .governingDelete), (.dead, .horizon): .dead
    default: nil
    }
  }
}

// One `sync_scopes` row: its owner, state, seq, counters of capped types, digest and governor.
public struct ScopeRecord: Sendable, Hashable {
  public enum State: String, Sendable {
    case alive, dead
  }

  public var owner: String
  public var state: State
  public var seq: Int64
  public var counters: [String: Int]
  public var digest: ScopeDigest
  public var governedBy: String?
  public var deadAt: Int64?

  // A scope born by §8.3's `event`: alive at seq 0 with digest 0.
  public init(owner: String, born event: ScopeLife.Event, governedBy: String? = nil) {
    precondition(ScopeLife.absent.after(event) == .alive, "\(event) does not create a scope")
    self.owner = owner
    state = .alive
    seq = 0
    counters = [:]
    digest = .zero
    self.governedBy = governedBy
    deadAt = nil
  }

  init(json: JSON, key: ScopeKey) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["kind", "owner", "state", "seq", "counters", "digest"], optional: ["governedBy", "deadAt"])
    guard try object.member("kind").asString() == key.kindName else { throw JSONError.shape("\(key) has another kind") }
    guard let state = State(rawValue: try object.member("state").asString()) else { throw JSONError.shape("not a scope state") }
    owner = try object.member("owner").asString()
    self.state = state
    seq = try object.member("seq").asInteger(atLeast: 0)
    counters = try JSON.map(object["counters"]) { Int(try $0.asInteger(atLeast: 0)) }
    digest = try ScopeDigest(hex: object.member("digest").asString())
    governedBy = try object["governedBy"]?.asString()
    deadAt = try object["deadAt"]?.asInteger()
  }

  // §2.1 `governed_by` of a tree: `<scope>#<type>#<id>` of its governing record.
  static func governor(scope: ScopeKey, key: RecordKey) -> String {
    "\(scope.text)#\(key.type)#\(key.id.description)"
  }

  var isAlive: Bool { state == .alive }

  // §8.3 a governing delete: an alive scope dies at `ms`; a dead one stays as it died. True when it died now.
  mutating func die(at ms: Int64) -> Bool {
    guard ScopeLife(rawValue: state.rawValue)?.after(.governingDelete) == .dead else { return false }
    state = .dead
    deadAt = ms
    return true
  }

  func json(kind: String) -> JSON {
    var object: JSON.Object = [
      "kind": .string(kind), "owner": .string(owner), "state": .string(state.rawValue), "seq": JSON(seq),
      "counters": .object(JSON.Object(uniqueKeysWithValues: counters.map { ($0.key, JSON($0.value)) })),
      "digest": .string(digest.hex),
    ]
    object["governedBy"] = governedBy.map { .string($0) }
    object["deadAt"] = deadAt.map { JSON($0) }
    return .object(object)
  }
}

// MARK: - Rows kept beside the typed rows

// A `sync_spent` row: a record of a `deadRows: spent` type, dead, with its born (none for a keyed type).
public struct SpentRow: Sendable, Hashable {
  public var born: Stamp?
  public var lifeStamp: Stamp
  public var seq: Int64

  public init(born: Stamp?, lifeStamp: Stamp, seq: Int64) {
    self.born = born
    self.lifeStamp = lifeStamp
    self.seq = seq
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["t", "id", "lifeStamp", "seq"], optional: ["born"])
    self.init(
      born: try object["born"].map { try Stamp(json: $0) }, lifeStamp: try Stamp(json: object.member("lifeStamp")),
      seq: try object.member("seq").asInteger())
  }

  static func key(json: JSON) throws -> RecordKey {
    RecordKey(try json.member("t").asString(), try RecordID(json: json.member("id")))
  }

  func row(for key: RecordKey) -> Row {
    Row(key: key, lattice: Lattice(life: Life(.dead, lifeStamp), born: born), seq: seq)
  }

  func json(for key: RecordKey) -> JSON {
    var object: JSON.Object = ["t": .string(key.type), "id": key.id.json, "lifeStamp": lifeStamp.json, "seq": JSON(seq)]
    object["born"] = born?.json
    return .object(object)
  }
}

// A superseded text head, kept under its rev (§2.2, §6.11 step 4).
public struct Revision: Sendable, Hashable, Comparable {
  public let key: RecordKey
  public let field: String
  public let rev: Int64
  public let text: String

  public init(key: RecordKey, field: String, rev: Int64, text: String) {
    self.key = key
    self.field = field
    self.rev = rev
    self.text = text
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["t", "id", "field", "rev", "text"])
    self.init(
      key: RecordKey(try object.member("t").asString(), try RecordID(json: object.member("id"))),
      field: try object.member("field").asString(), rev: try object.member("rev").asInteger(),
      text: try object.member("text").asString())
  }

  var json: JSON {
    ["t": .string(key.type), "id": key.id.json, "field": .string(field), "rev": JSON(rev), "text": .string(text)]
  }

  public static func < (lhs: Revision, rhs: Revision) -> Bool {
    if lhs.key != rhs.key { return lhs.key < rhs.key }
    if !lhs.field.utf8.elementsEqual(rhs.field.utf8) { return lhs.field.utf8.lexicographicallyPrecedes(rhs.field.utf8) }
    return lhs.rev < rhs.rev
  }
}

// MARK: - Push and request bookkeeping

// A `sync_replicas` row.
public struct ReplicaBinding: Sendable, Hashable {
  public var account: String
  public var lastN: Int64

  public init(account: String, lastN: Int64) {
    self.account = account
    self.lastN = lastN
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["account", "lastN"])
    self.init(account: try object.member("account").asString(), lastN: try object.member("lastN").asInteger(atLeast: 0))
  }

  var json: JSON { ["account": .string(account), "lastN": JSON(lastN)] }
}

// A `sync_requests` key (§2.1): an account and a request id, the same only byte for byte.
public struct RequestKey: Sendable, Hashable, Comparable {
  public let account: String
  public let requestId: String

  public init(account: String, requestId: String) {
    self.account = account
    self.requestId = requestId
  }

  public static func == (lhs: RequestKey, rhs: RequestKey) -> Bool {
    lhs.account.isSameID(as: rhs.account) && lhs.requestId.isSameID(as: rhs.requestId)
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(account.utf8))
    hasher.combine(Array(requestId.utf8))
  }

  public static func < (lhs: RequestKey, rhs: RequestKey) -> Bool {
    if !lhs.account.isSameID(as: rhs.account) { return lhs.account.utf8.lexicographicallyPrecedes(rhs.account.utf8) }
    return lhs.requestId.utf8.lexicographicallyPrecedes(rhs.requestId.utf8)
  }
}

extension String {
  // Accounts and ids are the same only byte for byte, never by Unicode canonical equivalence (§9.1, INV-7).
  public func isSameID(as other: String?) -> Bool {
    other.map { utf8.elementsEqual($0.utf8) } ?? false
  }
}

// A `sync_results` row: the intent's digest, its final result once there is one, and the faults counted so far.
public struct StoredResult: Sendable, Hashable {
  public var digest: String
  public var result: JSON?
  public var faults: Int

  public init(digest: String, result: JSON?, faults: Int) {
    self.digest = digest
    self.result = result
    self.faults = faults
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["n", "digest", "result", "faults"])
    let result = try object.member("result")
    self.init(
      digest: try object.member("digest").asString(), result: result.isNull ? nil : result,
      faults: Int(try object.member("faults").asInteger(atLeast: 0)))
  }

  func json(n: Int64) -> JSON {
    ["n": JSON(n), "digest": .string(digest), "result": result ?? .null, "faults": JSON(faults)]
  }
}

// A `sync_requests` row (§6.3): running until the call's last admit, with each admit's result as part k.
public struct RequestRecord: Sendable, Hashable {
  public enum State: String, Sendable {
    case running, done
  }

  public var digest: String
  public var state: State
  public var startedAt: Int64
  public var parts: [Int: JSON]
  public var result: JSON?

  public init(digest: String, state: State, startedAt: Int64, parts: [Int: JSON] = [:], result: JSON? = nil) {
    self.digest = digest
    self.state = state
    self.startedAt = startedAt
    self.parts = parts
    self.result = result
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["requestId", "digest", "state", "startedAt", "parts"], optional: ["result"])
    guard let state = State(rawValue: try object.member("state").asString()) else { throw JSONError.shape("not a request state") }
    let parts = try object.member("parts").asArray().map { (Int(try $0.member("k").asInteger(atLeast: 1)), try $0.member("result")) }
    self.init(
      digest: try object.member("digest").asString(), state: state, startedAt: try object.member("startedAt").asInteger(),
      parts: Dictionary(uniqueKeysWithValues: parts), result: object["result"])
  }

  func json(requestId: String) -> JSON {
    var object: JSON.Object = [
      "requestId": .string(requestId), "digest": .string(digest), "state": .string(state.rawValue), "startedAt": JSON(startedAt),
      "parts": .array(parts.sorted { $0.key < $1.key }.map { ["k": JSON($0.key), "result": $0.value] }),
    ]
    object["result"] = result
    return .object(object)
  }
}
