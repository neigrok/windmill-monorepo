import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A note: a title and a body the lifter writes for Coach, ten to an account, in the order they take precedence.

public struct Note: Draftable, Removable, Ordered {
  public static let type = Gym.Types.note
  public static let scope = ScopeRef.product("gym")
  public static let orderField = "ord"
  public static let savesGuarded = true
  public static let heldRemoval = true

  public let id: ID<Note>
  public var title: String
  public var body: String

  public init(id: ID<Note>, title: String = "", body: String = "") {
    self.id = id
    self.title = title
    self.body = body
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), title: try r.string("title"), body: try r.string("body", default: ""))
  }

  public var fields: [String: JSON] { ["title": .string(title), "body": .string(body)] }

  public static let checks: [Check<Note>] = [
    Check("title") { n, _ in n.title = try NoteRules.title.apply(n.title, at: "title") },
    Check("body") { n, _ in n.body = try NoteRules.body.apply(n.body, at: "body") },
  ]

  // Engine A.2's `position`: the dense rank of (ord, id), 1 for the top note, among the alive notes `stored` lists, a note
  // inside its delete window included.
  public static func position(of id: ID<Note>, stored notes: [Note]) -> Int? {
    notes.firstIndex { $0.id == id }.map { $0 + 1 }
  }
}

public enum NoteRules {
  public static let title = TextSpec("note.title", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let body = TextSpec("note.body", unit: .bytes, min: 0, max: 500, trim: true, nfc: true)
  static let rules: [Rule] = [.local(title), .local(body)]
}

public typealias SaveNote = SaveDraft<Note, GymRefusal>
public typealias DeleteNote = Remove<Note, GymRefusal>
public typealias MoveNote = Move<Note, GymRefusal>

// Coach's `save_note` on the phone: the call's note, under the id its turn gave it, goes below every stored note. A
// replay that finds that note stored, or a call whose words a stored note holds, is done and writes nothing.
public struct SaveNoteCall: Action {
  public typealias Loaded = (save: SaveDraftLoaded<Note>, stored: [Note], slots: Capacity)

  public let note: Note

  public init(_ note: Note) {
    self.note = note
  }

  public var scope: ScopeRef { Note.scope }

  public func load(_ read: Reader) throws -> Loaded {
    let notes = read.repository(Note.self)
    return (try save.load(read), try notes.all(in: .stored), try notes.capacity())
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Note>, GymRefusal> {
    switch try save.decide(loaded.save, ids: ids) {
    case .refuse(.taken), .unchanged: return .unchanged(note.id)
    case .refuse(let refusal): return .refuse(refusal)
    case .write(let plan, let saved):
      if let same = loaded.stored.first(where: { $0.fields == saved.values }) { return .unchanged(same.id) }
      let slots = loaded.slots
      if slots.used + 1 > slots.cap { return .refuse(GymRefusal(.cap(Note.type, cap: slots.cap, subject: note.id.ref))) }
      return .write(plan, note.id)
    }
  }

  var save: SaveNote { SaveNote(creating: note, placed: .bottom) }
}
