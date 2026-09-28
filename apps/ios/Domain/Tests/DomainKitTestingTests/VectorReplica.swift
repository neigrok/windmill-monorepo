import DomainKitTesting
import SyncAPI
import SyncCore
import Synchronization

// A replica over a vector's records, which it never changes by itself, read in each call's scope as the engine reads it.
// Its commits answer as the vector says: the receipt or refusal of `answer`, or `g<k>` for its k-th committed gesture;
// `failNextCommit` throws before committing, whether or not the body decides a gesture.
final class VectorReplica: Replica {
  struct State {
    var records: VectorRecords
    var answer: CommitOutcome?
    var failNext = false
    var gestures: [Gesture] = []
  }

  let now: Int64
  let registry: Registry
  let state: Mutex<State>

  init(_ records: VectorRecords, now: Int64, registry: Registry, answer: CommitOutcome? = nil) {
    self.now = now
    self.registry = registry
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
    let (gesture, value) = try body(VectorReader(records: records, now: now, scope: (scope, registry)))
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
    try body(VectorReader(records: records, now: now, scope: (scope, registry)))
  }

  func mintID(_ type: String) throws -> RecordID {
    throw CommitFailure.malformed("a vector mints no id")
  }

  func physNow() throws -> Int64 { now }

  func dismissNotice(_ id: String) throws {
    throw ContractError("a vector's commit writes no notice, and \(id) was dismissed")
  }
}
