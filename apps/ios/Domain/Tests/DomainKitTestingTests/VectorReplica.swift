import DomainKit
import DomainKitTesting
import Foundation
import SyncAPI
import SyncCore
import SyncReplica
import Synchronization

// The records a vector lists per view (§15.1), made `Record`s by the engine's own visibility rule (engine §7.6).
struct VectorRecords: Sendable {
  var drawn: [Record]
  var stored: [Record]

  init(drawn: JSON?, stored: JSON?, registry: Registry) throws {
    self.drawn = try VectorRecords.records(drawn, registry: registry)
    self.stored = try VectorRecords.records(stored, registry: registry)
  }

  static func records(_ rows: JSON?, registry: Registry) throws -> [Record] {
    try (rows?.asArray() ?? []).map { json in
      let row = try Row(json: json)
      return Record(
        type: row.key.type, id: row.key.id, life: row.lattice.life, born: row.lattice.born,
        values: row.lattice.fields.mapValues(\.value),
        texts: row.texts.mapValues { TextValue(text: $0.text, merged: $0.merged, pending: false) },
        serials: row.serials, rc: row.rc, ru: row.ru, isVisible: Visibility.of(row, registry: registry), isPending: false,
        isHeld: false)
    }
  }
}

// A reader over a vector's records: the folded record by id visible or not, and the visible records of a type in id
// order, as the engine's readers answer (ER-3, ER-12).
struct VectorReader: CommitContext {
  let records: VectorRecords
  let now: Int64

  func drawn(_ type: String, _ id: RecordID) throws -> Record? { find(records.drawn, type, id) }
  func stored(_ type: String, _ id: RecordID) throws -> Record? { find(records.stored, type, id) }
  func drawn(_ type: String) throws -> [Record] { visible(records.drawn, type) }
  func stored(_ type: String) throws -> [Record] { visible(records.stored, type) }

  func drawn(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    visible(records.drawn, type).filter { $0.values[field] == id.json }
  }

  func stored(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    visible(records.stored, type).filter { $0.values[field] == id.json }
  }

  func device(_ key: String) throws -> JSON? { nil }
  func firstPullComplete() throws -> Bool { true }

  func mintID(_ type: String) throws -> RecordID {
    throw CommitFailure.malformed("a vector mints no id")
  }

  func find(_ records: [Record], _ type: String, _ id: RecordID) -> Record? {
    records.first { $0.type == type && $0.id == id }
  }

  func visible(_ records: [Record], _ type: String) -> [Record] {
    records.filter { $0.type == type && $0.isVisible }.sorted { $0.id < $1.id }
  }
}

// A replica over a vector's records, which it never changes by itself. Its commits answer as the vector says: the
// receipt or refusal of `answer`, or `g<k>` for its k-th committed gesture; `failNextCommit` throws before committing,
// whether or not the body decides a gesture.
final class VectorReplica: Replica {
  struct State {
    var records: VectorRecords
    var answer: CommitOutcome?
    var failNext = false
    var gestures: [Gesture] = []
  }

  let now: Int64
  let state: Mutex<State>

  init(_ records: VectorRecords, now: Int64, answer: CommitOutcome? = nil) {
    self.now = now
    state = Mutex(State(records: records, answer: answer))
  }

  var records: VectorRecords {
    get { state.withLock(\.records) }
    set { state.withLock { $0.records = newValue } }
  }

  func failNextCommit() {
    state.withLock { $0.failNext = true }
  }

  var gestures: [Gesture] { state.withLock(\.gestures) }

  func commit<T>(_ scope: ScopeRef, _ body: (any CommitContext) throws -> (Gesture?, T)) throws -> (outcome: CommitOutcome?, value: T) {
    let (gesture, value) = try body(VectorReader(records: records, now: now))
    let (failing, answer, k) = state.withLock { state in
      defer { state.failNext = false }
      if let gesture, !state.failNext { state.gestures.append(gesture) }
      return (state.failNext, state.answer, state.gestures.count)
    }
    if failing { throw CommitFailure(.storeFailure, "the disk is full") }
    guard gesture != nil else { return (nil, value) }
    let receipt = CommitReceipt(gestureId: "g\(k)", stamp: .unset, localIds: ["g\(k)/0"], ids: [], releaseAt: nil, retired: [])
    return (answer ?? .committed(receipt), value)
  }

  func undo(_ gestureId: String) throws -> Bool { false }

  func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T {
    try body(VectorReader(records: records, now: now))
  }

  func mintID(_ type: String) throws -> RecordID {
    throw CommitFailure.malformed("a vector mints no id")
  }

  func physNow() throws -> Int64 { now }
}
