import SyncCore

// The values a product domain or the domain kit names when it writes and reads through the engine (§7.1, §7.6).

public struct RecordRef: Hashable, Sendable {
  public let type: String
  public let id: RecordID

  public init(type: String, id: RecordID) {
    self.type = type
    self.id = id
  }

  public var key: RecordKey { RecordKey(type, id) }
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
}

// D-25 where a member is placed: its order field, and the record just above the drop point (nil: the top).
public struct OrderAnchor: Hashable, Sendable {
  public let field: String
  public let below: RecordID?

  public init(field: String, below: RecordID?) {
    self.field = field
    self.below = below
  }
}

// How a create names its record (D-8, D-26); every kind but `given` is resolved inside the commit.
public enum NewID: Hashable, Sendable {
  case minted
  case seeded(seed: String, ordinal: Int)
  case derived(label: String)
  case given(RecordID)
}

// A text change and the text it was edited from; nil means the text drawn when the commit reads it (§7.1 step 4).
public struct TextEdit: Hashable, Sendable {
  public var text: String
  public var editedFrom: String?

  public init(text: String, editedFrom: String? = nil) {
    self.text = text
    self.editedFrom = editedFrom
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
  public let anchor: OrderAnchor?

  public init(type: String, operation: Operation, values: [String: JSON] = [:], texts: [String: TextEdit] = [:],
              anchor: OrderAnchor? = nil) {
    self.type = type
    self.operation = operation
    self.values = values
    self.texts = texts
    self.anchor = anchor
  }

  // `anchor`: the D-25 drop position of the order field it names, which `values` then leaves out.
  public static func create(_ type: String, id: NewID = .minted, _ values: [String: JSON] = [:],
                            texts: [String: TextEdit] = [:], anchor: OrderAnchor? = nil) -> Change {
    Change(type: type, operation: .create(id), values: values, texts: texts, anchor: anchor)
  }

  public static func update(_ type: String, _ id: RecordID, _ values: [String: JSON] = [:],
                            texts: [String: TextEdit] = [:]) -> Change {
    Change(type: type, operation: .update(id), values: values, texts: texts)
  }

  public static func delete(_ type: String, _ id: RecordID) -> Change {
    Change(type: type, operation: .delete(id))
  }

  public static func revive(_ type: String, _ id: RecordID, _ values: [String: JSON] = [:]) -> Change {
    Change(type: type, operation: .revive(id), values: values)
  }

  // A keyed record with life; `present` nil keeps its drawn presence.
  public static func put(_ type: String, _ id: RecordID, present: Bool?, _ values: [String: JSON] = [:],
                         texts: [String: TextEdit] = [:]) -> Change {
    Change(type: type, operation: .put(id, present: present), values: values, texts: texts)
  }

  // A keyed record without life, or a singleton.
  public static func write(_ type: String, _ id: RecordID, _ values: [String: JSON] = [:],
                           texts: [String: TextEdit] = [:]) -> Change {
    Change(type: type, operation: .write(id), values: values, texts: texts)
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
}

// A row of `device/<product>`, written with the gesture and never sent; nil deletes it.
public struct DeviceWrite: Hashable, Sendable {
  public let key: String
  public let value: JSON?

  public init(key: String, value: JSON?) {
    self.key = key
    self.value = value
  }
}

// §7.1 one user act and its options.
public struct Gesture: Hashable, Sendable {
  public var changes: [Change]
  public var atomic: Bool
  public var hold: Bool
  public var guards: [RegisterRef]
  public var retire: [RecordRef]
  public var command: Command?
  public var predict: [Change]
  public var local: [DeviceWrite]
  public var gestureId: String?

  // `guards`: exactly these lattice registers, each at its stored stamp. `retire`: held removal gestures of these
  // records end undone first.
  public init(changes: [Change], atomic: Bool = false, hold: Bool = false, guards: [RegisterRef] = [],
              retire: [RecordRef] = [], command: Command? = nil, predict: [Change] = [], local: [DeviceWrite] = [],
              gestureId: String? = nil) {
    self.changes = changes
    self.atomic = atomic
    self.hold = hold
    self.guards = guards
    self.retire = retire
    self.command = command
    self.predict = predict
    self.local = local
    self.gestureId = gestureId
  }
}

public enum CommitOutcome: Hashable, Sendable {
  case committed(CommitReceipt)
  // scope-dead and cap write nothing; too-large refuses the whole gesture, and notice `notice:<gestureId>/0` holds it.
  case refused(RefusalCode, detail: JSON?)
}

public struct CommitReceipt: Hashable, Sendable {
  public let gestureId: String
  public let stamp: Stamp
  public let localIds: [String]
  public let ids: [RecordID?]
  public let releaseAt: Int64?
  public let retired: [String]

  // `ids`: the resolved id per change, aligned with the gesture's changes. `releaseAt`: set when held, the Undo deadline.
  public init(gestureId: String, stamp: Stamp, localIds: [String], ids: [RecordID?], releaseAt: Int64?, retired: [String]) {
    self.gestureId = gestureId
    self.stamp = stamp
    self.localIds = localIds
    self.ids = ids
    self.releaseAt = releaseAt
    self.retired = retired
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
}

// One record of a view: its lattice values, texts and serials, and what the outbox holds of it.
public struct Record: Hashable, Sendable {
  public let type: String
  public let id: RecordID
  public let life: Life?
  public let born: Stamp?
  public let values: [String: JSON]
  public let texts: [String: TextValue]
  public let serials: [String: JSON]
  public let rc: Int64?
  public let ru: Int64?
  public let isVisible: Bool
  public let isPending: Bool
  public let isHeld: Bool

  public init(type: String, id: RecordID, life: Life?, born: Stamp?, values: [String: JSON], texts: [String: TextValue],
              serials: [String: JSON], rc: Int64?, ru: Int64?, isVisible: Bool, isPending: Bool, isHeld: Bool) {
    self.type = type
    self.id = id
    self.life = life
    self.born = born
    self.values = values
    self.texts = texts
    self.serials = serials
    self.rc = rc
    self.ru = ru
    self.isVisible = isVisible
    self.isPending = isPending
    self.isHeld = isHeld
  }
}

// MARK: - Notices and Undo

// What a refused intent held, and each dependent folded into its refusal (§7.7 step 4).
public struct NoticeContent: Hashable, Sendable {
  public var deltas: [Delta]
  public var command: Command?
  public var dependents: [NoticeContent]

  public init(deltas: [Delta] = [], command: Command? = nil, dependents: [NoticeContent] = []) {
    self.deltas = deltas
    self.command = command
    self.dependents = dependents
  }
}

// D-17 the durable record of a refused intent, for its product to describe.
public struct Notice: Hashable, Sendable, Identifiable {
  public let id: String
  public let product: String
  public let scope: ScopeRef
  public let code: RefusalCode
  public let detail: JSON?
  public let content: NoticeContent
  public let at: Int64

  public init(id: String, product: String, scope: ScopeRef, code: RefusalCode, detail: JSON?, content: NoticeContent,
              at: Int64) {
    self.id = id
    self.product = product
    self.scope = scope
    self.code = code
    self.detail = detail
    self.content = content
    self.at = at
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
}
