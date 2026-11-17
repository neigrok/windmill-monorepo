import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

extension Benchmarks {
  @Suite(.enabled(if: ProcessInfo.processInfo.environment["SYNC_ROADMAP_SCALE_FIXTURES"] != nil,
                 "SYNC_ROADMAP_SCALE_FIXTURES names the generated probe fixtures"))
  struct RoadmapScale {
    @Test func pendingAdoptionPlan() throws {
      let directory = try #require(ProcessInfo.processInfo.environment["SYNC_ROADMAP_SCALE_FIXTURES"])
      let file = URL(fileURLWithPath: directory).appendingPathComponent("pending-entries.json")
      let entries = try JSON(parsing: [UInt8](Data(contentsOf: file))).asArray().map(OutboxEntry.init(json:))
      var device = LoadedDevice(meta: DeviceMeta(), active: "rp_scale", replicas: [
        LoadedReplica(meta: ReplicaMeta(replica: "rp_scale", state: .anon), outbox: entries, wholeScopes: true),
      ])
      let lifecycle = try ReplicaLifecycle(registry: Corpus.probeRegistry())
      let identities = try QueuedIdentities(["ids": []])
      let began = ContinuousClock.now
      let result = try lifecycle.signIn(&device, account: "A", holdsRecords: [:], decisions: [:], counted: [:], identities: identities)
      let elapsed = Bench.ms(ContinuousClock.now - began)
      let expected = entries.map { entry in var adopted = entry; adopted.lineage = "A"; return adopted }
      #expect(result == SignIn(complete: true, due: []))
      #expect(device.activeReplica.outbox == expected)
      #expect(device.batch.writes.compactMap { write -> OutboxEntry? in
        if case .replica(_, .putEntry(let entry)) = write { return entry }
        return nil
      } == expected)
      Bench.report("roadmap scale · pending · adoption plan", [("ms", String(elapsed)), ("entries", String(entries.count)),
        ("coverage", "pure lifecycle plan; database writes excluded"),
        ("sourceHead", ProcessInfo.processInfo.environment["SYNC_BENCH_SOURCE_HEAD"] ?? "unspecified")])
    }

    @Test(arguments: ["large", "many", "pending"])
    func deviceCopy(_ scenario: String) async throws {
      let directory = try #require(ProcessInfo.processInfo.environment["SYNC_ROADMAP_SCALE_FIXTURES"])
      let manifest = try JSON(parsing: [UInt8](Data(contentsOf: URL(fileURLWithPath: directory).appendingPathComponent("manifest.json"))))
      let expected = try Int(manifest.member("scenarios").member(scenario).member("deviceRecords").asInteger())
      let pendingCount = try Int(manifest.member("scenarios").member(scenario).member("pendingEntries").asInteger())
      let boards = try Int(manifest.member("scenarios").member(scenario).member("boards").asInteger())
      let sourceHead = ProcessInfo.processInfo.environment["SYNC_BENCH_SOURCE_HEAD"] ?? "unspecified"
      let registry = try Corpus.probeRegistry()
      let source = URL(fileURLWithPath: directory).appendingPathComponent("\(scenario).json")
      let state = try ServerState(json: JSON(parsing: [UInt8](Data(contentsOf: source))))
      let network = SimNetwork(server: ModelServer(registry: registry, rules: ProbeServerRules(), state: state), clock: SystemClock())
      let scope = try ScopeRef(json: manifest.member("tree"))
      try await Bench.inDirectory { directory in
        let path = directory.appending(path: "roadmap.sqlite")
        let keys = Phone.Keys()
        var phone = try Phone.onDisk(path, registry: registry, transport: network, keys: keys)
        if scenario == "pending" {
          await phone.engine.start()
          let file = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["SYNC_ROADMAP_SCALE_FIXTURES"]))
            .appendingPathComponent("pending-entries.json")
          let entries = try JSON(parsing: [UInt8](Data(contentsOf: file))).asArray().map(OutboxEntry.init(json:))
          _ = try phone.store.write(.commit) { tx in
            let id = try tx.activeReplica()
            return Planned((), ReplicaBatch(writes: entries.map { .replica(id, .putEntry($0)) }))
          }
        } else {
          try await phone.signIn("A", token: network.server.token(for: "A"))
          let started = ContinuousClock.now
          let rounds = await phone.pull()
          Bench.report("roadmap scale · \(scenario) · first pull", [
            ("ms", String(Bench.ms(ContinuousClock.now - started))), ("rounds", String(rounds.count)),
            ("transport", "in-process model server"), ("storage", "SQLite WAL FULL"),
            ("coverage", "all owned product, tree and overlay scopes"), ("sourceHead", sourceHead),
          ])
          #expect(try phone.firstPullComplete(scope))
          if scenario == "many" {
            #expect(try phone.engine.read(.product("probe")) { try $0.drawn("board").count } == boards)
            for index in 1...boards {
              let tree = ScopeRef.tree(String(format: "b_%08x", index))
              #expect(try phone.firstPullComplete(tree))
              #expect(try phone.engine.read(tree) { try $0.drawn("tag").count } == 1)
            }
          }
        }

        let opened = ContinuousClock.now
        phone = try Phone.onDisk(path, registry: registry, transport: network, keys: keys)
        let openMs = Bench.ms(ContinuousClock.now - opened)
        let read = ContinuousClock.now
        let count = try phone.engine.read(scope) { reader in
          try reader.drawn("tag").count + reader.drawn("link").count
        }
        let readMs = Bench.ms(ContinuousClock.now - read)
        #expect(count == expected)
        Bench.report("roadmap scale · \(scenario) · open", [("ms", String(openMs)), ("records", String(count)),
          ("storage", "SQLite WAL FULL"), ("cache", "same-process reopen; OS pages may be warm"), ("sourceHead", sourceHead)])
        Bench.report("roadmap scale · \(scenario) · read", [("ms", String(readMs)), ("records", String(count)), ("sourceHead", sourceHead)])

        let edited = ContinuousClock.now
        _ = try phone.commit(Gesture(changes: [.update("tag", "step0", ["label": "Edited"])]), in: scope)
        Bench.report("roadmap scale · \(scenario) · gesture", [("ms", String(Bench.ms(ContinuousClock.now - edited))), ("sourceHead", sourceHead)])
        #expect(try phone.engine.read(scope) { try $0.drawn("tag", "step0")?.values["label"] } == "Edited")

        let signed = ContinuousClock.now
        try await phone.signIn("A", token: network.server.token(for: "A"))
        Bench.report("roadmap scale · \(scenario) · sign in", [("ms", String(Bench.ms(ContinuousClock.now - signed))), ("sourceHead", sourceHead)])
        if scenario == "pending" {
          let before = try phone.store.read { try $0.replica($0.activeReplica())?.outbox.count }
          let started = ContinuousClock.now
          let rounds = await phone.pull(only: [.product("probe")])
          Bench.report("roadmap scale · \(scenario) · first pull", [
            ("ms", String(Bench.ms(ContinuousClock.now - started))), ("rounds", String(rounds.count)),
            ("transport", "in-process model server"), ("storage", "SQLite WAL FULL"),
            ("coverage", "empty account product after adoption; queued new tree remains local"), ("sourceHead", sourceHead),
          ])
          #expect(try phone.firstPullComplete(.product("probe")))
          #expect(try phone.store.read { try $0.replica($0.activeReplica())?.outbox.count } == before)
          #expect(try !phone.firstPullComplete(scope))
        }
        #expect(try phone.engine.read(scope) { try $0.drawn("tag").count + $0.drawn("link").count } == expected)
        let pending = try phone.store.read { try $0.replica($0.activeReplica())?.outbox.count }
        #expect(pending == pendingCount + 1)
      }
    }
  }
}
