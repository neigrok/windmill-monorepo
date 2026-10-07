// §9.1 the wire's records, the same only byte for byte: ids and keys, scopes, rows, deltas, guards, commands and intents.

// MARK: - Record ids

// A string id, or a tuple key's array of strings; identity and order are the UTF-8 bytes of its JCS (§9.1).
public struct RecordID: Sendable, Hashable, Comparable, CustomStringConvertible, ExpressibleByStringLiteral {
  public let json: JSON
  public let jcs: [UInt8]

  public init(_ id: String) {
    json = .string(id)
    jcs = json.jcs
  }

  public init(tuple parts: [String]) {
    json = .array(parts.map { .string($0) })
    jcs = json.jcs
  }

  public static func pair(_ a: String, _ b: String) -> RecordID {
    RecordID(tuple: [a, b])
  }

  public init(stringLiteral value: String) {
    self.init(value)
  }

  public init(json: JSON) throws(JSONError) {
    switch json {
    case .string(let id): self.init(id)
    case .array(let parts) where !parts.isEmpty: self.init(tuple: try parts.map { part throws(JSONError) in try part.asString() })
    default: throw JSONError.shape("an id is a string or a non-empty array of strings, found \(json.jcsText)")
    }
  }

  // The id's stored text is its JCS, so a string id and a tuple key can never read back as one another.
  public init(text: String) throws(JSONError) {
    try self.init(json: JSON(parsing: text))
  }

  public var text: String { String(decoding: jcs, as: UTF8.self) }

  public var string: String? {
    if case .string(let id) = json { return id }
    return nil
  }

  public var parts: [String]? {
    guard case .array(let parts) = json else { return nil }
    return parts.map { if case .string(let part) = $0 { part } else { "" } }
  }

  public var description: String { string ?? text }

  public static func == (lhs: RecordID, rhs: RecordID) -> Bool { lhs.jcs == rhs.jcs }
  public func hash(into hasher: inout Hasher) { hasher.combine(jcs) }
  public static func < (lhs: RecordID, rhs: RecordID) -> Bool { lhs.jcs.lexicographicallyPrecedes(rhs.jcs) }
}

// A record of a scope: its type and id; records sort by the type's bytes, then the id's (§9.1).
public struct RecordKey: Sendable, Hashable, Comparable, CustomStringConvertible {
  public let type: String
  public let id: RecordID

  public init(_ type: String, _ id: RecordID) {
    self.type = type
    self.id = id
  }

  public var description: String { "\(type) \(id)" }

  public static func == (lhs: RecordKey, rhs: RecordKey) -> Bool {
    lhs.type.utf8.elementsEqual(rhs.type.utf8) && lhs.id == rhs.id
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(type.utf8))
    hasher.combine(id)
  }

  public static func < (lhs: RecordKey, rhs: RecordKey) -> Bool {
    if !lhs.type.utf8.elementsEqual(rhs.type.utf8) { return lhs.type.utf8.lexicographicallyPrecedes(rhs.type.utf8) }
    return lhs.id < rhs.id
  }

  public var json: JSON { [.string(type), id.json] }
}

// MARK: - Account ids

// §9.1 an account id: at most ACCOUNT_ID_BYTES bytes of UTF-8, holding no character JCS escapes (a control character, `"`
// or `\`). The server resolves a credential to no other, so every account a push names fits §7.1 step 8's widest body.
public enum AccountID {
  public static func isWellFormed(_ id: String) -> Bool {
    id.utf8.count <= Constants.accountIdBytes && JSON.string(id).jcs.count == id.utf8.count + 2
  }

  // The widest account a push can name: what an `anon` replica's commit measures an entry with, before it knows its
  // account (§7.1 step 8).
  public static let widest = String(repeating: "a", count: Constants.accountIdBytes)
}

extension String {
  // Accounts and ids are the same only byte for byte, never by Unicode canonical equivalence (§9.1, INV-7).
  public func isSameID(as other: String?) -> Bool {
    other.map { utf8.elementsEqual($0.utf8) } ?? false
  }
}

// MARK: - Scope references

// D-4 wire references: `self/<product>`, `self/overlay/<T>`, `tree/<T>`, and the client-only `device/<product>`.
public struct ScopeRef: Sendable, Hashable, Comparable, CustomStringConvertible {
  public enum Kind: Sendable {
    case product(String)
    case tree(String)
    case overlay(String)
    case device(String)
  }

  public let kind: Kind

  public init(_ kind: Kind) {
    self.kind = kind
  }

  public static func product(_ name: String) -> ScopeRef { ScopeRef(.product(name)) }
  public static func tree(_ tree: String) -> ScopeRef { ScopeRef(.tree(tree)) }
  public static func overlay(_ tree: String) -> ScopeRef { ScopeRef(.overlay(tree)) }
  public static func device(_ product: String) -> ScopeRef { ScopeRef(.device(product)) }

  public init(_ text: String) throws(JSONError) {
    let parts = text.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard text.isPrintableASCII, parts.allSatisfy({ !$0.isEmpty }) else { throw JSONError.shape("\(text) is not a scope reference") }
    switch (parts.first, parts.count) {
    case ("self", 3) where parts[1] == "overlay": self.init(.overlay(parts[2]))
    case ("self", 2): self.init(.product(parts[1]))
    case ("tree", 2): self.init(.tree(parts[1]))
    case ("device", 2): self.init(.device(parts[1]))
    default: throw JSONError.shape("\(text) is not a scope reference")
    }
  }

  public init(json: JSON) throws(JSONError) {
    try self.init(json.asString())
  }

  public var text: String {
    switch kind {
    case .product(let name): "self/\(name)"
    case .tree(let tree): "tree/\(tree)"
    case .overlay(let tree): "self/overlay/\(tree)"
    case .device(let product): "device/\(product)"
    }
  }

  // The tree a tree or overlay scope belongs to.
  public var tree: String? {
    switch kind {
    case .tree(let tree), .overlay(let tree): tree
    case .product, .device: nil
    }
  }

  public var description: String { text }
  public var json: JSON { .string(text) }

  public static func == (lhs: ScopeRef, rhs: ScopeRef) -> Bool { lhs.text.utf8.elementsEqual(rhs.text.utf8) }
  public func hash(into hasher: inout Hasher) { hasher.combine(Array(text.utf8)) }
  public static func < (lhs: ScopeRef, rhs: ScopeRef) -> Bool { lhs.text.utf8.lexicographicallyPrecedes(rhs.text.utf8) }
}

extension Registry {
  // The registry scope kind a reference names; nil for a device scope, an undeclared product, or text the wire cannot carry.
  public func scopeKind(of scope: ScopeRef) -> ScopeKind? {
    guard (try? ScopeRef(scope.text)) != nil else { return nil }
    return switch scope.kind {
    case .product(let name): product(name) == nil ? nil : .product(name)
    case .tree: .tree
    case .overlay: .overlay
    case .device: nil
    }
  }

  // The product a scope belongs to: its own, or for a tree or overlay the governing type's (§7.10).
  public func product(of scope: ScopeRef) -> String? {
    switch scope.kind {
    case .product(let name), .device(let name): product(name) == nil ? nil : name
    case .tree, .overlay: governingType.flatMap(\.scope.productName)
    }
  }

  public var governingType: TypeDef? {
    types.first(where: \.governsTree)
  }

  // A tree or overlay scope's governing record, and the product scope it lives in, where §7.1 step 2 and §7.9 read it; nil
  // for any other scope.
  public func governingRecord(of scope: ScopeRef) -> (key: RecordKey, scope: ScopeRef)? {
    guard let tree = scope.tree, let governing = governingType, let product = governing.scope.productName else { return nil }
    return (RecordKey(governing.name, RecordID(tree)), .product(product))
  }

  // A reference from `scope` to a record of `type` names it in the scope that type lives in (§7.7 step 3).
  public func scope(ofType type: String, from scope: ScopeRef) -> ScopeRef? {
    guard let kind = self.type(type)?.scope else { return nil }
    switch kind {
    case .product(let name): return .product(name)
    case .tree: return scope.tree.map(ScopeRef.tree)
    case .overlay: return scope.tree.map(ScopeRef.overlay)
    }
  }

  public func lives(_ type: String, in scope: ScopeRef) -> Bool {
    guard let kind = scopeKind(of: scope), let def = self.type(type) else { return false }
    return def.scope == kind
  }
}

extension ScopeKind {
  public var productName: String? {
    if case .product(let name) = self { return name }
    return nil
  }
}

extension TypeDef {
  // Every record this one names: the parts of its ref-built key, and its ref fields' values (§7.7 step 3).
  public func references(of id: RecordID, values: [String: JSON]) -> [RecordKey] {
    var named: [RecordKey] = []
    switch key {
    case .ref(let target)?: named.append(RecordKey(target, id))
    case .tuple(let parts)?:
      for (part, value) in zip(parts, id.parts ?? []) { named.append(RecordKey(part.ref, RecordID(value))) }
    case nil: break
    }
    for field in fields {
      guard let target = field.ref, case .string(let value)? = values[field.name] else { continue }
      named.append(RecordKey(target, RecordID(value)))
    }
    return named
  }

  public var clientTimeFields: [String] {
    fields.filter { if case .time = $0.kind { $0.writer == .client } else { false } }.map(\.name)
  }
}

// MARK: - Rows

// A text field's server state in a row: its whole text, the rev of its head, and whether a merge conflicted.
public struct TextState: Sendable, Hashable {
  public var text: String
  public var rev: Int64
  public var merged: Bool

  public init(text: String, rev: Int64, merged: Bool) {
    self.text = text
    self.rev = rev
    self.merged = merged
  }

  public init(json: JSON) throws(JSONError) {
    let object = try json.asObject()
    self.init(
      text: try object.member("text").asString(), rev: try object.member("rev").asInteger(),
      merged: try object.member("merged").asBool())
  }

  public var json: JSON { ["text": .string(text), "rev": JSON(rev), "merged": .bool(merged)] }

  public static func == (lhs: TextState, rhs: TextState) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// A §9.1 row as a page carries it; a thin dead row has no rc and ru. `json` is the form the digest hashes and rows compare by.
public struct Row: Sendable, Hashable {
  public var key: RecordKey
  public var lattice: Lattice
  public var texts: [String: TextState]
  public var serials: [String: JSON]
  public var seq: Int64
  public var rc: Int64?
  public var ru: Int64?

  public init(key: RecordKey, lattice: Lattice = Lattice(), texts: [String: TextState] = [:], serials: [String: JSON] = [:],
              seq: Int64, rc: Int64? = nil, ru: Int64? = nil) {
    self.key = key
    self.lattice = lattice
    self.texts = texts
    self.serials = serials
    self.seq = seq
    self.rc = rc
    self.ru = ru
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    self.init(
      key: RecordKey(try object.member("t").asString(), try RecordID(json: object.member("id"))),
      lattice: try Lattice(json: json),
      texts: try JSON.map(object["x"]) { try TextState(json: $0) },
      serials: try JSON.map(object["v"]) { $0 },
      seq: try object.member("seq").asInteger(),
      rc: try object["rc"].map { try $0.asInteger() },
      ru: try object["ru"].map { try $0.asInteger() })
  }

  // Alive when it has no life or its life is alive; only alive rows are stored and hashed (§6.12).
  public var isAlive: Bool { lattice.life?.isAlive ?? true }

  public var json: JSON {
    var object: JSON.Object = ["t": .string(key.type), "id": key.id.json, "seq": JSON(seq)]
    object["life"] = lattice.life?.json
    object["born"] = lattice.born?.json
    object["f"] = JSON.object(from: lattice.fields) { $0.json }
    object["x"] = JSON.object(from: texts) { $0.json }
    object["v"] = JSON.object(from: serials) { $0 }
    object["rc"] = rc.map { JSON($0) }
    object["ru"] = ru.map { JSON($0) }
    return .object(object)
  }

  public var digest: ScopeDigest { ScopeDigest(row: json) }

  // Every stamp the row carries: its life's, its born, and each lattice register's.
  public var stamps: [Stamp] { lattice.stamps }

  public static func == (lhs: Row, rhs: Row) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// MARK: - Deltas, guards, commands and intents

public enum TextBase: Sendable, Hashable {
  case rev(Int64)
  case text(String)

  public init(json: JSON) throws(JSONError) {
    let object = try json.asObject()
    if let rev = object["rev"] {
      self = .rev(try rev.asInteger())
      return
    }
    self = .text(try object.member("text").asString())
  }

  public var json: JSON {
    switch self {
    case .rev(let rev): ["rev": JSON(rev)]
    case .text(let text): ["text": .string(text)]
    }
  }

  public static func == (lhs: TextBase, rhs: TextBase) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// §6.11 a text write: the new text, and the base it was edited from.
public struct TextWrite: Sendable, Hashable {
  public var text: String
  public var base: TextBase

  public init(text: String, base: TextBase) {
    self.text = text
    self.base = base
  }

  public init(json: JSON) throws(JSONError) {
    self.init(text: try json.member("text").asString(), base: try TextBase(json: json.member("base")))
  }

  public var json: JSON { ["text": .string(text), "base": base.json] }

  public static func == (lhs: TextWrite, rhs: TextWrite) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// D-12 a partial record state: its lattice part, stamped, and its text writes; local predictions may carry serials.
public struct Delta: Sendable, Hashable {
  public var key: RecordKey
  public var lattice: Lattice
  public var texts: [String: TextWrite]
  public var serials: [String: JSON]

  public init(key: RecordKey, lattice: Lattice = Lattice(), texts: [String: TextWrite] = [:], serials: [String: JSON] = [:]) {
    self.key = key
    self.lattice = lattice
    self.texts = texts
    self.serials = serials
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    self.init(
      key: RecordKey(try object.member("t").asString(), try RecordID(json: object.member("id"))),
      lattice: try Lattice(json: json),
      texts: try JSON.map(object["x"]) { try TextWrite(json: $0) },
      serials: try JSON.map(object["v"]) { $0 })
  }

  public var json: JSON {
    var object: JSON.Object = ["t": .string(key.type), "id": key.id.json]
    object["born"] = lattice.born?.json
    object["life"] = lattice.life?.json
    object["f"] = JSON.object(from: lattice.fields) { $0.json }
    object["x"] = JSON.object(from: texts) { $0.json }
    object["v"] = JSON.object(from: serials) { $0 }
    return .object(object)
  }

  // A create: a life made alive at its own born (§7.7 step 3).
  public var creates: Bool {
    guard let life = lattice.life, let born = lattice.born else { return false }
    return life.isAlive && life.stamp == born
  }

  public var removes: Bool { lattice.life?.state == .dead }

  public static func == (lhs: Delta, rhs: Delta) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// D-19 a guard: the register `(t, id, field)` holds `stamp`, or is unset when `stamp` is nil.
public struct Guard: Sendable, Hashable {
  public var key: RecordKey
  public var field: String
  public var stamp: Stamp?

  public init(key: RecordKey, field: String, stamp: Stamp?) {
    self.key = key
    self.field = field
    self.stamp = stamp
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    let stamp = try object.member("stamp")
    self.init(
      key: RecordKey(try object.member("t").asString(), try RecordID(json: object.member("id"))),
      field: try object.member("field").asString(),
      stamp: stamp.isNull ? nil : try Stamp(json: stamp))
  }

  public var json: JSON {
    ["t": .string(key.type), "id": key.id.json, "field": .string(field), "stamp": stamp?.json ?? .null]
  }

  public static func == (lhs: Guard, rhs: Guard) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// D-20 a named server function and its arguments.
public struct Command: Sendable, Hashable {
  public var name: String
  public var args: JSON

  public init(name: String, args: JSON) {
    self.name = name
    self.args = args
  }

  public init(json: JSON) throws(JSONError) {
    self.init(name: try json.member("name").asString(), args: try json.member("args"))
  }

  public var json: JSON { ["name": .string(name), "args": args] }

  public static func == (lhs: Command, rhs: Command) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// D-13 the unit of admission; `n` is set once the sender numbers it (§7.4).
public struct Intent: Sendable, Hashable {
  public var n: Int64?
  public var scope: ScopeRef
  public var deltas: [Delta]
  public var guards: [Guard]
  public var command: Command?
  public var gestureId: String?

  public init(n: Int64? = nil, scope: ScopeRef, deltas: [Delta] = [], guards: [Guard] = [], command: Command? = nil,
              gestureId: String? = nil) {
    self.n = n
    self.scope = scope
    self.deltas = deltas
    self.guards = guards
    self.command = command
    self.gestureId = gestureId
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    self.init(
      n: try object["n"].map { try $0.asInteger() },
      scope: try ScopeRef(json: object.member("scope")),
      deltas: try object["d"]?.asArray().map { try Delta(json: $0) } ?? [],
      guards: try object["guard"]?.asArray().map { try Guard(json: $0) } ?? [],
      command: try object["cmd"].map { try Command(json: $0) },
      gestureId: try object["gestureId"]?.asString())
  }

  public var json: JSON {
    var object: JSON.Object = ["scope": scope.json]
    object["n"] = n.map { JSON($0) }
    object["d"] = deltas.isEmpty ? nil : .array(deltas.map(\.json))
    object["guard"] = guards.isEmpty ? nil : .array(guards.map(\.json))
    object["cmd"] = command?.json
    object["gestureId"] = gestureId.map { .string($0) }
    return .object(object)
  }

  // §6.2 digest(intent) = sha256(jcs(intent)), as 64 lowercase hex characters.
  public var digest: String { SHA256Hex.of(json.jcs) }

  public static func == (lhs: Intent, rhs: Intent) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// MARK: - Cursors

// §9.4 a cursor: unpadded base64url of jcs({e, m, s, k?, a?}), decoded strictly.
public struct Cursor: Sendable, Hashable {
  public enum Mode: String, Sendable {
    case boot, live
  }

  public let epoch: String
  public let mode: Mode
  public let seq: Int64
  public let key: RecordKey?
  public let asOf: Int64?

  public init(epoch: String, mode: Mode, seq: Int64, key: RecordKey? = nil, asOf: Int64? = nil) {
    self.epoch = epoch
    self.mode = mode
    self.seq = seq
    self.key = key
    self.asOf = asOf
  }

  // A text that is not the unpadded base64url of a cursor of this shape, `s` and `a` safe integers (§9.1), or that does
  // not re-encode to itself, is nil.
  public init?(decoding text: String) {
    guard let bytes = Base64URL.decode(text), let json = try? JSON(parsing: bytes), case .object(let object) = json,
          object.keys.allSatisfy({ ["e", "m", "s", "k", "a"].contains($0) }),
          case .string(let epoch)? = object["e"], case .string(let modeText)? = object["m"], let mode = Mode(rawValue: modeText),
          let seq = try? object["s"]?.asInteger(atLeast: 0)
    else { return nil }
    var key: RecordKey?
    if let k = object["k"] {
      guard case .array(let pair) = k, pair.count == 2, case .string(let type) = pair[0],
            let id = try? RecordID(json: pair[1]) else { return nil }
      key = RecordKey(type, id)
    }
    let asOf = try? object["a"]?.asInteger()
    switch mode {
    case .live: guard object["a"] == nil else { return nil }
    case .boot: guard let asOf, asOf >= seq else { return nil }
    }
    self.init(epoch: epoch, mode: mode, seq: seq, key: key, asOf: asOf)
    guard self.text == text else { return nil }
  }

  public var json: JSON {
    var object: JSON.Object = ["e": .string(epoch), "m": .string(mode.rawValue), "s": JSON(seq)]
    object["k"] = key?.json
    object["a"] = asOf.map { JSON($0) }
    return .object(object)
  }

  public var text: String { Base64URL.encode(json.jcs) }

  // Live without a key: the cursor is at a whole seq (§7.5 steps 3 and 4).
  public var isLiveAtSeq: Bool { mode == .live && key == nil }

  // §7.5 cleanSeq: the last seq a live cursor has received whole, the one before its own while it carries a key; nil
  // while booting.
  public var cleanSeq: Int64? {
    guard mode == .live else { return nil }
    return key == nil ? seq : seq - 1
  }

  public static func == (lhs: Cursor, rhs: Cursor) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

enum Base64URL {
  static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

  static func encode(_ bytes: [UInt8]) -> String {
    var out: [UInt8] = []
    for start in stride(from: 0, to: bytes.count, by: 3) {
      let chunk = Array(bytes[start..<min(start + 3, bytes.count)])
      let word = chunk.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (16 - 8 * $1.offset) }
      for index in 0...chunk.count { out.append(alphabet[Int(word >> (18 - 6 * index) & 0x3F)]) }
    }
    return String(decoding: out, as: UTF8.self)
  }

  // Unpadded only; a length that leaves a lone sextet is not base64url.
  static func decode(_ text: String) -> [UInt8]? {
    let digits = Array(text.utf8)
    guard digits.count % 4 != 1 else { return nil }
    var values: [UInt32] = []
    for digit in digits {
      guard let value = alphabet.firstIndex(of: digit) else { return nil }
      values.append(UInt32(value))
    }
    var out: [UInt8] = []
    for start in stride(from: 0, to: values.count, by: 4) {
      let chunk = values[start..<min(start + 4, values.count)]
      let word = chunk.enumerated().reduce(UInt32(0)) { $0 | $1.element << (18 - 6 * $1.offset) }
      for index in 0..<(chunk.count - 1) { out.append(UInt8(word >> (16 - 8 * index) & 0xFF)) }
    }
    return out
  }
}

// MARK: - U+0000

extension JSON {
  // A string of the value, a key or a value at any depth, holds U+0000: an intent holding one is refused (§6.1 step 2)
  // and a commit building one throws (§7.1 step 7).
  public var holdsNul: Bool {
    switch self {
    case .string(let text): text.utf8.contains(0)
    case .array(let items): items.contains(where: \.holdsNul)
    case .object(let object): object.members.contains { $0.key.utf8.contains(0) || $0.value.holdsNul }
    case .null, .bool, .number: false
    }
  }
}

// MARK: - JSON object helpers for maps of named parts

extension JSON {
  // An object of named parts, or nil when there are none (rows and deltas never carry empty maps).
  public static func object<Value>(from map: [String: Value], _ encode: (Value) -> JSON) -> JSON? {
    map.isEmpty ? nil : .object(JSON.Object(uniqueKeysWithValues: map.map { ($0.key, encode($0.value)) }))
  }

  // Named parts read from an absent or object-valued member; names are printable ASCII.
  public static func map<Value>(_ json: JSON?, _ decode: (JSON) throws -> Value) throws -> [String: Value] {
    guard let json else { return [:] }
    var out: [String: Value] = [:]
    for (name, value) in try json.asObject().members {
      guard name.isPrintableASCII else { throw JSONError.shape("the name \(JSON.string(name).jcsText) is not printable ASCII") }
      out[name] = try decode(value)
    }
    return out
  }
}
