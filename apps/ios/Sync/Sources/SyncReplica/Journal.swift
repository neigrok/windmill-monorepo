import SyncAPI
import SyncCore

// K-3 the journal of reversible acts (engine.md §2.5, §7.3 Undo of an act): each act's source entries with their recipes,
// first local preimages and the receipts or refusals their ACK transactions record, beside the inverse requests and the
// cancellation receipts that read them. It lives in its replica's namespace; its values are local user data and its ids
// private sync data, so none of it enters telemetry, logs or reports.

// MARK: - Reversible acts

// What a slot read before an act changed it: a field, a text or a life, as a logical value.
public struct Preimage: Sendable, Hashable {
  public var target: Target
  public let value: JSON

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
  public var attempts: [Attempt]
  // An epoch change took its history: it was collected before it could earn the new epoch's receipt.
  public var unavailable: Bool

  public init(localId: String, originScope: ScopeRef, recipes: [ActUndoRecipe], preimages: [Preimage], attempts: [Attempt] = [],
              unavailable: Bool = false) {
    self.localId = localId
    self.originScope = originScope
    self.recipes = recipes
    self.preimages = preimages
    self.attempts = attempts
    self.unavailable = unavailable
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["localId", "originScope", "recipes", "preimages", "attempts"], optional: ["unavailable"])
    self.init(
      localId: try object.member("localId").asString(), originScope: try ScopeRef(json: object.member("originScope")),
      recipes: try object.member("recipes").asArray().map { (recipe: JSON) throws -> ActUndoRecipe in try ActUndoRecipe(json: recipe) },
      preimages: try object.member("preimages").asArray().map { (preimage: JSON) throws -> Preimage in try Preimage(json: preimage) },
      attempts: try object.member("attempts").asArray().map { (attempt: JSON) throws -> Attempt in try Attempt(json: attempt) },
      unavailable: try object["unavailable"]?.asBool() ?? false)
  }

  var json: JSON {
    var object: JSON.Object = [
      "localId": .string(localId), "originScope": originScope.json, "recipes": .array(recipes.map(\.json)),
      "preimages": .array(preimages.map(\.json)), "attempts": .array(attempts.map(\.json)),
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
    default: throw JSONError.shape("an unknown version reference")
    }
  }

  var json: JSON {
    switch self {
    case .accepted(let epoch, let version): ["kind": "accepted", "epoch": epoch.map(JSON.string) ?? .null, "version": version.json]
    case .pending(let localId, let target): ["kind": "pending", "localId": .string(localId), "target": target.json]
    case .fieldAbsent(let epoch, let birth): ["kind": "fieldAbsent", "epoch": epoch.map(JSON.string) ?? .null, "recordBirth": birth?.json ?? .null]
    case .recordAbsent(let epoch): ["kind": "recordAbsent", "epoch": epoch.map(JSON.string) ?? .null]
    }
  }

  // The pending entries this reference, and the birth it names, wait on.
  var pendingLocalIds: [String] {
    switch self {
    case .pending(let localId, _): [localId]
    case .fieldAbsent(_, let birth): birth?.pendingLocalIds ?? []
    case .accepted, .recordAbsent: []
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
}

// One change a held cancellation took out of `drawn`, and what its Redo must find to put it back.
public enum CancellationUnit: Sendable, Hashable {
  case field(ownerLocalId: String, target: Target, redoValue: JSON?, restored: VersionReference)
  case createdRecord(ownerLocalId: String, record: RecordAddress, redoValues: JSON.Object, restored: VersionReference)

  init(json: JSON) throws {
    let object = try json.asObject()
    let owner = try object.member("ownerLocalId").asString()
    let restored = try VersionReference(json: object.member("restored"))
    switch try object.member("kind").asString() {
    case "field": self = .field(ownerLocalId: owner, target: try Target(json: object.member("target")), redoValue: object["redoValue"], restored: restored)
    case "createdRecord":
      self = .createdRecord(ownerLocalId: owner, record: try RecordAddress(json: object.member("record")),
                            redoValues: try object.member("redoValues").asObject(), restored: restored)
    default: throw JSONError.shape("an unknown cancellation unit")
    }
  }

  var json: JSON {
    switch self {
    case .field(let owner, let target, let value, let restored):
      var object: JSON.Object = ["kind": "field", "ownerLocalId": .string(owner), "target": target.json, "restored": restored.json]
      object["redoValue"] = value
      return .object(object)
    case .createdRecord(let owner, let record, let values, let restored):
      return ["kind": "createdRecord", "ownerLocalId": .string(owner), "record": record.json, "redoValues": .object(values), "restored": restored.json]
    }
  }

  var ownerLocalId: String {
    switch self {
    case .field(let owner, _, _, _), .createdRecord(let owner, _, _, _): owner
    }
  }

  func bound(to epoch: String?) -> CancellationUnit {
    switch self {
    case .field(let owner, let target, let value, let restored): .field(ownerLocalId: owner, target: target, redoValue: value, restored: restored.bound(to: epoch))
    case .createdRecord(let owner, let record, let values, let restored):
      .createdRecord(ownerLocalId: owner, record: record, redoValues: values, restored: restored.bound(to: epoch))
    }
  }

  var restored: VersionReference {
    switch self {
    case .field(_, _, _, let restored), .createdRecord(_, _, _, let restored): restored
    }
  }
}

// §7.3 what a held cancellation actually took out of `drawn`, which its Redo restores.
public struct CancellationReceipt: Sendable, Hashable {
  public let inverseActId: String
  public let cancelledActId: String
  public var units: [CancellationUnit]
  public var retained: Bool

  public init(inverseActId: String, cancelledActId: String, units: [CancellationUnit], retained: Bool = true) {
    self.inverseActId = inverseActId
    self.cancelledActId = cancelledActId
    self.units = units
    self.retained = retained
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["version", "inverseActId", "cancelledActId", "units"], optional: ["retained"])
    self.init(inverseActId: try object.member("inverseActId").asString(), cancelledActId: try object.member("cancelledActId").asString(),
              units: try object.member("units").asArray().map { (unit: JSON) throws -> CancellationUnit in try CancellationUnit(json: unit) },
              retained: try object["retained"]?.asBool() ?? true)
  }

  public var json: JSON {
    var object: JSON.Object = ["version": 1, "inverseActId": .string(inverseActId), "cancelledActId": .string(cancelledActId),
                               "units": .array(units.map(\.json))]
    object["retained"] = retained ? nil : false
    return .object(object)
  }
}

// MARK: - Inverse requests

// A restore operation as an Undo or a Redo plans it, before materialization binds its expectation.
public enum PlannedOperation: Sendable, Hashable {
  case field(Target, before: JSON?, reference: VersionReference?)
  case createdRecord(RecordAddress)
  case createRecord(RecordAddress, values: JSON.Object, reference: VersionReference)

  init(json: JSON) throws {
    let object = try json.asObject()
    switch try object.member("kind").asString() {
    case "field":
      self = .field(try Target(json: object.member("target")), before: object["before"],
                    reference: try object["reference"].map { (reference: JSON) throws -> VersionReference in try VersionReference(json: reference) })
    case "createdRecord": self = .createdRecord(try RecordAddress(json: object.member("record")))
    case "createRecord":
      self = .createRecord(try RecordAddress(json: object.member("record")), values: try object.member("values").asObject(),
                           reference: try VersionReference(json: object.member("reference")))
    default: throw JSONError.shape("an unknown planned operation")
    }
  }

  var json: JSON {
    switch self {
    case .field(let target, let before, let reference):
      var object: JSON.Object = ["kind": "field", "target": target.json]
      object["before"] = before
      object["reference"] = reference?.json
      return .object(object)
    case .createdRecord(let record): return ["kind": "createdRecord", "record": record.json]
    case .createRecord(let record, let values, let reference):
      return ["kind": "createRecord", "record": record.json, "values": .object(values), "reference": reference.json]
    }
  }

  public var address: RecordAddress {
    switch self {
    case .field(let target, _, _): target.address
    case .createdRecord(let record), .createRecord(let record, _, _): record
    }
  }

  var reference: VersionReference? {
    switch self {
    case .field(_, _, let reference): reference
    case .createRecord(_, _, let reference): reference
    case .createdRecord: nil
    }
  }

  func bound(to epoch: String?) -> PlannedOperation {
    switch self {
    case .field(let target, let before, let reference): .field(target, before: before, reference: reference?.bound(to: epoch))
    case .createRecord(let record, let values, let reference): .createRecord(record, values: values, reference: reference.bound(to: epoch))
    case .createdRecord: self
    }
  }
}

// What an inverse slot runs: a restore of its operations, a product inverse command, or nothing once a Discard withdrew
// its values.
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

// One outbox entry an inverse request reserved.
public struct InverseSlot: Sendable, Hashable {
  public let localId: String
  public let commitOrder: Int64
  public var recipe: SlotRecipe
  public var state: InverseState
  public var outcomes: [InverseOutcome]?
  public var changed: Bool?

  init(localId: String, commitOrder: Int64, recipe: SlotRecipe) {
    self.localId = localId
    self.commitOrder = commitOrder
    self.recipe = recipe
    state = .waiting
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["localId", "commitOrder", "recipe", "state"], optional: ["outcomes", "changed"])
    guard let state = InverseState(rawValue: try object.member("state").asString()) else { throw JSONError.shape("a slot state") }
    localId = try object.member("localId").asString()
    commitOrder = try object.member("commitOrder").asInteger()
    recipe = try SlotRecipe(json: object.member("recipe"))
    self.state = state
    outcomes = try object["outcomes"]?.asArray().map { (outcome: JSON) throws -> InverseOutcome in
      let fields = try outcome.asObject()
      let code: String? = try fields["code"]?.asString()
      return InverseOutcome(index: Int(try fields.member("index").asInteger()), skipped: code)
    }
    changed = try object["changed"]?.asBool()
  }

  var json: JSON {
    var object: JSON.Object = ["localId": .string(localId), "commitOrder": JSON(commitOrder), "recipe": recipe.json, "state": .string(state.rawValue)]
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
  public let localChanged: Bool?
  public var slots: [InverseSlot]
  public var result: InverseResult?

  init(requestId: String, sourceActId: String, inverseActId: String, state: InverseState, localChanged: Bool?, slots: [InverseSlot],
       result: InverseResult? = nil) {
    self.requestId = requestId
    self.sourceActId = sourceActId
    self.inverseActId = inverseActId
    self.state = state
    self.localChanged = localChanged
    self.slots = slots
    self.result = result
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["version", "requestId", "sourceActId", "inverseActId", "state", "slots"], optional: ["localChanged", "result"])
    guard let state = InverseState(rawValue: try object.member("state").asString()) else { throw JSONError.shape("a request state") }
    self.init(
      requestId: try object.member("requestId").asString(), sourceActId: try object.member("sourceActId").asString(),
      inverseActId: try object.member("inverseActId").asString(), state: state, localChanged: try object["localChanged"]?.asBool(),
      slots: try object.member("slots").asArray().map { (slot: JSON) throws -> InverseSlot in try InverseSlot(json: slot) },
      result: try object["result"].map { (result: JSON) throws -> InverseResult in try InverseResult(json: result) })
  }

  public var json: JSON {
    var object: JSON.Object = [
      "version": 1, "requestId": .string(requestId), "sourceActId": .string(sourceActId), "inverseActId": .string(inverseActId),
      "state": .string(state.rawValue), "slots": .array(slots.map(\.json)),
    ]
    object["localChanged"] = localChanged.map(JSON.bool)
    object["result"] = result?.json
    return .object(object)
  }

  // A slot settles with its outcomes, or every operation skipped by `code`.
  mutating func settle(slot index: Int, outcomes: [InverseOutcome]?, code: String) {
    let count = slots[index].recipe.count
    slots[index].outcomes = outcomes ?? (0..<count).map { (operation: Int) -> InverseOutcome in InverseOutcome(index: operation, skipped: code) }
    slots[index].state = .settled
  }

  // The request settles once every slot has: changed when any slot's accepted effects changed a row. True when it did now.
  mutating func settleIfDone() -> Bool {
    guard state != .settled, slots.allSatisfy({ $0.state == .settled }) else { return false }
    let outcomes: [InverseOutcome] = slots.flatMap { $0.outcomes ?? [] }
    state = .settled
    result = .settled(requestId: requestId, inverseActId: inverseActId, changed: slots.contains { $0.changed == true },
                      appliedCount: outcomes.filter(\.applied).count, skippedCount: outcomes.filter { !$0.applied }.count)
    return true
  }

  // readInverseResult: its result once it has one, else pending.
  public var current: InverseResult {
    result ?? .pending(requestId: requestId, inverseActId: inverseActId, localChanged: localChanged ?? false)
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
  // epoch: a replay's replaces it.
  mutating func retain(_ attempt: Attempt, of localId: String) {
    guard let (act, source) = source(of: localId) else { return }
    acts[act].sourceEntries[source].attempts.removeAll { $0.epoch.isSameID(as: attempt.epoch) }
    acts[act].sourceEntries[source].attempts.append(attempt)
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

  // §7.10 a Discard of a product's work removes the journal's whole source entries of that product, values included; an
  // act left with none goes. Its waiting slots settle skipped `discarded`, their values withdrawn.
  public mutating func discardJournal(of product: String, registry: Registry) {
    updateJournal { journal in
      for act in journal.acts.indices {
        journal.acts[act].sourceEntries.removeAll { registry.product(of: $0.originScope)?.isSameID(as: product) == true }
      }
      journal.acts.removeAll { $0.sourceEntries.isEmpty }
    }
    settleEnded(code: "discarded", withdraw: true)
  }

  // The slots whose entries ended without a result (a fold, a refusal of another entry, a Discard) settle skipped by
  // `code`; a Discard also withdraws their values, the slot keeping only its outcomes.
  public mutating func settleEnded(code: String, withdraw: Bool = false) {
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
      for (request, slot) in ended {
        journal.inverses[request].settle(slot: slot, outcomes: nil, code: code)
        if withdraw { journal.inverses[request].slots[slot].recipe = .withdrawn(command: journal.inverses[request].slots[slot].recipe.command) }
      }
      for request in unsettled { journal.settle(request: request) }
    }
  }

  // §7.5 step 1: references taken before the replica held an epoch belong to the epoch it then took, which an epoch
  // change now leaves.
  public mutating func bindReferences(to epoch: String?) {
    guard !journal.cancellations.isEmpty || !journal.inverses.isEmpty else { return }
    updateJournal { journal in
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

  // §7.7 write map and E-8: the journal's scopes, targets, records, typed inputs and receipts follow the same logical map
  // as the queue.
  public mutating func remapJournal(by map: RecordMap, registry: Registry) {
    guard !journal.acts.isEmpty else { return }
    let address = { (address: inout RecordAddress) -> Void in
      address.key = registry.remapped(address.key, in: address.scope, by: map)
      address.scope = map.scope(address.scope)
    }
    updateJournal { journal in
      for act in journal.acts.indices {
        for index in journal.acts[act].sourceEntries.indices {
          var source = journal.acts[act].sourceEntries[index]
          source.originScope = map.scope(source.originScope)
          let scope = source.originScope
          source.recipes = source.recipes.map { (recipe: ActUndoRecipe) -> ActUndoRecipe in
            switch recipe {
            case .fields(let command, let targets):
              return .fields(restoreCommand: command, targets: targets.map { (item: RestoreTarget) -> RestoreTarget in
                var moved = item
                address(&moved.target.address)
                return moved
              })
            case .createdRecord(let command, var record):
              address(&record)
              return .createdRecord(restoreCommand: command, record: record)
            case .command(let name, let input, var evidence):
              var command = Command(name: name, args: ["input": input])
              registry.remap(&command, in: scope, by: map)
              for target in evidence.ownedFields.indices { address(&evidence.ownedFields[target].address) }
              for record in evidence.unchangedCreatedRecords.indices { address(&evidence.unchangedCreatedRecords[record]) }
              evidence.unchangedCreatedScopes = evidence.unchangedCreatedScopes.map(map.scope)
              return .command(name, input: command.args["input"] ?? input, evidence: evidence)
            }
          }
          for preimage in source.preimages.indices { address(&source.preimages[preimage].target.address) }
          for attempt in source.attempts.indices {
            source.attempts[attempt].acceptedEffects = source.attempts[attempt].acceptedEffects?.map { (effect: EffectReceipt) -> EffectReceipt in
              var moved = effect
              for row in moved.rows.indices { moved.rows[row].key = registry.remapped(moved.rows[row].key, in: effect.scope, by: map) }
              moved.scope = map.scope(effect.scope)
              return moved
            }
          }
          journal.acts[act].sourceEntries[index] = source
        }
      }
    }
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
  // `drawn` before any segment changes it. An unset slot takes its target's default; with none, and for any malformed
  // recipe, the act throws before anything changes.
  public func undoPlan(_ undo: ActUndo?, scopes: [ScopeRef], in replica: LoadedReplica) throws -> UndoPlan? {
    guard let undo else { return nil }
    var segments: [Int: UndoPlan.Segment] = [:]
    for segment in undo.segments {
      guard scopes.indices.contains(segment.index), segments[segment.index] == nil, !segment.recipes.isEmpty else {
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
          guard let value = view.record(item.target.key)?.value(of: item.target.slot) ?? item.defaultValue else {
            throw CommitFailure.malformed("an unset undo target needs its default")
          }
          preimages.append(Preimage(target: item.target, value: value))
        }
      }
      segments[segment.index] = UndoPlan.Segment(scope: scope, recipes: segment.recipes, preimages: preimages)
    }
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

  // §7.3 record: the act's journal record, one source entry per named segment that left an entry, in commit order. A
  // segment that writes nothing leaves none, and an act left with none records nothing.
  public func record(act actId: String, plan: UndoPlan?, receipts: [ActSegmentReceipt], in replica: inout LoadedReplica) throws {
    guard let plan else { return }
    var sources: [JournalSource] = []
    for (index, segment) in plan.segments.sorted(by: { $0.key < $1.key }) {
      let localIds = receipts[index].localIds
      if localIds.isEmpty { continue }
      guard localIds.count == 1 else { throw CommitFailure.malformed("an opted segment commits one intent") }
      sources.append(JournalSource(localId: localIds[0], originScope: segment.scope, recipes: segment.recipes, preimages: segment.preimages))
    }
    guard !sources.isEmpty else { return }
    replica.updateJournal { $0.acts.append(ReversibleAct(actId: actId, sourceEntries: sources)) }
  }
}
