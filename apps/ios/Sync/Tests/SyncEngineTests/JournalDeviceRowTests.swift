import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncStore
import SyncTesting
import Testing

// Talk's mark (Journal Talk D-5) through the engine: the journal's device row `talkTake`, kept on this device alone. It
// rides in the gesture of the save beside it and never in a push, and a build whose registry declares no `talkTake` opens
// the store, carries the mark untouched and cannot write it.
struct JournalDeviceRowTests {
  static let scope = ScopeRef.product("journal")
  static let mark: JSON = ["day": "2026-11-28", "bytesBefore": 120, "pageDigest": "9dd9da01856b9b41",
                           "sessions": [["callId": "talkSessionOne-0000001", "bytesSaved": 48, "heardAt": 1_795_824_000_000]]]

  @Test func theTalkMarkStaysOnTheDeviceAndABuildThatKnowsNoTalkTakeCarriesIt() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "talk-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appending(path: "store.sqlite").path
    var source = try Corpus.registryFile("journal").asObject()
    var products = try source.member("products").asObject()
    var journal = try products.member("journal").asObject()
    var device = try journal.member("device").asObject()
    device["talkTake"] = nil
    journal["device"] = .object(device)
    products["journal"] = .object(journal)
    source["products"] = .object(products)
    let older = try Registry(json: .object(source))
    let mark = { (replica: any Replica) in try replica.read(Self.scope) { try $0.device("talkTake") } }

    let rig = try Rig(account: "A", registry: Registry(json: Corpus.registryFile("journal")), path: path)
    _ = try rig.engine.commit(Self.scope, Gesture(changes: [.write("journalState", "journalState", ["placeholder": "retired"])],
      local: [DeviceWrite(key: "talkTake", value: Self.mark)]))
    #expect(try mark(rig.engine) == Self.mark)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    let pushes = rig.transport.pushes
    #expect(pushes.map { $0.intents.map { $0.deltas.map { [$0.key.type] + $0.lattice.fields.keys.sorted() } } } == [[[["journalState", "placeholder"]]]])
    #expect(!pushes.contains { push in ["talkTake", "pageDigest", "talkSessionOne"].contains { push.json.jcsText.contains($0) } })

    let old = try Rig.engine(over: Store(path: path, registry: older), clock: rig.clock, random: rig.random, transport: rig.transport,
      tokens: rig.tokens, forkGuard: rig.forkGuard, connectivity: rig.connectivity, slicing: rig.slicing, drivesLoops: false, bindings: [],
      events: rig.events)
    #expect(try mark(old) == Self.mark)
    #expect(throws: CommitFailure.malformed("talkTake is not a device row of journal")) {
      try old.commit(Self.scope, Gesture(changes: [], local: [DeviceWrite(key: "talkTake", value: nil)]))
    }
    #expect(try mark(rig.relaunch()) == Self.mark)
  }
}
