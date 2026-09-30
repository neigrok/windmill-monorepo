import Foundation
import SyncAPI
import SyncCore
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// §11.3 the replay fuzz and §11.2 property 3, through the simulator; and that its checks see what they check.
struct SimulatorTests {
  // SYNC_SIM_SEEDS seeds from SYNC_SEED (128 from 1 by default), each SYNC_SIM_ACTIONS actions (300) before quiescence.
  static let firstSeed = UInt64(ProcessInfo.processInfo.environment["SYNC_SEED"] ?? "") ?? 1
  static let seeds = UInt64(ProcessInfo.processInfo.environment["SYNC_SIM_SEEDS"] ?? "") ?? 128
  static let actions = Int(ProcessInfo.processInfo.environment["SYNC_SIM_ACTIONS"] ?? "") ?? 300

  // §11.3's coverage floor for a fuzz of 128 × 300 or more: each event from ten or more seeds on average (coverage-survey.sh).
  static let floor = (seeds: 128, actions: 300)
  static let exercised = [
    // drop, duplicate, delay and reorder; lost replies
    "wire push drop", "wire pull drop", "wire push duplicate", "frame duplicated", "wire push delay", "delayed push admitted",
    "frame overtook", "frame dropped", "wire push loseReply", "wire pull loseReply",
    // process death: at a step, between two chunks, two settling slices or two result batches
    "relaunch", "reboot", "death after a pullPage transaction", "death after a settle transaction", "death after a results transaction",
    // pages short of the head, frames between them
    "page short of its head", "frame frame", "live open",
    // clock error and device clock jumps; a born a receipt replay left unsourced, which recovery lowers (§7.7 step 1.5)
    "refused clock-skew", "clock jumped", "unsourced stamp lowered",
    // holds, undo, retire, leaving the app
    "ended undone by undo", "ended undone by retire", "leave",
    // sign-in and sign-out
    "sign-in add", "sign-in discard", "sign-in left pending", "sign-out keep", "sign-out discard", "sign-out cancelled",
    "dormant discarded", "ended discarded by discard",
    // credentials expired, lost or another account's
    "http 401 unauthenticated", "session of another account", "http 409 account-mismatch", "wire push loseCredential",
    "wire pull loseCredential", "wire live loseCredential", "wire hello loseCredential", "push served as anonymous",
    "push served as another account", "pull served as anonymous", "pull served as another account", "frame served as anonymous",
    // poison
    "poisoned", "refused internal",
    // epoch change; a store restored or cloned
    "server restored", "epoch change", "store restored from a backup", "store rolled back in place", "store cloned", "http 409 gap",
    "http 409 replica-forked",
    // engine paths
    "active replica change announced", "ok with a joining write map", "refused cap", "wire push answer(status: 413)", "retry",
    "ended refused by target-merged", "wire push answer(status: 400)", "ended refused by refuse", "ended refused by fold",
    "ended resolved by resolve", "refused stale", "commit refused cap", "commit refused scope-dead", "http 503 unavailable",
    "visibility set", "read-and-commit decided nothing", "gesture tag revive", "gesture probe.copy", "notice dismissed",
    "scope closed", "tree opened", "foreign tree opened", "gesture fact save", "gesture fact save retiring its delete", "rows swept",
  ]

  @Test func everySeedHoldsEveryInvariantAfterQuiescence() async throws {
    let registry = try Corpus.probeRegistry()
    let seeds = Array(Self.firstSeed..<(Self.firstSeed + Self.seeds))
    var coverage: [String: Int] = [:]
    var producing: [String: Int] = [:]
    await withTaskGroup(of: Simulator.Report.self) { group in
      var next = seeds.makeIterator()
      for _ in 0..<ProcessInfo.processInfo.activeProcessorCount {
        guard let seed = next.next() else { break }
        group.addTask { await Simulator(seed: seed, registry: registry).run(actions: Self.actions) }
      }
      for await report in group {
        #expect(report.violations == [], "seed \(report.seed): \(report.violations.prefix(5))\nlast actions: \(report.log.suffix(12))")
        coverage.merge(report.coverage) { $0 + $1 }
        for (event, count) in report.coverage where count > 0 { producing[event, default: 0] += 1 }
        if let seed = next.next() { group.addTask { await Simulator(seed: seed, registry: registry).run(actions: Self.actions) } }
      }
    }
    print("simulated \(seeds.count) seeds from \(Self.firstSeed), \(Self.actions) actions each: \(coverage["checked rows"] ?? 0) rows, "
      + "\(coverage["checked entries"] ?? 0) entries checked")
    print("seeds producing: " + producing.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "|"))
    print("events: " + coverage.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "|"))
    guard seeds.count >= Self.floor.seeds && Self.actions >= Self.floor.actions else { return }
    #expect(Self.exercised.filter { producing[$0] == nil } == [])
  }

  // §7.7 step 1.5: a clone 900 s fast replays a start by receipt, so its delete's born is unsourced, refused once, lowered.
  @Test func aReceiptReplayUnderSkewRecoversByLoweringTheSkewedBorn() async throws {
    let probe = ScopeRef.product("probe")
    let simulator = await Simulator(seed: 1, registry: try Corpus.probeRegistry(), phones: [.init("pb", account: "A", signedIn: true)],
                                    faults: false)
    let run = RecordID("run000000000000r")
    let start = Gesture(changes: [], command: Command(name: "probe.start", args: ["id": "run000000000000r", "startedAt": 1, "join": true]),
                        predict: [.create("run", id: .given(run), ["startedAt": 1])])
    let send = Simulator.Action.send(.deliver, PushFaults())
    let steps: [(Simulator.Action, Int)] = [
      (.pull(.deliver), 0), (.skew(ms: 900_000), 0), (.commit(probe, start), 0), (.commit(probe, Gesture(changes: [.delete("run", run)])), 0),
      (.clone, 0), (send, 0), (.pull(.deliver), 0), (send, 0), (.pull(.deliver), 0), (send, 1), (send, 1), (send, 1), (send, 1),
    ]
    for (action, phone) in steps { await simulator.perform(action, on: phone) }
    await simulator.quiesce()
    let report = simulator.report()
    #expect(report.violations == [])
    #expect(report.coverage["unsourced stamp lowered"] == 1)
  }

  @Test func aRunIsAPureFunctionOfItsSeed() async throws {
    let registry = try Corpus.probeRegistry()
    let first = await Simulator(seed: 7, registry: registry).run(actions: 150)
    let second = await Simulator(seed: 7, registry: registry).run(actions: 150)
    #expect(second.log == first.log)
    #expect(second.server == first.server)
    #expect(second.coverage == first.coverage)
  }

  // §11.2 property 3: one writer's plain intents, admitted by the model server; after each round's results and a pull to
  // the head, its drawn view is the server's rows, with the server's digests. Sixteen seeds of twelve rounds.
  @Test func propertyThree() async throws {
    let registry = try Corpus.probeRegistry()
    var compared = 0
    await withTaskGroup(of: (seed: UInt64, violations: [String], rows: Int).self) { group in
      for seed in 1...16 as ClosedRange<UInt64> {
        group.addTask {
          let simulator = await Simulator(seed: seed, registry: registry, phones: [.init("a1", account: "A", signedIn: true)], faults: false)
          let violations = await simulator.convergeByRounds(12)
          return (seed, violations, simulator.report().coverage["checked rows", default: 0])
        }
      }
      for await run in group {
        #expect(run.violations == [], "seed \(run.seed)")
        compared += run.rows
      }
    }
    #expect(compared > 1_000)
  }

  // The checks see a divergence: a server that lost a row its phones confirmed fails INV-6 and the digest check on each.
  @Test func theChecksSeeAPhoneThatHoldsWhatTheServerDoesNot() async throws {
    let simulator = await Simulator(seed: 3, registry: try Corpus.probeRegistry())
    #expect(await simulator.run(actions: 120).violations == [])
    var state = simulator.server.state
    let scope = try #require(state.rows.keys.filter { $0.text == "acct:A/probe" }.first)
    let lost = try #require(state.rows[scope]?.keys.sorted().first)
    state.rows[scope]?[lost] = nil
    simulator.server.restore(state, epoch: state.epoch)
    let violations = simulator.check()
    #expect(violations.contains { $0.hasPrefix("INV-6 a1 self/probe") })
    #expect(violations.contains { $0.hasPrefix("INV-6 a2 self/probe") })
  }

  // INV-2 watches every record with a life: a card, which is never revived, and a keyed day, which comes back only by a
  // put newer than its death, are both caught alive again at their old stamps.
  @Test func theChecksSeeARecordAliveAgainWithNoRevive() async throws {
    let simulator = await Simulator(
      seed: 1, registry: try Corpus.probeRegistry(), phones: [.init("a1", account: "A", signedIn: true)], faults: false)
    let send = Simulator.Action.send(.deliver, PushFaults())
    await simulator.perform(.commit(Self.probe, Gesture(changes: [.create("card", id: .given("card0001"), ["title": "One", "tier": "draft"])])), on: 0)
    await simulator.perform(.commit(Self.probe, Gesture(changes: [.put("day", Self.day, present: true, ["score": 3])])), on: 0)
    await simulator.perform(send, on: 0)
    let alive = simulator.server.state
    await simulator.perform(.commit(Self.probe, Gesture(changes: [.delete("card", "card0001")])), on: 0)
    await simulator.perform(.commit(Self.probe, Gesture(changes: [.put("day", Self.day, present: false)])), on: 0)
    await simulator.perform(send, on: 0)
    #expect(simulator.server.rows(Self.probe, of: "A") == [])
    simulator.server.restore(alive, epoch: simulator.server.state.epoch)
    await simulator.perform(.advance(ms: 1), on: 0)
    let resurrections = simulator.check().filter { $0.hasPrefix("INV-2") }
    #expect(resurrections.count == 2)
    #expect(resurrections.contains { $0.contains("card0001") })
    #expect(resurrections.contains { $0.contains("2026-09-01") })
  }

  // INV-3 holds a refused gesture to its content: a notice that kept its id and lost the card is caught.
  @Test func theChecksSeeANoticeThatLostWhatItHeld() async throws {
    let simulator = await Simulator(
      seed: 1, registry: try Corpus.probeRegistry(), phones: [.init("a1", account: "A", signedIn: true)], faults: false)
    await simulator.perform(.refuse(.invalid), on: 0)
    await simulator.perform(.commit(Self.probe, Gesture(changes: [.create("card", id: .given("card0001"), ["title": "Refused", "tier": "draft"])])), on: 0)
    await simulator.perform(.send(.deliver, PushFaults()), on: 0)
    let store = simulator.device(0).store
    let notice = try #require(try store.read { tx in try tx.replica(tx.activeReplica(), notices: true)?.notices.first })
    #expect(notice.content.deltas.map(\.key) == [RecordKey("card", "card0001")])
    _ = try store.write(.pullPage) { tx in
      let id = try tx.activeReplica()
      let emptied = Notice(id: notice.id, product: notice.product, scope: notice.scope, code: notice.code, detail: notice.detail,
                           content: NoticeContent(), at: notice.at)
      return Planned((), ReplicaBatch(writes: [.replica(id, .putNotice(emptied))]))
    }
    await simulator.quiesce()
    #expect(simulator.check().filter { $0.hasPrefix("INV-3") } == [
      "INV-3 a1: \(notice.id.dropFirst("notice:".count)) refused (refuse); its card card0001 is in no part of \(notice.id)",
    ])
  }

  // INV-7: a phone holding rows of a scope its account may not read is caught.
  @Test func theChecksSeeRowsOfATreeThePhoneMayNotRead() async throws {
    let simulator = await Simulator(seed: 5, registry: try Corpus.probeRegistry())
    #expect(await simulator.run(actions: 60).violations == [])
    let foreign = ScopeRef.tree("b_ffffffff")
    let store = simulator.device(2).store
    _ = try store.write(.pullPage) { tx in
      let row = try Row(json: ["t": "meta", "id": "meta", "f": ["title": ["Leaked", "1:0:r_server00001"]], "seq": 1, "rc": 1, "ru": 1])
      return Planned((), ReplicaBatch(writes: [.replica(try tx.activeReplica(), .putRow(foreign, row))]))
    }
    #expect(simulator.check().filter { $0.hasPrefix("INV-7") } == ["INV-7 b1 holds rows of tree/b_ffffffff, which B may not read"])
  }

  // A finished simulation frees its server: the push watcher holds the fleet weakly.
  @Test func aFinishedSimulationFreesItsServer() async throws {
    weak var server: ModelServerHandle?
    do {
      let simulator = await Simulator(seed: 1, registry: try Corpus.probeRegistry())
      _ = await simulator.run(actions: 20)
      server = simulator.server
    }
    #expect(server == nil)
  }

  static let probe = ScopeRef.product("probe")
  static let day = RecordID("2026-09-01")
}
