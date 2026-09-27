import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// §6.1 properties the corpus pins only by example: the digest and the counters admission keeps, and step R's rollback.

struct AdmissionTests {
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

extension AdmissionTests {
  // Review F4: a client delta §4.3 answers `ok` writes nothing, so the server stamp does not observe it (§10.3).
  @Test func aClientDeltaAnsweredOkIsNotObservedByTheServerStamp_10_3() throws {
    let admission = Admission(registry: try Corpus.probeRegistry(), rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-1")
    let start: JSON = ["scope": "self/probe", "cmd": ["name": "probe.start", "args": ["id": "run00001", "startedAt": 100, "join": true]]]
    _ = try admission.admit(start, from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000_000, in: &state)
    let lap: JSON = ["scope": "self/probe", "d": [["t": "lap", "id": "lap00001", "born": "200:0:r_aaaaaaaaaaaa",
                                                  "life": ["alive", "200:0:r_aaaaaaaaaaaa"],
                                                  "f": ["runId": ["run00001", "200:0:r_aaaaaaaaaaaa"], "at": [200, "200:0:r_aaaaaaaaaaaa"],
                                                        "weight": [1, "200:0:r_aaaaaaaaaaaa"]]]]]
    _ = try admission.admit(lap, from: .replica(account: "A", replica: "rp_a", n: 2), at: 1_000_000, in: &state)
    let scope = ScopeKey(.product(account: "A", name: "probe"))
    let runBorn = try #require(state.rows[scope]?[RecordKey("run", "run00001")]?.lattice.born)
    let intent: JSON = ["scope": "self/probe", "d": [
      ["t": "run", "id": "run00001", "born": runBorn.json, "life": ["dead", "1000001:0:r_aaaaaaaaaaaa"]],
      ["t": "lap", "id": "lap00001", "born": "199:0:r_aaaaaaaaaaaa", "life": ["dead", "1250000:0:r_aaaaaaaaaaaa"]],
    ]]
    _ = try admission.admit(intent, from: .replica(account: "A", replica: "rp_a", n: 3), at: 1_000_000, in: &state)
    #expect(state.spent[scope]?[RecordKey("lap", "lap00001")]?.lifeStamp == (try Stamp("1000000:1:srv")))
    #expect(state.clock == HLC(ms: 1_000_000, counter: 1))
  }

  // Same cause as F4: a guard holds through the stamp this intent writes, and a delta answered `ok` writes nothing.
  @Test func aGuardDoesNotHoldThroughADeltaAnsweredOk_6_1_step7() throws {
    let admission = Admission(registry: try Corpus.probeRegistry(), rules: ProbeServerRules())
    var state = ServerState(epoch: "ep-1")
    let create: JSON = ["scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "10:0:r_aaaaaaaaaaaa",
                                                     "life": ["alive", "10:0:r_aaaaaaaaaaaa"], "f": ["title": ["Hi", "10:0:r_aaaaaaaaaaaa"]]]]]
    _ = try admission.admit(create, from: .replica(account: "A", replica: "rp_a", n: 1), at: 1_000_000, in: &state)
    let otherBorn: JSON = ["scope": "self/probe",
                           "d": [["t": "card", "id": "card0001", "born": "9:0:r_aaaaaaaaaaaa", "life": ["dead", "20:0:r_aaaaaaaaaaaa"],
                                  "f": ["title": ["Hi", "10:0:r_aaaaaaaaaaaa"]]]],
                           "guard": [["t": "card", "id": "card0001", "field": "title", "stamp": "5:0:r_aaaaaaaaaaaa"]]]
    let admitted = try admission.admit(otherBorn, from: .replica(account: "A", replica: "rp_a", n: 2), at: 1_000_000, in: &state)
    #expect(admitted.result == .refused(Refusal(.stale, detail: ["t": "card", "id": "card0001", "field": "title", "current": "10:0:r_aaaaaaaaaaaa"])))
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
