// K-3 Undo of an act (engine.md §6.4, §7.3): the closed recipe union an act opts in with, the fixed arguments of an
// engine `restore` command and the evidence of a product `inverse` command, and the shapes and conditions both ends
// share. Slots and versions use E-7's encoding. Values never leave the device but in a restore's own arguments, and a
// record id may carry user text, so none of it enters a log or telemetry.

// MARK: - Slots and versions

extension EffectSlot.Slot {
  // `{kind: "born" | "life"}` or `{kind: "field" | "text", name}`, nothing else.
  public init(json: JSON) throws(JSONError) {
    let object = try json.asObject()
    switch try object.member("kind").asString() {
    case "born":
      try object.expectKeys(required: ["kind"])
      self = .born
    case "life":
      try object.expectKeys(required: ["kind"])
      self = .life
    case "field":
      try object.expectKeys(required: ["kind", "name"])
      self = .field(try object.member("name").asString())
    case "text":
      try object.expectKeys(required: ["kind", "name"])
      self = .text(try object.member("name").asString())
    default: throw JSONError.shape("an unknown slot kind")
    }
  }

  public var json: JSON {
    switch self {
    case .born: ["kind": "born"]
    case .life: ["kind": "life"]
    case .field(let name): ["kind": "field", "name": .string(name)]
    case .text(let name): ["kind": "text", "name": .string(name)]
    }
  }

  // Born, life, fields by name, texts by name: the order a row lists its slots in.
  public static func precedes(_ a: EffectSlot.Slot, _ b: EffectSlot.Slot) -> Bool {
    EffectSlot(a, .text(revision: 0)).order.utf8.lexicographicallyPrecedes(EffectSlot(b, .text(revision: 0)).order.utf8)
  }
}

extension EffectSlot.Version {
  // `{kind: "stamp", stamp}`, never unset, or a text's `{kind: "text", revision}`, above 0.
  public init(json: JSON) throws(JSONError) {
    let object = try json.asObject()
    switch try object.member("kind").asString() {
    case "stamp":
      try object.expectKeys(required: ["kind", "stamp"])
      guard let stamp = try? Stamp(json: object.member("stamp")), stamp != .unset else { throw JSONError.shape("a version is a stamp") }
      self = .stamp(stamp)
    case "text":
      try object.expectKeys(required: ["kind", "revision"])
      let revision = try object.member("revision").asInteger()
      guard revision > 0 else { throw JSONError.shape("a text version is its revision") }
      self = .text(revision: revision)
    default: throw JSONError.shape("an unknown version kind")
    }
  }

  public var json: JSON {
    switch self {
    case .stamp(let stamp): ["kind": "stamp", "stamp": stamp.json]
    case .text(let revision): ["kind": "text", "revision": JSON(revision)]
    }
  }

  // A text slot carries a revision, any other a stamp.
  func fits(_ slot: EffectSlot.Slot) -> Bool {
    switch (slot, self) {
    case (.text, .text), (.born, .stamp), (.life, .stamp), (.field, .stamp): true
    default: false
    }
  }
}

extension EffectSlot {
  // `{slot, version}`, the version fitting its slot.
  public init(strict json: JSON) throws(JSONError) {
    let object = try json.asObject()
    try object.expectKeys(required: ["slot", "version"])
    let slot = try EffectSlot.Slot(json: object.member("slot"))
    let version = try EffectSlot.Version(json: object.member("version"))
    guard version.fits(slot) else { throw JSONError.shape("a version fits its slot") }
    self.init(slot, version)
  }
}

extension Row {
  // The version a slot of this stored row carries now, or nil while the register is unset.
  public func version(of slot: EffectSlot.Slot) -> EffectSlot.Version? {
    switch slot {
    case .born: lattice.born.map(EffectSlot.Version.stamp)
    case .life: lattice.life.map { .stamp($0.stamp) }
    case .field(let name): lattice.fields[name].map { .stamp($0.stamp) }
    case .text(let name): texts[name].map { .text(revision: $0.rev) }
    }
  }

  // The row's complete versioned footprint: born, life, every field and every text, in slot order.
  public var footprint: [EffectSlot] {
    let slots: [EffectSlot.Slot] = [.born, .life] + lattice.fields.keys.map(EffectSlot.Slot.field) + texts.keys.map(EffectSlot.Slot.text)
    return slots.compactMap { (slot: EffectSlot.Slot) -> EffectSlot? in version(of: slot).map { EffectSlot(slot, $0) } }
      .sorted { EffectSlot.Slot.precedes($0.slot, $1.slot) }
  }
}

// MARK: - Addresses

// A record of a scope.
public struct RecordAddress: Sendable, Hashable {
  public var scope: ScopeRef
  public var key: RecordKey

  public init(scope: ScopeRef, key: RecordKey) {
    self.scope = scope
    self.key = key
  }

  // `{scope, t, id}`.
  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["scope", "t", "id"])
    self.init(scope: try ScopeRef(json: object.member("scope")), key: RecordKey(try object.member("t").asString(), try RecordID(json: object.member("id"))))
  }

  public var json: JSON { ["scope": scope.json, "t": .string(key.type), "id": key.id.json] }
}

// One slot of a record of a scope.
public struct Target: Sendable, Hashable {
  public var address: RecordAddress
  public let slot: EffectSlot.Slot

  public init(_ address: RecordAddress, _ slot: EffectSlot.Slot) {
    self.address = address
    self.slot = slot
  }

  // `{scope, t, id, slot}`.
  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["scope", "t", "id", "slot"])
    let address = RecordAddress(scope: try ScopeRef(json: object.member("scope")),
                                key: RecordKey(try object.member("t").asString(), try RecordID(json: object.member("id"))))
    self.init(address, try EffectSlot.Slot(json: object.member("slot")))
  }

  public var scope: ScopeRef { address.scope }
  public var key: RecordKey { address.key }

  public var json: JSON { ["scope": scope.json, "t": .string(key.type), "id": key.id.json, "slot": slot.json] }
}

// MARK: - Recipes (engine.md §7.3 Undo of an act)

// What an Undo's command reads beyond its input: the fields the act owns, and the records and scopes it created.
public struct EvidenceSelection: Sendable, Hashable {
  public var ownedFields: [Target]
  public var unchangedCreatedRecords: [RecordAddress]
  public var unchangedCreatedScopes: [ScopeRef]

  public init(ownedFields: [Target], unchangedCreatedRecords: [RecordAddress], unchangedCreatedScopes: [ScopeRef]) {
    self.ownedFields = ownedFields
    self.unchangedCreatedRecords = unchangedCreatedRecords
    self.unchangedCreatedScopes = unchangedCreatedScopes
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["ownedFields", "unchangedCreatedRecords", "unchangedCreatedScopes"])
    ownedFields = try object.member("ownedFields").asArray().map { (target: JSON) throws -> Target in try Target(json: target) }
    unchangedCreatedRecords = try object.member("unchangedCreatedRecords").asArray().map { (record: JSON) throws -> RecordAddress in
      try RecordAddress(json: record)
    }
    unchangedCreatedScopes = try object.member("unchangedCreatedScopes").asArray().map { (scope: JSON) throws -> ScopeRef in try ScopeRef(json: scope) }
  }

  public var json: JSON {
    ["ownedFields": .array(ownedFields.map(\.json)), "unchangedCreatedRecords": .array(unchangedCreatedRecords.map(\.json)),
     "unchangedCreatedScopes": .array(unchangedCreatedScopes.map(\.json))]
  }
}

// A field target and the value equivalent to its slot unset, when the product gives one.
public struct RestoreTarget: Sendable, Hashable {
  public var target: Target
  public let defaultValue: JSON?

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["target"], optional: ["defaultValue"])
    target = try Target(json: object.member("target"))
    defaultValue = object["defaultValue"]
  }

  public init(target: Target, defaultValue: JSON? = nil) {
    self.target = target
    self.defaultValue = defaultValue
  }

  public var json: JSON {
    var object: JSON.Object = ["target": target.json]
    object["defaultValue"] = defaultValue
    return .object(object)
  }
}

// The closed union a segment opts into Undo with.
public enum ActUndoRecipe: Sendable, Hashable {
  case fields(restoreCommand: String, targets: [RestoreTarget])
  case createdRecord(restoreCommand: String, record: RecordAddress)
  case command(String, input: JSON, evidence: EvidenceSelection)

  public init(json: JSON) throws {
    let object = try json.asObject()
    switch try object.member("kind").asString() {
    case "fields":
      try object.expectKeys(required: ["kind", "restoreCommand", "targets"])
      self = .fields(restoreCommand: try object.member("restoreCommand").asString(),
                     targets: try object.member("targets").asArray().map { (target: JSON) throws -> RestoreTarget in try RestoreTarget(json: target) })
    case "createdRecord":
      try object.expectKeys(required: ["kind", "restoreCommand", "record"])
      self = .createdRecord(restoreCommand: try object.member("restoreCommand").asString(), record: try RecordAddress(json: object.member("record")))
    case "command":
      try object.expectKeys(required: ["kind", "command", "input", "evidence"])
      self = .command(try object.member("command").asString(), input: try object.member("input"),
                      evidence: try EvidenceSelection(json: object.member("evidence")))
    default: throw JSONError.shape("an unknown recipe")
    }
  }

  public var json: JSON {
    switch self {
    case .fields(let command, let targets):
      ["kind": "fields", "restoreCommand": .string(command), "targets": .array(targets.map(\.json))]
    case .createdRecord(let command, let record):
      ["kind": "createdRecord", "restoreCommand": .string(command), "record": record.json]
    case .command(let name, let input, let evidence):
      ["kind": "command", "command": .string(name), "input": input, "evidence": evidence.json]
    }
  }
}

// MARK: - The restore command's arguments (§6.4)

public enum RestoreOperation: Sendable, Hashable {
  // What a field must find to be restored: its accepted version, or an absent register in the record of that birth.
  public enum Expected: Sendable, Hashable {
    case version(EffectSlot.Version)
    case absent(born: Stamp?)

    public var json: JSON {
      switch self {
      case .version(let version): version.json
      case .absent(let born): ["kind": "absent", "born": born?.json ?? .null]
      }
    }
  }

  // `values`: on a keyed record's life brought back alive, the record's values, which its death did not keep (G1).
  case field(RecordKey, slot: EffectSlot.Slot, expected: Expected, before: JSON, values: JSON.Object? = nil)

  // The composed version that declares a keyed revival's values (§2.4): a client sends them only to a server that
  // advertised it.
  public static let revivalValuesSchema: Int64 = 14
  case createdRecord(RecordKey, rowSeq: Int64, footprint: [EffectSlot])
  // `values`: `{f?, x?}` as the act created the record, client lww, fww, const and time fields and client texts.
  case createRecord(RecordKey, values: JSON.Object)

  public var key: RecordKey {
    switch self {
    case .field(let key, _, _, _, _), .createdRecord(let key, _, _), .createRecord(let key, _): key
    }
  }

  public var json: JSON {
    let address: JSON.Object = ["t": .string(key.type), "id": key.id.json]
    var object = address
    switch self {
    case .field(_, let slot, let expected, let before, let values):
      object["kind"] = "field"
      object["slot"] = slot.json
      object["expected"] = expected.json
      object["before"] = before
      object["values"] = values.map(JSON.object)
    case .createdRecord(_, let rowSeq, let footprint):
      object["kind"] = "createdRecord"
      object["rowSeq"] = JSON(rowSeq)
      object["footprint"] = .array(footprint.map(\.json))
    case .createRecord(_, let values):
      object["kind"] = "createRecord"
      object["values"] = .object(values)
    }
    return .object(object)
  }
}

// `{expectedEpoch, operations}`, every operation restoring a type its command restores, one slot once.
public struct RestoreArguments: Sendable, Hashable {
  public let expectedEpoch: String
  public let operations: [RestoreOperation]

  public init(expectedEpoch: String, operations: [RestoreOperation]) {
    self.expectedEpoch = expectedEpoch
    self.operations = operations
  }

  public var json: JSON { ["expectedEpoch": .string(expectedEpoch), "operations": .array(operations.map(\.json))] }
}

// One operation's outcome in an inverse command's detail.
public struct InverseOutcome: Sendable, Hashable {
  public let index: Int
  public let code: String?

  public init(index: Int, skipped code: String? = nil) {
    self.index = index
    self.code = code
  }

  public var applied: Bool { code == nil }

  public var json: JSON {
    var object: JSON.Object = ["index": JSON(index), "s": applied ? "applied" : "skipped"]
    object["code"] = code.map(JSON.string)
    return .object(object)
  }

  // `{inverse: {outcomes}}` as a restore or an inverse command reports them: one per operation, in order, applied or
  // skipped with a code. Anything else is a malformed result.
  public static func reported(in detail: JSON?, count: Int) throws(JSONError) -> [InverseOutcome] {
    let malformed = JSONError.shape("an inverse result reports each operation")
    guard case .array(let outcomes)? = detail?["inverse"]?["outcomes"], outcomes.count == count else { throw malformed }
    return try outcomes.enumerated().map { (index: Int, outcome: JSON) throws(JSONError) -> InverseOutcome in
      guard case .object(let object) = outcome, object["index"] == JSON(index) else { throw malformed }
      switch object["s"] {
      case "applied"?:
        guard object.count == 2 else { throw malformed }
        return InverseOutcome(index: index)
      case "skipped"?:
        guard object.count == 3, case .string(let code)? = object["code"] else { throw malformed }
        return InverseOutcome(index: index, skipped: code)
      default: throw malformed
      }
    }
  }

  public static func detail(_ outcomes: [InverseOutcome]) -> JSON {
    ["inverse": ["outcomes": .array(outcomes.map(\.json))]]
  }
}

// MARK: - The product inverse command's evidence (§6.4)

public struct Evidence: Sendable, Hashable {
  public struct OwnedField: Sendable, Hashable {
    public var target: Target
    public let version: EffectSlot.Version

    public init(target: Target, version: EffectSlot.Version) {
      self.target = target
      self.version = version
    }
  }

  public struct CreatedRecord: Sendable, Hashable {
    public var record: RecordAddress
    public let rowSeq: Int64
    public let footprint: [EffectSlot]

    public init(record: RecordAddress, rowSeq: Int64, footprint: [EffectSlot]) {
      self.record = record
      self.rowSeq = rowSeq
      self.footprint = footprint
    }
  }

  public struct CreatedScope: Sendable, Hashable {
    public var scope: ScopeRef
    public let seq: Int64

    public init(scope: ScopeRef, seq: Int64) {
      self.scope = scope
      self.seq = seq
    }
  }

  public let expectedEpoch: String
  public var ownedFields: [OwnedField]
  public var unchangedCreatedRecords: [CreatedRecord]
  public var unchangedCreatedScopes: [CreatedScope]

  public init(expectedEpoch: String, ownedFields: [OwnedField], unchangedCreatedRecords: [CreatedRecord], unchangedCreatedScopes: [CreatedScope]) {
    self.expectedEpoch = expectedEpoch
    self.ownedFields = ownedFields
    self.unchangedCreatedRecords = unchangedCreatedRecords
    self.unchangedCreatedScopes = unchangedCreatedScopes
  }

  public var json: JSON {
    ["expectedEpoch": .string(expectedEpoch),
     "ownedFields": .array(ownedFields.map { (owned: OwnedField) -> JSON in ["target": owned.target.json, "version": owned.version.json] }),
     "unchangedCreatedRecords": .array(unchangedCreatedRecords.map { (created: CreatedRecord) -> JSON in
       ["record": created.record.json, "rowSeq": JSON(created.rowSeq), "footprint": .array(created.footprint.map(\.json))]
     }),
     "unchangedCreatedScopes": .array(unchangedCreatedScopes.map { (created: CreatedScope) -> JSON in
       ["scope": created.scope.json, "seq": JSON(created.seq)]
     })]
  }
}

// MARK: - The registry's rules

extension Registry {
  // A slot a generic restore may write back: a client lww register, a client text, or the life of a record a write can
  // bring back, keyed with life or revivable. Never born, a server field or a const. The fault, or nil.
  public func restorableFault(_ type: TypeDef, _ slot: EffectSlot.Slot) -> String? {
    switch slot {
    case .born: return "born is never restored"
    case .life: return type.life && (type.identity == .keyed || type.revivable == true) ? nil : "\(type.name) life cannot be restored"
    case .field(let name):
      guard let field = type.field(name), case .lww = field.kind, field.writer == .client else { return "\(type.name).\(name) is not a client lww register" }
      return nil
    case .text(let name):
      guard let field = type.field(name), case .text = field.kind, field.writer == .client else { return "\(type.name).\(name) is not a client text" }
      return nil
    }
  }

  // A keyed record's life brought back alive: its death kept no field (G1), so its restore carries the record's values.
  public func revivesKeyed(_ type: TypeDef, _ slot: EffectSlot.Slot, _ before: JSON) -> Bool {
    type.identity == .keyed && slot == .life && before == "alive"
  }

  // The values a keyed record's revival brings back, from the record its life's preimage read: its client fields and texts.
  public func revivalValues(_ type: TypeDef, fields: [String: Register], texts: [String: String]) -> JSON.Object {
    let client = { (name: String) -> FieldKind? in type.field(name).flatMap { $0.writer == .client ? $0.kind : nil } }
    let f = fields.compactMap { (name: String, register: Register) -> (String, JSON)? in
      switch client(name) {
      case .lww?, .fww?, .const?, .time?: (name, register.value)
      default: nil
      }
    }
    let x = texts.compactMap { (name: String, text: String) -> (String, JSON)? in
      guard case .text? = client(name) else { return nil }
      return (name, .string(text))
    }
    var values: JSON.Object = [:]
    if !f.isEmpty { values["f"] = .object(JSON.Object(uniqueKeysWithValues: f)) }
    if !x.isEmpty { values["x"] = .object(JSON.Object(uniqueKeysWithValues: x)) }
    return values
  }

  // A record a creation recipe may delete again, or create again: a type with life that governs no tree and is not saved
  // whole.
  public func creatableFault(_ type: TypeDef) -> String? {
    if !type.life { return "\(type.name) has no life" }
    if type.governsTree { return "\(type.name) governs a tree: its creation is undone by a product command" }
    if type.wholePut { return "\(type.name) is saved whole" }
    return nil
  }

  // A logical value on a slot's domain: a life is alive or dead, a text within its bound, a field a value it admits.
  public func valueFault(_ type: TypeDef, _ slot: EffectSlot.Slot, _ value: JSON) -> String? {
    switch slot {
    case .born: return "born has no logical value"
    case .life: return value == "alive" || value == "dead" ? nil : "a life is alive or dead"
    case .text(let name):
      guard case .string(let text) = value else { return "a text is a string" }
      guard let bounds = type.field(name)?.bounds, let max = bounds.max else { return nil }
      return bounds.unit.length(of: text) > max ? "a text over its bound" : nil
    case .field(let name):
      guard let field = type.field(name) else { return "\(type.name).\(name) is no field" }
      return admits(value, for: field, of: type) ? nil : "a value off its field's domain"
    }
  }

  // The registry scope kind a ScopeRef names, a tree or overlay naming a governing id; nil for a device scope.
  func addressKind(_ scope: ScopeRef) -> ScopeKind? {
    guard let kind = scopeKind(of: scope), isScopeID(scope) else { return nil }
    if case .device = scope.kind { return nil }
    return kind
  }

  func addressFault(_ address: RecordAddress) -> String? {
    guard let type = type(address.key.type), let kind = addressKind(address.scope), type.scope == kind else {
      return "\(address.key.type) does not live in \(address.scope)"
    }
    return isID(address.key.id.json, of: type) ? nil : "an id outside \(type.name)'s pattern"
  }

  func restores(_ command: String, kind: ScopeKind) -> CommandDef? {
    guard let definition = self.command(command), definition.engine == .restore, definition.scope == kind else { return nil }
    return definition
  }

  // §7.3 a segment's recipe against its scope: the scope kind's restore command and targets of its own scope and types,
  // restorable slots and defaults on their domains, a creatable created record, or an inverse command of the scope kind
  // with evidence of records and created trees and overlays. The fault, or nil.
  public func recipeFault(_ recipe: ActUndoRecipe, in scope: ScopeRef) -> String? {
    guard let kind = scopeKind(of: scope) else { return "\(scope) is no scope" }
    switch recipe {
    case .fields(let name, let targets):
      guard let command = restores(name, kind: kind) else { return "a fields recipe names its scope kind's restore command" }
      guard !targets.isEmpty else { return "a fields recipe lists targets" }
      for item in targets {
        guard item.target.scope == scope else { return "a generic target lives in its segment scope" }
        if let fault = addressFault(item.target.address) { return fault }
        let type = type(item.target.key.type)!
        guard command.predicts.contains(where: { $0.isSameID(as: type.name) }) else { return "\(name) restores no \(type.name)" }
        if let fault = restorableFault(type, item.target.slot) { return fault }
        if let value = item.defaultValue, valueFault(type, item.target.slot, value) != nil { return "a default off its slot domain" }
      }
      return nil
    case .createdRecord(let name, let record):
      guard let command = restores(name, kind: kind) else { return "a created record recipe names its scope kind's restore command" }
      guard record.scope == scope else { return "a created record lives in its segment scope" }
      if let fault = addressFault(record) { return fault }
      guard command.predicts.contains(where: { $0.isSameID(as: record.key.type) }) else { return "\(name) restores no \(record.key.type)" }
      return creatableFault(type(record.key.type)!)
    case .command(let name, _, let evidence):
      guard let command = self.command(name), command.inverse, command.scope == kind else { return "\(name) is no inverse command of \(kind)" }
      for target in evidence.ownedFields {
        if let fault = addressFault(target.address) { return fault }
      }
      for record in evidence.unchangedCreatedRecords {
        if let fault = addressFault(record) { return fault }
        guard type(record.key.type)?.life == true else { return "\(record.key.type) has no life" }
      }
      for created in evidence.unchangedCreatedScopes {
        guard let createdKind = addressKind(created), createdKind == .tree || createdKind == .overlay else { return "a created scope is a tree or an overlay" }
      }
      return nil
    }
  }

  // §6.4 an engine restore's fixed arguments, parsed against its command, or the reason they are malformed.
  public func restoreArguments(_ json: JSON, of command: CommandDef) throws(JSONError) -> RestoreArguments {
    let malformed = { (reason: String) -> JSONError in JSONError.shape(reason) }
    guard case .object(let args) = json, (try? args.expectKeys(required: ["expectedEpoch", "operations"])) != nil else {
      throw malformed("restore arguments are {expectedEpoch, operations}")
    }
    guard case .string(let epoch)? = args["expectedEpoch"], !epoch.isEmpty else { throw malformed("an expected epoch") }
    guard case .array(let operations)? = args["operations"], !operations.isEmpty else { throw malformed("a restore restores something") }
    var seen: Set<JSON> = []
    var parsed: [RestoreOperation] = []
    for operation in operations {
      guard case .object(let op) = operation else { throw malformed("an operation is an object") }
      guard case .string(let name)? = op["t"], let type = type(name), command.predicts.contains(where: { $0.isSameID(as: name) }) else {
        throw malformed("\(command.name) restores no such type")
      }
      guard let idJSON = op["id"], isID(idJSON, of: type), let id = try? RecordID(json: idJSON) else { throw malformed("an id outside its pattern") }
      let key = RecordKey(name, id)
      switch op["kind"] {
      case "field"?:
        guard (try? op.expectKeys(required: ["kind", "t", "id", "slot", "expected", "before"], optional: ["values"])) != nil,
              let slot = try? EffectSlot.Slot(json: op.member("slot")) else { throw malformed("a field operation is {t, id, slot, expected, before, values?}") }
        let before = op["before"]!
        if let fault = restorableFault(type, slot) ?? valueFault(type, slot, before) { throw malformed(fault) }
        var values: JSON.Object?
        if let given = op["values"] {
          guard revivesKeyed(type, slot, before) else { throw malformed("values bring back a keyed record's life") }
          guard case .object(let object) = given else { throw malformed("values are {f?, x?}") }
          if let fault = valuesFault(type, object) { throw malformed(fault) }
          values = object
        }
        let expected = op["expected"]!
        let parsedExpected: RestoreOperation.Expected
        if expected["kind"] == "absent" {
          guard case .object(let absent) = expected, absent.count == 2, let born = absent["born"], slot != .life else {
            throw malformed("an absent expectation names a birth and a field")
          }
          if type.hasBorn {
            guard let stamp = try? Stamp(json: born), stamp != .unset else { throw malformed("an absent expectation names the record birth") }
            parsedExpected = .absent(born: stamp)
          } else {
            guard born.isNull else { throw malformed("an absent expectation names the record birth") }
            parsedExpected = .absent(born: nil)
          }
        } else {
          guard let version = try? EffectSlot.Version(json: expected), version.fits(slot) else { throw malformed("a version fits its slot") }
          parsedExpected = .version(version)
        }
        guard seen.insert([key.json, slot.json]).inserted else { throw malformed("one operation per slot") }
        parsed.append(.field(key, slot: slot, expected: parsedExpected, before: before, values: values))
      case "createdRecord"?:
        guard (try? op.expectKeys(required: ["kind", "t", "id", "rowSeq", "footprint"])) != nil else {
          throw malformed("a created record operation is {t, id, rowSeq, footprint}")
        }
        if let fault = creatableFault(type) { throw malformed(fault) }
        let footprint = try self.footprint(op["footprint"]!, of: type)
        guard case .number? = op["rowSeq"], let rowSeq = try? op["rowSeq"]!.asInteger(), rowSeq > 0 else { throw malformed("a row sequence") }
        parsed.append(.createdRecord(key, rowSeq: rowSeq, footprint: footprint))
      case "createRecord"?:
        guard (try? op.expectKeys(required: ["kind", "t", "id", "values"])) != nil, case .object(let values)? = op["values"] else {
          throw malformed("a create operation is {t, id, values}")
        }
        if let fault = creatableFault(type) ?? valuesFault(type, values) { throw malformed(fault) }
        parsed.append(.createRecord(key, values: values))
      default: throw malformed("an unknown restore operation")
      }
    }
    return RestoreArguments(expectedEpoch: epoch, operations: parsed)
  }

  // A complete footprint: born, life, fields and texts the type declares, each with its version, in slot order.
  func footprint(_ json: JSON, of type: TypeDef) throws(JSONError) -> [EffectSlot] {
    guard case .array(let items) = json, !items.isEmpty else { throw JSONError.shape("a footprint lists slots") }
    var previous: EffectSlot.Slot?
    var footprint: [EffectSlot] = []
    for item in items {
      let slot = try EffectSlot(strict: item)
      let declared: Bool = switch slot.slot {
      case .born: type.hasBorn
      case .life: type.life
      case .field(let name): type.field(name).map { (field: FieldDef) -> Bool in
          if case .text = field.kind { return false }
          if case .serial = field.kind { return false }
          return true
        } ?? false
      case .text(let name): type.field(name).map { (field: FieldDef) -> Bool in
          if case .text = field.kind { return true }
          return false
        } ?? false
      }
      guard declared else { throw JSONError.shape("a footprint slot outside its type") }
      if let previous, !EffectSlot.Slot.precedes(previous, slot.slot) { throw JSONError.shape("a footprint is in slot order") }
      previous = slot.slot
      footprint.append(slot)
    }
    return footprint
  }

  // The values a create, or a keyed record's revival, writes: client lww, fww, const or time fields and client texts.
  func valuesFault(_ type: TypeDef, _ values: JSON.Object) -> String? {
    guard values.keys.allSatisfy({ $0 == "f" || $0 == "x" }) else { return "values are {f?, x?}" }
    if let f = values["f"] {
      guard case .object(let fields) = f else { return "values' fields are an object" }
      for (name, value) in fields.members {
        guard let field = type.field(name), field.writer == .client else { return "\(type.name).\(name) is not a client value" }
        switch field.kind {
        case .lww, .fww, .const, .time: break
        default: return "\(type.name).\(name) is not a client value"
        }
        guard admits(value, for: field, of: type) else { return "a value off its field's domain" }
      }
    }
    if let x = values["x"] {
      guard case .object(let texts) = x else { return "values' texts are an object" }
      for (name, text) in texts.members {
        guard let field = type.field(name), case .text = field.kind, field.writer == .client, case .string(let value) = text else {
          return "\(type.name).\(name) is not a client text"
        }
        if let bounds = field.bounds, let max = bounds.max, bounds.unit.length(of: value) > max { return "a text over its bound" }
      }
    }
    return nil
  }

  // §6.4 the engine-built evidence of a product inverse command, parsed, or the reason it is malformed.
  public func evidence(_ json: JSON) throws(JSONError) -> Evidence {
    let malformed = JSONError.shape("malformed evidence")
    guard case .object(let object) = json,
          (try? object.expectKeys(required: ["expectedEpoch", "ownedFields", "unchangedCreatedRecords", "unchangedCreatedScopes"])) != nil,
          case .string(let epoch)? = object["expectedEpoch"], !epoch.isEmpty,
          case .array(let owned)? = object["ownedFields"], case .array(let records)? = object["unchangedCreatedRecords"],
          case .array(let scopes)? = object["unchangedCreatedScopes"] else { throw malformed }
    let address = { (json: JSON) throws(JSONError) -> RecordAddress in
      guard let address = try? RecordAddress(json: json), self.addressFault(address) == nil else { throw malformed }
      return address
    }
    let ownedFields = try owned.map { (item: JSON) throws(JSONError) -> Evidence.OwnedField in
      guard case .object(let pair) = item, pair.count == 2, let targetJSON = pair["target"], let versionJSON = pair["version"],
            let target = try? Target(json: targetJSON), let version = try? EffectSlot.Version(json: versionJSON), version.fits(target.slot)
      else { throw malformed }
      _ = try address(target.address.json)
      return Evidence.OwnedField(target: target, version: version)
    }
    let createdRecords = try records.map { (item: JSON) throws(JSONError) -> Evidence.CreatedRecord in
      guard case .object(let created) = item, (try? created.expectKeys(required: ["record", "rowSeq", "footprint"])) != nil,
            case .number? = created["rowSeq"], let rowSeq = try? created["rowSeq"]!.asInteger(), rowSeq > 0 else { throw malformed }
      let record = try address(created["record"]!)
      return Evidence.CreatedRecord(record: record, rowSeq: rowSeq, footprint: try footprint(created["footprint"]!, of: type(record.key.type)!))
    }
    let createdScopes = try scopes.map { (item: JSON) throws(JSONError) -> Evidence.CreatedScope in
      guard case .object(let created) = item, (try? created.expectKeys(required: ["scope", "seq"])) != nil,
            let scope = try? ScopeRef(json: created["scope"]!), let kind = addressKind(scope), kind == .tree || kind == .overlay,
            case .number? = created["seq"], let seq = try? created["seq"]!.asInteger(), seq >= 0 else { throw malformed }
      return Evidence.CreatedScope(scope: scope, seq: seq)
    }
    return Evidence(expectedEpoch: epoch, ownedFields: ownedFields, unchangedCreatedRecords: createdRecords, unchangedCreatedScopes: createdScopes)
  }
}
