import Foundation
import Observation
import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import Testing

// §4.5: a view sees a commit one main-actor turn later, before the next frame. Budget: the change reaches the observers
// within one frame at 60 Hz, 16.7 ms, from the moment the store committed it: a commit returning, or a pull page's
// transaction committing. A screen of a session with 50 sets observes the sets view, which holds every set, and filters
// it; there is no view of one session's sets.
extension Benchmarks {
  @MainActor @Suite struct ViewRefresh {
    static let rounds = 100
    static let frameMs = 1_000.0 / 60

    @Test func afterACommit() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"))
        let session = try Self.sessionOfFifty(on: phone, history: history)
        let routines = phone.engine.records(Gym.scope, Gym.Types.routine)
        let sets = phone.engine.records(Gym.scope, Gym.Types.set)
        await phone.engine.settle()
        var routineRefresh = Samples("view refresh · routines list after the editor's save commits")
        var setRefresh = Samples("view refresh · a session of 50 sets after a set is logged")
        for round in 0..<Self.rounds {
          let routine = history.routines[round % history.routines.count]
          let renamed = "Renamed \(round)"
          routineRefresh.add(try await Self.untilNotified(routines) {
            try phone.commit(Gestures.editRoutine(routine, name: renamed, exercises: history.exercises, shift: round))
            return ContinuousClock.now
          })
          #expect(routines.records[routine]?.values["name"] == .string(renamed))
          let set = try phone.engine.mintID(Gym.Types.set)
          setRefresh.add(try await Self.untilNotified(sets) {
            try phone.commit(Gestures.logSet(in: session, of: history.exercises[3], id: .given(set), number: round))
            return ContinuousClock.now
          })
          #expect(sets.records[set] != nil)
          await phone.sync()
          await phone.engine.settle()
        }
        routineRefresh.report(p95Budget: Self.frameMs)
        setRefresh.report(p95Budget: Self.frameMs)
      }
    }

    // Another phone of the lifter logs a set; this phone's puller applies the page that carries it.
    @Test func afterAPullPage() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let times = TransactionTimes()
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"), crashPoints: times.crashPoints)
        let session = try Self.sessionOfFifty(on: phone, history: history)
        await phone.sync()
        await history.writer.sync()
        let sets = phone.engine.records(Gym.scope, Gym.Types.set)
        await phone.engine.settle()
        var refresh = Samples("view refresh · a session of 50 sets after a pull page carrying another phone's set")
        for round in 0..<Self.rounds {
          let set = try history.writer.engine.mintID(Gym.Types.set)
          try history.writer.commit(Gestures.logSet(in: session, of: history.exercises[4], id: .given(set), number: round))
          await history.writer.push()
          times.reset()
          refresh.add(try await Self.untilNotified(sets) {
            await phone.pull(only: [Gym.scope])
            guard let committed = times.firstCommit(of: .pullPage) else { throw BenchError("no page was applied") }
            return committed
          })
          #expect(sets.records[set] != nil)
          await phone.engine.settle()
        }
        await history.writer.pull()
        refresh.report(p95Budget: Self.frameMs)
      }
    }

    // A new session holding 50 sets, synced, so the screen under test shows 50.
    static func sessionOfFifty(on phone: Phone, history: GymHistory) throws -> RecordID {
      let session = try phone.engine.mintID(Gym.Types.session)
      var changes: [Change] = [.create(Gym.Types.session, id: .given(session))]
      for number in 0..<50 {
        changes.append(.create(Gym.Types.set, id: .given(try phone.engine.mintID(Gym.Types.set)),
                               GymHistory.setValues(session: session, exercise: history.exercises[number % 5], number: number)))
      }
      try phone.commit(Gesture(changes: changes))
      return session
    }

    // From the moment `act` answers to the moment the view's observers are told its records changed; the view holds the
    // new records once the main actor runs again.
    static func untilNotified(_ view: RecordsView, after act: () async throws -> ContinuousClock.Instant) async throws -> Duration {
      let (notified, notify) = AsyncStream<ContinuousClock.Instant>.makeStream()
      withObservationTracking { _ = view.records } onChange: {
        notify.yield(ContinuousClock.now)
        notify.finish()
      }
      let from = try await act()
      var iterator = notified.makeAsyncIterator()
      guard let at = await iterator.next() else { throw BenchError("the view was never told") }
      await Task.yield()
      return at - from
    }
  }
}
