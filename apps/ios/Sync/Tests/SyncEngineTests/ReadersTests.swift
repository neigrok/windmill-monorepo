import SyncAPI
import SyncCore
@testable import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The readers a `read` and a commit's body get (§7.6, design §5.2): drawn and stored apart, the indexed read by a ref
// field (ER-12), spent ids, device rows, the first pull, ids minted inside a commit, and every misuse of a reader, which
// is malformed (§7.1) wherever it surfaces.

struct ReadersTests {
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

  @Test func everyReadPathPreservesHeldPendingAndTextMetadata() throws {
    var document = try Rig.shelf.json.asObject()
    document["types"] = .array(try document.member("types").asArray().map { value in
      var type = try value.asObject()
      if type["type"] == "item" {
        var fields = try type.member("fields").asObject()
        for name in ["memo", "detail", "untouched"] {
          fields[name] = ["kind": "text", "writer": "client", "unit": "bytes", "max": 80]
        }
        type["fields"] = .object(fields)
      }
      return .object(type)
    })
    let rig = try Rig(registry: Registry(json: .object(document)))
    let scope = Self.scope
    let seeded = try Stamp("1:0:r_seed")
    let changed = try Stamp("2:0:r_change")
    let keys = ["i_aaaa", "i_bbbb", "i_cccc"].map { RecordKey("item", RecordID($0)) }
    let rows = keys.map { key in
      Row(key: key, lattice: Lattice(life: Life(.alive, seeded), born: seeded,
        fields: ["listId": Register("l_one", seeded), "name": Register(key.id.json, seeded)]),
        texts: Dictionary(uniqueKeysWithValues: ["memo", "detail", "untouched"].map { ($0, TextState(text: "confirmed", rev: 1, merged: true)) }),
        seq: 1, rc: 5, ru: 6)
    }
    let entries = [
      OutboxEntry(localId: "held/0", gestureId: "held", lineage: "anon", scope: scope, state: .held, commitOrder: 1,
        releaseAt: Int64.max, stamp: changed, intent: Intent(scope: scope, deltas: [
          Delta(key: keys[0], texts: ["memo": TextWrite(text: "held memo", base: .rev(1))]),
          Delta(key: keys[1], lattice: Lattice(fields: ["name": Register("held name", changed)])),
        ]), predict: [Delta(key: keys[0], texts: ["detail": TextWrite(text: "held detail", base: .rev(1))])]),
      OutboxEntry(localId: "ready/0", gestureId: "ready", lineage: "anon", scope: scope, state: .ready, commitOrder: 2,
        releaseAt: 0, stamp: changed, intent: Intent(scope: scope, deltas: [
          Delta(key: keys[1], texts: ["memo": TextWrite(text: "ready memo", base: .rev(1))]),
        ]), predict: [Delta(key: keys[1], texts: ["detail": TextWrite(text: "ready detail", base: .rev(1))])]),
    ]
    _ = try rig.store.write(.commit) { tx in
      let replica = try tx.activeReplica()
      return Planned((), ReplicaBatch(writes: rows.map { .replica(replica, .putRow(scope, $0)) }
        + entries.map { .replica(replica, .putEntry($0)) }))
    }
    for mode in [ViewMode.drawn, .stored] {
      let expected = keys.enumerated().map { index, key in
        let pending = index == 1 || index == 0 && mode == .drawn
        var texts = Dictionary(uniqueKeysWithValues: ["memo", "detail", "untouched"].map {
          ($0, TextValue(text: "confirmed", merged: true, pending: false))
        })
        if pending {
          for field in ["memo", "detail"] {
            texts[field] = TextValue(text: "\(index == 0 ? "held" : "ready") \(field)", merged: false, pending: true)
          }
        }
        let renamed = index == 1 && mode == .drawn
        return Record(type: "item", id: key.id, life: Life(.alive, seeded), born: seeded,
          values: ["listId": "l_one", "name": renamed ? "held name" : key.id.json], stamps: ["listId": seeded, "name": renamed ? changed : seeded],
          texts: texts, serials: [:], seq: 1, rc: 5, ru: 6, isVisible: true, isPending: pending, isHeld: index < 2)
      }
      let indexed = Dictionary(uniqueKeysWithValues: zip(keys, expected))
      try rig.store.read { tx in
        let reader = try TransactionReader(tx, core: rig.engine.core, scope: scope, deviceNow: Rig.startMs)
        let all = try Listing("item", mode, in: scope, registry: rig.store.registry)
        let narrowed = try Listing("item", mode, where: Listing.Narrowing(field: "listId", id: "l_one"), in: scope, registry: rig.store.registry)
        #expect(try reader.records(Set(keys), mode) == indexed)
        #expect(try reader.records(all) == expected)
        #expect(try reader.records(narrowed) == expected)
        #expect(try reader.records(Set(keys), in: narrowed) == indexed)
      }
    }
  }

  @Test func queuedCommandsReportAdmissionBeforeTheirPredictionIsPulled() async throws {
    let rig = try Rig(account: "A")
    _ = try rig.engine.commit(Rig.scope) { context -> (Gesture?, Void) in
      let id = try context.mintID("run")
      return (Gesture(changes: [], command: Command(name: "probe.start", args: ["id": id.json, "startedAt": JSON(context.now), "join": false]),
                      predict: [.create("run", id: .given(id), ["startedAt": JSON(context.now)])], gestureId: "admission"), ())
    }
    #expect(try rig.engine.commit(Rig.scope) { context in (nil as Gesture?, try context.commands().map(\.isAdmitted)) }.value == [false])
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 7)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.engine.commit(Rig.scope) { context in (nil as Gesture?, try context.commands().map(\.isAdmitted)) }.value == [true])
    #expect(try rig.outbox() == ["admission/0 acked 1"])
  }

  // E-7: an opted command's prediction in another scope reads pending there, as drawn and in a list, while its command
  // stays listed by its origin alone.
  @Test func aScopedPredictionReadsPendingInItsTargetWhileItsCommandStaysTheOrigins() throws {
    let rig = try Rig(account: "A")
    let child = ScopeRef.tree("b_00000002")
    _ = try rig.commit(Gesture(
      changes: [], command: Command(name: "probe.branch", args: ["parent": "b_00000001", "child": "b_00000002", "title": "Branch"]),
      scopedPredict: [ScopedPrediction(scope: child, changes: [.write("meta", "meta", ["title": "Branch"])])], gestureId: "branch"))
    let meta = try #require(try rig.engine.read(child) { try $0.drawn("meta", "meta") })
    #expect((meta.values["title"], meta.isPending, meta.isHeld) == ("Branch", true, false))
    let pending: [Bool] = try rig.engine.read(child) { (reader: any ScopeReader) -> [Bool] in try reader.stored("meta").map(\.isPending) }
    #expect(pending == [true])
    let listed = { (scope: ScopeRef) throws -> [String] in
      try rig.engine.commit(scope) { (context: any CommitContext) -> (Gesture?, [String]) in (nil, try context.commands().map(\.gestureId)) }.value
    }
    #expect(try listed(child) == [])
    #expect(try listed(Rig.scope) == ["branch"])
  }

  // §7.12: a read-and-commit body is given the id of the replica its commit writes to, the active one as it stands at
  // that commit: after a re-identify, the new id.
  @Test func aReadAndCommitBodyIsGivenTheIdOfTheReplicaItWritesTo() throws {
    let rig = try Rig(account: "A")
    let before = try rig.engine.commit(Rig.scope) { context in (nil as Gesture?, context.replica) }.value
    #expect(before == (try rig.meta().replica))
    _ = try rig.engine.write { store, instance in try store.reidentify(instance: &instance, identities: rig.engine.identities) }
    let after = try rig.engine.commit(Rig.scope) { context in (Gesture(changes: [Rig.card("card0001", "One")]), context.replica) }.value
    #expect(after == (try rig.meta().replica))
    #expect(after != before)
  }

  // A reader a `read` or a commit passed, used after that call returned, is malformed, a mint included; so is a commit
  // whose body reads through such a reader and lets its error out.
  @Test func aReaderUsedAfterItsCallIsMalformed() throws {
    let rig = try Rig(registry: Rig.shelf)
    let ended = CommitFailure(.malformed, "a reader serves only inside the call that passed it")
    var kept: (any ScopeReader)?
    _ = try rig.engine.read(Self.scope) { reader in
      kept = reader
      return try reader.drawn("item").count
    }
    #expect(throws: ended) { try kept!.drawn("item") }
    #expect(throws: ended) { try kept!.device("anything") }
    #expect(throws: ended) { try kept!.spentBorn("item", "i_aaaa") }
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
  // lets the error out or swallows it. A narrowed read checks its type before its field. A commit that met one writes
  // nothing.
  @Test func aMisuseOfAReaderIsMalformedThroughReadAndInsideACommit() throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    let misuses: [(scope: ScopeRef, failure: CommitFailure, use: (any ScopeReader) throws -> Void)] = [
      (Rig.scope, CommitFailure(.malformed, "tag is no type of self/probe"), { _ = try $0.drawn("tag") }),
      (Rig.scope, CommitFailure(.malformed, "card.title is not a top-level ref field"), { _ = try $0.stored("card", where: "title", is: "card0001") }),
      (Rig.scope, CommitFailure(.malformed, "tag is no type of self/probe"), { _ = try $0.drawn("tag", where: "label", is: "tag0001") }),
      (Rig.scope, CommitFailure(.malformed, "tag is no type of self/probe"), { _ = try $0.spentBorn("tag", "tag0001") }),
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
    let rig = try Rig(registry: Rig.shelf)
    try Self.seed(rig, items: [("i_aaaa", "l_one")])
    let receipt = try rig.commit(Gesture(changes: [.delete("item", "i_aaaa")], hold: true), in: Self.scope)
    let alive = Life(.alive, Self.seeded)
    let values: [String: JSON] = ["listId": "l_one", "name": "i_aaaa"]
    let stamps = ["listId": Self.seeded, "name": Self.seeded]
    let (drawn, stored) = try rig.engine.read(Self.scope) { reader in
      (try reader.drawn("item", "i_aaaa"), try reader.stored("item", "i_aaaa"))
    }
    #expect(drawn == Record(
      type: "item", id: "i_aaaa", life: Life(.dead, receipt.stamp), born: Self.seeded, values: values, stamps: stamps, texts: [:],
      serials: [:], seq: 1, rc: 5, ru: 6, isVisible: false, isPending: true, isHeld: true))
    #expect(stored == Record(
      type: "item", id: "i_aaaa", life: alive, born: Self.seeded, values: values, stamps: stamps, texts: [:], serials: [:], seq: 1,
      rc: 5, ru: 6, isVisible: true, isPending: false, isHeld: true))
    #expect(try rig.engine.read(Self.scope) { [try Self.ids($0.drawn("item")), try Self.ids($0.stored("item"))] } == [[], ["i_aaaa"]])
  }

  // §7.6, §9.1: a record carries the stamp of each register and its confirmed row's `seq`. A queued rename is drawn under
  // the gesture's stamp over the row's `seq`, while the confirmed read stays the server's copy; a record the server has
  // not sent has no confirmed read and no `seq`.
  @Test func aQueuedChangeIsDrawnUnderItsStampWhileTheConfirmedReadStaysTheServersCopy() throws {
    let rig = try Rig(registry: Rig.shelf)
    try Self.seed(rig, items: [("i_aaaa", "l_one")])
    let receipt = try rig.commit(Gesture(changes: [
      .update("item", "i_aaaa", ["name": "milk"]), .create("item", id: .given("i_bbbb"), ["listId": "l_one", "name": "eggs"]),
    ]), in: Self.scope)
    let pulled = Record(
      type: "item", id: "i_aaaa", life: Life(.alive, Self.seeded), born: Self.seeded, values: ["listId": "l_one", "name": "i_aaaa"],
      stamps: ["listId": Self.seeded, "name": Self.seeded], texts: [:], serials: [:], seq: 1, rc: 5, ru: 6, isVisible: true,
      isPending: false, isHeld: false)
    let renamed = Record(
      type: "item", id: "i_aaaa", life: Life(.alive, Self.seeded), born: Self.seeded, values: ["listId": "l_one", "name": "milk"],
      stamps: ["listId": Self.seeded, "name": receipt.stamp], texts: [:], serials: [:], seq: 1, rc: 5, ru: 6, isVisible: true,
      isPending: true, isHeld: false)
    let made = Record(
      type: "item", id: "i_bbbb", life: Life(.alive, receipt.stamp), born: receipt.stamp, values: ["listId": "l_one", "name": "eggs"],
      stamps: ["listId": receipt.stamp, "name": receipt.stamp], texts: [:], serials: [:], seq: nil, rc: nil, ru: nil, isVisible: true,
      isPending: true, isHeld: false)
    let read = try rig.engine.read(Self.scope) { reader in
      try ["i_aaaa", "i_bbbb"].flatMap { id in [try reader.confirmed("item", RecordID(id)), try reader.drawn("item", RecordID(id))] }
    }
    #expect(read == [pulled, renamed, nil, made])
    let decided = try rig.engine.commit(Self.scope) { context -> (Gesture?, [Record?]) in
      (nil, [try context.confirmed("item", "i_aaaa"), try context.stored("item", "i_aaaa")])
    }.value
    #expect(decided == [pulled, renamed])
  }

  // §2.5, §7.5: a spent id is all the device keeps of a derived record deleted elsewhere. Both readers answer its born, nil
  // for an id the scope keeps no spent id of, and a revive of the record takes that born (§7.1 step 4).
  @Test func bothReadersAnswerTheBornOfASpentIdAndARevivalTakesIt() throws {
    let rig = try Rig()
    let tree = ScopeRef.tree("b_00000001")
    let born = try Stamp("1000:0:r_aaaaaaaaaaaa")
    _ = try rig.store.write(.pullPage) { tx in
      var replica = try tx.replica(tx.activeReplica(), reads: [tree: RowSelection()])!
      replica.apply(.putSpent(tree, SpentID(key: RecordKey("tag", "oak"), born: born, seq: 3)))
      return Planned((), replica.batch)
    }
    #expect(try rig.engine.read(tree) { reader -> [Stamp?] in [try reader.spentBorn("tag", "oak"), try reader.spentBorn("tag", "elm")] } == [born, nil])
    let read = try rig.engine.commit(tree) { context -> (Gesture?, Stamp?) in
      (Gesture(changes: [.revive("tag", "oak", ["label": "Next"])]), try context.spentBorn("tag", "oak"))
    }.value
    #expect(read == born)
    #expect(try rig.engine.read(tree) { try $0.drawn("tag", "oak")?.born } == born)
  }

  // ER-12: the index names the confirmed side; a pending write that moves a reference is seen leaving and arriving.
  @Test func theIndexedReadSeesAPendingMoveOnBothSides() throws {
    let rig = try Rig(registry: Rig.shelf)
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

  @Test func aReadersTreeKeepsItsOwnOverlayUntilTheLastSubscriptionLeaves() async throws {
    let tree = ScopeRef.tree("b_00000001")
    let overlay = ScopeRef.overlay("b_00000001")
    let rig = try Rig(account: "B")
    try rig.engine.subscribe(tree)
    #expect(try rig.engine.read(overlay) { try $0.firstPullComplete() } == false)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows(in: tree, seq: 0), Rig.rows(in: overlay, seq: 0)], as: "B"))
    _ = await rig.engine.puller.step()
    #expect(rig.transport.pulls.last?.scopes.map(\.scope) == [Rig.scope, tree, overlay])
    #expect(try rig.engine.read(overlay) { try $0.firstPullComplete() })
    try rig.engine.subscribe(overlay)
    try rig.engine.unsubscribe(tree)
    #expect(try rig.active().cursors[overlay] != nil)
    try rig.engine.unsubscribe(overlay)
    #expect(try rig.active().cursors[overlay] == nil)

    try rig.engine.commit(Rig.scope, Gesture(changes: [.create("board", id: .given("b_00000001"))]))
    try rig.engine.subscribe(tree)
    try rig.engine.unsubscribe(tree)
    #expect(try rig.engine.read(overlay) { try $0.firstPullComplete() } == false)
  }

  @Test(arguments: ["page", "frame"])
  func aTreeDenialForgetsItsExplicitOverlayAndResolvesOnlyAcknowledgedWork(_ door: String) async throws {
    let rig = try Rig(account: "B")
    let tree = ScopeRef.tree("b_00000001"), overlay = ScopeRef.overlay("b_00000001")
    let mark = try Row(json: ["t": "mark", "id": "oak", "f": ["done": [true, "1000:0:r_server00001"]], "seq": 1, "rc": 1000, "ru": 1000])
    try rig.engine.subscribe(tree)
    try rig.engine.subscribe(overlay)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows(in: tree, seq: 0), Rig.rows([mark], in: overlay, seq: 1)], as: "B"))
    _ = await rig.engine.puller.step()
    try rig.commit(Gesture(changes: [.write("mark", "oak", ["done": false])], gestureId: "g1"), in: overlay)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 2)], as: "B"))
    _ = await rig.engine.sender.step()
    try rig.commit(Gesture(changes: [.write("mark", "oak", ["done": true])], gestureId: "g2"), in: overlay)
    #expect(try rig.outbox() == ["g1/0 acked 1", "g2/0 ready"])
    if door == "frame" {
      await rig.engine.puller.enqueue(.notFound(tree, servedAs: "B"), for: try rig.meta().replica)
    } else {
      rig.engine.puller.wants.add([tree])
      rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(tree, "not-found")], as: "B"))
    }
    _ = await rig.engine.puller.step()
    #expect(try rig.active().known == [tree: .notFound, overlay: .notFound])
    #expect(try rig.store.read { try $0.device(rows: true).activeReplica.confirmed[overlay]?.all ?? [] } == [])
    #expect(try rig.active().cursors[overlay] == nil)
    #expect(try rig.outbox() == ["g2/0 ready"])
    #expect(try rig.engine.read(overlay) { try $0.firstPullComplete() })
    try rig.engine.subscribe(tree)
    #expect(try rig.active().known == [:])
    #expect(try rig.engine.read(overlay) { try $0.firstPullComplete() } == false)
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
