import SyncAPI
import SyncCore
import SyncReplica
@testable import SyncStore
import SyncTesting
import Testing

// The store's queries answer by bytes, as SQLite compares text: an index row whose target is a canonically equivalent
// look-alike ("\u{E9}" and "e\u{301}") of the value its row holds is another line than the one the row expects.

struct RepositoriesTests {
  @Test func theRefIndexTellsALookAlikeTargetFromTheOneItsRowNames() throws {
    let store = try Store.inMemory(registry: try Corpus.probeRegistry())
    let replica = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    let stamp = try Stamp("5:0:r_aaaaaaaaaaaa")
    let lap = Row(key: RecordKey("lap", "lap00001"),
                  lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: ["runId": Register("run\u{E9}", stamp)]), seq: 5)
    _ = try store.write(.pullPage) { _ in Planned((), ReplicaBatch(writes: [.replica(replica, .putRow(.product("probe"), lap))])) }
    try store.writer.write { db in try db.execute(sql: "UPDATE confirmed_ref SET target = ?", arguments: [RecordID("rune\u{301}").text]) }
    let index = try store.read { try $0.refIndex() }
    #expect(index.stored != index.expected)
  }
}
