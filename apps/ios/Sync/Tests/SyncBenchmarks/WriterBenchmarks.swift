import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import SyncTesting
import Testing

// §2.5 the writer, which a commit waits for: each benchmark on a phone on disk holding the whole 10 000-set history.
extension Benchmarks {
  @Suite struct Writer {
    static let warmUp = 10
    static let rounds = 100
    static let unsent = 300

    // Another phone's set reaches this one by a live frame applied inline, beside an empty outbox and then beside 300 unsent sets.
    @Test func aLiveFrameBesideAnUnsentOutbox() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"))
        guard case .open = await phone.engine.live.step() else { throw BenchError("the live socket did not open") }
        let empty = try await Self.frames(on: phone, history: history, as: "transaction · a live frame applied inline, beside an empty outbox")
        for number in 0..<Self.unsent {
          try phone.commit(Gestures.logSet(in: history.sessions[5], of: history.exercises[5], id: .minted, number: number))
        }
        let unsent = try await Self.frames(on: phone, history: history, as: "transaction · a live frame applied inline, beside 300 unsent entries")
        empty.report(p95Budget: Double(Constants.writerSliceMs))
        unsent.report(p95Budget: Double(Constants.writerSliceMs))
      }
    }

    // Each round, a set the other phone logs and pushes, and the puller's step that applies the frame bringing it.
    static func frames(on phone: Phone, history: GymHistory, as measure: String) async throws -> Samples {
      var frames = Samples(measure)
      for round in 0..<(Self.warmUp + Self.rounds) {
        try history.writer.commit(Gestures.logSet(in: history.sessions[6], of: history.exercises[6], id: .minted, number: round))
        await history.writer.push()
        guard (await phone.engine.live.connection as? FakeLiveConnection)?.canReceive == true, await phone.engine.live.receiveNext() else {
          throw BenchError("no frame reached the phone")
        }
        let step = await frames.time { await phone.engine.puller.step() }
        guard step == .frame(Gym.scope, .applied) else { throw BenchError("the frame was not applied inline: \(step)") }
      }
      return frames.afterWarmUp(Self.warmUp)
    }
  }
}
