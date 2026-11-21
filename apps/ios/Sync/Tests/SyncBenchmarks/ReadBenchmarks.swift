import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// §7.6: a read runs on the caller's thread and a gesture makes about ten, so what a read costs is what a tap waits for.
// Each kind of read a domain makes is timed on a phone of the probe product, on disk and in memory, beside one act opted
// into Undo and not released (§7.3) that created 0, 120 or 500 records: while the act's entry is still queued, and once
// it has landed and only the journal holds the act. Beside them, an act that makes ten reads and one write.
extension Benchmarks {
  @Suite struct Reads {
    static let scope = ScopeRef.product("probe")
    static let warmUp = 10
    static let rounds = 100
    static let actRounds = 20

    @Test(arguments: ["disk", "memory"])
    func besideAJournaledAct(_ storage: String) async throws {
      let registry = try Corpus.probeRegistry()
      for planted in [0, 120, 500] {
        try await Bench.inDirectory { directory in
          let network = SimNetwork(server: ModelServer(registry: registry, rules: ProbeServerRules(), state: ServerState(epoch: "ep-1")),
                                   clock: SystemClock())
          let phone = storage == "disk"
            ? try Phone.onDisk(directory.appending(path: "sync.sqlite"), registry: registry, transport: network)
            : try Phone(store: Store.inMemory(registry: registry), transport: network)
          try await phone.signIn("reader", token: network.server.token(for: "reader"))

          // What the reads name, there before anything is journaled: a day, three cards, a device row, and a spent id as
          // a pull leaves one.
          let standing = RecordID("2026-01-01"), spent = RecordID("2026-02-01")
          let cards: [Change] = ["One", "Two", "Three"].map { (title: String) -> Change in .create("card", ["title": .string(title)]) }
          let day: [Change] = [.put("day", standing, present: true, ["score": 1])]
          try phone.commit(Gesture(changes: day + cards, local: [DeviceWrite(key: "rack", value: ["slot": 2])]), in: Self.scope)
          await phone.sync()
          _ = try phone.store.write(.pullPage) { tx in
            var replica = try tx.replica(tx.activeReplica(), reads: [Self.scope: RowSelection()])!
            replica.apply(.putSpent(Self.scope, SpentID(key: RecordKey("day", spent), born: try Stamp("1000:0:r_aaaaaaaaaaaa"), seq: 3)))
            return Planned((), replica.batch)
          }
          let reads: [(name: String, read: (any ScopeReader) throws -> Void)] = [
            ("a record by id", { _ = try $0.drawn("day", standing) }),
            ("a list of a type", { _ = try $0.drawn("card") }),
            ("a confirmed row", { _ = try $0.confirmed("day", standing) }),
            ("spentSeq", { _ = try $0.spentSeq("day", spent) }),
            ("spentBorn", { _ = try $0.spentBorn("day", spent) }),
            ("a device row", { _ = try $0.device("rack") }),
            ("firstPullComplete", { _ = try $0.firstPullComplete() }),
          ]
          let stands: [Bool] = try phone.engine.read(Self.scope) { reader in
            [try reader.drawn("day", standing)?.values["score"] == 1, try reader.drawn("card").count == 3,
             try reader.confirmed("day", standing)?.seq != nil, try reader.spentSeq("day", spent) != nil,
             try reader.spentBorn("day", spent) != nil, try reader.device("rack") == ["slot": 2], try reader.firstPullComplete()]
          }
          guard stands == Array(repeating: true, count: reads.count) else { throw BenchError("the phone does not hold what the reads name: \(stands)") }

          // Each read of `kinds` in turn, a round after a round, each a call of the engine's reader of its own.
          let time = { (state: String, kinds: [(name: String, read: (any ScopeReader) throws -> Void)]) throws -> Void in
            var samples: [Samples] = kinds.map { Samples("read · \($0.name) · \(storage), \(state)") }
            for _ in 0..<(Self.warmUp + Self.rounds) {
              for (index, kind) in kinds.enumerated() { try samples[index].time { try phone.engine.read(Self.scope, kind.read) } }
            }
            for taken in samples { taken.afterWarmUp(Self.warmUp).report() }
          }

          var state = "nothing journaled"
          if planted > 0 {
            let ids: [RecordID] = (0..<planted).map { RecordID(String(format: "%04d-%02d-%02d", 3000 + $0 / 100, 1 + $0 / 10 % 10, 1 + $0 % 10)) }
            let recipes: [ActUndoRecipe] = ids.map { .createdRecord(restoreCommand: "probe.restore", record: RecordAddress(scope: Self.scope, key: RecordKey("day", $0))) }
            let act = try phone.engine.commitAct({ _ in (ActRequest(scopes: [Self.scope], undo: ActUndo(segments: [ActUndo.Segment(index: 0, recipes: recipes)])), ()) },
                                                 segment: { _, _, _ in
              Gesture(changes: ids.enumerated().map { index, id in .put("day", id, present: true, ["score": JSON(index)]) })
            })
            guard case .committed? = act.outcome else { throw BenchError("the act of \(planted) records did not commit") }
            let queued = try phone.store.read { tx in try tx.replica(tx.activeReplica()) }
            guard queued?.outbox.count == 1, queued?.journal.acts.map(\.sourceEntries.count) == [1],
                  queued?.journal.acts.first?.sourceEntries.first?.recipes.count == planted else {
              throw BenchError("the act of \(planted) records is not one queued entry the journal names")
            }
            try time("\(planted) journaled, its entry queued", reads + [("a record the act created", { _ = try $0.drawn("day", ids[0]) })])
            await phone.sync()
            let landed = try phone.store.read { tx in try tx.replica(tx.activeReplica()) }
            guard landed?.outbox.isEmpty == true, landed?.journal.acts.first?.sourceEntries.first?.attempts.count == 1 else {
              throw BenchError("the act of \(planted) records did not land with its receipt journaled")
            }
            state = "\(planted) journaled, landed"
          }
          try time(state, reads)

          // An act as a domain runs one: ten reads through its context, then one write; the phone syncs after each, so
          // its outbox stands empty.
          var tenReads = Samples("act · its ten reads · \(storage), \(state)")
          var whole = Samples("act · ten reads and one write · \(storage), \(state)")
          for round in 0..<(Self.warmUp + Self.actRounds) {
            var read = Duration.zero
            let began = ContinuousClock.now
            let act = try phone.engine.commitAct({ context in
              let from = ContinuousClock.now
              for index in 0..<10 { try context.inScope(Self.scope, reads[index % reads.count].read) }
              read = ContinuousClock.now - from
              return (ActRequest(scopes: [Self.scope]), ())
            }, segment: { _, _, _ in Gesture(changes: [.put("day", standing, present: true, ["score": JSON(round)])]) })
            whole.add(ContinuousClock.now - began)
            tenReads.add(read)
            guard case .committed? = act.outcome else { throw BenchError("the act of ten reads did not commit") }
            await phone.sync()
          }
          tenReads.afterWarmUp(Self.warmUp).report()
          whole.afterWarmUp(Self.warmUp).report()
        }
      }
    }
  }
}
