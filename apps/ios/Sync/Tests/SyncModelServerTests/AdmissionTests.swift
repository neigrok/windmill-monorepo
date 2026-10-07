import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// §6.1 properties the corpus pins only by example: the digest and the counters admission keeps, and step R's rollback.

struct AdmissionTests {
  @Test(arguments: [("card", "card0001"), ("board", "b_00000001"), ("tag", "oak")])
  func anAbsentDeleteSurvivesReloadAndPreventsALaterReplayedCreate_4_3(_ type: String, _ id: String) throws {
    let registry = try Corpus.probeRegistry()
    let admission = Admission(registry: registry, rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-2")
    if type == "tag" {
      let board: JSON = ["scope": "self/probe", "d": [["t": "board", "id": "b_00000001", "born": "5:0:r_aaaaaaaaaaaa",
                                                       "life": ["alive", "5:0:r_aaaaaaaaaaaa"]]]]
      _ = try admission.admit(board, from: .replica(account: "A", replica: "rp_a", n: 1), at: 900, in: &state)
    }
    let scope = type == "tag" ? ScopeKey(.tree("b_00000001")) : ScopeKey(.product(account: "A", name: "probe"))
    let key = RecordKey(type, RecordID(id))
    let born = try Stamp("10:0:r_aaaaaaaaaaaa")
    let life = try Stamp("20:0:r_bbbbbbbbbbbb")
    let intent: JSON = ["scope": scope.ref.json, "d": [["t": .string(type), "id": .string(id), "born": born.json,
                                                      "life": ["dead", life.json]]]]
    let deleted = try admission.admit(intent, from: .replica(account: "A", replica: "rp_b", n: 1), at: 1_000, in: &state)
    let row = Row(key: key, lattice: Lattice(life: Life(.dead, life), born: born), seq: 1, rc: 1_000, ru: 1_000)
    #expect(deleted.result == .ok(seq: 1, write: nil, detail: nil))
    #expect(deleted.events == [.change(scope, frame: [
      "op": "change", "scope": scope.ref.json, "epoch": "ep-2", "seq": 1, "digest": .string(ScopeDigest.zero.hex),
      "rows": [["t": .string(type), "id": .string(id), "born": born.json, "life": ["dead", life.json], "seq": 1]],
    ])])
    #expect(state.scopes[scope]?.seq == 1)
    #expect(state.scopes[scope]?.digest == .zero)
    #expect(state.scopes[scope]?.counters == [:])
    if registry.type(type)?.deadRows == .spent {
      #expect(state.rows[scope]?[key] == nil)
      #expect(state.spent[scope]?[key] == SpentRow(born: born, lifeStamp: life, seq: 1))
    } else {
      #expect(state.rows[scope]?[key] == row)
      #expect(state.spent[scope]?[key] == nil)
    }
    let persisted = state
    state = try ServerState(json: JSON(parsing: state.json.jcs))
    #expect(state == persisted)
    let create: JSON = ["scope": scope.ref.json, "d": [["t": .string(type), "id": .string(id), "born": born.json,
                                                      "life": ["alive", born.json]]]]
    let replayed = try admission.admit(create, from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_100, in: &state)
    #expect(replayed.result == .ok(seq: 1, write: nil, detail: nil))
    #expect(replayed.events == [])
    #expect(state == persisted)
    let repeated = try admission.admit(intent, from: .replica(account: "A", replica: "rp_b", n: 2), at: 1_200, in: &state)
    #expect(repeated.result == .ok(seq: 1, write: nil, detail: nil))
    #expect(repeated.events == [])
    #expect(state == persisted)
  }

  @Test func aDeleteOfAnotherLiveBornRefusesTheWholeIntent_4_3() throws {
    let admission = Admission(registry: try Corpus.probeRegistry(), rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-2")
    let create: JSON = ["scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "10:0:r_aaaaaaaaaaaa",
                                                     "life": ["alive", "10:0:r_aaaaaaaaaaaa"], "f": ["title": ["New", "10:0:r_aaaaaaaaaaaa"]]]]]
    _ = try admission.admit(create, from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000, in: &state)
    let before = state
    let intent: JSON = ["scope": "self/probe", "d": [
      ["t": "card", "id": "card0002", "born": "20:0:r_bbbbbbbbbbbb", "life": ["alive", "20:0:r_bbbbbbbbbbbb"]],
      ["t": "card", "id": "card0001", "born": "9:0:r_aaaaaaaaaaaa", "life": ["dead", "20:0:r_bbbbbbbbbbbb"]],
    ]]
    let refused = try admission.admit(intent, from: .replica(account: "A", replica: "rp_b", n: 1), at: 1_100, in: &state)
    #expect(refused.result == .refused(Refusal(.unknownRecord)))
    #expect(refused.events == [])
    #expect(state == before)
  }

  @Test func everyScopeDigestIsTheSumOverItsAliveRowsAndEveryCounterTheirCount_6_5_6_12() throws {
    let registry = try Corpus.probeRegistry()
    let admission = Admission(registry: registry, rules: ProbeServerRules())
    for seed in UInt64(1)...24 {
      var draws = SplitMix64(seed: seed)
      var state = ServerState(epoch: "ep-1")
      for step in Int64(1)...80 {
        let intent = cardOrDayIntent(&draws, stamp: try Stamp("\(1_000 + step):0:r_aaaaaaaaaaaa"), state: state)
        _ = try admission.admit(intent, from: .replica(account: "A", replica: "rp_a", n: step), at: 1_000_000, in: &state)
        for (key, record) in state.scopes {
          let rows = Array((state.rows[key] ?? [:]).values)
          #expect(record.digest == ScopeDigest(rows: rows.map(\.json)), "seed \(seed), step \(step): \(key)")
          #expect(record.counters["card", default: 0] == rows.filter { $0.key.type == "card" && $0.isAlive }.count)
          #expect(rows.allSatisfy { $0.isAlive || $0.key.type != "card" }, "a dead card lives in sync_spent, not in its table")
        }
      }
    }
  }

  // A card or a day of a small pool: creates, updates and deletes of what the tables hold, and puts either way.
  func cardOrDayIntent(_ draws: inout SplitMix64, stamp: Stamp, state: ServerState) -> JSON {
    let scope = ScopeKey(.product(account: "A", name: "probe"))
    guard draws.next() % 3 != 0 else {
      let day = "2026-09-0\(draws.next() % 4 + 1)"
      let life = draws.next() % 3 == 0 ? "dead" : "alive"
      return ["scope": "self/probe", "d": [["t": "day", "id": .string(day), "life": [.string(life), stamp.json],
                                             "f": ["score": [JSON(draws.next() % 11), stamp.json]]]]]
    }
    let id = "card000\(draws.next() % 5)"
    let stored = state.rows[scope]?[RecordKey("card", RecordID(id))]
    let delta: JSON = switch (stored?.lattice.born, draws.next() % 3) {
    case (let born?, 0): ["t": "card", "id": .string(id), "born": born.json, "life": ["dead", stamp.json]]
    case (let born?, _): ["t": "card", "id": .string(id), "born": born.json, "f": ["title": [.string("T\(draws.next() % 9)"), stamp.json]]]
    case (nil, _): ["t": "card", "id": .string(id), "born": stamp.json, "life": ["alive", stamp.json], "f": ["title": ["New", stamp.json]]]
    }
    return ["scope": "self/probe", "d": [delta]]
  }

  @Test func aRefusalAfterTheServerMintedItsStampLeavesTheTablesAndTheClockAsTheyWere_6_1_stepR() throws {
    let registry = try Corpus.probeRegistry()
    let admission = Admission(registry: registry, rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-1", clock: HLC(ms: 5, counter: 0))
    for (n, id) in ["card0001", "card0002", "card0003"].enumerated() {
      let create: JSON = ["scope": "self/probe", "d": [["t": "card", "id": .string(id), "born": "10:0:r_aaaaaaaaaaaa",
                                                        "life": ["alive", "10:0:r_aaaaaaaaaaaa"]]]]
      _ = try admission.admit(create, from: .replica(account: "A", replica: "rp_a", n: Int64(n + 1)), at: 1_000_000, in: &state)
    }
    let before = state
    let serverCreate: JSON = ["scope": "self/probe", "d": [["t": "card", "id": "card0004", "born": .null, "life": ["alive", .null]]]]
    let admitted = try admission.admit(serverCreate, from: .server(account: "A", requestId: nil), at: 1_000_000, in: &state)
    #expect(admitted.result == .refused(Refusal(.cap, detail: ["type": "card", "cap": 3])))
    #expect(admitted.events == [])
    #expect(state == before)
  }

  @Test func anUpdateUnderARunTheSameIntentDeletesIsParentDead_6_1_step10() throws {
    let registry = try Corpus.probeRegistry()
    let admission = Admission(registry: registry, rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-1")
    let start: JSON = ["scope": "self/probe", "cmd": ["name": "probe.start", "args": ["id": "run00001", "startedAt": 100, "join": true]]]
    _ = try admission.admit(start, from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000_000, in: &state)
    let lap: JSON = ["scope": "self/probe", "d": [["t": "lap", "id": "lap00001", "born": "200:0:r_aaaaaaaaaaaa",
                                                  "life": ["alive", "200:0:r_aaaaaaaaaaaa"],
                                                  "f": ["runId": ["run00001", "200:0:r_aaaaaaaaaaaa"], "at": [200, "200:0:r_aaaaaaaaaaaa"],
                                                        "weight": [1, "200:0:r_aaaaaaaaaaaa"]]]]]
    _ = try admission.admit(lap, from: .replica(account: "A", replica: "rp_a", n: 2), at: 1_000_000, in: &state)
    let runBorn = try #require(state.rows[ScopeKey(.product(account: "A", name: "probe"))]?[RecordKey("run", "run00001")]?.lattice.born)
    let deleteAndUpdate: JSON = ["scope": "self/probe", "d": [
      ["t": "run", "id": "run00001", "born": runBorn.json, "life": ["dead", "1000001:0:r_aaaaaaaaaaaa"]],
      ["t": "lap", "id": "lap00001", "born": "200:0:r_aaaaaaaaaaaa", "f": ["weight": [2, "1000001:0:r_aaaaaaaaaaaa"]]],
    ]]
    let before = state
    let admitted = try admission.admit(deleteAndUpdate, from: .replica(account: "A", replica: "rp_a", n: 3), at: 1_000_000, in: &state)
    #expect(admitted.result == .refused(Refusal(.parentDead)))
    #expect(state == before)
  }
}

// Folders and docs on boards, a product the probe cannot express: a board governs a tree of folders and docs, each doc
// sits in a folder (its parent) and is numbered by a serial, `p.copy` copies a board's docs (and, when asked, its folders)
// into the tree of a board it creates, and a doc whose joined folder is dead dies with a server delete.
struct Boards: ServerRules {
  static let registry: JSON = [
    "registry": "test", "version": 1, "minVersion": 1, "products": ["p": [:]],
    "types": [
      [
        "type": "board", "scope": "product:p", "identity": "minted", "idSpace": "global", "idPattern": "^b[0-9]$",
        "mint": ["prefix": "b", "alphabet": "0123456789", "length": 1], "life": true, "revivable": false, "deadRows": "keep",
        "governs": "tree", "origins": ["replica", "server"], "fields": [:],
      ],
      [
        "type": "folder", "scope": "tree", "identity": "minted", "idSpace": "scope", "idPattern": "^f[0-9]$",
        "mint": ["prefix": "f", "alphabet": "0123456789", "length": 1], "life": true, "revivable": false, "deadRows": "keep",
        "origins": ["replica", "server"], "fields": [:],
      ],
      [
        "type": "doc", "scope": "tree", "identity": "minted", "idSpace": "scope", "idPattern": "^d[0-9]$",
        "mint": ["prefix": "d", "alphabet": "0123456789", "length": 1], "life": true, "revivable": false, "deadRows": "keep",
        "origins": ["replica", "server"], "fields": [
          "folderId": ["kind": "lww", "writer": "client", "ref": "folder", "parent": true],
          "no": ["kind": "serial", "writer": "server", "serialNext": []],
        ],
      ],
    ],
    "commands": [[
      "name": "p.copy", "scope": "product:p", "origins": ["replica", "server"], "serverInternal": false,
      "args": ["src": ["type": "ref<board>"], "dst": ["type": "ref<board>"], "folders": ["type": "json", "domain": ["type": "boolean"]]],
      "predicts": ["board"],
    ]],
  ]

  // Board b1, and tree:b1 holding folder f1 and doc d1 in it: the state the reference run of the copies started from.
  static let state = #"""
    {"epoch": "ep-1", "clock": {"ms": 0, "counter": 0},
     "scopes": {
      "acct:A/p": {
       "kind": "product",
       "owner": "A",
       "state": "alive",
       "seq": 1,
       "counters": {},
       "digest": "c4d6434a28c31cdac4775ab4253b134d2490c4dd894a844580c9375e05671d8f"
      },
      "tree:b1": {
       "kind": "tree",
       "owner": "A",
       "state": "alive",
       "seq": 1,
       "counters": {},
       "digest": "ff75f30c73537970e975376b59f64283e0d73eeb5052fa46336b500a4b1771a9",
       "governedBy": "acct:A/p#board#b1"
      }
     },
     "rows": {
      "acct:A/p": [
       {
        "t": "board",
        "id": "b1",
        "life": ["alive", "10:0:r_aaaaaaaaaaaa"],
        "born": "10:0:r_aaaaaaaaaaaa",
        "seq": 1,
        "rc": 1000,
        "ru": 1000
       }
      ],
      "tree:b1": [
       {
        "t": "folder",
        "id": "f1",
        "life": ["alive", "11:0:r_aaaaaaaaaaaa"],
        "born": "11:0:r_aaaaaaaaaaaa",
        "seq": 1,
        "rc": 1000,
        "ru": 1000
       },
       {
        "t": "doc",
        "id": "d1",
        "life": ["alive", "12:0:r_aaaaaaaaaaaa"],
        "born": "12:0:r_aaaaaaaaaaaa",
        "f": {"folderId": ["f1", "12:0:r_aaaaaaaaaaaa"]},
        "v": {"no": 1},
        "seq": 1,
        "rc": 1000,
        "ru": 1000
       }
      ]
     }}
    """#

  func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool { false }

  func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let destination = RecordKey("board", RecordID((try? command.args["dst"]?.asString()) ?? ""))
    let copied = context.rows(ofTree: (try? command.args["src"]?.asString()) ?? "")
      .filter { $0.isAlive && ($0.key.type == "doc" || (command.args["folders"] == true && $0.key.type == "folder")) }
    return CommandOutcome(
      deltas: [.serverCreate(destination)], write: [WriteClaim(key: destination, born: .minted)], product: context.product,
      created: [ScopeKey(.tree(destination.id.description)): copied.map(PlannedDelta.copy(of:))])
  }

  func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
    changes.filter { change in
      guard change.scope == context.scope, change.key.type == "doc", change.after.isAlive,
            case .string(let folder)? = change.after.lattice.fields["folderId"]?.value else { return false }
      if case .dead = context.idState(of: RecordKey("folder", RecordID(folder))) { return true }
      return false
    }
    .map { PlannedDelta.serverDelete($0.key, born: $0.after.lattice.born) }
  }

  func keptRevisions(_ revisions: [Revision]) -> [Revision] { revisions }

  // The intents admitted in order from the fixture: the last one's result, and the tables before and after it.
  static func admit(_ intents: [JSON], limits: ServerLimits = ServerLimits()) throws
    -> (last: AdmitResult, before: ServerState, after: ServerState) {
    let admission = Admission(registry: try Registry(json: registry), rules: Boards(), limits: limits)
    var state = try ServerState(json: JSON(parsing: Array(Self.state.utf8)))
    var before = state
    var last = AdmitResult.refused(Refusal(.invalid))
    for (n, intent) in intents.enumerated() {
      before = state
      last = try admission.admit(intent, from: .replica(account: "A", replica: "rp_a", n: Int64(n + 1)), at: 1_000_000, in: &state).result
    }
    return (last, before, state)
  }
}

// Steps 9 to 11 on every record the intent touches: in its scope, and in the scope of a board a copy creates (step 14).
extension AdmissionTests {
  static func copy(folders: Bool) -> JSON {
    ["scope": "self/p", "cmd": ["name": "p.copy", "args": ["src": "b1", "dst": "b2", "folders": .bool(folders)]]]
  }

  // The parent rule reads the reference as the join wrote it, before G1 drops a dead record's fields: a doc moved into a
  // dead folder, which the product's check then deletes, is parent-dead, whatever folder it was stored in.
  @Test func theParentRuleReadsTheJoinedReferenceBeforeG1_6_1_step10() throws {
    let folder = { (life: String, at: Int) -> JSON in
      ["scope": "tree/b1", "d": [["t": "folder", "id": "f2", "born": "20:0:r_aaaaaaaaaaaa",
                                  "life": [.string(life), .string("\(at):0:r_aaaaaaaaaaaa")]]]]
    }
    let move: JSON = [
      "scope": "tree/b1", "d": [["t": "doc", "id": "d1", "born": "12:0:r_aaaaaaaaaaaa", "f": ["folderId": ["f2", "22:0:r_aaaaaaaaaaaa"]]]],
    ]
    let admitted = try Boards.admit([folder("alive", 20), folder("dead", 21), move])
    #expect(admitted.last == .refused(Refusal(.parentDead)))
    #expect(admitted.after == admitted.before)
  }

  @Test func aDocCopiedIntoACreatedTreeWithoutItsFolderIsParentDead_6_1_step10_step14() throws {
    let admitted = try Boards.admit([Self.copy(folders: false)])
    #expect(admitted.last == .refused(Refusal(.parentDead)))
    #expect(admitted.after == admitted.before)
  }

  @Test func aCopyNumbersTheDocsItWritesIntoTheTreeItCreates_6_1_step11_step14() throws {
    let admitted = try Boards.admit([Self.copy(folders: true)])
    #expect(admitted.last == .ok(seq: 2, write: [["t": "board", "id": "b2", "born": "1000000:0:srv"]], detail: nil))
    #expect(admitted.after.rows[ScopeKey(.tree("b2"))].map { $0.values.sorted { $0.key < $1.key }.map(\.json) } == [
      ["t": "doc", "id": "d1", "life": ["alive", "12:0:r_aaaaaaaaaaaa"], "born": "12:0:r_aaaaaaaaaaaa",
       "f": ["folderId": ["f1", "12:0:r_aaaaaaaaaaaa"]], "v": ["no": 1], "seq": 1, "rc": 1_000_000, "ru": 1_000_000],
      ["t": "folder", "id": "f1", "life": ["alive", "11:0:r_aaaaaaaaaaaa"], "born": "11:0:r_aaaaaaaaaaaa", "seq": 1, "rc": 1_000_000,
       "ru": 1_000_000],
    ])
  }

  // The reference admits this copy at MAX_RECORD_BYTES 169 and refuses it at 168: the doc it writes, before its serial.
  @Test(arguments: [(169, false), (168, true)])
  func theRowsACopyWritesIntoTheTreeItCreatesAreMeasuredBeforeTheirSerial_6_1_step9(_ bound: Int, _ refused: Bool) throws {
    var limits = ServerLimits()
    limits.maxRecordBytes = bound
    #expect(try Boards.admit([Self.copy(folders: true)], limits: limits).last.isRefused == refused)
  }
}

extension AdmissionTests {
  // Review F4: a client delta §4.3 answers `ok` writes nothing, so the server stamp does not observe it (§10.3).
  @Test func aClientDeltaAnsweredOkIsNotObservedByTheServerStamp_10_3() throws {
    struct AdvanceDeath: ServerRules {
      func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
        [.serverDelete(RecordKey("card", "card0001"), born: try! Stamp("200:0:r_aaaaaaaaaaaa"))]
      }
    }
    let admission = Admission(registry: try Corpus.probeRegistry(), rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-1")
    let dead: JSON = ["scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "200:0:r_aaaaaaaaaaaa",
                                                   "life": ["dead", "201:0:r_aaaaaaaaaaaa"]]]]
    _ = try admission.admit(dead, from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000_000, in: &state)
    let scope = ScopeKey(.product(account: "A", name: "probe"))
    let intent: JSON = ["scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "199:0:r_aaaaaaaaaaaa",
                                                     "life": ["dead", "1250000:0:r_aaaaaaaaaaaa"]]]]
    let advancing = Admission(registry: admission.registry, rules: AdvanceDeath())
    let admitted = try advancing.admit(intent, from: .replica(account: "A", replica: "rp_a", n: 2), at: 1_000_000, in: &state)
    #expect(admitted.result == .ok(seq: 2, write: nil, detail: nil))
    #expect(state.spent[scope]?[RecordKey("card", "card0001")]?.lifeStamp == (try Stamp("1000000:0:srv")))
    #expect(state.clock == HLC(ms: 1_000_000, counter: 0))
  }

  // Same cause as F4: a guard holds through the stamp this intent writes, and a delta answered `ok` writes nothing.
  @Test func aGuardDoesNotHoldThroughADeltaAnsweredOk_6_1_step7() throws {
    let admission = Admission(registry: try Corpus.probeRegistry(), rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-1")
    let board: JSON = ["scope": "self/probe", "d": [["t": "board", "id": "b_00000001", "born": "1:0:r_aaaaaaaaaaaa",
                                                     "life": ["alive", "1:0:r_aaaaaaaaaaaa"]]]]
    _ = try admission.admit(board, from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000_000, in: &state)
    let dead: JSON = ["scope": "tree/b_00000001", "d": [["t": "tag", "id": "oak", "born": "10:0:r_aaaaaaaaaaaa",
                                                        "life": ["dead", "11:0:r_aaaaaaaaaaaa"], "f": ["label": ["Hi", "10:0:r_aaaaaaaaaaaa"]]]]]
    _ = try admission.admit(dead, from: .replica(account: "A", replica: "rp_a", n: 2), at: 1_000_000, in: &state)
    let before = state
    let otherBorn: JSON = ["scope": "tree/b_00000001",
                           "d": [["t": "tag", "id": "oak", "born": "9:0:r_aaaaaaaaaaaa", "life": ["dead", "20:0:r_aaaaaaaaaaaa"],
                                  "f": ["label": ["Hi", "10:0:r_aaaaaaaaaaaa"]]]],
                           "guard": [["t": "tag", "id": "oak", "field": "label", "stamp": "5:0:r_aaaaaaaaaaaa"]]]
    let admitted = try admission.admit(otherBorn, from: .replica(account: "A", replica: "rp_a", n: 3), at: 1_000_000, in: &state)
    #expect(admitted.result == .refused(Refusal(.stale, detail: ["t": "tag", "id": "oak", "field": "label", "current": "10:0:r_aaaaaaaaaaaa"])))
    #expect(admitted.events == [])
    #expect(state == before)
  }

  // Review F5 and D-20: the write map gives the record's born, the smaller one when a client create joined it.
  @Test func aWriteMapBornIsTheStoredRecordsBorn_D20() throws {
    let admission = Admission(registry: try Corpus.probeRegistry(), rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-1")
    let board = { (id: String, stamp: String) -> JSON in ["t": "board", "id": .string(id), "born": .string(stamp), "life": ["alive", .string(stamp)]] }
    _ = try admission.admit(["scope": "self/probe", "d": [board("b_00000001", "10:0:r_aaaaaaaaaaaa")]],
                            from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000_000, in: &state)
    let admitted = try admission.admit(["scope": "self/probe", "d": [board("b_00000002", "20:0:r_aaaaaaaaaaaa")],
                                        "cmd": ["name": "probe.copy", "args": ["src": "b_00000001", "dst": "b_00000002"]]],
                                       from: .replica(account: "A", replica: "rp_a", n: 2), at: 1_000_000, in: &state)
    let stored = state.rows[ScopeKey(.product(account: "A", name: "probe"))]?[RecordKey("board", "b_00000002")]
    #expect(stored?.lattice.born == (try Stamp("20:0:r_aaaaaaaaaaaa")))
    #expect(admitted.result == .ok(seq: 2, write: [["t": "board", "id": "b_00000002", "born": "20:0:r_aaaaaaaaaaaa"]], detail: nil))
  }

  // §6.1 step 10: a joined record carries the source of every delta that creates it, so a product rule tells the
  // command's create from the intent's own create beside it.
  @Test func aJoinedRecordCarriesTheSourceOfEachCreateOfIt_6_1_step10() throws {
    let admission = Admission(registry: try Corpus.probeRegistry(), rules: Creators())
    var state = ServerState(epoch: "ep-1")
    let start = { (id: String) -> JSON in ["name": "probe.start", "args": ["id": .string(id), "startedAt": 100, "join": false]] }
    let run: JSON = ["t": "run", "id": "run00001", "born": "100:0:r_aaaaaaaaaaaa", "life": ["alive", "100:0:r_aaaaaaaaaaaa"],
                     "f": ["startedAt": [100, "100:0:r_aaaaaaaaaaaa"]]]
    let beside = try admission.admit(["scope": "self/probe", "d": [run], "cmd": start("run00001")],
                                     from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000_000, in: &state)
    let alone = try admission.admit(["scope": "self/probe", "cmd": start("run00002")],
                                    from: .replica(account: "A", replica: "rp_a", n: 2), at: 1_000_000, in: &state)
    #expect(beside.result == .refused(Refusal(.invalid, detail: ["run/run00001": ["intent", "command"]])))
    #expect(alone.result == .refused(Refusal(.invalid, detail: ["run/run00002": ["command"]])))
  }
}

// The probe's rules, but `check` refuses every intent with the sources that created each record it is given.
struct Creators: ServerRules {
  let probe = ProbeServerRules()

  func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool { probe.replays(command, in: context) }

  func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    try probe.run(command, in: context)
  }

  func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
    let creators = changes.map { ("\($0.key.type)/\($0.key.id)", JSON.array($0.createdBy.map { .string($0.rawValue) })) }
    throw Refusal(.invalid, detail: .object(JSON.Object(uniqueKeysWithValues: creators)))
  }

  func keptRevisions(_ revisions: [Revision]) -> [Revision] { probe.keptRevisions(revisions) }
}

// A seeded SplitMix64, so a failing seed replays.
struct SplitMix64: RandomNumberGenerator {
  var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var mixed = state
    mixed = (mixed ^ (mixed >> 30)) &* 0xBF58_476D_1CE4_E5B9
    mixed = (mixed ^ (mixed >> 27)) &* 0x94D0_49BB_1331_11EB
    return mixed ^ (mixed >> 31)
  }
}
