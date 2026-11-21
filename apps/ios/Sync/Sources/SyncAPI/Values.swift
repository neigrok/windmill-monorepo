import SyncCore

// The values a product domain or the domain kit names through the engine (§7.1, §7.6), the same only byte for byte.

public struct RecordRef: Hashable, Sendable {
  public let type: String
  public let id: RecordID

  public init(type: String, id: RecordID) {
    self.type = type
    self.id = id
  }

  public var key: RecordKey { RecordKey(type, id) }

  public static func == (lhs: RecordRef, rhs: RecordRef) -> Bool { lhs.key == rhs.key }
  public func hash(into hasher: inout Hasher) { hasher.combine(key) }
}

// A lattice register of one record: the unit a guard names (D-19).
public struct RegisterRef: Hashable, Sendable {
  public let type: String
  public let id: RecordID
  public let field: String

  public init(type: String, id: RecordID, field: String) {
    self.type = type
    self.id = id
    self.field = field
  }

  public var key: RecordKey { RecordKey(type, id) }

  public static func == (lhs: RegisterRef, rhs: RegisterRef) -> Bool {
    lhs.key == rhs.key && lhs.field.utf8.elementsEqual(rhs.field.utf8)
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(key)
    hasher.combine(Array(field.utf8))
  }
}

// D-25 where a member is placed: its order field, and the record just above the drop point (nil: the top).
public struct OrderAnchor: Hashable, Sendable {
  public let field: String
  public let below: RecordID?

  public init(field: String, below: RecordID?) {
    self.field = field
    self.below = below
  }

  public static func == (lhs: OrderAnchor, rhs: OrderAnchor) -> Bool {
    lhs.field.utf8.elementsEqual(rhs.field.utf8) && lhs.below == rhs.below
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(field.utf8))
    hasher.combine(below)
  }
}

// How a create names its record (D-8, D-26); every kind but `given` is resolved inside the commit.
public enum NewID: Hashable, Sendable {
  case minted
  case seeded(seed: String, ordinal: Int)
  case derived(label: String)
  case given(RecordID)

  public static func == (lhs: NewID, rhs: NewID) -> Bool {
    switch (lhs, rhs) {
    case (.minted, .minted): true
    case (.seeded(let a, let m), .seeded(let b, let n)): a.utf8.elementsEqual(b.utf8) && m == n
    case (.derived(let a), .derived(let b)): a.utf8.elementsEqual(b.utf8)
    case (.given(let a), .given(let b)): a == b
    default: false
    }
  }

  public func hash(into hasher: inout Hasher) {
    switch self {
    case .minted: hasher.combine(0)
    case .seeded(let seed, let ordinal):
      hasher.combine(Array(seed.utf8))
      hasher.combine(ordinal)
    case .derived(let label): hasher.combine(Array(label.utf8))
    case .given(let id): hasher.combine(id)
    }
  }
}

// A text change and the text it was edited from; nil means the text drawn when the commit reads it (§7.1 step 4).
public struct TextEdit: Hashable, Sendable {
  public var text: String
  public var editedFrom: String?

  public init(text: String, editedFrom: String? = nil) {
    self.text = text
    self.editedFrom = editedFrom
  }

  public static func == (lhs: TextEdit, rhs: TextEdit) -> Bool {
    lhs.text.utf8.elementsEqual(rhs.text.utf8) && lhs.editedFrom.map { Array($0.utf8) } == rhs.editedFrom.map { Array($0.utf8) }
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(text.utf8))
    hasher.combine(editedFrom.map { Array($0.utf8) })
  }
}

// One record change of a gesture, in the vocabulary of §4.1 plus the D-25 move.
public struct Change: Hashable, Sendable {
  public enum Operation: Hashable, Sendable {
    case create(NewID)
    case update(RecordID)
    case delete(RecordID)
    case revive(RecordID)
    case put(RecordID, present: Bool?)
    case write(RecordID)
    case move(RecordID)
  }

  public let type: String
  public let operation: Operation
  public let values: [String: JSON]
  public let texts: [String: TextEdit]
  // Server-assigned values for a command's local prediction only.
  public let serials: [String: JSON]
  public let anchor: OrderAnchor?

  public init(type: String, operation: Operation, values: [String: JSON] = [:], texts: [String: TextEdit] = [:],
              serials: [String: JSON] = [:], anchor: OrderAnchor? = nil) {
    self.type = type
    self.operation = operation
    self.values = values
    self.texts = texts
    self.serials = serials
    self.anchor = anchor
  }

  // `anchor`: the D-25 drop position of the order field it names, which `values` then leaves out.
  public static func create(_ type: String, id: NewID = .minted, _ values: [String: JSON] = [:],
                            texts: [String: TextEdit] = [:], serials: [String: JSON] = [:], anchor: OrderAnchor? = nil) -> Change {
    Change(type: type, operation: .create(id), values: values, texts: texts, serials: serials, anchor: anchor)
  }

  public static func update(_ type: String, _ id: RecordID, _ values: [String: JSON] = [:],
                            texts: [String: TextEdit] = [:], serials: [String: JSON] = [:]) -> Change {
    Change(type: type, operation: .update(id), values: values, texts: texts, serials: serials)
  }

  public static func delete(_ type: String, _ id: RecordID) -> Change {
    Change(type: type, operation: .delete(id))
  }

  public static func revive(_ type: String, _ id: RecordID, _ values: [String: JSON] = [:]) -> Change {
    Change(type: type, operation: .revive(id), values: values)
  }

  // A keyed record with life; `present` nil keeps its drawn presence.
  public static func put(_ type: String, _ id: RecordID, present: Bool?, _ values: [String: JSON] = [:],
                         texts: [String: TextEdit] = [:], serials: [String: JSON] = [:]) -> Change {
    Change(type: type, operation: .put(id, present: present), values: values, texts: texts, serials: serials)
  }

  // A keyed record without life, or a singleton.
  public static func write(_ type: String, _ id: RecordID, _ values: [String: JSON] = [:],
                           texts: [String: TextEdit] = [:], serials: [String: JSON] = [:]) -> Change {
    Change(type: type, operation: .write(id), values: values, texts: texts, serials: serials)
  }

  // D-25 one record's order field, at the drop position below the anchor.
  public static func move(_ type: String, _ id: RecordID, to anchor: OrderAnchor) -> Change {
    Change(type: type, operation: .move(id), anchor: anchor)
  }

  public var id: RecordID? {
    switch operation {
    case .create(.given(let id)), .update(let id), .delete(let id), .revive(let id), .put(let id, _), .write(let id), .move(let id): id
    case .create: nil
    }
  }

  public static func == (lhs: Change, rhs: Change) -> Bool {
    lhs.type.utf8.elementsEqual(rhs.type.utf8) && lhs.operation == rhs.operation && lhs.values == rhs.values
      && lhs.texts == rhs.texts && lhs.serials == rhs.serials && lhs.anchor == rhs.anchor
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(type.utf8))
    hasher.combine(operation)
    hasher.combine(values)
    hasher.combine(texts)
    hasher.combine(serials)
    hasher.combine(anchor)
  }
}

// A row of `device/<product>`, written with the gesture and never sent; nil deletes it.
public struct DeviceWrite: Hashable, Sendable {
  public let key: String
  public let value: JSON?

  public init(key: String, value: JSON?) {
    self.key = key
    self.value = value
  }

  public static func == (lhs: DeviceWrite, rhs: DeviceWrite) -> Bool {
    lhs.key.utf8.elementsEqual(rhs.key.utf8) && lhs.value == rhs.value
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(key.utf8))
    hasher.combine(value)
  }
}

// E-7 what an opted command predicts in one scope it changes, its origin's or another's.
public struct ScopedPrediction: Hashable, Sendable {
  public var scope: ScopeRef
  public var changes: [Change]

  public init(scope: ScopeRef, changes: [Change]) {
    self.scope = scope
    self.changes = changes
  }
}

// §7.1 one user act and its options.
public struct Gesture: Hashable, Sendable {
  public var changes: [Change]
  public var atomic: Bool
  public var hold: Bool
  public var guards: [RegisterRef]
  public var retire: [RecordRef]
  public var supersede: [String]
  public var command: Command?
  public var predict: [Change]
  public var scopedPredict: [ScopedPrediction]
  public var local: [DeviceWrite]
  public var gestureId: String?

  // `guards`: exactly these lattice registers, each at its stored stamp. `retire`: held removal gestures of these
  // records end undone first. `scopedPredict`: an opted command's predictions, scope by scope, beside `predict`'s origin
  // ones of any other command.
  public init(changes: [Change], atomic: Bool = false, hold: Bool = false, guards: [RegisterRef] = [],
              retire: [RecordRef] = [], supersede: [String] = [], command: Command? = nil, predict: [Change] = [],
              scopedPredict: [ScopedPrediction] = [], local: [DeviceWrite] = [], gestureId: String? = nil) {
    self.changes = changes
    self.atomic = atomic
    self.hold = hold
    self.guards = guards
    self.retire = retire
    self.supersede = supersede
    self.command = command
    self.predict = predict
    self.scopedPredict = scopedPredict
    self.local = local
    self.gestureId = gestureId
  }

  public static func == (lhs: Gesture, rhs: Gesture) -> Bool {
    lhs.changes == rhs.changes && lhs.atomic == rhs.atomic && lhs.hold == rhs.hold && lhs.guards == rhs.guards
      && lhs.retire == rhs.retire && lhs.supersede.map { Array($0.utf8) } == rhs.supersede.map { Array($0.utf8) } && lhs.command == rhs.command
      && lhs.predict == rhs.predict && lhs.scopedPredict == rhs.scopedPredict && lhs.local == rhs.local
      && lhs.gestureId.map { Array($0.utf8) } == rhs.gestureId.map { Array($0.utf8) }
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(changes)
    hasher.combine(atomic)
    hasher.combine(hold)
    hasher.combine(guards)
    hasher.combine(retire)
    hasher.combine(supersede.map { Array($0.utf8) })
    hasher.combine(command)
    hasher.combine(predict)
    hasher.combine(scopedPredict)
    hasher.combine(local)
    hasher.combine(gestureId.map { Array($0.utf8) })
  }
}

public enum CommitOutcome: Hashable, Sendable {
  case committed(CommitReceipt)
  // scope-dead and cap write nothing; too-large refuses the whole gesture into the notice it names,
  // `notice:<gestureId>/0`.
  case refused(RefusalCode, detail: JSON?, notice: String? = nil)
}

// §7.3 an act's opt-in to Undo: each named segment's recipes, by its index in the act.
public struct ActUndo: Sendable, Hashable {
  public struct Segment: Sendable, Hashable {
    public let index: Int
    public let recipes: [ActUndoRecipe]

    public init(index: Int, recipes: [ActUndoRecipe]) {
      self.index = index
      self.recipes = recipes
    }
  }

  public let segments: [Segment]

  public init(segments: [Segment]) {
    self.segments = segments
  }

  // `{version: 1, segments: [{index, recipes}]}`.
  public init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["version", "segments"])
    guard try object.member("version").asInteger() == 1 else { throw JSONError.shape("an act undo is version 1") }
    segments = try object.member("segments").asArray().map { (segment: JSON) throws -> Segment in
      let fields = try segment.asObject()
      try fields.expectKeys(required: ["index", "recipes"])
      return Segment(index: Int(try fields.member("index").asInteger()),
                     recipes: try fields.member("recipes").asArray().map { (recipe: JSON) throws -> ActUndoRecipe in try ActUndoRecipe(json: recipe) })
    }
  }
}

// §7.3 Undo of an act (K-3): what an Undo or a Redo came to. A pending one says whether the device's view changed; a
// settled one whether accepted effects changed anything and how many conditional operations applied and skipped.
public enum InverseResult: Sendable, Hashable {
  case cancelled(requestId: String, inverseActId: String, changed: Bool)
  case pending(requestId: String, inverseActId: String, localChanged: Bool)
  case settled(requestId: String, inverseActId: String, changed: Bool, appliedCount: Int, skippedCount: Int)
  case unavailable(requestId: String?, reason: String)

  public init(json: JSON) throws {
    let object = try json.asObject()
    let text = { (key: String) throws -> String in try object.member(key).asString() }
    switch try text("kind") {
    case "cancelled": self = .cancelled(requestId: try text("requestId"), inverseActId: try text("inverseActId"), changed: try object.member("changed").asBool())
    case "pending":
      self = .pending(requestId: try text("requestId"), inverseActId: try text("inverseActId"), localChanged: try object.member("localChanged").asBool())
    case "settled":
      self = .settled(requestId: try text("requestId"), inverseActId: try text("inverseActId"), changed: try object.member("changed").asBool(),
                      appliedCount: Int(try object.member("appliedCount").asInteger()), skippedCount: Int(try object.member("skippedCount").asInteger()))
    case "unavailable":
      self = .unavailable(requestId: try object.member("requestId").nullable { (id: JSON) throws -> String in try id.asString() }, reason: try text("reason"))
    default: throw JSONError.shape("an unknown inverse result")
    }
  }

  // Its kind as telemetry may name it: cancelled, pending, settled or unavailable, never an id.
  public var kindName: String {
    switch self {
    case .cancelled: "cancelled"
    case .pending: "pending"
    case .settled: "settled"
    case .unavailable: "unavailable"
    }
  }

  public var json: JSON {
    switch self {
    case .cancelled(let requestId, let inverseActId, let changed):
      return ["kind": "cancelled", "requestId": .string(requestId), "inverseActId": .string(inverseActId), "changed": .bool(changed)]
    case .pending(let requestId, let inverseActId, let localChanged):
      return ["kind": "pending", "requestId": .string(requestId), "inverseActId": .string(inverseActId), "localChanged": .bool(localChanged)]
    case .settled(let requestId, let inverseActId, let changed, let applied, let skipped):
      return ["kind": "settled", "requestId": .string(requestId), "inverseActId": .string(inverseActId), "changed": .bool(changed),
              "appliedCount": JSON(applied), "skippedCount": JSON(skipped)]
    case .unavailable(let requestId, let reason):
      return ["kind": "unavailable", "requestId": requestId.map(JSON.string) ?? .null, "reason": .string(reason)]
    }
  }
}

public struct ActRequest: Sendable {
  public let scopes: [ScopeRef]
  public let hold: Bool
  public let gestureId: String?
  // §7.3: the act's opt-in to Undo after its hold, nil for an act that keeps only the held Undo.
  public let undo: ActUndo?
  public init(scopes: [ScopeRef], hold: Bool = false, gestureId: String? = nil, undo: ActUndo? = nil) {
    self.scopes = scopes; self.hold = hold; self.gestureId = gestureId; self.undo = undo
  }
}

public struct ScopedGesture: Sendable {
  public let scope: ScopeRef
  public let gesture: Gesture
  public init(scope: ScopeRef, gesture: Gesture) { self.scope = scope; self.gesture = gesture }
}

public struct ActSegmentReceipt: Sendable {
  public let scope: ScopeRef
  public let stamp: Stamp?
  public let localIds: [String]
  public let ids: [RecordID?]
  public init(scope: ScopeRef, stamp: Stamp?, localIds: [String], ids: [RecordID?] = []) {
    self.scope = scope; self.stamp = stamp; self.localIds = localIds; self.ids = ids
  }
}

public struct ActReceipt: Sendable {
  public let gestureId: String
  public let segments: [ActSegmentReceipt]
  public let retired: [String]
  public let superseded: [String]
  public let releaseAt: Int64?
  public init(gestureId: String, segments: [ActSegmentReceipt], retired: [String] = [], superseded: [String] = [], releaseAt: Int64? = nil) {
    self.gestureId = gestureId; self.segments = segments; self.retired = retired
    self.superseded = superseded; self.releaseAt = releaseAt
  }
  public var localIds: [String] { segments.flatMap(\.localIds) }
}

public enum ActCommitOutcome: Sendable {
  case committed(ActReceipt)
  case refused(segment: Int, code: RefusalCode, detail: JSON?)
}

public struct CommitReceipt: Hashable, Sendable {
  public let gestureId: String
  public let stamp: Stamp
  public let localIds: [String]
  public let ids: [RecordID?]
  public let releaseAt: Int64?
  public let retired: [String]
  public let superseded: [String]

  // `ids`: the resolved id per change, aligned with the gesture's changes. `releaseAt`: set when held, the Undo deadline.
  public init(gestureId: String, stamp: Stamp, localIds: [String], ids: [RecordID?], releaseAt: Int64?, retired: [String], superseded: [String] = []) {
    self.gestureId = gestureId
    self.stamp = stamp
    self.localIds = localIds
    self.ids = ids
    self.releaseAt = releaseAt
    self.retired = retired
    self.superseded = superseded
  }

  public static func == (lhs: CommitReceipt, rhs: CommitReceipt) -> Bool {
    lhs.gestureId.utf8.elementsEqual(rhs.gestureId.utf8) && lhs.stamp == rhs.stamp
      && lhs.localIds.map { Array($0.utf8) } == rhs.localIds.map { Array($0.utf8) } && lhs.ids == rhs.ids
      && lhs.superseded.map { Array($0.utf8) } == rhs.superseded.map { Array($0.utf8) }
      && lhs.releaseAt == rhs.releaseAt && lhs.retired.map { Array($0.utf8) } == rhs.retired.map { Array($0.utf8) }
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(gestureId.utf8))
    hasher.combine(stamp)
    hasher.combine(localIds.map { Array($0.utf8) })
    hasher.combine(ids)
    hasher.combine(releaseAt)
    hasher.combine(retired.map { Array($0.utf8) })
    hasher.combine(superseded.map { Array($0.utf8) })
  }
}

// MARK: - Reading

public enum ViewMode: Hashable, Sendable {
  case drawn, stored
}

public struct TextValue: Hashable, Sendable {
  public let text: String
  public let merged: Bool
  public let pending: Bool

  public init(text: String, merged: Bool, pending: Bool) {
    self.text = text
    self.merged = merged
    self.pending = pending
  }

  public static func == (lhs: TextValue, rhs: TextValue) -> Bool {
    lhs.text.utf8.elementsEqual(rhs.text.utf8) && lhs.merged == rhs.merged && lhs.pending == rhs.pending
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(text.utf8))
    hasher.combine(merged)
    hasher.combine(pending)
  }
}

// One record of a view: its life and born, its lattice values and the stamp of the register that holds each (§3), its
// texts and serials, the server's order and receipt times of its confirmed row, and what the outbox holds of it.
public struct Record: Hashable, Sendable {
  public let type: String
  public let id: RecordID
  public let life: Life?
  public let born: Stamp?
  public let values: [String: JSON]
  // By field, as `values`.
  public let stamps: [String: Stamp]
  public let texts: [String: TextValue]
  public let serials: [String: JSON]
  // §9.1 the confirmed row's `seq`, `rc` and `ru`; nil where the scope holds no confirmed row of the record.
  public let seq: Int64?
  public let rc: Int64?
  public let ru: Int64?
  public let isVisible: Bool
  public let isPending: Bool
  public let isHeld: Bool

  public init(type: String, id: RecordID, life: Life?, born: Stamp?, values: [String: JSON], stamps: [String: Stamp],
              texts: [String: TextValue], serials: [String: JSON], seq: Int64?, rc: Int64?, ru: Int64?, isVisible: Bool,
              isPending: Bool, isHeld: Bool) {
    self.type = type
    self.id = id
    self.life = life
    self.born = born
    self.values = values
    self.stamps = stamps
    self.texts = texts
    self.serials = serials
    self.seq = seq
    self.rc = rc
    self.ru = ru
    self.isVisible = isVisible
    self.isPending = isPending
    self.isHeld = isHeld
  }

  public static func == (lhs: Record, rhs: Record) -> Bool {
    lhs.type.utf8.elementsEqual(rhs.type.utf8) && lhs.id == rhs.id && lhs.life == rhs.life && lhs.born == rhs.born
      && lhs.values == rhs.values && lhs.stamps == rhs.stamps && lhs.texts == rhs.texts && lhs.serials == rhs.serials
      && lhs.seq == rhs.seq && lhs.rc == rhs.rc && lhs.ru == rhs.ru
      && lhs.isVisible == rhs.isVisible && lhs.isPending == rhs.isPending && lhs.isHeld == rhs.isHeld
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(type.utf8))
    hasher.combine(id)
    hasher.combine(life)
    hasher.combine(born)
    hasher.combine(values)
    hasher.combine(stamps)
    hasher.combine(texts)
    hasher.combine(serials)
    hasher.combine(seq)
    hasher.combine(rc)
    hasher.combine(ru)
    hasher.combine(isVisible)
    hasher.combine(isPending)
    hasher.combine(isHeld)
  }
}

// MARK: - Notices and Undo

// What a refused intent held, and each dependent folded into its refusal (§7.7 step 4). An opted command's predictions
// keep their scopes, and where a refusal crossed scopes each dependent names the scope it was committed in.
public struct NoticeContent: Hashable, Sendable {
  public var scope: ScopeRef?
  public var deltas: [Delta]
  public var command: Command?
  public var predictions: [ScopedDeltas]?
  public var dependents: [NoticeContent]

  public init(scope: ScopeRef? = nil, deltas: [Delta] = [], command: Command? = nil, predictions: [ScopedDeltas]? = nil,
              dependents: [NoticeContent] = []) {
    self.scope = scope
    self.deltas = deltas
    self.command = command
    self.predictions = predictions
    self.dependents = dependents
  }
}

// D-17 the durable record of a refused intent, for its product to describe. Dismissing a notice hides it; it is never
// deleted while an outbox entry's `orphanOf` names it.
public struct Notice: Hashable, Sendable, Identifiable {
  public let id: String
  public let product: String
  public let scope: ScopeRef
  public let code: RefusalCode
  public let detail: JSON?
  public let content: NoticeContent
  public let at: Int64
  public let isDismissed: Bool

  public init(id: String, product: String, scope: ScopeRef, code: RefusalCode, detail: JSON?, content: NoticeContent,
              at: Int64, isDismissed: Bool = false) {
    self.id = id
    self.product = product
    self.scope = scope
    self.code = code
    self.detail = detail
    self.content = content
    self.at = at
    self.isDismissed = isDismissed
  }

  public static func == (lhs: Notice, rhs: Notice) -> Bool {
    lhs.id.utf8.elementsEqual(rhs.id.utf8) && lhs.product.utf8.elementsEqual(rhs.product.utf8) && lhs.scope == rhs.scope
      && lhs.code == rhs.code && lhs.detail == rhs.detail && lhs.content == rhs.content && lhs.at == rhs.at
      && lhs.isDismissed == rhs.isDismissed
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(id.utf8))
    hasher.combine(Array(product.utf8))
    hasher.combine(scope)
    hasher.combine(code)
    hasher.combine(detail)
    hasher.combine(content)
    hasher.combine(at)
    hasher.combine(isDismissed)
  }
}

// A held gesture that Undo can still remove, until `releaseAt` (device ms, §7.3).
public struct UndoOffer: Hashable, Sendable, Identifiable {
  public let id: String
  public let scope: ScopeRef
  public let releaseAt: Int64

  public init(id: String, scope: ScopeRef, releaseAt: Int64) {
    self.id = id
    self.scope = scope
    self.releaseAt = releaseAt
  }

  public static func == (lhs: UndoOffer, rhs: UndoOffer) -> Bool {
    lhs.id.utf8.elementsEqual(rhs.id.utf8) && lhs.scope == rhs.scope && lhs.releaseAt == rhs.releaseAt
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(id.utf8))
    hasher.combine(scope)
    hasher.combine(releaseAt)
  }
}

// Called in the result transaction before acknowledgement or resolution removes the command.
public typealias CommandResultDeviceWrites = @Sendable (Command, PushResult, String, JSON.Object) -> [DeviceWrite]

// Product device rows that hold unsaved work beyond the outbox; sign-out pins their values when asking Discard.
public typealias PendingDeviceWork = @Sendable (String, JSON.Object) -> [String]
