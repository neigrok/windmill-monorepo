import SyncAPI
import SyncCore

// K-3 the journal of reversible acts (engine.md §2.5, §7.3 Undo of an act): each act's source entries with their recipes,
// first local preimages and the receipts or refusals their ACK transactions record, beside the inverse requests and the
// cancellation receipts that read them. It lives in its replica's namespace; its values are local user data and its ids
// private sync data, so none of it enters telemetry, logs or reports.

// MARK: - Reversible acts

// A record as a view read it, kept for a revival to draw: its birth, field registers and texts, never its life.
public struct RecordValues: Sendable, Hashable {
  public let born: Stamp?
  public var fields: [String: Register]
  public let texts: [String: String]

  public init(_ record: ViewRecord) {
    born = record.lattice.born
    fields = record.lattice.fields
    texts = record.texts
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: [], optional: ["born", "f", "x"])
    var registers = object
    registers["x"] = nil
    let lattice = try Lattice(json: .object(registers))
    born = lattice.born
    fields = lattice.fields
    var texts: [String: String] = [:]
    for (name, text) in try object["x"]?.asObject().members ?? [] { texts[name] = try text.asString() }
    self.texts = texts
  }

  var json: JSON {
    guard case .object(var object) = Lattice(born: born, fields: fields).json else { return [:] }
    if !texts.isEmpty { object["x"] = .object(JSON.Object(uniqueKeysWithValues: texts.map { ($0.key, JSON.string($0.value)) })) }
    return .object(object)
  }
}

// What a slot read before an act changed it: a field, a text or a life, as a logical value, with the sequence of the
// row it was read over (nil where none was) and the epoch that sequence counts in. A life's preimage keeps the record it
// read, which a revival draws.
public struct Preimage: Sendable, Hashable {
  public var target: Target
  public var value: JSON
  public var rowSeq: Int64?
  public var epoch: String?
  public var record: RecordValues?

  public init(target: Target, value: JSON, rowSeq: Int64? = nil, epoch: String? = nil, record: RecordValues? = nil) {
    self.target = target
    self.value = value
    self.rowSeq = rowSeq
    self.epoch = epoch
    self.record = record
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["target", "value"], optional: ["rowSeq", "epoch", "record"])
    self.init(target: try Target(json: object.member("target")), value: try object.member("value"),
              rowSeq: try object["rowSeq"]?.nullable { (seq: JSON) throws -> Int64 in try seq.asInteger() },
              epoch: try object["epoch"]?.nullable { (epoch: JSON) throws -> String in try epoch.asString() },
              record: try object["record"].map { (record: JSON) throws -> RecordValues in try RecordValues(json: record) })
  }

  var json: JSON {
    var object: JSON.Object = ["target": target.json, "value": value, "rowSeq": rowSeq.map { JSON($0) } ?? .null,
                               "epoch": epoch.map(JSON.string) ?? .null]
    object["record"] = record?.json
    return .object(object)
  }

  // §7.3 Capture: `drawn` read over this device's own earlier write of the record, so the preimage stands on the row that
  // write left, once the write's receipt shows it started where the preimage stood, in the preimage's epoch (one taken
  // before the replica held an epoch takes the receipt's). An entry with no receipt, an ordinary one, moves nothing.
  mutating func step(over entry: OutboxEntry) {
    guard entry.state == .acked, let effects = entry.acceptedEffects, let answered = entry.resultEpoch, (epoch ?? answered).isSameID(as: answered),
          entry.deltas(in: target.scope).contains(where: { $0.key == target.key }),
          let row = effects.first(where: { $0.scope == target.scope })?.rows.first(where: { $0.key == target.key }),
          row.beforeRowSeq == rowSeq else { return }
    rowSeq = row.rowSeq
    epoch = answered
  }
}

// The value an act left in a target, which a Redo writes back.
public struct WrittenValue: Sendable, Hashable {
  public var target: Target
  public var value: JSON

  public init(target: Target, value: JSON) {
    self.target = target
    self.value = value
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["target", "value"])
    self.init(target: try Target(json: object.member("target")), value: try object.member("value"))
  }

  var json: JSON { ["target": target.json, "value": value] }
}

// A source entry's answer under one epoch: its accepted receipt, or its terminal refusal.
public struct Attempt: Sendable, Hashable {
  public let epoch: String
  public let n: Int64
  public let ok: Bool
  public var acceptedEffects: [EffectReceipt]?

  public init(epoch: String, n: Int64, ok: Bool, acceptedEffects: [EffectReceipt]? = nil) {
    self.epoch = epoch
    self.n = n
    self.ok = ok
    self.acceptedEffects = acceptedEffects
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["epoch", "n", "outcome"], optional: ["acceptedEffects"])
    self.init(epoch: try object.member("epoch").asString(), n: try object.member("n").asInteger(),
              ok: try object.member("outcome").asString() == "ok",
              acceptedEffects: try object["acceptedEffects"]?.asArray().map { (effect: JSON) throws -> EffectReceipt in try EffectReceipt(json: effect) })
  }

  var json: JSON {
    var object: JSON.Object = ["epoch": .string(epoch), "n": JSON(n), "outcome": ok ? "ok" : "refused"]
    object["acceptedEffects"] = acceptedEffects.map { .array($0.map(\.json)) }
    return .object(object)
  }
}

// One segment's entry of a reversible act.
public struct JournalSource: Sendable, Hashable {
  public let localId: String
  public var originScope: ScopeRef
  public var recipes: [ActUndoRecipe]
  public var preimages: [Preimage]
  public var written: [WrittenValue]
  public var attempts: [Attempt]
  // An epoch change took its history: it was collected before it could earn the new epoch's receipt.
  public var unavailable: Bool

  public init(localId: String, originScope: ScopeRef, recipes: [ActUndoRecipe], preimages: [Preimage], written: [WrittenValue] = [],
              attempts: [Attempt] = [], unavailable: Bool = false) {
    self.localId = localId
    self.originScope = originScope
    self.recipes = recipes
    self.preimages = preimages
    self.written = written
    self.attempts = attempts
    self.unavailable = unavailable
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["localId", "originScope", "recipes", "preimages", "attempts"], optional: ["written", "unavailable"])
    self.init(
      localId: try object.member("localId").asString(), originScope: try ScopeRef(json: object.member("originScope")),
      recipes: try object.member("recipes").asArray().map { (recipe: JSON) throws -> ActUndoRecipe in try ActUndoRecipe(json: recipe) },
      preimages: try object.member("preimages").asArray().map { (preimage: JSON) throws -> Preimage in try Preimage(json: preimage) },
      written: try (object["written"]?.asArray() ?? []).map { (written: JSON) throws -> WrittenValue in try WrittenValue(json: written) },
      attempts: try object.member("attempts").asArray().map { (attempt: JSON) throws -> Attempt in try Attempt(json: attempt) },
      unavailable: try object["unavailable"]?.asBool() ?? false)
  }

  var json: JSON {
    var object: JSON.Object = [
      "localId": .string(localId), "originScope": originScope.json, "recipes": .array(recipes.map(\.json)),
      "preimages": .array(preimages.map(\.json)), "written": .array(written.map(\.json)), "attempts": .array(attempts.map(\.json)),
    ]
    object["unavailable"] = unavailable ? true : nil
    return .object(object)
  }

  // The receipt this epoch's acceptance holds, or nil: no answer yet, a refusal, or another epoch's.
  func accepted(in epoch: String?) -> [EffectReceipt]? {
    attempts.first { $0.ok && $0.epoch.isSameID(as: epoch) }.map { $0.acceptedEffects ?? [] }
  }
}

// §7.3 an act opted into Undo, its id its gesture id.
public struct ReversibleAct: Sendable, Hashable {
  public let actId: String
  public var retained: Bool
  public var sourceEntries: [JournalSource]

  public init(actId: String, retained: Bool = true, sourceEntries: [JournalSource]) {
    self.actId = actId
    self.retained = retained
    self.sourceEntries = sourceEntries
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["version", "actId", "retained", "sourceEntries"])
    guard try object.member("version").asInteger() == 1 else { throw JSONError.shape("a reversible act is version 1") }
    self.init(actId: try object.member("actId").asString(), retained: try object.member("retained").asBool(),
              sourceEntries: try object.member("sourceEntries").asArray().map { (source: JSON) throws -> JournalSource in try JournalSource(json: source) })
  }

  public var json: JSON {
    ["version": 1, "actId": .string(actId), "retained": .bool(retained), "sourceEntries": .array(sourceEntries.map(\.json))]
  }
}

// MARK: - Version references and cancellations

// Where a register's value came from when a cancellation took the act's write out of `drawn`, so its Redo expects it.
public indirect enum VersionReference: Sendable, Hashable {
  case accepted(epoch: String?, version: EffectSlot.Version)
  case pending(localId: String, target: Target)
  case fieldAbsent(epoch: String?, recordBirth: VersionReference?)
  case recordAbsent(epoch: String?)
  // A pending reference whose entry wrote no version of its target that the device could read: it binds nothing.
  case unbound

  init(json: JSON) throws {
    let object = try json.asObject()
    let epoch = { () throws -> String? in try object.member("epoch").nullable { (epoch: JSON) throws -> String in try epoch.asString() } }
    switch try object.member("kind").asString() {
    case "accepted": self = .accepted(epoch: try epoch(), version: try EffectSlot.Version(json: object.member("version")))
    case "pending": self = .pending(localId: try object.member("localId").asString(), target: try Target(json: object.member("target")))
    case "fieldAbsent":
      self = .fieldAbsent(epoch: try epoch(), recordBirth: try object.member("recordBirth").nullable { (birth: JSON) throws -> VersionReference in
        try VersionReference(json: birth)
      })
    case "recordAbsent": self = .recordAbsent(epoch: try epoch())
    case "unbound": self = .unbound
    default: throw JSONError.shape("an unknown version reference")
    }
  }

  var json: JSON {
    switch self {
    case .accepted(let epoch, let version): ["kind": "accepted", "epoch": epoch.map(JSON.string) ?? .null, "version": version.json]
    case .pending(let localId, let target): ["kind": "pending", "localId": .string(localId), "target": target.json]
    case .fieldAbsent(let epoch, let birth): ["kind": "fieldAbsent", "epoch": epoch.map(JSON.string) ?? .null, "recordBirth": birth?.json ?? .null]
    case .recordAbsent(let epoch): ["kind": "recordAbsent", "epoch": epoch.map(JSON.string) ?? .null]
    case .unbound: ["kind": "unbound"]
    }
  }

  // The pending entries this reference, and the birth it names, wait on.
  var pendingLocalIds: [String] {
    switch self {
    case .pending(let localId, _): [localId]
    case .fieldAbsent(_, let birth): birth?.pendingLocalIds ?? []
    case .accepted, .recordAbsent, .unbound: []
    }
  }

  // A reference taken before the replica held an epoch belongs to the epoch it then takes.
  func bound(to epoch: String?) -> VersionReference {
    switch self {
    case .accepted(nil, let version): .accepted(epoch: epoch, version: version)
    case .fieldAbsent(let held, let birth): .fieldAbsent(epoch: held ?? epoch, recordBirth: birth?.bound(to: epoch))
    case .recordAbsent(nil): .recordAbsent(epoch: epoch)
    default: self
    }
  }

  // The epoch it was taken in: nil before the replica held one, and for a pending or unbound reference.
  var epoch: String? {
    switch self {
    case .accepted(let epoch, _), .fieldAbsent(let epoch, _), .recordAbsent(let epoch): epoch
    case .pending, .unbound: nil
    }
  }

  // The reference with each pending one to `localId` bound, at that entry's result, to the version `bind` finds for its
  // target.
  func resolving(_ localId: String, by bind: (Target) -> VersionReference) -> VersionReference {
    switch self {
    case .pending(let id, let target) where id.isSameID(as: localId): bind(target)
    case .fieldAbsent(let epoch, let birth): .fieldAbsent(epoch: epoch, recordBirth: birth?.resolving(localId, by: bind))
    default: self
    }
  }
}

// One change a held cancellation took out of `drawn`, and what its Redo must find to put it back.
public enum CancellationUnit: Sendable, Hashable {
  case field(ownerLocalId: String, target: Target, redoValue: JSON?, restored: VersionReference, restoredValue: JSON?)
  case createdRecord(ownerLocalId: String, record: RecordAddress, redoValues: JSON.Object, restored: VersionReference)

  init(json: JSON) throws {
    let object = try json.asObject()
    let owner = try object.member("ownerLocalId").asString()
    let restored = try VersionReference(json: object.member("restored"))
    switch try object.member("kind").asString() {
    case "field":
      self = .field(ownerLocalId: owner, target: try Target(json: object.member("target")), redoValue: object["redoValue"], restored: restored,
                    restoredValue: object["restoredValue"])
    case "createdRecord":
      self = .createdRecord(ownerLocalId: owner, record: try RecordAddress(json: object.member("record")),
                            redoValues: try object.member("redoValues").asObject(), restored: restored)
    default: throw JSONError.shape("an unknown cancellation unit")
    }
  }

  var json: JSON {
    switch self {
    case .field(let owner, let target, let value, let restored, let restoredValue):
      var object: JSON.Object = ["kind": "field", "ownerLocalId": .string(owner), "target": target.json, "restored": restored.json]
      object["redoValue"] = value
      object["restoredValue"] = restoredValue
      return .object(object)
    case .createdRecord(let owner, let record, let values, let restored):
      return ["kind": "createdRecord", "ownerLocalId": .string(owner), "record": record.json, "redoValues": .object(values), "restored": restored.json]
    }
  }

  var ownerLocalId: String {
    switch self {
    case .field(let owner, _, _, _, _), .createdRecord(let owner, _, _, _): owner
    }
  }

  // The record the unit's change was to.
  var address: RecordAddress {
    switch self {
    case .field(_, let target, _, _, _): target.address
    case .createdRecord(_, let record, _, _): record
    }
  }

  func restoring(_ restored: VersionReference) -> CancellationUnit {
    switch self {
    case .field(let owner, let target, let value, _, let restoredValue):
      .field(ownerLocalId: owner, target: target, redoValue: value, restored: restored, restoredValue: restoredValue)
    case .createdRecord(let owner, let record, let values, _): .createdRecord(ownerLocalId: owner, record: record, redoValues: values, restored: restored)
    }
  }

  func bound(to epoch: String?) -> CancellationUnit {
    switch self {
    case .field(let owner, let target, let value, let restored, let restoredValue):
      .field(ownerLocalId: owner, target: target, redoValue: value, restored: restored.bound(to: epoch), restoredValue: restoredValue)
    case .createdRecord(let owner, let record, let values, let restored):
      .createdRecord(ownerLocalId: owner, record: record, redoValues: values, restored: restored.bound(to: epoch))
    }
  }

  var restored: VersionReference {
    switch self {
    case .field(_, _, _, let restored, _), .createdRecord(_, _, _, let restored): restored
    }
  }
}

// §7.3 what a held cancellation actually took out of `drawn`, which its Redo restores.
public struct CancellationReceipt: Sendable, Hashable {
  // An entry the cancellation took out, in the scope it was committed in; `command` marks a product command, whose
  // effects only the product can write again.
  public struct Source: Sendable, Hashable {
    public var localId: String
    public var originScope: ScopeRef
    public let command: Bool

    public init(localId: String, originScope: ScopeRef, command: Bool) {
      self.localId = localId
      self.originScope = originScope
      self.command = command
    }

    init(json: JSON) throws {
      let object = try json.asObject()
      try object.expectKeys(required: ["localId", "originScope"], optional: ["command"])
      self.init(localId: try object.member("localId").asString(), originScope: try ScopeRef(json: object.member("originScope")),
                command: try object["command"]?.asBool() ?? false)
    }

    var json: JSON {
      var object: JSON.Object = ["localId": .string(localId), "originScope": originScope.json]
      object["command"] = command ? true : nil
      return .object(object)
    }
  }

  public let inverseActId: String
  public let cancelledActId: String
  public var sourceEntries: [Source]
  public var units: [CancellationUnit]
  public var retained: Bool

  public init(inverseActId: String, cancelledActId: String, sourceEntries: [Source], units: [CancellationUnit], retained: Bool = true) {
    self.inverseActId = inverseActId
    self.cancelledActId = cancelledActId
    self.sourceEntries = sourceEntries
    self.units = units
    self.retained = retained
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["version", "inverseActId", "cancelledActId", "sourceEntries", "units"], optional: ["retained"])
    self.init(inverseActId: try object.member("inverseActId").asString(), cancelledActId: try object.member("cancelledActId").asString(),
              sourceEntries: try object.member("sourceEntries").asArray().map { (source: JSON) throws -> Source in try Source(json: source) },
              units: try object.member("units").asArray().map { (unit: JSON) throws -> CancellationUnit in try CancellationUnit(json: unit) },
              retained: try object["retained"]?.asBool() ?? true)
  }

  public var json: JSON {
    var object: JSON.Object = ["version": 1, "inverseActId": .string(inverseActId), "cancelledActId": .string(cancelledActId),
                               "sourceEntries": .array(sourceEntries.map(\.json)), "units": .array(units.map(\.json))]
    object["retained"] = retained ? nil : false
    return .object(object)
  }
}

// MARK: - Inverse requests

// A restore operation as an Undo or a Redo plans it, before materialization binds its expectation.
public enum PlannedOperation: Sendable, Hashable {
  // `record`: for a life it revives, the record its preimage read, which the projection draws where the view lacks it.
  case field(Target, before: JSON?, reference: VersionReference?, record: RecordValues?)
  case createdRecord(RecordAddress)
  case createRecord(RecordAddress, values: JSON.Object, reference: VersionReference)

  init(json: JSON) throws {
    let object = try json.asObject()
    switch try object.member("kind").asString() {
    case "field":
      self = .field(try Target(json: object.member("target")), before: object["before"],
                    reference: try object["reference"].map { (reference: JSON) throws -> VersionReference in try VersionReference(json: reference) },
                    record: try object["record"].map { (record: JSON) throws -> RecordValues in try RecordValues(json: record) })
    case "createdRecord": self = .createdRecord(try RecordAddress(json: object.member("record")))
    case "createRecord":
      self = .createRecord(try RecordAddress(json: object.member("record")), values: try object.member("values").asObject(),
                           reference: try VersionReference(json: object.member("reference")))
    default: throw JSONError.shape("an unknown planned operation")
    }
  }

  var json: JSON {
    switch self {
    case .field(let target, let before, let reference, let record):
      var object: JSON.Object = ["kind": "field", "target": target.json]
      object["before"] = before
      object["reference"] = reference?.json
      object["record"] = record?.json
      return .object(object)
    case .createdRecord(let record): return ["kind": "createdRecord", "record": record.json]
    case .createRecord(let record, let values, let reference):
      return ["kind": "createRecord", "record": record.json, "values": .object(values), "reference": reference.json]
    }
  }

  public var address: RecordAddress {
    switch self {
    case .field(let target, _, _, _): target.address
    case .createdRecord(let record), .createRecord(let record, _, _): record
    }
  }

  var reference: VersionReference? {
    switch self {
    case .field(_, _, let reference, _): reference
    case .createRecord(_, _, let reference): reference
    case .createdRecord: nil
    }
  }

  func bound(to epoch: String?) -> PlannedOperation {
    switch self {
    case .field(let target, let before, let reference, let record): .field(target, before: before, reference: reference?.bound(to: epoch), record: record)
    case .createRecord(let record, let values, let reference): .createRecord(record, values: values, reference: reference.bound(to: epoch))
    case .createdRecord: self
    }
  }

  func resolving(_ localId: String, by bind: (Target) -> VersionReference) -> PlannedOperation {
    switch self {
    case .field(let target, let before, let reference, let record):
      .field(target, before: before, reference: reference?.resolving(localId, by: bind), record: record)
    case .createRecord(let record, let values, let reference):
      .createRecord(record, values: values, reference: reference.resolving(localId, by: bind))
    case .createdRecord: self
    }
  }
}

// What an inverse slot runs: a restore of its operations, a product inverse command, or nothing once the slot settled.
public enum SlotRecipe: Sendable, Hashable {
  case restore(command: String, operations: [PlannedOperation])
  case command(String, input: JSON, evidence: EvidenceSelection)
  case withdrawn(command: String)

  init(json: JSON) throws {
    let object = try json.asObject()
    switch try object.member("kind").asString() {
    case "restore":
      self = .restore(command: try object.member("command").asString(),
                      operations: try object.member("operations").asArray().map { (operation: JSON) throws -> PlannedOperation in try PlannedOperation(json: operation) })
    case "command":
      self = .command(try object.member("command").asString(), input: try object.member("input"),
                      evidence: try EvidenceSelection(json: object.member("evidence")))
    case "withdrawn": self = .withdrawn(command: try object.member("command").asString())
    default: throw JSONError.shape("an unknown slot recipe")
    }
  }

  var json: JSON {
    switch self {
    case .restore(let command, let operations): ["kind": "restore", "command": .string(command), "operations": .array(operations.map(\.json))]
    case .command(let name, let input, let evidence): ["kind": "command", "command": .string(name), "input": input, "evidence": evidence.json]
    case .withdrawn(let command): ["kind": "withdrawn", "command": .string(command)]
    }
  }

  public var command: String {
    switch self {
    case .restore(let command, _), .command(let command, _, _), .withdrawn(let command): command
    }
  }

  // The conditional operations it counts: each restore operation, an atomic product command one.
  var count: Int {
    guard case .restore(_, let operations) = self else { return 1 }
    return operations.count
  }
}

public enum InverseState: String, Sendable, Hashable {
  case waiting, materialized, settled
}

// One outbox entry an inverse request reserved in its scope. `skipped`: the codes of the operations materialization
// skipped before sending, which the request's counts take with the slot's outcomes.
public struct InverseSlot: Sendable, Hashable {
  public let localId: String
  public let commitOrder: Int64
  public var originScope: ScopeRef
  public var recipe: SlotRecipe
  public var state: InverseState
  public var skipped: [String]?
  public var outcomes: [InverseOutcome]?
  public var changed: Bool?

  init(localId: String, commitOrder: Int64, originScope: ScopeRef, recipe: SlotRecipe) {
    self.localId = localId
    self.commitOrder = commitOrder
    self.originScope = originScope
    self.recipe = recipe
    state = .waiting
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["localId", "commitOrder", "originScope", "recipe", "state"], optional: ["skipped", "outcomes", "changed"])
    guard let state = InverseState(rawValue: try object.member("state").asString()) else { throw JSONError.shape("a slot state") }
    localId = try object.member("localId").asString()
    commitOrder = try object.member("commitOrder").asInteger()
    originScope = try ScopeRef(json: object.member("originScope"))
    recipe = try SlotRecipe(json: object.member("recipe"))
    self.state = state
    skipped = try object["skipped"]?.asArray().map { (skip: JSON) throws -> String in try skip.asObject().member("code").asString() }
    outcomes = try object["outcomes"]?.asArray().map { (outcome: JSON) throws -> InverseOutcome in
      let fields = try outcome.asObject()
      let code: String? = try fields["code"]?.asString()
      return InverseOutcome(index: Int(try fields.member("index").asInteger()), skipped: code)
    }
    changed = try object["changed"]?.asBool()
  }

  var json: JSON {
    var object: JSON.Object = ["localId": .string(localId), "commitOrder": JSON(commitOrder), "originScope": originScope.json,
                               "recipe": recipe.json, "state": .string(state.rawValue)]
    object["skipped"] = skipped.map { (codes: [String]) -> JSON in .array(codes.map { (code: String) -> JSON in ["code": .string(code)] }) }
    object["outcomes"] = outcomes.map { .array($0.map(\.json)) }
    object["changed"] = changed.map(JSON.bool)
    return .object(object)
  }
}

// §7.3 one Undo or Redo of an act: its slots are outbox entries whose `inverseOf` names the request.
public struct InverseRequest: Sendable, Hashable {
  public let requestId: String
  public let sourceActId: String
  public let inverseActId: String
  public var state: InverseState
  // The device time it was asked at, which the engine's first start reports the oldest waiting one's age from.
  public let requestedAt: Int64
  public let localChanged: Bool?
  public var slots: [InverseSlot]
  public var result: InverseResult?

  init(requestId: String, sourceActId: String, inverseActId: String, state: InverseState, requestedAt: Int64, localChanged: Bool?,
       slots: [InverseSlot], result: InverseResult? = nil) {
    self.requestId = requestId
    self.sourceActId = sourceActId
    self.inverseActId = inverseActId
    self.state = state
    self.requestedAt = requestedAt
    self.localChanged = localChanged
    self.slots = slots
    self.result = result
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["version", "requestId", "sourceActId", "inverseActId", "state", "requestedAt", "slots"],
                          optional: ["localChanged", "result"])
    guard let state = InverseState(rawValue: try object.member("state").asString()) else { throw JSONError.shape("a request state") }
    self.init(
      requestId: try object.member("requestId").asString(), sourceActId: try object.member("sourceActId").asString(),
      inverseActId: try object.member("inverseActId").asString(), state: state, requestedAt: try object.member("requestedAt").asInteger(),
      localChanged: try object["localChanged"]?.asBool(),
      slots: try object.member("slots").asArray().map { (slot: JSON) throws -> InverseSlot in try InverseSlot(json: slot) },
      result: try object["result"].map { (result: JSON) throws -> InverseResult in try InverseResult(json: result) })
  }

  public var json: JSON {
    var object: JSON.Object = [
      "version": 1, "requestId": .string(requestId), "sourceActId": .string(sourceActId), "inverseActId": .string(inverseActId),
      "state": .string(state.rawValue), "requestedAt": JSON(requestedAt), "slots": .array(slots.map(\.json)),
    ]
    object["localChanged"] = localChanged.map(JSON.bool)
    object["result"] = result?.json
    return .object(object)
  }

  // A slot settles with its outcomes, or every operation skipped by `code`. A settled slot keeps no values: its recipe is
  // withdrawn.
  mutating func settle(slot index: Int, outcomes: [InverseOutcome]?, code: String) {
    let count = slots[index].recipe.count
    slots[index].outcomes = outcomes ?? (0..<count).map { (operation: Int) -> InverseOutcome in InverseOutcome(index: operation, skipped: code) }
    slots[index].recipe = .withdrawn(command: slots[index].recipe.command)
    slots[index].state = .settled
  }

  // The request settles once every slot has: changed when any slot's accepted effects changed a row, and the counts take
  // every operation a slot sent and every one it skipped before sending. True when it did now.
  mutating func settleIfDone() -> Bool {
    guard state != .settled, slots.allSatisfy({ $0.state == .settled }) else { return false }
    let applied: Int = slots.flatMap { $0.outcomes ?? [] }.filter(\.applied).count
    let skipped: Int = slots.flatMap { $0.outcomes ?? [] }.filter { !$0.applied }.count + slots.flatMap { $0.skipped ?? [] }.count
    state = .settled
    result = .settled(requestId: requestId, inverseActId: inverseActId, changed: slots.contains { $0.changed == true },
                      appliedCount: applied, skippedCount: skipped)
    return true
  }

  // readInverseResult: its result once it has one, else pending.
  public var current: InverseResult {
    result ?? .pending(requestId: requestId, inverseActId: inverseActId, localChanged: localChanged ?? false)
  }

  // Why its operations were skipped, from the codes its slots keep: those materialization skipped before sending and
  // those its outcomes carry.
  public var skipReason: InverseSkipReason {
    InverseSkipReason(codes: slots.flatMap { (slot: InverseSlot) -> [String] in (slot.skipped ?? []) + (slot.outcomes ?? []).compactMap(\.code) })
  }
}

// Why an inverse request's operations were skipped, as its settled report names it: the device's own refusals to send
// (engine.md §7.3 Materialize) before the server's conditions (§6.4), any other code (a refusal, an unreadable answer, a
// discard, an ended scope) as `other`, and `none` when nothing was skipped. A request skipped for several reasons is named
// by the first of them in this order.
public enum InverseSkipReason: String, Sendable, Hashable, CaseIterable {
  case historyChanged = "history-changed"
  case epochChanged = "epoch-changed"
  case referenceUnbound = "reference-unbound"
  case versionChanged = "version-changed"
  case recordChanged = "record-changed"
  case recordPresent = "record-present"
  case scopeChanged = "scope-changed"
  case other
  case nothingSkipped = "none"

  public init(codes: [String]) {
    guard !codes.isEmpty else {
      self = .nothingSkipped
      return
    }
    let named = InverseSkipReason.allCases.filter { $0 != .other && $0 != .nothingSkipped }
    self = named.first { (reason: InverseSkipReason) -> Bool in codes.contains { $0.isSameID(as: reason.rawValue) } } ?? .other
  }
}

// MARK: - The journal

// One replica's journal: its reversible acts, inverse requests and cancellation receipts.
public struct Journal: Sendable, Hashable {
  public var acts: [ReversibleAct]
  public var inverses: [InverseRequest]
  public var cancellations: [CancellationReceipt]

  public init(acts: [ReversibleAct] = [], inverses: [InverseRequest] = [], cancellations: [CancellationReceipt] = []) {
    self.acts = acts
    self.inverses = inverses
    self.cancellations = cancellations
  }

  public var isEmpty: Bool { acts.isEmpty && inverses.isEmpty && cancellations.isEmpty }

  // Every outbox entry the journal names: each act's sources, each unsettled request's slots, and the entries a kept
  // cancellation's references wait on. A load of the journal loads these entries with it.
  public var namedLocalIds: Set<String> {
    var named = Set(acts.flatMap(\.sourceEntries).map(\.localId))
    for request in inverses where request.state != .settled { named.formUnion(request.slots.map(\.localId)) }
    for request in inverses { for slot in request.slots { for id in slot.recipe.pendingLocalIds { named.insert(id) } } }
    named.formUnion(cancellations.flatMap(\.units).flatMap(\.restored.pendingLocalIds))
    return named
  }

  // Whether an act, a request or a cancellation of this journal carries the gesture id.
  public func carries(gestureId: String) -> Bool {
    acts.contains { $0.actId.isSameID(as: gestureId) }
      || inverses.contains { $0.requestId.isSameID(as: gestureId) || $0.inverseActId.isSameID(as: gestureId) }
      || cancellations.contains { $0.inverseActId.isSameID(as: gestureId) }
  }

  func act(_ actId: String) -> ReversibleAct? { acts.first { $0.actId.isSameID(as: actId) } }

  func request(_ requestId: String) -> InverseRequest? { inverses.first { $0.requestId.isSameID(as: requestId) } }

  // The act and source index of a source entry.
  func source(of localId: String) -> (act: Int, source: Int)? {
    for (actIndex, act) in acts.enumerated() {
      if let index = act.sourceEntries.firstIndex(where: { $0.localId.isSameID(as: localId) }) { return (actIndex, index) }
    }
    return nil
  }

  // §7.4's retention point: a source keeps its accepted receipt, or its refusal, under the answer's epoch. One attempt an
  // epoch: a replay's replaces it. An ok without a readable receipt proves nothing of what the act wrote: the source's
  // history is unavailable.
  mutating func retain(_ attempt: Attempt, of localId: String) {
    guard let (act, source) = source(of: localId) else { return }
    acts[act].sourceEntries[source].attempts.removeAll { $0.epoch.isSameID(as: attempt.epoch) }
    acts[act].sourceEntries[source].attempts.append(attempt)
    if attempt.ok && attempt.acceptedEffects == nil { acts[act].sourceEntries[source].unavailable = true }
  }

  // The journal keeps acts the product's stack retains, acts an unsettled request inverts, and acts whose sources a kept
  // cancellation's references wait on; cancellations stay while retained or redone.
  mutating func collect() {
    let unsettled = inverses.filter { $0.state != .settled }.map(\.sourceActId)
    cancellations.removeAll { cancellation in !cancellation.retained && !unsettled.contains { $0.isSameID(as: cancellation.inverseActId) } }
    let referenced = Set(cancellations.flatMap(\.units).flatMap(\.restored.pendingLocalIds))
    acts.removeAll { act in
      !act.retained && !unsettled.contains { $0.isSameID(as: act.actId) } && !act.sourceEntries.contains { referenced.contains($0.localId) }
    }
  }

  // releaseReversibleAct: the product's stack no longer needs the act. Its record goes unless an unsettled request still
  // reads it; a settled request whose inverse act this is goes with it. False when the journal holds no such act.
  mutating func release(_ actId: String) -> Bool {
    let act = acts.firstIndex { $0.actId.isSameID(as: actId) }
    let cancellation = cancellations.firstIndex { $0.inverseActId.isSameID(as: actId) }
    guard act != nil || cancellation != nil else { return false }
    if let act { acts[act].retained = false }
    if let cancellation { cancellations[cancellation].retained = false }
    inverses.removeAll { $0.state == .settled && $0.inverseActId.isSameID(as: actId) }
    collect()
    return true
  }

  // A request settled now leaves its act to collection.
  mutating func settle(request index: Int) {
    if inverses[index].settleIfDone() { collect() }
  }

  // Each slot's record held as JSON, by id, for its stored form.
  public var json: (acts: [JSON], inverses: [JSON], cancellations: [JSON]) {
    let byId = { (records: [(String, JSON)]) -> [JSON] in
      records.sorted { $0.0.utf8.lexicographicallyPrecedes($1.0.utf8) }.map(\.1)
    }
    return (byId(acts.map { ($0.actId, $0.json) }), byId(inverses.map { ($0.requestId, $0.json) }),
            byId(cancellations.map { ($0.inverseActId, $0.json) }))
  }
}

extension SlotRecipe {
  var pendingLocalIds: [String] {
    guard case .restore(_, let operations) = self else { return [] }
    return operations.flatMap { $0.reference?.pendingLocalIds ?? [] }
  }
}

// MARK: - The journal in its replica

extension LoadedReplica {
  // §7.4 an answer's retention, in its transaction: an ok source keeps its receipt after the result's maps, a terminal
  // refusal its refusal.
  public mutating func retain(_ attempt: Attempt, of localId: String) {
    guard journal.source(of: localId) != nil else { return }
    updateJournal { $0.retain(attempt, of: localId) }
  }

  // §7.3 Capture: the acknowledged entries with a receipt that write each record, in commit order, the only writes a
  // capture's preimages can step over. An entry still unanswered is passed over before its deltas are read, so a capture
  // over a large unsent outbox reads none of it.
  func acknowledgedWrites() -> [RecordAddress: [OutboxEntry]] {
    var writes: [RecordAddress: [OutboxEntry]] = [:]
    for entry in loadedEntries where entry.state == .acked && entry.acceptedEffects != nil {
      for effect in entry.effects() {
        for delta in effect.deltas where writes[RecordAddress(scope: effect.scope, key: delta.key)]?.last?.localId.isSameID(as: entry.localId) != true {
          writes[RecordAddress(scope: effect.scope, key: delta.key), default: []].append(entry)
        }
      }
    }
    return writes
  }

  // §7.4 the ACK transaction's retention point, after the source's own: each preimage of another act's source entry still
  // in the outbox after this entry in commit order was read over its write, and steps over it. An act's own segments come
  // after its preimages were read. Only a preimage of a record the entry's receipt names can step, and the journal is
  // written only for the acts in which one did.
  public mutating func stepPreimages(over entry: OutboxEntry) {
    guard let effects = entry.acceptedEffects, !journal.acts.isEmpty else { return }
    let written = Set(effects.flatMap { (effect: EffectReceipt) -> [RecordAddress] in effect.rows.map { RecordAddress(scope: effect.scope, key: $0.key) } })
    guard !written.isEmpty else { return }
    var stepped: [(index: Int, act: ReversibleAct)] = []
    for (index, act) in journal.acts.enumerated() where !act.actId.isSameID(as: entry.gestureId) {
      var next = act
      for source in next.sourceEntries.indices {
        guard next.sourceEntries[source].preimages.contains(where: { written.contains($0.target.address) }),
              let later = named(next.sourceEntries[source].localId), later.commitOrder > entry.commitOrder else { continue }
        for preimage in next.sourceEntries[source].preimages.indices where written.contains(next.sourceEntries[source].preimages[preimage].target.address) {
          next.sourceEntries[source].preimages[preimage].step(over: entry)
        }
      }
      if next != act { stepped.append((index, next)) }
    }
    guard !stepped.isEmpty else { return }
    updateJournal { journal in
      for (index, act) in stepped { journal.acts[index] = act }
    }
  }

  // §7.5 step 1: an epoch change drops every attempt of another epoch. A source still in the outbox replays and earns its
  // own; a collected one has none left, and its history is `unavailable`.
  public mutating func invalidateAttempts(outside epoch: String?) {
    let present = Set(journal.acts.flatMap(\.sourceEntries).map(\.localId).filter { named($0) != nil })
    updateJournal { journal in
      for act in journal.acts.indices {
        for index in journal.acts[act].sourceEntries.indices {
          var source = journal.acts[act].sourceEntries[index]
          let lost = !present.contains(source.localId) && source.attempts.contains { $0.ok && !$0.epoch.isSameID(as: epoch) }
          source.attempts.removeAll { !$0.epoch.isSameID(as: epoch) }
          if lost { source.unavailable = true }
          journal.acts[act].sourceEntries[index] = source
        }
      }
    }
  }

  // §7.10 a Discard of a product's work removes the journal's whole source entries of that product, values included, and
  // its cancellations' units and inverse requests; an act or a cancellation left with nothing of its own goes. The
  // discarded slots settle skipped `discarded` first.
  public mutating func discardJournal(of product: String, registry: Registry) {
    let theirs = { (scope: ScopeRef) -> Bool in registry.product(of: scope)?.isSameID(as: product) == true }
    updateJournal { journal in
      for act in journal.acts.indices { journal.acts[act].sourceEntries.removeAll { theirs($0.originScope) } }
      journal.acts.removeAll { $0.sourceEntries.isEmpty }
    }
    settleEnded(code: "discarded")
    updateJournal { journal in
      for index in journal.cancellations.indices {
        journal.cancellations[index].sourceEntries.removeAll { theirs($0.originScope) }
        let kept = Set(journal.cancellations[index].sourceEntries.map(\.localId))
        journal.cancellations[index].units.removeAll { !kept.contains($0.ownerLocalId) }
      }
      let gone = journal.cancellations.filter(\.sourceEntries.isEmpty).map(\.inverseActId)
      journal.cancellations.removeAll(where: \.sourceEntries.isEmpty)
      journal.inverses.removeAll { request in
        request.slots.isEmpty ? gone.contains { $0.isSameID(as: request.inverseActId) } : request.slots.allSatisfy { theirs($0.originScope) }
      }
    }
  }

  // §7.5 step 2: a scope that ends (its `gone` or `not-found`, or a dead governing row) keeps none of its values in the
  // journal. Its sources keep their receipts and become unavailable; a cancellation's units there go; a slot still
  // waiting there vacates, skipped `scope-gone`.
  public mutating func forgetJournalScope(_ scope: ScopeRef) throws {
    guard !journal.isEmpty else { return }
    let vacated: [String] = journal.inverses.filter { $0.state != .settled }.flatMap(\.slots)
      .filter { $0.state == .waiting && $0.originScope == scope }.map(\.localId).filter { named($0) != nil }
    for localId in vacated { try move(localId, .vacate) }
    updateJournal { journal in
      for act in journal.acts.indices {
        for index in journal.acts[act].sourceEntries.indices where journal.acts[act].sourceEntries[index].originScope == scope {
          journal.acts[act].sourceEntries[index].recipes = []
          journal.acts[act].sourceEntries[index].preimages = []
          journal.acts[act].sourceEntries[index].written = []
          journal.acts[act].sourceEntries[index].unavailable = true
        }
      }
      for index in journal.cancellations.indices { journal.cancellations[index].units.removeAll { $0.address.scope == scope } }
      for request in journal.inverses.indices where journal.inverses[request].state != .settled {
        for slot in journal.inverses[request].slots.indices {
          let held = journal.inverses[request].slots[slot]
          guard held.state == .waiting, held.originScope == scope else { continue }
          journal.inverses[request].settle(slot: slot, outcomes: nil, code: "scope-gone")
        }
        journal.settle(request: request)
      }
    }
  }

  // §7.3 engine start: no product's stack outlives its process, so every act and cancellation no unsettled request reads
  // goes.
  public mutating func releaseJournal() {
    guard !journal.isEmpty else { return }
    updateJournal { journal in
      for index in journal.acts.indices { journal.acts[index].retained = false }
      for index in journal.cancellations.indices { journal.cancellations[index].retained = false }
      journal.collect()
    }
  }

  // The slots whose entries ended without a result (a fold, a refusal of another entry, a Discard) settle skipped by
  // `code`.
  public mutating func settleEnded(code: String) {
    let ended: [(request: Int, slot: Int)] = journal.inverses.indices.flatMap { (request: Int) -> [(request: Int, slot: Int)] in
      guard journal.inverses[request].state != .settled else { return [] }
      return journal.inverses[request].slots.indices.compactMap { (slot: Int) -> (request: Int, slot: Int)? in
        let held = journal.inverses[request].slots[slot]
        return held.state != .settled && named(held.localId) == nil ? (request, slot) : nil
      }
    }
    let unsettled = journal.inverses.indices.filter { journal.inverses[$0].state != .settled }
    guard !unsettled.isEmpty else { return }
    updateJournal { journal in
      for (request, slot) in ended { journal.inverses[request].settle(slot: slot, outcomes: nil, code: code) }
      for request in unsettled { journal.settle(request: request) }
    }
  }

  // §7.5 step 1: references and preimages taken before the replica held an epoch belong to the epoch it then took, which
  // an epoch change now leaves.
  public mutating func bindReferences(to epoch: String?) {
    guard !journal.isEmpty else { return }
    updateJournal { journal in
      for act in journal.acts.indices {
        for source in journal.acts[act].sourceEntries.indices {
          for preimage in journal.acts[act].sourceEntries[source].preimages.indices where journal.acts[act].sourceEntries[source].preimages[preimage].epoch == nil {
            journal.acts[act].sourceEntries[source].preimages[preimage].epoch = epoch
          }
        }
      }
      for cancellation in journal.cancellations.indices {
        journal.cancellations[cancellation].units = journal.cancellations[cancellation].units.map { $0.bound(to: epoch) }
      }
      for request in journal.inverses.indices {
        for slot in journal.inverses[request].slots.indices {
          guard case .restore(let command, let operations) = journal.inverses[request].slots[slot].recipe else { continue }
          journal.inverses[request].slots[slot].recipe = .restore(command: command, operations: operations.map { $0.bound(to: epoch) })
        }
      }
    }
  }

  // §7.7 write map and E-8: the journal, its inverse requests and its cancellations follow the same logical map as the
  // queue (`JournalRemap`).
  public mutating func remapJournal(by map: RecordMap, registry: Registry) {
    guard !journal.isEmpty else { return }
    let remap = JournalRemap(map: map, registry: registry)
    updateJournal { journal in
      for act in journal.acts.indices { journal.acts[act].sourceEntries = journal.acts[act].sourceEntries.map(remap.source) }
      for request in journal.inverses.indices { journal.inverses[request].slots = journal.inverses[request].slots.map(remap.slot) }
      journal.cancellations = journal.cancellations.map(remap.cancellation)
    }
  }
}

// One write map over the journal. A record a holder names is renamed in the scope it names, and moves with that scope; a
// value recorded for a field is renamed as a one-field record of its own record, in that record's scope, before the scope
// moves (a text or a life names no record); a typed command input is renamed in the scope its holder had.
struct JournalRemap {
  let map: RecordMap
  let registry: Registry

  func address(_ address: RecordAddress) -> RecordAddress {
    RecordAddress(scope: map.scope(address.scope), key: registry.remapped(address.key, in: address.scope, by: map))
  }

  func target(_ target: Target) -> Target {
    Target(address(target.address), target.slot)
  }

  // A record's registers renamed as its references are, each keeping its stamp.
  func registers(_ fields: [String: Register], of record: RecordAddress) -> [String: Register] {
    var delta = Delta(key: record.key, lattice: Lattice(fields: fields))
    registry.remap(&delta, in: record.scope, by: map)
    return delta.lattice.fields
  }

  // The record a revival draws, its registers renamed in the scope of the life it revives.
  func revival(_ record: RecordValues?, of life: Target) -> RecordValues? {
    guard var renamed = record else { return nil }
    renamed.fields = registers(renamed.fields, of: life.address)
    return renamed
  }

  func value(_ value: JSON?, of target: Target) -> JSON? {
    guard case .field(let name) = target.slot, let value else { return value }
    return registers([name: Register(value, .unset)], of: target.address)[name]?.value ?? value
  }

  // `{f?, x?}` as an act created a record, its fields renamed.
  func values(_ values: JSON.Object, of record: RecordAddress) -> JSON.Object {
    guard case .object(let fields)? = values["f"] else { return values }
    let named = Dictionary(uniqueKeysWithValues: fields.members.map { (member: (key: String, value: JSON)) -> (String, Register) in
      (member.key, Register(member.value, .unset))
    })
    var renamed = values
    renamed["f"] = .object(JSON.Object(uniqueKeysWithValues: registers(named, of: record).map { ($0.key, $0.value.value) }))
    return renamed
  }

  func reference(_ reference: VersionReference) -> VersionReference {
    switch reference {
    case .pending(let localId, let held): .pending(localId: localId, target: target(held))
    case .fieldAbsent(let epoch, let birth): .fieldAbsent(epoch: epoch, recordBirth: birth.map(self.reference))
    case .accepted, .recordAbsent, .unbound: reference
    }
  }

  func input(_ input: JSON, of command: String, in scope: ScopeRef) -> JSON {
    var named = Command(name: command, args: ["input": input])
    registry.remap(&named, in: scope, by: map)
    return named.args["input"] ?? input
  }

  func evidence(_ evidence: EvidenceSelection) -> EvidenceSelection {
    EvidenceSelection(ownedFields: evidence.ownedFields.map(target), unchangedCreatedRecords: evidence.unchangedCreatedRecords.map(address),
                      unchangedCreatedScopes: evidence.unchangedCreatedScopes.map(map.scope))
  }

  func recipe(_ recipe: ActUndoRecipe, in scope: ScopeRef) -> ActUndoRecipe {
    switch recipe {
    case .fields(let command, let targets):
      return .fields(restoreCommand: command, targets: targets.map { (item: RestoreTarget) -> RestoreTarget in
        RestoreTarget(target: target(item.target), defaultValue: value(item.defaultValue, of: item.target))
      })
    case .createdRecord(let command, let record):
      return .createdRecord(restoreCommand: command, record: address(record))
    case .command(let name, let input, let selection):
      return .command(name, input: self.input(input, of: name, in: scope), evidence: evidence(selection))
    }
  }

  func operation(_ operation: PlannedOperation) -> PlannedOperation {
    switch operation {
    case .field(let held, let before, let reference, let record):
      return .field(target(held), before: value(before, of: held), reference: reference.map(self.reference), record: revival(record, of: held))
    case .createdRecord(let record):
      return .createdRecord(address(record))
    case .createRecord(let record, let values, let reference):
      return .createRecord(address(record), values: self.values(values, of: record), reference: self.reference(reference))
    }
  }

  func source(_ source: JournalSource) -> JournalSource {
    var moved = source
    moved.recipes = source.recipes.map { recipe($0, in: source.originScope) }
    moved.originScope = map.scope(source.originScope)
    moved.preimages = source.preimages.map { (preimage: Preimage) -> Preimage in
      var renamed = preimage
      renamed.value = value(preimage.value, of: preimage.target) ?? preimage.value
      renamed.record = revival(preimage.record, of: preimage.target)
      renamed.target = target(preimage.target)
      return renamed
    }
    moved.written = source.written.map { (written: WrittenValue) -> WrittenValue in
      WrittenValue(target: target(written.target), value: value(written.value, of: written.target) ?? written.value)
    }
    moved.attempts = source.attempts.map { (attempt: Attempt) -> Attempt in
      var renamed = attempt
      renamed.acceptedEffects = attempt.acceptedEffects?.map { (effect: EffectReceipt) -> EffectReceipt in
        var receipt = effect
        for row in receipt.rows.indices { receipt.rows[row].key = registry.remapped(receipt.rows[row].key, in: effect.scope, by: map) }
        receipt.scope = map.scope(effect.scope)
        return receipt
      }
      return renamed
    }
    return moved
  }

  func slot(_ slot: InverseSlot) -> InverseSlot {
    var moved = slot
    moved.recipe = switch slot.recipe {
    case .restore(let command, let operations): .restore(command: command, operations: operations.map(operation))
    case .command(let name, let input, let selection): .command(name, input: self.input(input, of: name, in: slot.originScope), evidence: evidence(selection))
    case .withdrawn: slot.recipe
    }
    moved.originScope = map.scope(slot.originScope)
    return moved
  }

  func cancellation(_ cancellation: CancellationReceipt) -> CancellationReceipt {
    var moved = cancellation
    for index in moved.sourceEntries.indices { moved.sourceEntries[index].originScope = map.scope(moved.sourceEntries[index].originScope) }
    moved.units = cancellation.units.map { (unit: CancellationUnit) -> CancellationUnit in
      switch unit {
      case .field(let owner, let held, let redoValue, let restored, let restoredValue):
        .field(ownerLocalId: owner, target: target(held), redoValue: value(redoValue, of: held), restored: reference(restored),
               restoredValue: value(restoredValue, of: held))
      case .createdRecord(let owner, let record, let redoValues, let restored):
        .createdRecord(ownerLocalId: owner, record: address(record), redoValues: values(redoValues, of: record), restored: reference(restored))
      }
    }
    return moved
  }
}

// MARK: - Opting an act in (§7.3 Undo of an act)

// An opted act's plan by segment index: the segment's scope, its recipes and the first local preimages its field targets
// read before any segment changed a projection.
public struct UndoPlan: Sendable {
  struct Segment: Sendable {
    let scope: ScopeRef
    let recipes: [ActUndoRecipe]
    let preimages: [Preimage]
  }

  let segments: [Int: Segment]

  public func opts(_ index: Int) -> Bool { segments[index] != nil }

  // The rows the capture reads: every record its recipes name, before the act.
  public static func reads(of undo: ActUndo?, scopes: [ScopeRef]) -> [ScopeRef: RowSelection] {
    var reads: [ScopeRef: RowSelection] = [:]
    for segment in undo?.segments ?? [] where scopes.indices.contains(segment.index) {
      let scope = scopes[segment.index]
      reads[scope] = reads[scope] ?? RowSelection()
      for recipe in segment.recipes {
        switch recipe {
        case .fields(_, let targets): reads[scope, default: RowSelection()].keys.formUnion(targets.map(\.target.key))
        case .createdRecord(_, let record): reads[scope, default: RowSelection()].keys.insert(record.key)
        case .command: break
        }
      }
    }
    return reads
  }
}

extension ViewRecord {
  // The logical value a slot reads: a life's state, a field's value or a text; nil while unset.
  public func value(of slot: EffectSlot.Slot) -> JSON? {
    switch slot {
    case .born: nil
    case .life: lattice.life.map { .string($0.state.rawValue) }
    case .field(let name): lattice.fields[name]?.value
    case .text(let name): texts[name].map(JSON.string)
    }
  }
}

extension CommitPlanner {
  // §7.3 capture: the act's undo request checked against its scopes, each segment's first local preimages read from
  // `drawn` before any segment changes it, each with the sequence of the row it was read over, the confirmed row or else
  // the dead row the record's spent id keeps, stepped over each of the device's own acknowledged writes of the record
  // whose receipt continues it, and the epoch that sequence counts in, a life's with the record it read.
  // An unset slot takes its target's default; with none, and for any malformed recipe, the act throws before anything
  // changes. A segment named with no recipes is journaled for its receipts alone, as evidence, and an act names at least
  // one recipe.
  public func undoPlan(_ undo: ActUndo?, scopes: [ScopeRef], in replica: LoadedReplica) throws -> UndoPlan? {
    guard let undo else { return nil }
    var segments: [Int: UndoPlan.Segment] = [:]
    let acknowledged = replica.acknowledgedWrites()
    for segment in undo.segments {
      guard scopes.indices.contains(segment.index), segments[segment.index] == nil else {
        throw CommitFailure.malformed("an undo segment names one act segment and its recipes")
      }
      let scope = scopes[segment.index]
      let view = try ScopeView(replica, scope, .drawn, registry: registry)
      var preimages: [Preimage] = []
      for recipe in segment.recipes {
        if let fault = registry.recipeFault(recipe, in: scope) { throw CommitFailure.malformed("an undo recipe is malformed: \(fault)") }
        if case .createdRecord(_, let record) = recipe, view.record(record.key) != nil {
          throw CommitFailure.malformed("a created record exists before its act")
        }
        guard case .fields(_, let targets) = recipe else { continue }
        for item in targets {
          let read = view.record(item.target.key)
          guard let value = read?.value(of: item.target.slot) ?? item.defaultValue else {
            throw CommitFailure.malformed("an unset undo target needs its default")
          }
          let rowSeq: Int64? = replica.rows(scope).row(item.target.key)?.seq ?? replica.spentIDs(scope)[item.target.key]?.seq
          let record: RecordValues? = item.target.slot == .life ? read.map(RecordValues.init) : nil
          var preimage = Preimage(target: item.target, value: value, rowSeq: rowSeq, epoch: replica.meta.serverEpoch, record: record)
          for entry in acknowledged[item.target.address] ?? [] { preimage.step(over: entry) }
          preimages.append(preimage)
        }
      }
      segments[segment.index] = UndoPlan.Segment(scope: scope, recipes: segment.recipes, preimages: preimages)
    }
    guard undo.segments.contains(where: { !$0.recipes.isEmpty }) else { throw CommitFailure.malformed("an act opts into Undo with at least one recipe") }
    return UndoPlan(segments: segments)
  }

  // An opted segment runs its own scoped-effects command, or else its scope kind's one capture command, which joins
  // the segment only when it writes a delta. None or several capture commands is a programming error, never a choice by
  // name. The capture command, or nil.
  public func capture(for gesture: Gesture, in scope: ScopeRef) throws -> String? {
    if let command = gesture.command {
      guard registry.command(command.name)?.scopedEffects == true else { throw CommitFailure.malformed("an opted command returns scoped effects") }
      return nil
    }
    let kind = registry.scopeKind(of: scope)
    let found = registry.commands.filter { $0.engine == .capture && $0.scope == kind }
    guard found.count == 1 else { throw CommitFailure.malformed("\(scope) has no single capture command") }
    return found[0].name
  }

  // §7.3 record: the act's journal record, one source entry per named segment that left an entry, in commit order, with
  // the value the act left in each target, which a Redo writes back. A segment that writes nothing leaves none, and an
  // act left with none records nothing.
  public func record(act actId: String, plan: UndoPlan?, receipts: [ActSegmentReceipt], in replica: inout LoadedReplica) throws {
    guard let plan else { return }
    var sources: [JournalSource] = []
    for (index, segment) in plan.segments.sorted(by: { $0.key < $1.key }) {
      let localIds = receipts[index].localIds
      if localIds.isEmpty { continue }
      guard localIds.count == 1 else { throw CommitFailure.malformed("an opted segment commits one intent") }
      let view = try ScopeView(replica, segment.scope, .drawn, registry: registry)
      let written: [WrittenValue] = segment.preimages.compactMap { (preimage: Preimage) -> WrittenValue? in
        view.record(preimage.target.key)?.value(of: preimage.target.slot).map { WrittenValue(target: preimage.target, value: $0) }
      }
      sources.append(JournalSource(localId: localIds[0], originScope: segment.scope, recipes: segment.recipes, preimages: segment.preimages,
                                   written: written))
    }
    guard !sources.isEmpty else { return }
    replica.updateJournal { $0.acts.append(ReversibleAct(actId: actId, sourceEntries: sources)) }
  }
}
