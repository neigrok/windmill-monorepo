import SyncAPI
import SyncCore
@testable import SyncEngine
import SyncReplica
import SyncStore
import Synchronization
import Testing

struct WriterTimingTests {
  final class OriginalFailure: Error {}

  @Test func observesSuccessAndRollbackAfterTheWriterIsReleased() throws {
    let timings = Mutex<[(WriterTiming, Bool)]>([])
    let engine = Mutex<SyncEngine?>(nil)
    let failCommit = Mutex(false)
    let original = OriginalFailure()
    let rig = try Rig(crashPoints: CrashPoints { point in
      if case .beforeCommit(.commit) = point, failCommit.withLock({ $0 }) { throw original }
    }, writerObserver: { timing in
      let released = engine.withLock { $0 }?.core.writers.state.withLock { !$0.busy } ?? true
      timings.withLock { $0.append((timing, released)) }
    })
    engine.withLock { $0 = rig.engine }
    timings.withLock { $0.removeAll() }

    let committed = try rig.engine.commit(Rig.scope, Gesture(changes: [
      .create("card", id: .given("card0001"), ["title": "One"]),
    ]))
    guard case .committed = committed else { Issue.record("the initial gesture was refused"); return }
    let before = try rig.store.read { try $0.device(rows: true).json }
    failCommit.withLock { $0 = true }
    do {
      _ = try rig.engine.core.write { store, instance in
        try store.commit(Gesture(changes: [.create("card", id: .given("card0002"), ["title": "Two"])]),
                         in: Rig.scope, instance: instance, identities: rig.engine.core.identities)
      }
      Issue.record("the storage failure was swallowed")
    } catch {
      #expect((error as? OriginalFailure) === original)
    }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
    let samples = timings.withLock { $0 }
    #expect(samples.map { $0.0.operation.rawValue } == ["commit", "engine"])
    #expect(samples.map { $0.0.outcome.rawValue } == ["success", "failure"])
    #expect(samples.map { $0.1 } == [true, true])
    #expect(samples.allSatisfy { $0.0.queue >= .zero && $0.0.held >= .zero })
  }
}
