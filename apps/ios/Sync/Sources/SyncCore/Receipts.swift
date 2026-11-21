// §6.4 scoped effect receipts (E-7): what an opted command's committed effects hold in each scope it changes, as the
// version of every changed slot and the scope's watermarks before and after, never a value. Record ids may carry user
// text, so a receipt is private sync data and enters no log or telemetry.

// The deltas an entry or a notice holds in one scope.
public struct ScopedDeltas: Sendable, Hashable {
  public var scope: ScopeRef
  public var deltas: [Delta]

  public init(scope: ScopeRef, deltas: [Delta]) {
    self.scope = scope
    self.deltas = deltas
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["scope", "d"])
    self.init(scope: try ScopeRef(json: object.member("scope")), deltas: try object.member("d").asArray().map { try Delta(json: $0) })
  }

  public var json: JSON { ["scope": scope.json, "d": .array(deltas.map(\.json))] }
}

// One changed slot of a receipt row and the version its committed write holds: a stamp, or a text's revision.
public struct EffectSlot: Sendable, Hashable {
  public enum Slot: Sendable, Hashable {
    case born, life
    case field(String)
    case text(String)
  }

  public enum Version: Sendable, Hashable {
    case stamp(Stamp)
    case text(revision: Int64)
  }

  public let slot: Slot
  public let version: Version

  public init(_ slot: Slot, _ version: Version) {
    self.slot = slot
    self.version = version
  }

  // Born, life, then fields and texts by name: the order a row lists its slots in, compared by UTF-8 bytes.
  var order: String {
    switch slot {
    case .born: "0"
    case .life: "1"
    case .field(let name): "2" + name
    case .text(let name): "3" + name
    }
  }

  public var json: JSON {
    let slot: JSON = switch self.slot {
    case .born: ["kind": "born"]
    case .life: ["kind": "life"]
    case .field(let name): ["kind": "field", "name": .string(name)]
    case .text(let name): ["kind": "text", "name": .string(name)]
    }
    let version: JSON = switch self.version {
    case .stamp(let stamp): ["kind": "stamp", "stamp": stamp.json]
    case .text(let revision): ["kind": "text", "revision": JSON(revision)]
    }
    return ["slot": slot, "version": version]
  }

  public static func == (lhs: EffectSlot, rhs: EffectSlot) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// One changed record: its row seq before (null when the admission created it) and after, and its changed slots.
public struct EffectRow: Sendable, Hashable {
  public var key: RecordKey
  public let beforeRowSeq: Int64?
  public let rowSeq: Int64
  public let slots: [EffectSlot]

  public init(key: RecordKey, beforeRowSeq: Int64?, rowSeq: Int64, slots: [EffectSlot]) {
    self.key = key
    self.beforeRowSeq = beforeRowSeq
    self.rowSeq = rowSeq
    self.slots = slots
  }

  // The slots `after` changes over `before`: a new row's whole versioned footprint, an updated row's changed slots only,
  // and none for a change of serials alone. A text owns the revision it was committed at.
  public init(before: Row?, after: Row) {
    var slots: [EffectSlot] = []
    if let born = after.lattice.born, born != before?.lattice.born { slots.append(EffectSlot(.born, .stamp(born))) }
    if let life = after.lattice.life, life != before?.lattice.life { slots.append(EffectSlot(.life, .stamp(life.stamp))) }
    for (name, register) in after.lattice.fields.sorted(by: { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) })
    where register != before?.lattice.fields[name] {
      slots.append(EffectSlot(.field(name), .stamp(register.stamp)))
    }
    for (name, text) in after.texts.sorted(by: { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) }) where text != before?.texts[name] {
      slots.append(EffectSlot(.text(name), .text(revision: text.rev)))
    }
    self.init(key: after.key, beforeRowSeq: before?.seq, rowSeq: after.seq, slots: slots)
  }

  public var json: JSON {
    ["t": .string(key.type), "id": key.id.json, "beforeRowSeq": beforeRowSeq.map { JSON($0) } ?? .null, "rowSeq": JSON(rowSeq),
     "slots": .array(slots.map(\.json))]
  }

  public static func == (lhs: EffectRow, rhs: EffectRow) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// One scope of a receipt: its seq before the admission and after it, null before for a scope the admission created and
// null both for an absent target it left alone, and the rows it changed there in record order.
public struct EffectReceipt: Sendable, Hashable {
  public var scope: ScopeRef
  public let beforeSeq: Int64?
  public let seq: Int64?
  public var rows: [EffectRow]

  public init(scope: ScopeRef, beforeSeq: Int64?, seq: Int64?, rows: [EffectRow]) {
    self.scope = scope
    self.beforeSeq = beforeSeq
    self.seq = seq
    self.rows = rows
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    let seq = { (key: String) throws -> Int64? in try object.member(key).nullable { try $0.asInteger() } }
    self.init(
      scope: try ScopeRef(json: object.member("scope")), beforeSeq: try seq("beforeSeq"), seq: try seq("seq"),
      rows: try object.member("rows").asArray().map { row in
        EffectRow(
          key: RecordKey(try row.member("t").asString(), try RecordID(json: row.member("id"))),
          beforeRowSeq: try row.member("beforeRowSeq").nullable { try $0.asInteger() }, rowSeq: try row.member("rowSeq").asInteger(),
          slots: try row.member("slots").asArray().map(EffectSlot.init(json:)))
      })
  }

  public var json: JSON {
    ["scope": scope.json, "beforeSeq": beforeSeq.map { JSON($0) } ?? .null, "seq": seq.map { JSON($0) } ?? .null,
     "rows": .array(rows.map(\.json))]
  }

  // The origin first, then every other scope once, by the UTF-8 bytes of its reference.
  public static func ordered(origin: ScopeRef, _ scopes: some Sequence<ScopeRef>) -> [ScopeRef] {
    [origin] + Set(scopes).subtracting([origin]).sorted()
  }

  public static func == (lhs: EffectReceipt, rhs: EffectReceipt) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

extension EffectSlot {
  init(json: JSON) throws {
    let slot = try json.member("slot"), version = try json.member("version")
    let kind = try slot.member("kind").asString()
    let name = { try slot.member("name").asString() }
    self.init(
      try kind == "born" ? .born : kind == "life" ? .life : kind == "field" ? .field(name()) : .text(name()),
      try version.member("kind").asString() == "text" ? .text(revision: version.member("revision").asInteger())
        : .stamp(try Stamp(json: version.member("stamp"))))
  }
}

// §6.4 the detail an opted command's success carries: `{windmillKit: {v: 1, effects}, command?}`, the handler's own detail
// under `command`.
public enum ScopedDetail {
  public static func wrapping(_ effects: [EffectReceipt], command: JSON?) -> JSON {
    var object: JSON.Object = ["windmillKit": metadata(effects)]
    object["command"] = command
    return .object(object)
  }

  // The canonical metadata RECEIPT_MAX_BYTES bounds.
  public static func metadata(_ effects: [EffectReceipt]) -> JSON {
    ["v": 1, "effects": .array(effects.map(\.json))]
  }

  // The UTF-8 bytes of a push response carrying `result` alone, its envelope at the widest safe integers, which
  // SCOPED_RESPONSE_MAX_BYTES bounds before the result commits.
  public static func responseBytes(of result: JSON, epoch: String, account: String) -> Int {
    let widest = JSON(JSON.maxSafeInteger)
    var numbered = (try? result.asObject()) ?? JSON.Object()
    numbered["n"] = widest
    let response: JSON = [
      "serverTime": widest, "epoch": .string(epoch), "as": .string(account), "lastN": widest, "results": [.object(numbered)],
      "retry": ["n": widest, "retryAfterMs": widest],
    ]
    return response.jcs.count
  }

  // §7.4 the receipt of an opted entry's success, checked whole before the answer changes anything: the metadata alone
  // beside the handler's detail, within RECEIPT_MAX_BYTES and holding no U+0000; each scope a product, tree or overlay
  // reference named once, the origin first at `seq` and the rest in byte order; each row a type of its scope with a valid
  // id, in record order, at its scope's new seq, a new row carrying its whole versioned footprint; each slot one the type
  // declares, in slot order, with a stamp or a revision no later than its row. Every scope in `required` is present.
  public static func effects(in detail: JSON?, registry: Registry, origin: ScopeRef, seq resultSeq: Int64,
                             requiring required: [ScopeRef]) throws(JSONError) -> [EffectReceipt] {
    let malformed = JSONError.shape("a malformed scoped receipt")
    do {
      guard let detail else { throw malformed }
      try detail.asObject().expectKeys(required: ["windmillKit"], optional: ["command"])
      let kit = try detail.member("windmillKit")
      try kit.asObject().expectKeys(required: ["v", "effects"])
      guard try kit.member("v").asInteger() == 1, !kit.holdsNul, kit.jcs.count <= Constants.receiptMaxBytes else { throw malformed }
      let effects = try kit.member("effects").asArray().map { try receipt($0, registry: registry) }
      let scopes = effects.map(\.scope)
      guard Set(scopes).count == scopes.count, scopes == EffectReceipt.ordered(origin: origin, scopes),
            let first = effects.first, first.beforeSeq != nil, first.seq == resultSeq,
            required.allSatisfy(scopes.contains) else { throw malformed }
      return effects
    } catch {
      throw malformed
    }
  }

  static func receipt(_ json: JSON, registry: Registry) throws -> EffectReceipt {
    let malformed = JSONError.shape("a malformed scoped receipt")
    try json.asObject().expectKeys(required: ["scope", "beforeSeq", "seq", "rows"])
    let receipt = try EffectReceipt(json: json)
    guard let kind = registry.scopeKind(of: receipt.scope), registry.isScopeID(receipt.scope) else { throw malformed }
    if let before = receipt.beforeSeq { guard before >= 0, let seq = receipt.seq, seq >= before else { throw malformed } }
    guard receipt.seq.map({ $0 >= 0 }) ?? receipt.rows.isEmpty else { throw malformed }
    var previous: RecordKey?
    for (row, rowJSON) in zip(receipt.rows, try json.member("rows").asArray()) {
      try rowJSON.asObject().expectKeys(required: ["t", "id", "beforeRowSeq", "rowSeq", "slots"])
      guard let type = registry.type(row.key.type), type.scope == kind, registry.isID(row.key.id.json, of: type),
            previous.map({ $0 < row.key }) ?? true, row.rowSeq > 0, row.rowSeq == receipt.seq, receipt.beforeSeq != receipt.seq
      else { throw malformed }
      if let before = row.beforeRowSeq {
        guard let scopeBefore = receipt.beforeSeq, before >= 0, before < row.rowSeq, before <= scopeBefore else { throw malformed }
      }
      try check(row, of: type, slots: try rowJSON.member("slots").asArray())
      previous = row.key
    }
    return receipt
  }

  static func check(_ row: EffectRow, of type: TypeDef, slots: [JSON]) throws {
    let malformed = JSONError.shape("a malformed scoped receipt")
    var previous = ""
    for (slot, slotJSON) in zip(row.slots, slots) {
      try slotJSON.asObject().expectKeys(required: ["slot", "version"])
      let named = try slotJSON.member("slot")
      switch slot.slot {
      case .born, .life:
        try named.asObject().expectKeys(required: ["kind"])
        guard slot.slot == .born ? type.hasBorn : type.life else { throw malformed }
      case .field(let name):
        try named.asObject().expectKeys(required: ["kind", "name"])
        guard type.field(name)?.kind.isLattice == true else { throw malformed }
      case .text(let name):
        try named.asObject().expectKeys(required: ["kind", "name"])
        guard try named.member("kind").asString() == "text", case .text? = type.field(name)?.kind else { throw malformed }
      }
      guard previous.utf8.lexicographicallyPrecedes(slot.order.utf8) else { throw malformed }
      previous = slot.order
      let version = try slotJSON.member("version")
      switch slot.version {
      case .text(let revision):
        try version.asObject().expectKeys(required: ["kind", "revision"])
        guard case .text = slot.slot, revision > 0, revision <= row.rowSeq else { throw malformed }
      case .stamp(let stamp):
        try version.asObject().expectKeys(required: ["kind", "stamp"])
        guard try version.member("kind").asString() == "stamp", stamp != .unset else { throw malformed }
        if case .text = slot.slot { throw malformed }
      }
    }
    guard row.beforeRowSeq == nil else { return }
    if type.hasBorn && !row.slots.contains(where: { $0.slot == .born }) { throw malformed }
    if type.life && !row.slots.contains(where: { $0.slot == .life }) { throw malformed }
  }
}

extension Delta {
  // The stamp the delta writes to a receipt's slot: its born, its life's or a field's; none to a text.
  public func stamp(of slot: EffectSlot.Slot) -> Stamp? {
    switch slot {
    case .born: lattice.born
    case .life: lattice.life?.stamp
    case .field(let name): lattice.fields[name]?.stamp
    case .text: nil
    }
  }
}
