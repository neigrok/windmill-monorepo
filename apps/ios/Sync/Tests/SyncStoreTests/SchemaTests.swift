import Foundation
import SyncAPI
import SyncCore
import SyncReplica
@testable import SyncStore
import SyncTesting
import Testing

// The schema makes impossible states unrepresentable: a batch that would store one is refused, and its transaction
// leaves the store as it was.

struct SchemaTests {
  static let probe = try! Corpus.probeRegistry()

  static func bound(_ id: String, _ account: String) -> ReplicaMeta { ReplicaMeta(replica: id, state: .bound, account: account) }

  static func entry(_ localId: String, order: Int64, state: EntryState, n: Int64? = nil, resultSeq: Int64? = nil) -> OutboxEntry {
    let stamp = try! Stamp("1000:0:r_aaaaaaaaaaaa")
    var entry = OutboxEntry(
      localId: localId, gestureId: localId, lineage: "A", scope: .product("probe"), state: state, commitOrder: order, releaseAt: 0,
      stamp: stamp, intent: Intent(n: n, scope: .product("probe"), deltas: [Delta(key: RecordKey("card", "card0001"))]))
    entry.resultSeq = resultSeq
    entry.resultEpoch = resultSeq.map { _ in "ep-1" }
    return entry
  }

  @Test(arguments: [
    ("two anon replicas", [StoreWrite.createReplica(ReplicaMeta(replica: "rp_2", state: .anon))]),
    ("two bound replicas", [.createReplica(bound("rp_2", "A")), .createReplica(bound("rp_3", "B"))]),
    ("a dormant replica beside a bound one of the same account",
     [.createReplica(bound("rp_2", "A")), .createReplica(ReplicaMeta(replica: "rp_3", state: .dormant, account: "A"))]),
    ("an anon replica with an account", [.replica("rp_1", .meta(ReplicaMeta(replica: "rp_1", state: .anon, account: "A")))]),
    ("a bound replica without an account", [.createReplica(ReplicaMeta(replica: "rp_2", state: .bound))]),
    ("a sent entry without n", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .sent)))]),
    ("a ready entry with n", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .ready, n: 1)))]),
    ("an acked entry without its result seq", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .acked, n: 1)))]),
    ("a sent entry with a result seq", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .sent, n: 1, resultSeq: 4)))]),
    ("two entries of one commit order", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .ready))),
                                         .replica("rp_1", .putEntry(entry("g2/0", order: 1, state: .ready)))]),
    ("two entries numbered alike", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .sent, n: 1))),
                                    .replica("rp_1", .putEntry(entry("g2/0", order: 2, state: .sent, n: 1)))]),
    ("a row of a replica the store does not hold", [.replica("rp_9", .putKnown(.tree("b_00000001"), .gone))]),
  ])
  func anImpossibleStateIsRefusedAndRolledBack(_ name: String, _ writes: [StoreWrite]) throws {
    let store = try Store.inMemory(registry: Self.probe)
    _ = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]]))
    let before = try store.read { try $0.device(rows: true).json }
    #expect(throws: (any Error).self, "\(name)") {
      try store.write(.commit) { _ in Planned((), ReplicaBatch(writes: writes)) }
    }
    #expect(try store.read { try $0.device(rows: true).json } == before)
  }

  @Test func aFileStoreRunsWALWithFullSynchronousWritesAndForeignKeys() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try Store(path: directory.appendingPathComponent("sync.sqlite").path, registry: Self.probe)
    #expect(try ["journal_mode", "synchronous", "foreign_keys"].map(store.pragma) == ["wal", "2", "1"])
  }
}
