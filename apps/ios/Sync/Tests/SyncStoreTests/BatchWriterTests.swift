import Foundation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The batch writer keeps the ref index (ER-12) a function of the rows: after any sequence of batches, and after a
// registry-version change, it equals its recomputation from the rows.

struct BatchWriterTests {
  static let probe = try! Corpus.probeRegistry()
  static let scope = ScopeRef.product("probe")

  // A lap naming one of three runs, or none; a run; each at a seq.
  static func row(_ random: inout SeededRandom, seq: Int64) -> Row {
    let stamp = try! Stamp("\(seq):0:r_aaaaaaaaaaaa")
    let id = RecordID("lap0000\(Int.random(in: 1...6, using: &random))")
    var fields = ["weight": Register(.number(JSON.Number(10)!), stamp)]
    if random.chance(0.8) { fields["runId"] = Register(.string("run0000\(Int.random(in: 1...3, using: &random))"), stamp) }
    if random.chance(0.2) {
      return Row(key: RecordKey("run", RecordID("run0000\(Int.random(in: 1...3, using: &random))")),
                 lattice: Lattice(life: Life(.alive, stamp), born: stamp), seq: seq, rc: seq, ru: seq)
    }
    return Row(key: RecordKey("lap", id), lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: fields), seq: seq, rc: seq, ru: seq)
  }

  // Row puts and deletes, confirmed and staged, a staging begun, swapped or dropped, a scope forgotten, a purge and a
  // rename: every write that touches rows.
  static func batch(_ random: inout SeededRandom, replica: inout String, seq: inout Int64) -> [StoreWrite] {
    (0..<Int.random(in: 1...6, using: &random)).map { _ -> StoreWrite in
      seq += 1
      let write: ReplicaWrite = switch Int.random(in: 0..<10, using: &random) {
      case 0, 1, 2: .putRow(scope, row(&random, seq: seq))
      case 3: .deleteRow(scope, row(&random, seq: seq).key)
      case 4: .beginStaging(scope)
      case 5: .putStagedRow(scope, row(&random, seq: seq))
      case 6: .swapStaging(scope)
      case 7: random.chance(0.5) ? .dropStaging(scope) : .deleteStagedRow(scope, row(&random, seq: seq).key)
      case 8: random.chance(0.5) ? .forgetScope(scope) : .purgeCaches
      default: .rename(to: "rp_\(seq)")
      }
      defer { if case .rename(let id) = write { replica = id } }
      return .replica(replica, write)
    }
  }

  @Test func theRefIndexEqualsItsRecomputationAfterAnyBatches() throws {
    var random = SeededRandom.fromEnvironment()
    let store = try Store.inMemory(registry: Self.probe)
    var replica = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    var seq: Int64 = 0
    for round in 0..<300 {
      let writes = [.replica(replica, .putCursor(Self.scope, CursorRecord()))] + Self.batch(&random, replica: &replica, seq: &seq)
      _ = try? store.write(.pullPage) { _ in Planned((), ReplicaBatch(writes: writes)) }
      let index = try store.read { try $0.refIndex() }
      #expect(index.stored == index.expected, "seed \(random.seed), round \(round)")
    }
  }

  // Rows written under one registry name a field it does not know; a registry that makes it a ref field indexes them
  // when the store opens.
  @Test func aRegistryVersionChangeRebuildsTheIndexAtOpen() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("sync.sqlite").path
    let stamp = try Stamp("5:0:r_aaaaaaaaaaaa")
    let card = Row(key: RecordKey("card", "card0001"),
                   lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: ["owner": Register("run00001", stamp)]), seq: 5, rc: 5, ru: 5)

    let before = try Store(path: path, registry: Self.probe)
    let replica = try before.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    _ = try before.write(.pullPage) { _ in Planned((), ReplicaBatch(writes: [.replica(replica, .putRow(Self.scope, card))])) }
    #expect(try before.read { try $0.referencing(replica, in: Self.scope, type: "lap", field: "runId", target: "run00001") } == [])

    var file = try Corpus.probeRegistryFile().asObject()
    file["version"] = 2
    var types = try file.member("types").asArray()
    let index = try #require(types.firstIndex { $0["type"] == "card" })
    var cardType = try types[index].asObject()
    var fields = try cardType.member("fields").asObject()
    fields["owner"] = ["kind": "lww", "writer": "client", "ref": "run"]
    cardType["fields"] = .object(fields)
    types[index] = .object(cardType)
    file["types"] = .array(types)
    let after = try Store(path: path, registry: try Registry(json: .object(file)))
    #expect(try after.read { try $0.referencing(replica, in: Self.scope, type: "card", field: "owner", target: "run00001") }
      == [RecordKey("card", "card0001")])
    let rebuilt = try after.read { try $0.refIndex() }
    #expect(rebuilt.stored == rebuilt.expected)
  }

  @Test func anIndexedReadOfAFieldThatIsNotARefThrows() throws {
    let store = try Store.inMemory(registry: Self.probe)
    let replica = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    #expect(throws: StoreError.notARefField(type: "lap", field: "weight")) {
      try store.read { try $0.referencing(replica, in: Self.scope, type: "lap", field: "weight", target: "run00001") }
    }
  }
}
