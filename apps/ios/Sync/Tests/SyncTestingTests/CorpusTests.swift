import SyncAPI
import SyncCore
import SyncModelServer
import SyncTesting
import Testing

struct CorpusTests {
  // Once no entry touches a record, its confirmed row reads as the engine's own reader hands the record over.
  @Test func aConfirmedRowReadsAsTheEngineReaderHandsItOver() throws {
    let registry = try Corpus.probeRegistry()
    let scope = ScopeRef.product("probe")
    let phone = SteppedEngine(registry: registry, startMs: 1_800_000_000_000, account: "A", rules: ProbeServerRules())
    let tablet = phone.device()
    _ = try phone.replica.commit(scope, Gesture(changes: [.create("board", id: .given("b_0000000a"))]))
    _ = try phone.replica.commit(scope, Gesture(changes: [.create("card", id: .given("card0001"), ["title": "One", "tier": "draft"])]))
    phone.sync()
    let rows = try tablet.store.read { try $0.device(rows: true) }.activeReplica.confirmed[scope]?.all ?? []
    let read = try rows.map { row in try tablet.replica.read(scope) { try $0.stored(row.key.type, row.key.id) } }
    #expect(rows.map { Record(confirmed: $0, registry: registry) } == read)
    #expect(read.map { $0.map { "\($0.type) \($0.id) \($0.isVisible)" } } == ["board b_0000000a true", "card card0001 true"])
  }
}
