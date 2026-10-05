import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// Notes over the real engine: the Add row, the editor's one save, a move, a held delete and its Undo, Coach's
// `save_note`, and the races two phones of one account run; then the note against the registry and its actions' vectors.
struct NotesTests {
  static func phone() -> Harness {
    Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
  }

  // The Add row: a blank placed at the bottom, its id minted as it opens, then the lifter's words.
  static func add(_ h: Harness, _ title: String, body: String = "") throws -> ID<Note> {
    var draft = Draft(new: Note(id: h.runner.mint(Note.self)), placed: .bottom)
    draft.current.title = title
    draft.current.body = body
    try #require(saved(h.runner.save(&draft, SaveNote.self)))
    return draft.id
  }

  @Test(arguments: [nil, Int64(1_800_000_000_000)])
  func contentTimeIsReadWithoutEnteringTheWriteMap(_ updatedAt: Int64?) throws {
    var values: [String: JSON] = ["title": "Tone", "body": "Blunt."]
    if let updatedAt { values["updatedAt"] = JSON(updatedAt) }
    let record = Record(type: Gym.Types.note, id: "note0001", life: nil, born: nil, values: values, texts: [:],
      serials: [:], rc: 100, ru: 200, isVisible: true, isPending: false, isHeld: false)
    let note = try Note(Fields(record))
    #expect(note.updatedAt == updatedAt.map { Instant(ms: $0) })
    #expect(note.fields == ["title": "Tone", "body": "Blunt."])
    #expect(Note(id: note.id, title: note.title, body: note.body).updatedAt == nil)
  }

  @Test func aNoteIsAddedBelowTheOthersAsTheStoreHoldsIt() throws {
    let a = NotesTests.phone()
    _ = try NotesTests.add(a, "What I am training for", body: "A 100 kg bench by June.")
    var draft = Draft(new: Note(id: a.runner.mint(Note.self)), placed: .bottom)
    draft.current.title = "\u{2003}How I want to be talked to "
    draft.current.body = "Blunt. No pep talks.\n"
    #expect(saved(a.runner.save(&draft, SaveNote.self)))
    #expect(draft.current.fields == ["title": "How I want to be talked to", "body": "Blunt. No pep talks."])
    #expect(!draft.isNew && !draft.isDirty)
    #expect(try a.drawn(Note.self).map(\.fields) == [
      ["title": "What I am training for", "body": "A 100 kg bench by June."],
      ["title": "How I want to be talked to", "body": "Blunt. No pep talks."],
    ])
  }

  @Test func aNoteWithoutATitleIsRefusedAndTheRowKeepsItsDraft() throws {
    let a = NotesTests.phone()
    var draft = Draft(new: Note(id: a.runner.mint(Note.self)), placed: .bottom)
    draft.current.title = " "
    draft.current.body = "Blunt."
    #expect(refused(a.runner.save(&draft, SaveNote.self)) == .invalid(Violation(rule: "note.title", path: "title", reason: .blank)))
    #expect(draft.isNew && draft.touched == ["body", "title"])
    #expect(try a.drawn(Note.self).isEmpty)
  }

  @Test func theTenthNoteFillsTheAccountAndAHeldDeleteKeepsItsSlotUntilItLands() throws {
    let a = NotesTests.phone()
    let notes = try (1...10).map { try NotesTests.add(a, "Note \($0)") }
    var eleventh = Draft(new: Note(id: a.runner.mint(Note.self)), placed: .bottom)
    eleventh.current.title = "Note 11"
    #expect(refused(a.runner.save(&eleventh, SaveNote.self)) == .full(type: "note", cap: 10, .predicted))
    _ = try a.runner.run(DeleteNote(notes[0]))
    let slots = try a.runner.read(Note.scope) { try $0.repository(Note.self).capacity() }
    #expect(slots.used == 10 && slots.isFull)
    #expect(refused(a.runner.save(&eleventh, SaveNote.self)) == .full(type: "note", cap: 10, .predicted))
    a.advance(ms: Constants.holdMs)
    #expect(saved(a.runner.save(&eleventh, SaveNote.self)))
    #expect(try a.drawn(Note.self).map(\.title) == (2...11).map { "Note \($0)" })
  }

  @Test func twoPhonesAddingTheTenthNoteLeaveOneAFullNoticeHoldingItsWords() throws {
    let a = NotesTests.phone()
    let b = a.device()
    for n in 1...9 { _ = try NotesTests.add(a, "Note \(n)") }
    a.sync()
    _ = try NotesTests.add(a, "From A")
    let fromB = try NotesTests.add(b, "From B", body: "Kept in the notice.")
    a.sync()
    let notices = try b.notices(GymRefusal.self)
    #expect(notices.map(\.refusal) == [.full(type: "note", cap: 10, .notice)])
    #expect(notices.map { $0.values(of: fromB.ref) } == [["title": "From B", "body": "Kept in the notice.", "ord": "a9"]])
    #expect(try b.drawn(Note.self).map(\.id) == a.drawn(Note.self).map(\.id))
    #expect(try b.drawn(Note.self).map(\.title) == (1...9).map { "Note \($0)" } + ["From A"])
  }

  @Test func anEditWritesOnlyTheFieldItChangedSoTwoPhonesKeepBoth() throws {
    let a = NotesTests.phone()
    let b = a.device()
    let id = try NotesTests.add(a, "Tone", body: "Blunt.")
    a.sync()
    var onA = try #require(try a.runner.open(id))
    var onB = try #require(try b.runner.open(id))
    onA.current.body = "Blunt. No pep talks."
    onB.current.title = "How I want to be talked to"
    #expect(saved(a.runner.save(&onA, SaveNote.self)))
    #expect(saved(b.runner.save(&onB, SaveNote.self)))
    a.sync()
    let both: [[String: JSON]] = [["title": "How I want to be talked to", "body": "Blunt. No pep talks."]]
    #expect(try a.drawn(Note.self).map(\.fields) == both && b.drawn(Note.self).map(\.fields) == both)
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
  }

  @Test func aStaleEditIsRefusedBeforeItIsSentAndKeepMineWritesOnlyMine() throws {
    let a = NotesTests.phone()
    let b = a.device()
    let id = try NotesTests.add(a, "Tone", body: "Blunt.")
    a.sync()
    var mine = try #require(try a.runner.open(id))
    var theirs = try #require(try b.runner.open(id))
    mine.current.title = "Tone, from A"
    theirs.current.title = "Tone, from B"
    theirs.current.body = "Blunt, from B."
    #expect(saved(b.runner.save(&theirs, SaveNote.self)))
    a.sync()
    #expect(refused(a.runner.save(&mine, SaveNote.self)) == .stale(id.ref, .predicted))
    mine = mine.rebased(onto: try #require(try a.runner.open(id)).current)
    #expect(mine.touched == ["title"])
    #expect(saved(a.runner.save(&mine, SaveNote.self)))
    a.sync()
    #expect(try b.drawn(Note.self).map(\.fields) == [["title": "Tone, from A", "body": "Blunt, from B."]])
  }

  // Both phones save before either sends; the first phone's sender runs first, so the second's guard finds a newer stamp.
  @Test func anEditRacingAnotherPhonesReturnsAsAStaleNoticeAndTakeTheirsReopensIt() throws {
    let a = NotesTests.phone()
    let b = a.device()
    let id = try NotesTests.add(a, "Tone")
    a.sync()
    var mine = try #require(try a.runner.open(id))
    var theirs = try #require(try b.runner.open(id))
    mine.current.title = "Tone, from A"
    theirs.current.title = "Tone, from B"
    #expect(saved(a.runner.save(&mine, SaveNote.self)))
    #expect(saved(b.runner.save(&theirs, SaveNote.self)))
    a.sync()
    let notices = try b.notices(GymRefusal.self)
    #expect(notices.map(\.refusal) == [.stale(id.ref, .notice)])
    #expect(notices.map { $0.values(of: id.ref) } == [["title": "Tone, from B"]])
    theirs = try #require(try b.runner.open(id))
    #expect(theirs.current.fields == ["title": "Tone, from A", "body": ""] && !theirs.isDirty)
  }

  @Test func anEditOfANoteDeletedOnAnotherPhoneIsGone() throws {
    let a = NotesTests.phone()
    let b = a.device()
    let id = try NotesTests.add(a, "Tone")
    a.sync()
    var editing = try #require(try b.runner.open(id))
    editing.current.title = "Tone, kept"
    _ = try a.runner.run(DeleteNote(id))
    a.advance(ms: Constants.holdMs)
    a.sync()
    #expect(refused(b.runner.save(&editing, SaveNote.self)) == .gone(id.ref, .predicted))
    #expect(editing.isDirty)
  }

  @Test func anEditSavedBeforeTheDeleteArrivedReturnsAsAGoneNotice() throws {
    let a = NotesTests.phone()
    let b = a.device()
    let id = try NotesTests.add(a, "Tone")
    a.sync()
    var editing = try #require(try b.runner.open(id))
    editing.current.title = "Tone, kept"
    _ = try a.runner.run(DeleteNote(id))
    a.advance(ms: Constants.holdMs)
    #expect(saved(b.runner.save(&editing, SaveNote.self)))
    a.sync()
    let notices = try b.notices(GymRefusal.self)
    #expect(notices.map(\.refusal) == [.gone(id.ref, .notice)])
    #expect(notices.map { $0.values(of: id.ref) } == [["title": "Tone, kept"]])
    #expect(try b.drawn(Note.self).isEmpty)
  }

  @Test func aMoveWritesTheMovedNoteAloneAndADropInPlaceWritesNothing() throws {
    let a = NotesTests.phone()
    let b = a.device()
    let one = try NotesTests.add(a, "One")
    let two = try NotesTests.add(a, "Two")
    let three = try NotesTests.add(a, "Three")
    #expect(unchanged(try a.runner.run(MoveNote(two, below: one))) != nil)
    let moved = try #require(try a.runner.run(MoveNote(three, below: nil)).receipt)
    #expect(moved.ids == [three.record])
    a.sync()
    let notes = try b.stored(Note.self)
    #expect(notes.map(\.id) == [three, one, two])
    #expect([three, one, two].map { Note.position(of: $0, stored: notes) } == [0, 1, 2])
  }

  @Test func aDeleteIsHeldForItsWindowKeepingItsPositionAndUndoBringsTheNoteBack() throws {
    let a = NotesTests.phone()
    let b = a.device()
    let one = try NotesTests.add(a, "One")
    let two = try NotesTests.add(a, "Two")
    a.sync()
    let removal = try #require(try a.runner.run(DeleteNote(one)).receipt)
    #expect(removal.releaseAt == 1_800_000_000_000 + Constants.holdMs)
    #expect(a.undoOffers().map(\.id) == [removal.gestureId])
    #expect(try a.drawn(Note.self).map(\.id) == [two])
    #expect(Note.position(of: two, stored: try a.stored(Note.self)) == 1)
    #expect(try a.runner.undo(removal.gestureId))
    #expect(try a.drawn(Note.self).map(\.id) == [one, two])
    let again = try #require(try a.runner.run(DeleteNote(one)).receipt)
    a.sync()
    #expect(try b.drawn(Note.self).map(\.id) == [one, two])
    a.advance(ms: Constants.holdMs)
    a.sync()
    #expect(try b.drawn(Note.self).map(\.id) == [two])
    #expect(try a.runner.undo(again.gestureId) == false)
  }

  @Test func coachAppendsItsNoteAndAReplayKeepsTheLiftersEdit() throws {
    let a = NotesTests.phone()
    _ = try NotesTests.add(a, "What I am training for")
    let call = SaveNoteCall(Note(id: a.runner.mint(Note.self), title: " Knee ", body: "No deep lunges."))
    #expect(committed(try a.runner.run(call)) == call.note.id)
    #expect(try a.drawn(Note.self).map(\.fields) == [
      ["title": "What I am training for", "body": ""], ["title": "Knee", "body": "No deep lunges."],
    ])
    var edited = try #require(try a.runner.open(call.note.id))
    edited.current.body = "No deep lunges, ever."
    #expect(saved(a.runner.save(&edited, SaveNote.self)))
    #expect(unchanged(try a.runner.run(call)) == call.note.id)
    #expect(try a.drawn(Note.self).map(\.body) == ["", "No deep lunges, ever."])
  }

  // Inside the delete window the replay finds its note taken. Once the delete has landed the phone holds no row of the
  // note, so the replay commits a create, drawn until the server refuses it `id-spent` as a taken notice.
  @Test func aReplayInsideTheDeleteWindowIsDoneAndOneAfterItReturnsAsATakenNotice() throws {
    let a = NotesTests.phone()
    let call = SaveNoteCall(Note(id: a.runner.mint(Note.self), title: "Knee"))
    _ = try a.runner.run(call)
    a.sync()
    _ = try a.runner.run(DeleteNote(call.note.id))
    #expect(unchanged(try a.runner.run(call)) == call.note.id)
    a.advance(ms: Constants.holdMs)
    a.sync()
    #expect(committed(try a.runner.run(call)) == call.note.id)
    a.sync()
    #expect(try a.notices(GymRefusal.self).map(\.refusal) == [.taken(call.note.id.ref, .notice)])
    #expect(try a.drawn(Note.self).isEmpty)
  }

  @Test func coachReusesTheStoredNoteHoldingItsWordsSoUndoLeavesOne() throws {
    let a = NotesTests.phone()
    let id = try NotesTests.add(a, "Tone", body: "Blunt.")
    let removal = try #require(try a.runner.run(DeleteNote(id)).receipt)
    let call = SaveNoteCall(Note(id: a.runner.mint(Note.self), title: "Tone ", body: "Blunt."))
    #expect(unchanged(try a.runner.run(call)) == id)
    #expect(try a.runner.undo(removal.gestureId))
    #expect(try a.drawn(Note.self).map(\.id) == [id])
  }

  // A turn records each call in the call's own gesture (gym Coach §4.3), so it sees every refusal in decide: the cap,
  // counting a held delete, and a violation.
  @Test func aTurnSeesTheCallsRefusalsInDecide() throws {
    let a = NotesTests.phone()
    let notes = try (1...10).map { try NotesTests.add(a, "Note \($0)") }
    _ = try a.runner.run(DeleteNote(notes[9]))
    let full = SaveNoteCall(Note(id: a.runner.mint(Note.self), title: "Knee"))
    let blank = SaveNoteCall(Note(id: a.runner.mint(Note.self), title: " "))
    #expect(try a.runner.run(full).refusal == .full(type: "note", cap: 10, .predicted))
    #expect(try [full, blank].map { try unchanged(a.runner.run(Recording(call: $0))) }
      == [.full(type: "note", cap: 10, .predicted), .invalid(Violation(rule: "note.title", path: "title", reason: .blank))])
  }

  @Test func theNoteAgreesWithTheRegistry() throws {
    let sample = Note(id: ID("note0001"), title: "How I want to be talked to", body: "Blunt. No pep talks.")
    try RegistryCheck.entity(Note.self, sample: sample, book: GymRules.book, registry: SyncSchema.registry)
  }

  @Test(arguments: try Contract.vectors("gym/domain/notes-actions.json"))
  func action(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let result = switch try vector.input.member("action").asString() {
    case "SaveNoteCall":
      try corpus.decision(of: SaveNoteCall(try Note(form: input.member("note"))), vector, result: \.json, refusal: \.form)
    case let action: throw ContractError("no notes action \(action)")
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  // How a turn composes a call (domain-kit §9.3): every refusal of its decision is what the turn records.
  struct Recording: Action {
    let call: SaveNoteCall
    var scope: ScopeRef { call.scope }

    func load(_ read: Reader) throws -> SaveNoteCall.Loaded { try call.load(read) }

    func decide(_ loaded: SaveNoteCall.Loaded, ids: IDSource) -> Decision<GymRefusal?, GymRefusal> {
      switch call.decision(loaded, ids: ids) {
      case .write(let plan, _): .write(plan, nil)
      case .unchanged: .unchanged(nil)
      case .refuse(let refusal): .unchanged(refusal)
      }
    }
  }
}
