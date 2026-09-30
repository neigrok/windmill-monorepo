import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import Synchronization
import Testing

// §4.6: `commit` runs on the caller's thread, so its latency is what a tap costs the main thread. Budget: p95 8 ms
// uncontended, 50 ms while pull pages of PULL_PAGE_BYTES apply, chunk by chunk, or a push answer's results, batch by
// batch. Each benchmark runs on a phone on disk holding the whole 10 000-set history.
extension Benchmarks {
  @Suite struct CommitLatency {
    static let warmUp = 20
    static let rounds = 300
    static let uncontendedBudgetMs = 8.0
    static let contendedBudgetMs = 50.0

    // Online: the phone syncs after each round, so its outbox stands near empty, as it does with a network.
    @Test func uncontended() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"))
        let session = history.sessions[0], exercise = history.exercises[0]
        var logGiven = Samples("commit · log a set, id from the engine's mintID")
        var logMinted = Samples("commit · log a set, id minted by the commit")
        var logContext = Samples("commit · log a set, id from the commit context's mintID (the kit's path)")
        var edit = Samples("commit · edit a routine, name and entries guarded")
        var heldDelete = Samples("commit · a held delete of a set")
        for round in 0..<(Self.warmUp + Self.rounds) {
          let set = try phone.engine.mintID(Gym.Types.set)
          try logGiven.time { _ = try phone.commit(Gestures.logSet(in: session, of: exercise, id: .given(set))) }
          try logMinted.time { _ = try phone.commit(Gestures.logSet(in: session, of: exercise, id: .minted)) }
          try logContext.time {
            _ = try phone.engine.commit(Gym.scope) { context in
              (Gestures.logSet(in: session, of: exercise, id: .given(try context.mintID(Gym.Types.set))), ())
            }
          }
          let routine = history.routines[round % history.routines.count]
          try edit.time {
            _ = try phone.commit(Gestures.editRoutine(routine, name: "Routine \(round)", exercises: history.exercises, shift: round))
          }
          let receipt = try heldDelete.time { try phone.commit(Gestures.heldDelete(set)) }
          #expect(try phone.engine.undo(receipt.gestureId))
          await phone.sync()
        }
        for samples in [logGiven, logMinted, logContext, edit, heldDelete] {
          samples.afterWarmUp(Self.warmUp).report(p95Budget: Self.uncontendedBudgetMs)
        }
      }
    }

    // Offline, as in a gym with no signal: nothing is sent, so the outbox grows by one entry a set, to 300.
    @Test func offline() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"))
        phone.keys.connectivity.set(online: false)
        var first = Samples("commit · log a set offline, outbox of 0–99 entries")
        var last = Samples("commit · log a set offline, outbox of 200–299 entries")
        for round in 0..<Self.rounds {
          let id = try phone.engine.mintID(Gym.Types.set)
          let gesture = Gestures.logSet(in: history.sessions[1], of: history.exercises[1], id: .given(id), number: round)
          switch round {
          case ..<100: try first.time { _ = try phone.commit(gesture) }
          case 200...: try last.time { _ = try phone.commit(gesture) }
          default: try phone.commit(gesture)
          }
        }
        first.report(p95Budget: Self.uncontendedBudgetMs)
        last.report(p95Budget: Self.uncontendedBudgetMs)
      }
    }

    // While the phone boots its gym scope again after three epoch changes (a server restored from backup), page by page,
    // each page of up to PULL_PAGE_BYTES in chunks of rows, and the sweep deleting what each swap replaced. The server's
    // epoch is put back after, so later benchmarks start from it.
    @Test func contendedByPullPages() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let times = TransactionTimes()
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"), crashPoints: times.crashPoints)
        let server = history.network.server
        let original = server.state.epoch
        times.reset()
        let contended = try await Self.setsLogged(on: phone, history: history, as: "commit · log a set while pull pages apply") {
          for epoch in 2...4 {
            server.restore(server.state, epoch: "\(original)-bench-\(epoch)")
            await phone.pull()
          }
        }
        server.restore(server.state, epoch: original)
        #expect(try phone.firstPullComplete(Gym.scope))
        contended.report(p95Budget: Self.contendedBudgetMs)
        times.reportEachKind("while booting again beside commits")
      }
    }

    // While the phone sends a workout logged offline, 100 sets, in the two pushes that carry it (commits made meanwhile
    // ride in the second): a push answer's results are recorded in batches, each one transaction.
    @Test func contendedByAPushAnswer() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let times = TransactionTimes()
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"), crashPoints: times.crashPoints)
        phone.keys.connectivity.set(online: false)
        for number in 0..<100 {
          try phone.commit(Gestures.logSet(in: history.sessions[3], of: history.exercises[3], id: .given(try phone.engine.mintID(Gym.Types.set)),
                                           number: number))
        }
        phone.keys.connectivity.set(online: true)
        times.reset()
        let contended = try await Self.setsLogged(on: phone, history: history, as: "commit · log a set while a push answer's results apply") {
          for _ in 0..<2 { _ = await phone.engine.sender.step() }
        }
        await phone.sync()
        contended.report(p95Budget: Self.contendedBudgetMs)
        times.reportEachKind("while sending the offline workout beside commits")
      }
    }

    // A set logged every 2 ms, each commit timed, until `writing` ends; at least one.
    static func setsLogged(on phone: Phone, history: GymHistory, as measure: String,
                           while writing: @escaping @Sendable () async -> Void) async throws -> Samples {
      let busy = Atomic(true)
      let writer = Task {
        await writing()
        busy.store(false, ordering: .releasing)
      }
      var samples = Samples(measure)
      repeat {
        let gesture = Gestures.logSet(in: history.sessions[2], of: history.exercises[2], id: .given(try phone.engine.mintID(Gym.Types.set)),
                                      number: samples.ms.count)
        try samples.time { _ = try phone.commit(gesture) }
        try await Task.sleep(for: .milliseconds(2))
      } while busy.load(ordering: .acquiring)
      await writer.value
      return samples
    }
  }
}
