import Foundation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization
import SyncTesting
import Testing

// Every Action is one transaction: killed before its commit it never happened, killed after it, it did. A store
// reopened after a kill at any step holds exactly the Actions that committed, and replaying the rest reaches the state
// an unkilled run reaches.

struct StoreTests {
  static let probe = try! Corpus.probeRegistry()
  static let scope = ScopeRef.product("probe")
  static let actor = try! Stamp.Actor("r_aaaaaaaaaaaa")

  struct Killed: Error {}

  // One Action of a scenario, run against a store.
  struct Step: Sendable {
    let name: String
    let run: @Sendable (Store) throws -> Void
  }

  static func at(_ deviceNow: Int64) -> Instance { Instance(actor: actor, deviceNow: deviceNow, appVersion: "1") }
  static func none() throws -> QueuedIdentities { try QueuedIdentities([:]) }

  // A bound replica of A holding card0001, confirmed at seq 1 under a live cursor.
  static func seed() throws -> ReplicaBatch {
    let row = try Row(json: JSON(parsing: """
      {"t":"card","id":"card0001","life":["alive","1000:0:r_aaaaaaaaaaaa"],"born":"1000:0:r_aaaaaaaaaaaa",
       "f":{"title":["One","1000:0:r_aaaaaaaaaaaa"]},"seq":1,"rc":1000,"ru":1000}
      """))
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-1"
    let cursor = CursorRecord(cursor: Cursor(epoch: "ep-1", mode: .live, seq: 1).text, digest: row.digest, booted: true)
    let device = LoadedDevice(meta: DeviceMeta(forkGuard: "fg-1"), active: "rp_1", replicas: [
      LoadedReplica(meta: meta, confirmed: [scope: Rows([row])], cursors: [scope: cursor], wholeScopes: true),
    ])
    return ReplicaBatch(building: device)
  }

  static func commit(_ name: String, at deviceNow: Int64, _ gesture: Gesture) -> Step {
    Step(name: name) { store in _ = try store.commit(gesture, in: scope, instance: at(deviceNow), identities: try none()) }
  }

  static func push(_ step: PushStep, at deviceNow: Int64) -> Step {
    Step(name: "\(step)") { store in
      var instance = at(deviceNow)
      _ = try store.apply(step, replica: "rp_1", instance: &instance, timing: .steady(send: deviceNow, recv: deviceNow), identities: try none())
    }
  }

  static func result(_ n: Int64, seq: Int64) throws -> PushResult {
    try PushResult(json: ["n": JSON(n), "s": "ok", "seq": JSON(seq)])
  }

  // Commits, held and not, Undo, the release timer, numbering, and a push answer's sample, results and ack.
  static func sending() throws -> [Step] {
    [
      commit("update", at: 5000, Gesture(changes: [.update("card", "card0001", ["title": "Two"])], gestureId: "u1")),
      commit("create", at: 5001, Gesture(changes: [.create("card", id: .given("card0002"), ["title": "New"])], gestureId: "c2")),
      commit("held delete", at: 5002, Gesture(changes: [.delete("card", "card0001")], hold: true, gestureId: "d1")),
      Step(name: "undo") { store in _ = try store.undo("d1") },
      commit("held delete again", at: 5003, Gesture(changes: [.delete("card", "card0001")], hold: true, gestureId: "d2")),
      Step(name: "release timer") { store in _ = try store.releaseDue(at: 5003 + Constants.holdMs) },
      Step(name: "number") { store in _ = try store.number(at: 14_000) },
      push(.sample(serverTime: 14_100), at: 14_050),
      push(.results(ResultBatch(replica: "rp_1", results: [try result(1, seq: 2)], lastN: 2, epoch: "ep-1", isLast: false)), at: 14_050),
      push(.results(ResultBatch(replica: "rp_1", results: [try result(2, seq: 3)], lastN: 2, epoch: "ep-1", isLast: true)), at: 14_050),
      push(.epoch("ep-1"), at: 14_050),
    ]
  }

  // A boot over confirmed rows fills staging, chunk by chunk, the page that turns the cursor live swaps it in, and the
  // acked entries it covers resolve; the sweep deletes the rows the swap replaced.
  static func pulling() throws -> [Step] {
    let bootCursor = Cursor(epoch: "ep-2", mode: .boot, seq: 2, key: RecordKey("card", "card0004"), asOf: 3).text
    let row = { (id: String, seq: Int64) throws -> JSON in
      try JSON(parsing: """
        {"t":"card","id":"\(id)","life":["alive","\(seq)000:0:r_aaaaaaaaaaaa"],"born":"\(seq)000:0:r_aaaaaaaaaaaa","seq":\(seq),"rc":\(seq),"ru":\(seq)}
        """)
    }
    let rows = [try row("card0002", 1), try row("card0004", 2), try row("card0003", 3)]
    let digest = ScopeDigest(rows: rows)
    let first = try PullPage(json: ["scope": "self/probe", "kind": "rows", "rows": [rows[0], rows[1]], "cursor": .string(bootCursor), "more": true,
                                "seq": 3, "digest": .string(digest.hex)])
    let last = try PullPage(json: ["scope": "self/probe", "kind": "rows", "rows": [rows[2]],
                               "cursor": .string(Cursor(epoch: "ep-2", mode: .live, seq: 3).text), "more": false, "seq": 3,
                               "digest": .string(digest.hex)])
    let pull = { (step: PullStep, replica: String) in
      Step(name: "\(step)") { store in
        var instance = at(20_000)
        _ = try store.apply(step, replica: replica, account: "A", subscribed: .given([scope]), instance: &instance,
                            timing: .steady(send: 20_000, recv: 20_000),
                            identities: try QueuedIdentities(["ids": ["rp_2"], "actors": ["r_bbbbbbbbbbbb"]]))
      }
    }
    return try sending() + [
      pull(.epoch("ep-2"), "rp_1"),
      pull(.page(first, requested: nil, chunk: PageChunk(rows: 0..<1, isLast: false)), "rp_2"),
      pull(.page(first, requested: nil, chunk: PageChunk(rows: 1..<2, isLast: true)), "rp_2"),
      pull(.page(last, requested: bootCursor, chunk: .whole(last, settles: .max)), "rp_2"),
      Step(name: "sweep") { store in _ = try store.sweep(limit: 1) },
    ]
  }

  // Sign-out with unsent entries, Keep, and sign-in again as A: the dormant replica is rebound.
  static func lifecycle() throws -> [Step] {
    let identities: @Sendable () throws -> QueuedIdentities = { try QueuedIdentities(["ids": ["rp_anon"]]) }
    return [
      commit("create", at: 5001, Gesture(changes: [.create("card", id: .given("card0002"), ["title": "New"])], gestureId: "c2")),
      Step(name: "sign-out count") { store in _ = try store.signOut(choice: nil, counted: nil, identities: try identities()) },
      Step(name: "sign-out keep") { store in _ = try store.signOut(choice: .keep, counted: nil, identities: try identities()) },
      commit("anon create", at: 6000, Gesture(changes: [.create("card", id: .given("card0003"), ["title": "Anon"])], gestureId: "a1")),
      Step(name: "sign-in begin") { store in _ = try store.beginSignIn(account: "A") },
      Step(name: "sign-in complete") { store in
        _ = try store.signIn(account: "A", holdsRecords: ["probe": true], decisions: ["probe": .add], counted: [:], identities: try none())
      },
    ]
  }

  @Test(arguments: ["sending", "pulling", "lifecycle"])
  func aStoreKilledAtAnyStepHoldsExactlyWhatCommitted(_ scenario: String) throws {
    let steps = try scenario == "sending" ? Self.sending() : scenario == "pulling" ? Self.pulling() : Self.lifecycle()
    let states = try Self.states(after: steps)
    #expect(Set(states).count > steps.count / 2, "\(scenario): most steps change the store")
    for point in 0..<(2 * steps.count) {
      let step = point / 2
      let committed = point % 2 == 1
      try Self.inFreshDirectory { path in
        let seeded = try Store(path: path, registry: Self.probe)
        _ = try seeded.write(.firstLaunch) { _ in Planned((), try Self.seed()) }
        let killing = try Store(path: path, registry: Self.probe, crashPoints: .killing(at: point))
        for index in 0...step {
          do {
            try steps[index].run(killing)
          } catch is Killed {
            break
          }
        }
        let reopened = try Store(path: path, registry: Self.probe)
        let held = try reopened.read { try $0.device(rows: true).json }
        #expect(held == states[committed ? step + 1 : step], "\(scenario): killed \(committed ? "after" : "before") \(steps[step].name)")
        for index in (committed ? step + 1 : step)..<steps.count { try steps[index].run(reopened) }
        #expect(try reopened.read { try $0.device(rows: true).json } == states.last, "\(scenario): replayed after \(steps[step].name)")
      }
    }
  }

  // The store's state before the first step and after each one, run without kills.
  static func states(after steps: [Step]) throws -> [JSON] {
    let store = try Store.inMemory(registry: probe)
    _ = try store.write(.firstLaunch) { _ in Planned((), try seed()) }
    var states = [try store.read { try $0.device(rows: true).json }]
    for step in steps {
      try step.run(store)
      states.append(try store.read { try $0.device(rows: true).json })
    }
    return states
  }

  static func inFreshDirectory(_ body: (String) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try body(directory.appendingPathComponent("sync.sqlite").path)
  }

  @Test func aKillBeforeTheCommitRollsTheActionBackAndOneAfterItKeepsIt() throws {
    for (point, kept) in [(CrashPoint.beforeCommit(.commit), false), (.afterCommit(.commit), true)] {
      let store = try Store.inMemory(registry: Self.probe, crashPoints: CrashPoints { if $0 == point { throw Killed() } })
      _ = try store.write(.firstLaunch) { _ in Planned((), try Self.seed()) }
      #expect(throws: Killed.self) {
        try store.commit(Gesture(changes: [.update("card", "card0001", ["title": "Two"])]), in: Self.scope, instance: Self.at(5000),
                         identities: try QueuedIdentities([:]))
      }
      #expect(try store.read { try $0.device(rows: true).activeReplica.outbox.count } == (kept ? 1 : 0))
    }
  }
}

extension CrashPoints {
  // Kills at the `point`-th crash point of a commit the store reaches, counting from 0: before a commit at even points,
  // after it at odd ones, one transaction per step.
  static func killing(at point: Int) -> CrashPoints {
    let reached = Mutex(-1)
    return CrashPoints { reachedPoint in
      guard reachedPoint != .read else { return }
      let count = reached.withLock { count in
        count += 1
        return count
      }
      if count == point { throw StoreTests.Killed() }
    }
  }
}
