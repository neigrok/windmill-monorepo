import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The readers a `read` and a commit's body get (§7.6, design §5.2): drawn and stored apart, the indexed read by a ref
// field (ER-12), device rows, the first pull, ids minted inside a commit, and every misuse of a reader, which is
// malformed (§7.1) wherever it surfaces.

struct ReadersTests {
  // A product whose items name their list by an lww ref, so a pending write can move a reference.
  static let shelf = try! Registry(json: JSON(parsing: """
    {"registry": "shelf", "version": 1, "minVersion": 1, "products": {"shelf": {"surfaces": ["ios"]}}, "commands": [],
     "types": [
       {"type": "list", "scope": "product:shelf", "identity": "minted", "idSpace": "global", "idPattern": "^l_[a-z]{4}$",
        "mint": {"prefix": "l_", "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 4}, "life": true, "revivable": false,
        "deadRows": "spent", "origins": ["replica"], "primary": true, "fields": {}},
       {"type": "item", "scope": "product:shelf", "identity": "minted", "idSpace": "global", "idPattern": "^i_[a-z]{4}$",
        "mint": {"prefix": "i_", "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 4}, "life": true, "revivable": false,
        "deadRows": "spent", "origins": ["replica"], "primary": true,
        "fields": {"listId": {"kind": "lww", "writer": "client", "ref": "list", "domain": {"type": "string"}},
                   "name": {"kind": "lww", "writer": "client", "unit": "chars", "max": 12, "domain": {"type": "string"}}}}
     ]}
    """))
  static let scope = ScopeRef.product("shelf")
  static let seeded = try! Stamp("1:0:r_seed")

  // Confirmed rows, as a pull would have left them.
  static func seed(_ rig: Rig, items: [(id: String, list: String)]) throws {
    let rows = try items.map { item in
      try Row(json: [
        "t": "item", "id": .string(item.id), "life": ["alive", seeded.json], "born": seeded.json,
        "f": ["listId": [.string(item.list), seeded.json], "name": [.string(item.id), seeded.json]], "seq": 1, "rc": 5, "ru": 6,
      ])
    }
    _ = try rig.store.write(.pullPage) { tx in
      var replica = try tx.replica(tx.activeReplica(), reads: [scope: RowSelection(keys: Set(rows.map(\.key)))])!
      for row in rows { replica.apply(.putRow(scope, row)) }
      return Planned((), replica.batch)
    }
  }

  static func ids(_ records: [Record]) -> [String] { records.map(\.id.description) }

  // A reader a `read` or a commit passed, used after that call returned, is malformed, a mint included; so is a commit
  // whose body reads through such a reader and lets its error out.
  @Test func aReaderUsedAfterItsCallIsMalformed() throws {
    let rig = try Rig(registry: Self.shelf)
    let ended = CommitFailure(.malformed, "a reader serves only inside the call that passed it")
    var kept: (any ScopeReader)?
    _ = try rig.engine.read(Self.scope) { reader in
      kept = reader
      return try reader.drawn("item").count
    }
    #expect(throws: ended) { try kept!.drawn("item") }
    #expect(throws: ended) { try kept!.device("anything") }
    var context: (any CommitContext)?
    _ = try rig.engine.commit(Self.scope) { body -> (Gesture?, Void) in
      context = body
      return (nil, ())
    }
    #expect(throws: ended) { try context!.stored("item", "i_aaaa") }
    #expect(throws: ended) { try context!.firstPullComplete() }
    #expect(throws: ended) { try context!.mintID("item") }
    #expect(throws: ended) { try rig.engine.commit(Self.scope) { _ -> (Gesture?, Int) in (nil, try kept!.drawn("item").count) } }
  }

  // §7.1: a read of a type outside the reader's scope, or by a field that is no ref, and a reader of a scope the
  // registry does not hold, are malformed wherever they surface: through `read`, and inside a commit whether its body
  // lets the error out or swallows it. A commit that met one writes nothing.
  @Test func aMisuseOfAReaderIsMalformedThroughReadAndInsideACommit() throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    let misuses: [(scope: ScopeRef, failure: CommitFailure, use: (any ScopeReader) throws -> Void)] = [
      (Rig.scope, CommitFailure(.malformed, "tag is no type of self/probe"), { _ = try $0.drawn("tag") }),
      (Rig.scope, CommitFailure(.malformed, "card.title is not a top-level ref field"), { _ = try $0.stored("card", where: "title", is: "card0001") }),
      (.device("probe"), CommitFailure(.malformed, "device/probe is no product, tree or overlay scope of the registry"), { _ = try $0.drawn("card") }),
    ]
    for (scope, failure, use) in misuses {
      #expect(throws: failure) { try rig.engine.read(scope, use) }
      #expect(throws: failure) { try rig.engine.commit(scope) { context -> (Gesture?, Void) in (nil, try use(context)) } }
      #expect(throws: failure) {
        try rig.engine.commit(scope) { context -> (Gesture?, Void) in
          _ = try? use(context)
          return (Gesture(changes: [Rig.card("card0001", "One")]), ())
        }
      }
    }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }

  @Test func aHeldDeleteIsGoneFromDrawnAndStillInStored() throws {
    let rig = try Rig(registry: Self.shelf)
    try Self.seed(rig, items: [("i_aaaa", "l_one")])
    let receipt = try rig.commit(Gesture(changes: [.delete("item", "i_aaaa")], hold: true), in: Self.scope)
    let alive = Life(.alive, Self.seeded)
    let values: [String: JSON] = ["listId": "l_one", "name": "i_aaaa"]
    let (drawn, stored) = try rig.engine.read(Self.scope) { reader in
      (try reader.drawn("item", "i_aaaa"), try reader.stored("item", "i_aaaa"))
    }
    #expect(drawn == Record(
      type: "item", id: "i_aaaa", life: Life(.dead, receipt.stamp), born: Self.seeded, values: values, texts: [:], serials: [:],
      rc: 5, ru: 6, isVisible: false, isPending: true, isHeld: true))
    #expect(stored == Record(
      type: "item", id: "i_aaaa", life: alive, born: Self.seeded, values: values, texts: [:], serials: [:], rc: 5, ru: 6,
      isVisible: true, isPending: false, isHeld: true))
    #expect(try rig.engine.read(Self.scope) { [try Self.ids($0.drawn("item")), try Self.ids($0.stored("item"))] } == [[], ["i_aaaa"]])
  }

  // ER-12: the index names the confirmed side; a pending write that moves a reference is seen leaving and arriving.
  @Test func theIndexedReadSeesAPendingMoveOnBothSides() throws {
    let rig = try Rig(registry: Self.shelf)
    try Self.seed(rig, items: [("i_aaaa", "l_one"), ("i_bbbb", "l_one"), ("i_cccc", "l_two")])
    try rig.commit(Gesture(changes: [.update("item", "i_aaaa", ["listId": "l_two"])]), in: Self.scope)
    try rig.commit(Gesture(changes: [.create("item", id: .given("i_dddd"), ["listId": "l_one", "name": "new"])]), in: Self.scope)
    try rig.commit(Gesture(changes: [.update("item", "i_bbbb", ["listId": "l_two"])], hold: true), in: Self.scope)
    let lists = try rig.engine.read(Self.scope) { reader in
      try ["l_one", "l_two"].flatMap { list in
        [try Self.ids(reader.drawn("item", where: "listId", is: RecordID(list))),
         try Self.ids(reader.stored("item", where: "listId", is: RecordID(list)))]
      }
    }
    #expect(lists == [["i_dddd"], ["i_bbbb", "i_dddd"], ["i_aaaa", "i_bbbb", "i_cccc"], ["i_aaaa", "i_cccc"]])
  }

  @Test func deviceReadsTheRowsOfTheScopesProduct() throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [], local: [DeviceWrite(key: "rack", value: ["slot": 2])]))
    #expect(try rig.engine.read(Rig.scope) { try $0.device("rack") } == ["slot": 2])
    try rig.commit(Gesture(changes: [], local: [DeviceWrite(key: "rack", value: nil)]))
    #expect(try rig.engine.read(Rig.scope) { try $0.device("rack") } == nil)
  }

  // §2.4, §9.1: a key pattern matches printable ASCII only, so a device key with a look-alike of a letter is never
  // written, and the look-alike reads no row.
  @Test func aDeviceKeyOutsideASCIIIsNeverWritten() throws {
    let notes = try Registry(json: JSON(parsing: """
      {"registry": "notes", "version": 1, "minVersion": 1, "types": [], "commands": [],
       "products": {"notes": {"surfaces": ["ios"], "device": {"draft": {"keyPattern": "^draft:[a-z]+$"}}}}}
      """))
    let rig = try Rig(registry: notes)
    let scope = ScopeRef.product("notes")
    try rig.commit(Gesture(changes: [], local: [DeviceWrite(key: "draft:e", value: 1)]), in: scope)
    #expect(throws: CommitFailure(.malformed, "draft:\u{E9} is not a device row of notes")) {
      try rig.commit(Gesture(changes: [], local: [DeviceWrite(key: "draft:\u{E9}", value: 2)]), in: scope)
    }
    let keys = ["draft:e", "draft:\u{E9}", "draft:e\u{301}"]
    #expect(try keys.map { key in try rig.engine.read(scope) { try $0.device(key) } } == [1, nil, nil])
  }

  // §9.1, D-4: a reference the wire cannot carry, such as a tree id with a look-alike of an ASCII letter, names no scope:
  // it is neither read nor written, so no look-alike of a tree reaches the store. The commit is malformed (§7.1).
  @Test func aScopeTheWireCannotCarryIsNeitherReadNorWritten() throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    let tree = ScopeRef.tree("t\u{E9}")
    let noScope = CommitFailure(.malformed, "tree/t\u{E9} is no product, tree or overlay scope of the registry")
    #expect(throws: noScope) { try rig.engine.commit(tree, Gesture(changes: [.create("tag", id: .given("sail"))])) }
    #expect(throws: noScope) { try rig.engine.read(tree) { try $0.drawn("tag") } }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }

  // §7.9: true for a scope the replica does not pull (an anon replica pulls no product scope), else once booted.
  @Test func theFirstPullIsCompleteForAScopeTheReplicaDoesNotPull() throws {
    #expect(try Rig().engine.read(Rig.scope) { try $0.firstPullComplete() })
    #expect(try Rig(account: "A").engine.read(Rig.scope) { try $0.firstPullComplete() } == false)
  }

  // Board ids are eight hex digits: the draws are queued so the first id is one drawn already holds.
  @Test func anIdMintedInsideACommitIsNeverOneTheViewsOrTheCallHold() throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [.create("board", id: .given("b_00000000"))]))
    rig.random.queue(symbol: 0, of: 16, count: 8)
    rig.random.queue(symbol: 1, of: 16, count: 8)
    rig.random.queue(symbol: 1, of: 16, count: 8)
    rig.random.queue(symbol: 2, of: 16, count: 8)
    let (_, minted) = try rig.engine.commit(Rig.scope) { context -> (Gesture?, [RecordID]) in
      (nil, [try context.mintID("board"), try context.mintID("board")])
    }
    #expect(minted == ["b_11111111", "b_22222222"])
  }

  // A misuse of the read-and-commit context: the commit is malformed (§7.1).
  @Test func aMintOfATypeWithNoMintFailsItsCommitAndWritesNothing() throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    #expect(throws: CommitFailure(.malformed, "day mints no ids")) {
      try rig.engine.commit(Rig.scope) { context -> (Gesture?, Void) in
        (Gesture(changes: [.put("day", try context.mintID("day"), present: true)]), ())
      }
    }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }
}
