import Foundation
import SQLite3
import SyncAPI
import SyncCore
import SyncReplica
@testable import SyncStore
import Synchronization
import SyncTesting
import Testing

// The store's Actions under the golden corpus: every client-step vector runs through SQLite, each step as the store's
// transactions over partial loads, and the dumped store must equal the vector's device exactly. What a commit and a
// push result read is named by key, so the same statements answer them whatever the store holds.

struct TransactionsTests {
  static let probe = try! Corpus.probeRegistry()

  static let vectors = try! Corpus.files().filter { Corpus.clientStepFiles.contains($0.path) }.flatMap { try Corpus.vectors(in: $0) }

  @Test(arguments: vectors)
  func everyClientStepVectorHoldsThroughTheStore(_ vector: CorpusVector) throws {
    let answer = try ClientSteps.run(vector.input, registry: Self.probe) { device, limits in
      try StoredDevice(seeding: device, registry: Self.probe, limits: limits)
    }
    #expect(answer == vector.expect, "\(vector)")
  }

  // Steps beyond the corpus, each run through the planners and through the store: the two must agree exactly, and
  // `returns` names what the steps must answer.
  static let beyond: [(name: String, steps: String, returns: [String])] = [
    ("after a re-identify, numbering starts at 1 beside an acked entry that keeps its number", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "a"}}], "deviceNow": 1000},
      {"op": "push", "deviceNow": 1000},
      {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 1000, "epoch": "ep-1", "as": "A", "lastN": 1, "results": [{"n": 1, "s": "ok", "seq": 1}]}}, "deviceNow": 1001},
      {"op": "reidentify", "deviceNow": 1002},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0002", "f": {"title": "b"}}], "deviceNow": 1003},
      {"op": "push", "deviceNow": 1004}
      """, ["intents.0.n=1"]),
    ("an epoch change in a push answer re-identifies, and numbering starts again at 1", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "a"}}], "deviceNow": 1000},
      {"op": "push", "deviceNow": 1000},
      {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 1000, "epoch": "ep-2", "as": "A", "lastN": 1, "results": [{"n": 1, "s": "ok", "seq": 1}]}}, "deviceNow": 1001},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0002", "f": {"title": "b"}}], "deviceNow": 1003},
      {"op": "push", "deviceNow": 1004}
      """, ["intents.0.n=1"]),
    ("a sign-in while the bound replica is paused throws: it re-authenticates or signs out first", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "a"}}], "deviceNow": 1000},
      {"op": "push", "deviceNow": 1000},
      {"op": "pushResponse", "response": {"status": 401, "body": {"serverTime": 1000, "epoch": "ep-1", "error": "unauthenticated"}}, "deviceNow": 1001},
      {"op": "signIn", "account": "A", "holdsRecords": {"probe": true}, "deviceNow": 1002}
      """, ["throws"]),
    ("a gesture id already in the outbox throws, and the entry holding it stays", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "first"}}], "opts": {"gestureId": "x", "hold": true}, "deviceNow": 1000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0002", "f": {"title": "second"}}], "opts": {"gestureId": "x"}, "deviceNow": 1001}
      """, ["committed", "throws"]),
    ("an atomic gesture changing one record twice throws: one intent holds one delta per record", """
      {"op": "commit", "scope": "self/overlay/b_00000001", "changes": [{"op": "write", "t": "mark", "id": "tag1", "x": {"memo": "one"}},
        {"op": "write", "t": "mark", "id": "tag1", "x": {"memo": "two"}}], "opts": {"atomic": true}, "deviceNow": 1000}
      """, ["throws"]),
    ("an orphan's refusal folds its held-back dependent into its origin's notice, which keeps its place before a later one", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0009", "f": {"title": "Thirteen char"}}], "deviceNow": 5000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0011", "f": {"title": "Thirteen chaR"}}], "deviceNow": 5000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0009", "f": {"title": "Fixed"}},
        {"op": "create", "t": "card", "id": "card0010", "f": {"title": "Fourth"}}], "opts": {"atomic": true}, "deviceNow": 5001},
      {"op": "push", "deviceNow": 5002},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0010", "f": {"title": "Edited"}}], "deviceNow": 5003},
      {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 5004, "epoch": "ep-1", "as": "A", "lastN": 3, "results": [
        {"n": 1, "s": "refused", "code": "invalid"}, {"n": 2, "s": "refused", "code": "invalid"}, {"n": 3, "s": "refused", "code": "unknown-record"}]}},
       "deviceNow": 5004}
      """, []),
    ("a device row outside the product's declared rows throws", """
      {"op": "commit", "scope": "self/probe", "changes": [], "opts": {"local": {"café": 1}}, "deviceNow": 1000}
      """, ["throws"]),
  ]

  // §2.5 and §7.1: gesture ids are unique on the device, so a given gesture id that a dormant replica's notice or outbox
  // entry carries is malformed on the bound replica too, in the planners and in the store alike, and nothing is written.
  @Test(arguments: [
    #""notices": [{"id": "notice:g/0", "scope": "self/probe", "code": "invalid", "content": {"d": []}, "at": 950}]"#,
    #"""
      "outbox": [{"localId": "g/0", "gestureId": "g", "lineage": "A", "scope": "self/probe", "state": "ready", "commitOrder": 1,
        "releaseAt": 0, "stamp": "900:0:r_aaaaaaaaaaaa", "intent": {"scope": "self/probe", "gestureId": "g", "d": [{"t": "card",
        "id": "card0009", "born": "900:0:r_aaaaaaaaaaaa", "life": ["alive", "900:0:r_aaaaaaaaaaaa"]}]}}]
      """#,
  ])
  func aGestureIdAnotherReplicaCarriesIsMalformed(_ dormantHolds: String) throws {
    let meta = { (replica: String, state: String, account: String) in
      """
      {"replica": "\(replica)", "state": "\(state)", "account": "\(account)", "nextN": 1, "hlc": {"ms": 0, "counter": 0},
       "hlcHigh": "0:0:", "admittedHigh": "0:0:", "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1",
       "ackThrough": 0, "authPaused": false}
      """
    }
    let seeded = try LoadedDevice(json: try JSON(parsing: """
      {"active": "rp_00000000000000000000000000000002", "replicas": [
        {"meta": \(meta("rp_00000000000000000000000000000001", "dormant", "A")), \(dormantHolds)},
        {"meta": \(meta("rp_00000000000000000000000000000002", "bound", "B"))}]}
      """), registry: Self.probe)
    let commit = try JSON(parsing: #"""
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0010", "f": {"title": "Ten"}}],
       "opts": {"gestureId": "g"}, "deviceNow": 1000}
      """#)
    var planned = PlannedDevice(seeded, registry: Self.probe, limits: Limits())
    var stored = try StoredDevice(seeding: seeded, registry: Self.probe, limits: Limits())
    let taken = CommitFailure.malformed("the gesture id g is taken")
    #expect(try [Self.failure(of: commit, on: &planned), Self.failure(of: commit, on: &stored)] == [taken, taken])
    #expect(try stored.dump() == seeded.json)
    #expect(try planned.dump() == seeded.json)
  }

  // The `CommitFailure` a step throws, nil when it throws none.
  static func failure<Device: ClientDevice>(of step: JSON, on device: inout Device) throws -> CommitFailure? {
    var context = StepContext(registry: probe, identities: try QueuedIdentities([:]), actor: try Stamp.Actor(ClientSteps.actor))
    do {
      _ = try ClientSteps.perform(step, on: &device, context: &context)
      return nil
    } catch let failure as CommitFailure {
      return failure
    }
  }

  // A commit reads what it touches by key: the ids it mints once drawn, the entries that touch the records it reads, the
  // held gestures when it retires, and the commit orders above what it read; a push result's `ok` reads its own entry,
  // and an epoch the replica already holds reads no entry. Each finds its replica's handle by id once. Every statement
  // searches an index but each commit's read of the one device row, and none reads more for a fuller store.
  @Test func aCommitAndAPushResultReadByKeyWhateverTheStoreHolds() throws {
    let runs = try [0, 40].map(Self.readsOfACommitAndAResult)
    #expect(runs[0].reads == runs[1].reads)
    #expect(runs.flatMap(\.scans) == Array(repeating: "SCAN device", count: 6))
    let device = "SELECT fork_guard, pending_sign_in, replica.id AS active FROM device JOIN replica ON replica.handle = device.active_replica"
    let replica = #"SELECT * FROM replica WHERE id = 'rp_1'"#
    let active = "SELECT active_replica FROM device WHERE id = 1"
    let handle = #"SELECT handle FROM replica WHERE id = 'rp_1'"#
    let cursors = "SELECT * FROM cursor WHERE replica = 1"
    let known = "SELECT scope, kind FROM known_scope WHERE replica = 1"
    let deviceRows = "SELECT product, key, value FROM device_row WHERE replica = 1"
    let confirmed = #"SELECT id FROM row_set WHERE replica = 1 AND scope = 'self/probe' AND role = 'confirmed'"#
    let anyRow = "SELECT EXISTS (SELECT 1 FROM set_row WHERE row_set = 1)"
    let spent = #"SELECT type, id, born FROM spent WHERE replica = 1 AND scope = 'self/probe'"#
    let row = { (type: String, id: String) in
      #"SELECT row FROM set_row WHERE row_set = 1 AND type = '"# + type + #"' AND id = '""# + id + #""'"#
    }
    let touching = { (type: String, id: String) in
      "SELECT outbox.* FROM outbox_touch JOIN outbox USING (local_id)\n"
        + #"WHERE outbox_touch.scope = 'self/probe' AND outbox_touch.type = '"# + type + #"' AND outbox_touch.id = '""# + id
        + #""' AND outbox.replica = 1"#
    }
    let carried = { (gestureId: String) in
      [#"SELECT EXISTS (SELECT 1 FROM outbox WHERE gesture_id = '"# + gestureId + "')",
       #"SELECT id FROM notice WHERE id >= 'notice:"# + gestureId + #"/' AND id < 'notice:"# + gestureId + "0'"]
    }
    let cards = #"SELECT row FROM set_row WHERE row_set = 1 AND type = 'card'"#
    let touchingCards = "SELECT outbox.* FROM outbox_touch JOIN outbox USING (local_id)\n"
      + #"WHERE outbox_touch.scope = 'self/probe' AND outbox_touch.type = 'card' AND outbox.replica = 1"#
    let heldGestures = "SELECT gesture.* FROM outbox AS held JOIN outbox AS gesture USING (gesture_id)\n"
      + "WHERE held.replica = 1 AND held.state = 'held' AND gesture.replica = 1"
    let above = { (count: Int) in "SELECT local_id, commit_order FROM outbox WHERE replica = 1 ORDER BY commit_order DESC LIMIT \(count)" }
    let mint: [String] = [
      device, replica, replica, cursors, confirmed, anyRow, spent, above(1), known, deviceRows, active,
      replica, cursors, confirmed, row("lap", "0123456789ABCDEF"), anyRow, spent, touching("lap", "0123456789ABCDEF"), above(1), known,
      deviceRows, active,
    ]
    let result: [String] = [
      replica, replica, cursors, "SELECT * FROM outbox WHERE replica = 1 AND state = 'sent' AND n = 1", above(2), known, deviceRows, active, handle,
    ]
    let heldDelete: [String] = [
      device, replica, replica, cursors, confirmed, row("card", "card0001"), cards, anyRow, spent, touching("card", "card0001"), touchingCards,
      above(1), known, deviceRows, active,
    ]
    let retiring: [String] = [
      device, replica, replica, cursors, confirmed, row("card", "card0001"), cards, anyRow, spent, touching("card", "card0001"), touchingCards,
      heldGestures, above(2), known, deviceRows, active,
    ]
    let expected: [[String]] = [
      mint + carried("g1") + [handle], result, [replica, replica, cursors, above(1), known, deviceRows, active],
      heldDelete + carried("g2") + [handle], retiring + carried("g3") + [handle],
    ]
    #expect(runs[0].reads == expected)
  }

  // The statements that read, of a commit minting a lap, of the `ok` of the entry numbered 1, of the epoch the replica
  // holds, and of a held delete of a card and an edit that retires it, in a bound replica that holds a card, `others`
  // confirmed laps, and `others` sent entries beside the one numbered 1; and the table scans their query plans hold.
  static func readsOfACommitAndAResult(_ others: Int) throws -> (reads: [[String]], scans: [String]) {
    let scope = ScopeRef.product("probe")
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let life = Lattice(life: Life(.alive, stamp), born: stamp)
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-1"
    let laps = (0..<others).map { Row(key: RecordKey("lap", RecordID("lap\(1000 + $0)")), lattice: life, seq: Int64($0 + 1)) }
    let card = Row(key: RecordKey("card", "card0001"), lattice: life, seq: Int64(others + 1))
    let sent = (0...others).map { index in
      var entry = OutboxEntry(
        localId: "s\(index)/0", gestureId: "s\(index)", lineage: "A", scope: scope, state: .sent, commitOrder: Int64(index + 1),
        releaseAt: 0, stamp: stamp, intent: Intent(n: Int64(index + 1), scope: scope, deltas: [Delta(key: RecordKey("lap", RecordID("sent\(index)")), lattice: life)]))
      entry.digest = entry.intent.digest
      return entry
    }
    let store = try Store.inMemory(holding: LoadedDevice(meta: DeviceMeta(), active: "rp_1", replicas: [
      LoadedReplica(meta: meta, outbox: sent, confirmed: [scope: Rows(laps + [card])], wholeScopes: true),
    ]), registry: Self.probe)
    let taken = try Self.readsRecorded(by: store)
    let instance = Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: 5000, appVersion: "1")
    let identities = try QueuedIdentities(["draws": .array((0..<16).map { JSON($0) })])
    var applying = instance
    let apply = { (step: PushStep) in
      _ = try store.apply(step, replica: "rp_1", instance: &applying, timing: .steady(send: 5000, recv: 5000), identities: try QueuedIdentities([:]))
    }
    _ = try store.commit(Gesture(changes: [.create("lap", ["runId": "run00001", "weight": 5])]), in: scope, instance: instance,
                         identities: identities)
    let commit = taken()
    try apply(.results(ResultBatch(results: [try PushResult(json: ["n": 1, "s": "ok", "seq": 2])], lastN: 1, epoch: "ep-1", isLast: false)))
    let result = taken()
    try apply(.epoch("ep-1"))
    let epoch = taken()
    _ = try store.commit(Gesture(changes: [.delete("card", "card0001")], hold: true), in: scope, instance: instance, identities: identities)
    let heldDelete = taken()
    _ = try store.commit(Gesture(changes: [.update("card", "card0001", ["title": "Kept"])], retire: [RecordRef(type: "card", id: "card0001")]),
                         in: scope, instance: instance, identities: identities)
    let reads = [commit, result, epoch, heldDelete, taken()]
    let plans = try store.read { tx in try reads.joined().flatMap(tx.queryPlan) }
    return (reads, plans.filter { $0.hasPrefix("SCAN") && $0 != "SCAN CONSTANT ROW" })
  }

  // The SELECTs `store` runs from now on, with their arguments, each handed over once by the function this answers.
  static func readsRecorded(by store: Store) throws -> () -> [String] {
    let statements = Mutex<[String]>([])
    try store.writer.write { db in
      db.trace { event in
        guard case .statement(let statement) = event, statement.sql.hasPrefix("SELECT") else { return }
        statements.withLock { $0.append(statement.expandedSQL) }
      }
    }
    return {
      statements.withLock { recorded in
        defer { recorded = [] }
        return recorded
      }
    }
  }

  // §7.5 step 3: a frame reads of the outbox only what its rules need, never every entry, the same beside 0 or 40 unsent entries.
  @Test func aFrameReadsOfTheOutboxOnlyWhatItsRulesNeed() throws {
    let runs = try [0, 40].map(Self.framesBeside)
    #expect(runs[0].reads == runs[1].reads)
    #expect(runs.map(\.outcomes) == Array(repeating: ["applied", "pull self/probe", "ignored tree/b_00000001", "gone"], count: 2))
    #expect(runs.map(\.outbox) == [["b/0"], ["b/0"] + (0..<40).map { "u\($0)/0" }])
    let touching = { (type: String, id: String?) in
      "SELECT outbox.* FROM outbox_touch JOIN outbox USING (local_id)\n"
        + #"WHERE outbox_touch.scope = 'self/probe' AND outbox_touch.type = '"# + type + "'"
        + (id.map { #" AND outbox_touch.id = '""# + $0 + #""'"# } ?? "") + " AND outbox.replica = 1"
    }
    let covered = { (seq: Int) in
      "SELECT * FROM outbox WHERE replica = 1 AND scope = 'self/probe' AND state = 'acked' AND result_epoch = 'ep-1' AND result_seq <= \(seq)\n"
        + "ORDER BY commit_order LIMIT 33"
    }
    let scope = { (scope: String) in "SELECT * FROM outbox WHERE replica = 1 AND scope = '\(scope)'" }
    let above = { (count: Int) in "SELECT local_id, commit_order FROM outbox WHERE replica = 1 ORDER BY commit_order DESC LIMIT \(count)" }
    #expect(runs[0].reads == [
      [touching("card", "card0009"), touching("board", nil), covered(6), above(3)],
      [touching("card", "card0010"), touching("board", nil), covered(9), above(2)],
      [touching("board", "b_00000001"), touching("board", nil), scope("tree/b_00000001"), above(2)],
      [touching("board", nil), scope("tree/b_00000002"), above(3)],
    ])
  }

  // A settling change, a change past a gap, a not-found whose board's create waits, a gone: their outbox reads and outcomes, the outbox after.
  static func framesBeside(_ unsent: Int) throws -> (reads: [[String]], outcomes: [String], outbox: [String]) {
    let product = ScopeRef.product("probe")
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let life = Lattice(life: Life(.alive, stamp), born: stamp)
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-1"
    let entry = { (localId: String, scope: ScopeRef, order: Int64, key: RecordKey, n: Int64?, resultSeq: Int64?) in
      var entry = OutboxEntry(
        localId: localId, gestureId: String(localId.dropLast(2)), lineage: "A", scope: scope, state: n == nil ? .ready : .acked,
        commitOrder: order, releaseAt: 0, stamp: stamp, intent: Intent(n: n, scope: scope, deltas: [Delta(key: key, lattice: life)]))
      entry.digest = n.map { _ in entry.intent.digest }
      entry.resultSeq = resultSeq
      entry.resultEpoch = resultSeq.map { _ in "ep-1" }
      return entry
    }
    let outbox = [
      entry("a/0", product, 1, RecordKey("day", "2026-09-01"), 1, 6),
      entry("t/0", .tree("b_00000002"), 2, RecordKey("tag", "tag-1"), 2, 2),
      entry("b/0", product, 3, RecordKey("board", "b_00000001"), nil, nil),
    ] + (0..<unsent).map { entry("u\($0)/0", product, Int64(4 + $0), RecordKey("lap", RecordID("lap\(1_000 + $0)")), nil, nil) }
    let board = Row(key: RecordKey("board", "b_00000002"), lattice: life, seq: 1)
    let booted = { (seq: Int64, rows: [Row]) in
      CursorRecord(cursor: Cursor(epoch: "ep-1", mode: .live, seq: seq).text, digest: ScopeDigest(rows: rows.map(\.json)), booted: true)
    }
    let store = try Store.inMemory(holding: LoadedDevice(meta: DeviceMeta(), active: "rp_1", replicas: [
      LoadedReplica(meta: meta, outbox: outbox, confirmed: [product: Rows([board])],
                    cursors: [product: booted(5, [board]), .tree("b_00000002"): booted(1, [])], wholeScopes: true),
    ]), registry: Self.probe)
    let card = { (id: String, seq: Int64) in Row(key: RecordKey("card", RecordID(id)), lattice: life, seq: seq) }
    let change = { (row: Row, digested: [Row]) in
      try LiveFrame(json: [
        "op": "change", "as": "A", "scope": product.json, "epoch": "ep-1", "seq": JSON(row.seq), "rows": [row.json],
        "digest": .string(ScopeDigest(rows: digested.map(\.json)).hex),
      ])
    }
    let frames = [
      try change(card("card0009", 6), [board, card("card0009", 6)]), try change(card("card0010", 9), []),
      LiveFrame.notFound(.tree("b_00000001"), servedAs: "A"), .gone(.tree("b_00000002"), servedAs: "A"),
    ]
    let taken = try Self.readsRecorded(by: store)
    var reads: [[String]] = []
    var outcomes: [String] = []
    for frame in frames {
      let applied = try #require(try store.apply(
        frame, replica: "rp_1", subscribed: .own(Subscriptions(products: ["probe"], opened: [])), settling: 32,
        instance: Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: 5000, appVersion: "1")).value)
      reads.append(taken().filter { $0.contains("outbox") })
      outcomes.append(([applied.outcome.rawValue] + applied.next.map(\.text) + (applied.unsettled ? ["unsettled"] : [])).joined(separator: " "))
    }
    let left = try store.read { try $0.device(rows: true).activeReplica.outbox.map(\.localId) }
    return (reads, outcomes, left)
  }

  // A commit whose gesture mints any number of ids loads the replica twice: once for what the gesture names, and once
  // more with every id it drew.
  @Test func aCommitMintingAnyNumberOfIdsLoadsTheReplicaTwice() throws {
    let loads = try [1, 5, 20].map { count -> Int in
      let store = try Store.inMemory(holding: LoadedDevice(meta: DeviceMeta(), active: "rp_1", replicas: [
        LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .bound, account: "A"), wholeScopes: true),
      ]), registry: Self.probe)
      let taken = try Self.readsRecorded(by: store)
      let laps = (0..<count).map { _ in Change.create("lap", ["runId": "run00001", "weight": 5]) }
      let outcome = try store.commit(
        Gesture(changes: laps), in: .product("probe"), instance: Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: 5000, appVersion: "1"),
        identities: try QueuedIdentities(["draws": .array((0..<(16 * count)).map { JSON($0 % 62) })])).value
      guard case .committed(let receipt) = outcome else { return -1 }
      #expect(Set(receipt.ids).count == count)
      return taken().filter { $0.hasPrefix("SELECT * FROM cursor") }.count
    }
    #expect(loads == [2, 2, 2])
  }

  // The store's Actions, each over what it loads, decide as the planners over the whole replica and leave the same
  // replica: commits that mint, a draw now and then repeating an id the replica holds; that hold removals, carry a held
  // removal's life in a put that keeps presence, and retire a held removal while changing other records; numbering,
  // results, acks, the epoch the replica holds, Undo and releases.
  @Test func theStoreDecidesAsThePlannersOverTheWholeReplica() throws {
    var random = SeededRandom.fromEnvironment()
    let (commits, pushes, hold) = (CommitPlanner(registry: Self.probe), PushPlanner(registry: Self.probe), Hold(registry: Self.probe))
    let scope = ScopeRef.product("probe")
    let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    var whole = try Self.replicaOfRecords()
    let store = try Store.inMemory(holding: LoadedDevice(meta: DeviceMeta(), active: "rp_1", replicas: [whole]), registry: Self.probe)
    var (folds, redraws, seq) = (0, 0, Int64(100))
    for step in 0..<300 {
      let deviceNow = 5000 + Int64(step) * 10
      var (storeInstance, wholeInstance) = (Self.instance(deviceNow), Self.instance(deviceNow))
      let timing = Timing.steady(send: deviceNow, recv: deviceNow)
      let none = { try QueuedIdentities([:]) }
      let action: String
      let agreed: Bool
      switch random.below(100) {
      case ..<55:
        var gesture = try Self.commitGesture(&random, over: whole)
        gesture.gestureId = "step\(step)"
        let held = Set(whole.rows(scope).all.map(\.key) + whole.outbox.flatMap(\.drawnDeltas).map(\.key))
        let repeated = random.chance(0.4) ? random.pick(held.filter { $0.id.string?.count == 16 }.sorted()) : nil
        let draws = JSON.array(((repeated?.id.string.map { Array($0) } ?? []).map { alphabet.firstIndex(of: $0)! }
          + (0..<256).map { _ in random.below(62) }).map { JSON($0) })
        let written = Result { try store.commit(gesture, in: scope, instance: storeInstance, identities: try QueuedIdentities(["draws": draws])) }
        let decided = Result {
          try commits.commit(gesture, in: scope, to: &whole, as: wholeInstance, identities: try QueuedIdentities(["draws": draws]), gestureIdTaken: false)
        }
        action = gesture.retire.isEmpty ? "commit" : "retiring commit"
        agreed = Self.agree(written.map(\.value), decided)
        if case .success(let written) = written, written.events.contains(where: { if case .ended(_, _, .silentFold, _) = $0 { true } else { false } }) {
          folds += 1
        }
        guard case .success(.committed(let receipt)) = decided else { break }
        let minted = zip(gesture.changes, receipt.ids).compactMap { change, id in change.id == nil ? id.map { RecordKey(change.type, $0) } : nil }
        #expect(held.isDisjoint(with: minted), "seed \(random.seed), step \(step)")
        if let repeated, minted.first?.type == repeated.type { redraws += 1 }
      case ..<68:
        action = "number"
        agreed = Self.agree(Result { try store.number(at: deviceNow).value }, Result { try pushes.number(&whole, at: deviceNow) })
      case ..<82:
        let sent = whole.outbox.filter { $0.state == .sent }.sorted { $0.n! < $1.n! }
        guard !sent.isEmpty else { continue }
        let answered = Array(sent.prefix(1 + random.below(min(3, sent.count))))
        let verdicts = try answered.map { entry -> PushResult in
          seq += 1
          return try PushResult(json: random.chance(0.75) ? ["n": JSON(entry.n!), "s": "ok", "seq": JSON(seq)]
            : ["n": JSON(entry.n!), "s": "refused", "code": .string(random.pick(["stale", "invalid", "clock-skew"]))])
        }
        let result = PushStep.results(ResultBatch(results: verdicts, lastN: sent.map { $0.n! }.max()!, epoch: "ep-1", isLast: false))
        action = "results"
        agreed = Self.agree(
          Result { try store.apply(result, replica: "rp_1", instance: &storeInstance, timing: timing, identities: try none()).value },
          Result { () -> String? in
            try pushes.apply(result, to: &whole, instance: &wholeInstance, timing: timing, identities: try none())
            return whole.id
          })
      case ..<88:
        let ack = PushStep.results(ResultBatch(results: [], lastN: whole.meta.nextN - 1, epoch: "ep-1", isLast: true))
        action = "ack"
        agreed = Self.agree(
          Result { try store.apply(ack, replica: "rp_1", instance: &storeInstance, timing: timing, identities: try none()).value },
          Result { () -> String? in
            try pushes.apply(ack, to: &whole, instance: &wholeInstance, timing: timing, identities: try none())
            return whole.id
          })
      case ..<91:
        action = "epoch"
        agreed = Self.agree(
          Result { try store.apply(.epoch("ep-1"), replica: "rp_1", instance: &storeInstance, timing: timing, identities: try none()).value },
          Result { () -> String? in
            try pushes.apply(.epoch("ep-1"), to: &whole, instance: &wholeInstance, timing: timing, identities: try none())
            return whole.id
          })
      case ..<97:
        let held = whole.outbox.filter { $0.state == .held }
        guard let gestureId = held.isEmpty ? nil : random.pick(held).gestureId else { continue }
        action = "undo"
        agreed = Self.agree(Result { try store.undo(gestureId).value }, Result { try hold.undo(gestureId, in: &whole) })
      default:
        action = "release all"
        agreed = Self.agree(Result { try store.releaseAll().value }, Result { try hold.releaseAll(in: &whole) })
      }
      #expect(agreed, "seed \(random.seed), step \(step), \(action)")
      let held = try store.read { try $0.device(rows: true).activeReplica.json }
      #expect(held == whole.json, "seed \(random.seed), step \(step), \(action)")
      if !agreed || held != whole.json { break }
    }
    #expect(folds > 0, "seed \(random.seed): no retire folded a carrier")
    #expect(redraws > 0, "seed \(random.seed): no draw was taken")
  }

  // Two answers to one step agree: equal values, or failures alike.
  static func agree<Value: Equatable>(_ stored: Result<Value, any Error>, _ planned: Result<Value, any Error>) -> Bool {
    switch (stored, planned) {
    case (.success(let stored), .success(let planned)): stored == planned
    case (.failure(let stored), .failure(let planned)): "\(stored)" == "\(planned)"
    default: false
    }
  }

  // A bound replica of A in epoch ep-1 holding two cards, a run, two of its laps and a day.
  static func replicaOfRecords() throws -> LoadedReplica {
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let alive = { (type: String, id: String, fields: [String: Register], seq: Int64) in
      Row(key: RecordKey(type, RecordID(id)), lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: fields), seq: seq, rc: seq, ru: seq)
    }
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.hlc = HLC(ms: 1000)
    meta.serverEpoch = "ep-1"
    return LoadedReplica(meta: meta, confirmed: [.product("probe"): Rows([
      alive("card", "card0001", ["title": Register("One", stamp), "tier": Register("draft", stamp)], 1),
      alive("card", "card0002", ["title": Register("Two", stamp), "tier": Register("draft", stamp)], 2),
      alive("run", "run0000000000001", [:], 3),
      alive("lap", "lap0000000000001", ["runId": Register("run0000000000001", stamp)], 4),
      alive("lap", "lap0000000000002", ["runId": Register("run0000000000001", stamp)], 5),
      Row(key: RecordKey("day", "2026-09-01"), lattice: Lattice(life: Life(.alive, stamp), fields: ["score": Register(1, stamp)]), seq: 6, rc: 6, ru: 6),
    ])], wholeScopes: true)
  }

  // A gesture over `whole`. While it holds a day's removal it may retire, most often a put carrying that removal's life
  // if none does yet, and else a gesture retiring the removal while it changes other records; now and then a retire of
  // another held removal, or a held removal alone; otherwise up to three changes, held or atomic now and then.
  static func commitGesture(_ random: inout SeededRandom, over whole: LoadedReplica) throws -> Gesture {
    let keys = whole.rows(.product("probe")).all.map(\.key) + whole.outbox.flatMap(\.drawnDeltas).map(\.key)
    let ids = { (type: String) in Array(Set(keys.filter { $0.type == type }.map(\.id))).sorted() }
    let changes = { (random: inout SeededRandom, count: Int) -> [Change] in
      var seen: Set<RecordKey> = []
      return (0..<count).map { _ in Self.change(&random, ids: ids) }.filter { change in change.id.map { seen.insert(RecordKey(change.type, $0)).inserted } ?? true }
    }
    let retiring = { (random: inout SeededRandom, removed: RecordKey) -> Gesture in
      let others = changes(&random, Int.random(in: 1...2, using: &random)).filter { change in change.id.map { RecordKey(change.type, $0) != removed } ?? true }
      return Gesture(changes: others, retire: [RecordRef(type: removed.type, id: removed.id)])
    }
    let retirable = whole.outbox.filter { $0.state == .held && !$0.intent.deltas.isEmpty && $0.intent.deltas.allSatisfy(\.removes) }
    if let removal = retirable.first(where: { $0.intent.deltas.contains { $0.key.type == "day" } }), random.chance(0.7) {
      let day = removal.intent.deltas.first { $0.key.type == "day" }!.key
      guard whole.outbox.contains(where: { $0.commitOrder > removal.commitOrder && $0.state != .held && $0.touches(day) }) else {
        return Gesture(changes: [.put("day", day.id, present: nil, ["score": JSON(random.below(11))])])
      }
      return retiring(&random, day)
    }
    if !retirable.isEmpty && random.chance(0.3) { return retiring(&random, random.pick(retirable.flatMap(\.intent.deltas)).key) }
    if random.chance(0.25) {
      let drawn = try ScopeView(whole, .product("probe"), .drawn, registry: Self.probe)
      let days = ["2026-09-01", "2026-09-02"].map { RecordKey("day", RecordID($0)) }.filter { drawn.record($0)?.lattice.life?.isAlive == true }
      let removal: Change = if let day = days.first, random.chance(0.6) {
        .put("day", day.id, present: false)
      } else if random.chance(0.5) {
        .delete("card", random.pick(ids("card")))
      } else {
        .delete("lap", random.pick(ids("lap")))
      }
      return Gesture(changes: [removal], hold: true)
    }
    return Gesture(changes: changes(&random, Int.random(in: 1...3, using: &random)), atomic: random.chance(0.2), hold: random.chance(0.3))
  }

  static func change(_ random: inout SeededRandom, ids: (String) -> [RecordID]) -> Change {
    let day = RecordID(random.pick(["2026-09-01", "2026-09-02"]))
    switch random.below(10) {
    case 0, 1: return .create("lap", ["runId": random.pick(ids("run")).json, "weight": JSON(random.below(100))])
    case 2: return .create("run", ["label": "r"])
    case 3: return .create("card", ["title": "Minted", "tier": "draft"])
    case 4: return .update("card", random.pick(ids("card")), ["tier": .string(random.pick(["draft", "review", "done"]))])
    case 5: return .delete("card", random.pick(ids("card")))
    case 6: return .put("day", day, present: false)
    case 7: return .put("day", day, present: true, ["score": JSON(random.below(11))])
    case 8: return .delete("lap", random.pick(ids("lap")))
    default: return .update("lap", random.pick(ids("lap")), ["weight": JSON(random.below(100))])
    }
  }

  static func instance(_ deviceNow: Int64) -> Instance {
    Instance(actor: try! Stamp.Actor(ClientSteps.actor), deviceNow: deviceNow, appVersion: "1")
  }

  // §7.1 step 4: a retire folds the dependents of the held removal it ends, which touch the removed record, though the
  // retiring gesture changes another: the put that carried the removal's life is left empty and ends undone, as over the
  // whole replica.
  @Test func aRetireFoldsTheDependentsOfARecordTheGestureDoesNotChange() throws {
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.hlc = HLC(ms: 1000)
    let day = Row(key: RecordKey("day", "2026-09-01"), lattice: Lattice(life: Life(.alive, stamp), fields: ["score": Register(1, stamp)]), seq: 1, rc: 1, ru: 1)
    var whole = LoadedReplica(meta: meta, confirmed: [.product("probe"): Rows([day])], wholeScopes: true)
    let store = try Store.inMemory(holding: LoadedDevice(meta: DeviceMeta(), active: "rp_1", replicas: [whole]), registry: Self.probe)
    let gestures = [
      Gesture(changes: [.put("day", "2026-09-01", present: false)], hold: true, gestureId: "held"),
      Gesture(changes: [.put("day", "2026-09-01", present: nil, ["score": 5])], gestureId: "carrier"),
      Gesture(changes: [.put("day", "2026-09-02", present: true, ["score": 2])], retire: [RecordRef(type: "day", id: "2026-09-01")],
              gestureId: "retiring"),
    ]
    for (step, gesture) in gestures.enumerated() {
      let stored = try store.commit(gesture, in: .product("probe"), instance: Self.instance(5000 + Int64(step)), identities: try QueuedIdentities([:]))
      let planned = try CommitPlanner(registry: Self.probe).commit(
        gesture, in: .product("probe"), to: &whole, as: Self.instance(5000 + Int64(step)), identities: try QueuedIdentities([:]), gestureIdTaken: false)
      #expect(stored.value == planned, "step \(step)")
      #expect(try store.read { try $0.device(rows: true).activeReplica.json } == whole.json, "step \(step)")
    }
    #expect(whole.outbox.map(\.localId) == ["retiring/0"])
  }

  // §7.1 step 7: a minted gesture id another gesture holds is drawn again, whether that gesture's entry is one the commit
  // loads, or one it leaves unread, or a later intent of it alone, or its notice: the commit goes on under the next id,
  // and the other gesture keeps its own.
  @Test(arguments: ["an entry the commit loads", "an entry the commit leaves unread", "a later intent", "a notice"])
  func aMintedGestureIdAnotherGestureHoldsIsDrawnAgain(_ holder: String) throws {
    let scope = ScopeRef.product("probe")
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let run = Row(key: RecordKey("run", "run00001"), lattice: Lattice(life: Life(.alive, stamp), born: stamp), seq: 1, rc: 1, ru: 1)
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.hlc = HLC(ms: 1000)
    let entry = OutboxEntry(
      localId: holder == "a later intent" ? "g1/1" : "g1/0", gestureId: "g1", lineage: "A", scope: scope, state: .ready, commitOrder: 1,
      releaseAt: 0, stamp: stamp, intent: Intent(scope: scope, deltas: [Delta(key: run.key, lattice: Lattice(fields: ["label": Register("X", stamp)]))],
                                                  gestureId: "g1"))
    let notice = Notice(id: "notice:g1/0", product: "probe", scope: scope, code: .invalid, detail: nil, content: NoticeContent(), at: 900)
    let replica = holder == "a notice"
      ? LoadedReplica(meta: meta, confirmed: [scope: Rows([run])], notices: [notice], wholeScopes: true)
      : LoadedReplica(meta: meta, outbox: [entry], confirmed: [scope: Rows([run])], wholeScopes: true)
    let store = try Store.inMemory(holding: LoadedDevice(meta: DeviceMeta(), active: "rp_1", replicas: [replica]), registry: Self.probe)
    let change: Change = holder == "an entry the commit loads" ? .update("run", "run00001", ["label": "Y"]) : .put("day", "2026-09-02", present: true, ["score": 3])
    let outcome = try store.commit(Gesture(changes: [change], hold: true), in: scope, instance: Self.instance(5000), identities: try QueuedIdentities([:])).value
    guard case .committed(let receipt) = outcome else { throw VectorError("\(outcome)") }
    #expect([receipt.gestureId] + receipt.localIds == ["g2", "g2/0"])
    let held = { try store.read { try $0.device(rows: true).activeReplica } }
    #expect(try held().outbox.map(\.localId) == replica.outbox.map(\.localId) + ["g2/0"])
    #expect(try store.undo("g2").value)
    #expect(try [held().outbox.map(\.json), held().notices.map(\.storedJSON)] == [replica.outbox.map(\.json), replica.notices.map(\.storedJSON)])
  }

  // §7.1: an error the read-and-commit body throws of its own is none of the three failures: the store's commit
  // rethrows it unchanged, and nothing is written.
  @Test func theBodysOwnErrorPassesThroughTheCommitAndNothingIsWritten() throws {
    struct Declined: Error, Equatable {}
    let device = try LoadedDevice(json: try JSON(parsing: """
      {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
        "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
        "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}}]}
      """), registry: Self.probe)
    let store = try Store.inMemory(holding: device, registry: Self.probe)
    let instance = Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: 1000, appVersion: "1")
    let identities = try QueuedIdentities([:])
    #expect(throws: Declined()) {
      try store.commit(in: .product("probe"), instance: instance, identities: identities) { _ -> (Gesture?, Void) in
        throw Declined()
      }
    }
    #expect(try store.read { try $0.device(rows: true).json } == device.json)
  }

  // D-17: dismissing a notice the active replica does not hold throws, and nothing is written.
  @Test func dismissingANoticeTheActiveReplicaDoesNotHoldThrows() throws {
    let device = try LoadedDevice(json: try JSON(parsing: """
      {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
        "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
        "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}}]}
      """), registry: Self.probe)
    let store = try Store.inMemory(holding: device, registry: Self.probe)
    #expect(throws: StoreError.noNotice("notice:g1/0")) { try store.dismissNotice("notice:g1/0") }
    #expect(try store.read { try $0.device(rows: true).json } == device.json)
  }

  @Test(arguments: beyond.indices)
  func beyondTheCorpusThePlannersAndTheStoreAgree(_ index: Int) throws {
    let (name, steps, returns) = Self.beyond[index]
    let input = try JSON(parsing: """
      {"ids": ["rp_00000000000000000000000000000002"], "actors": ["r_bbbbbbbbbbbb"],
       "device": {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
         "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
         "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}}]},
       "steps": [\(steps)]}
      """)
    let planned = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
    let stored = try ClientSteps.run(input, registry: Self.probe) { try StoredDevice(seeding: $0, registry: Self.probe, limits: $1) }
    #expect(stored == planned, "\(name)")
    let answers = try planned.member("returns").asArray()
    for (position, expected) in returns.enumerated() {
      let answer = answers[answers.count - returns.count + position]
      switch expected {
      case "throws": #expect(answer == ["throws": true], "\(name)")
      case "committed": #expect(answer["localIds"] != nil, "\(name)")
      default: #expect(try answer["intents"]?.asArray().first?["n"] == 1, "\(name)")
      }
    }
  }
}

// A corpus device held in an in-memory SQLite store, every step one or more of the store's transactions.
struct StoredDevice: ClientDevice {
  let store: Store
  var events: [EngineEvent] = []

  init(seeding device: LoadedDevice, registry: Registry, limits: Limits) throws {
    store = try Store.inMemory(holding: device, registry: registry, limits: limits)
  }

  mutating func take<Value>(_ written: Written<Value>) -> Value {
    events += written.events
    return written.value
  }

  func active() throws -> String { try store.read { try $0.activeReplica() } }

  func activeReplica() throws -> LoadedReplica { try store.read { try $0.device(rows: true) }.activeReplica }

  mutating func commit(_ gesture: Gesture?, in scope: ScopeRef, instance: Instance, identities: IdentitySource) throws -> CommitOutcome? {
    take(try store.commit(in: scope, instance: instance, identities: identities) { _ in (gesture, ()) }).outcome
  }

  mutating func release(_ localId: String) throws -> Bool { take(try store.release(localId)) }
  mutating func releaseAll() throws { _ = take(try store.releaseAll()) }
  mutating func releaseDue(at deviceNow: Int64) throws { take(try store.releaseDue(at: deviceNow)) }
  mutating func undo(_ gestureId: String) throws -> Bool { take(try store.undo(gestureId)) }
  mutating func dismiss(_ noticeId: String) throws { take(try store.dismissNotice(noticeId)) }
  mutating func push(limit: Int?, at deviceNow: Int64) throws -> PushRequest? { take(try store.number(limit: limit, at: deviceNow)) }

  mutating func apply(_ step: PushStep, instance: inout Instance, timing: Timing, identities: IdentitySource) throws {
    _ = take(try store.apply(step, replica: try active(), instance: &instance, timing: timing, identities: identities))
  }

  mutating func hello(_ answer: Answer<HelloResponse>, timing: Timing) throws {
    take(try store.write(.offset) { tx in
      guard var replica = try tx.replica(try tx.activeReplica()) else { return Planned((), ReplicaBatch()) }
      ReplicaLifecycle(registry: store.registry).receive(answer, in: &replica, timing: timing)
      return Planned((), replica.batch)
    })
  }

  mutating func start(backup: BackupCopy, instance: inout Instance, identities: IdentitySource) throws -> EngineStart {
    take(try store.start(backup: backup, instance: &instance, identities: identities))
  }

  mutating func pullRequest(_ scopes: [ScopeRef]) throws -> PullRequest? { try store.pullPlan(scopes, replica: active())!.request }

  mutating func apply(_ step: PullStep, subscribed: [ScopeRef], instance: inout Instance, timing: Timing,
                      identities: IdentitySource) throws -> (outcome: PageOutcome?, unsettled: Bool) {
    let replica = try activeReplica().meta
    let applied = take(try store.apply(step, replica: replica.replica, account: replica.account, subscribed: .given(subscribed),
                                       instance: &instance, timing: timing, identities: identities))
    guard let applied else { throw VectorError("the store dropped a step of the active replica") }
    return (applied.outcome, applied.unsettled)
  }

  mutating func settle(_ scope: ScopeRef, count: Int) throws -> Bool {
    guard let settled = take(try store.settle(scope, replica: active(), count: count)) else {
      throw VectorError("the store dropped a slice of the active replica")
    }
    return settled.left
  }

  mutating func apply(_ frame: LiveFrame, subscribed: [ScopeRef], instance: Instance) throws -> FrameOutcome {
    take(try store.apply(frame, replica: active(), subscribed: .given(subscribed), settling: .max, instance: instance))!.outcome
  }

  mutating func subscribe(_ scope: ScopeRef) throws -> SubscribeOutcome { take(try store.subscribe(scope)) }
  mutating func reconcile(_ set: SubscriptionSet) throws -> [ScopeRef] { take(try store.reconcile(set)) }

  mutating func signIn(account: String, holdsRecords: [String: Bool], decisions: [String: LineageAnswer],
                       counted: [String: [String]], identities: IdentitySource) throws -> SignIn {
    take(try store.signIn(account: account, holdsRecords: holdsRecords, decisions: decisions, counted: counted, identities: identities))
  }

  mutating func signOut(choice: SignOutChoice?, counted: [String]?, identities: IdentitySource) throws -> SignOut {
    take(try store.signOut(choice: choice, counted: counted, identities: identities))
  }

  mutating func discardUnsent(_ replica: String) throws { take(try store.discardDormant(replica)) }

  mutating func reidentify(instance: inout Instance, identities: IdentitySource) throws {
    take(try store.reidentify(instance: &instance, identities: identities))
  }

  mutating func changeEpoch(to epoch: String, instance: inout Instance, identities: IdentitySource) throws {
    take(try store.changeEpoch(to: epoch, instance: &instance, identities: identities))
  }

  func anonCount(of product: String, in replica: String) throws -> [String: Int] { try store.anonCount(of: product, in: replica) }
  func dump() throws -> JSON { try store.read { try $0.device(rows: true).json } }
}

extension StoreTransaction {
  // SQLite's plan for `sql`, a line per step: which tables it searches through an index, and which it scans.
  func queryPlan(_ sql: String) throws -> [String] {
    let statement = try db.makeStatement(sql: "EXPLAIN QUERY PLAN \(sql)")
    var steps: [String] = []
    while sqlite3_step(statement.sqliteStatement) == SQLITE_ROW {
      steps.append(String(cString: sqlite3_column_text(statement.sqliteStatement, 3)))
    }
    return steps
  }
}
