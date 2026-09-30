import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import Testing

// §4.5: a view sees a commit one main-actor turn later, before the next frame. Budget: the change reaches the observers
// within one frame at 60 Hz, 16.7 ms, from the moment the store committed it: a commit returning, or a pull page's
// transaction committing. The screen of a session observes its sets through a view narrowed by `sessionId` (ER-12); a
// set logged in another session reaches that view only as one read of the set, which tells it nothing, and views of
// other types not at all. A view's first load runs beside the refreshes, so none waits behind it.
extension Benchmarks {
  @MainActor @Suite struct ViewRefresh {
    static let rounds = 100
    static let frameMs = 1_000.0 / 60

    @Test func afterACommit() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"))
        let session = try Self.sessionOfFifty(on: phone, history: history)
        let routines = try phone.engine.records(Gym.scope, Gym.Types.routine)
        let sets = try phone.engine.records(Gym.scope, Gym.Types.set, where: "sessionId", is: session)
        await phone.engine.settle()
        var routineRefresh = Samples("view refresh · routines list after the editor's save commits")
        var setRefresh = Samples("view refresh · a session's 50 sets (narrowed view) after a set is logged in it")
        var elsewhere = Samples("view refresh · a session's 50 sets (narrowed view) after a set is logged in another session, until the views settle")
        for round in 0..<Self.rounds {
          let routine = history.routines[round % history.routines.count]
          let renamed = "Renamed \(round)"
          routineRefresh.add(try await ViewTimes.untilNotified(routines) {
            try phone.commit(Gestures.editRoutine(routine, name: renamed, exercises: history.exercises, shift: round))
            return ContinuousClock.now
          })
          #expect(Self.loaded(routines)?.record(routine)?.values["name"] == .string(renamed))
          let set = try phone.engine.mintID(Gym.Types.set)
          setRefresh.add(try await ViewTimes.untilNotified(sets) {
            try phone.commit(Gestures.logSet(in: session, of: history.exercises[3], id: .given(set), number: round))
            return ContinuousClock.now
          })
          #expect(Self.loaded(sets)?.record(set) != nil)
          let shown = sets.state
          try phone.commit(Gestures.logSet(in: history.sessions[round], of: history.exercises[3], id: .minted, number: round))
          let committed = ContinuousClock.now
          await phone.engine.settle()
          elsewhere.add(ContinuousClock.now - committed)
          #expect(sets.state == shown)
          await phone.sync()
          await phone.engine.settle()
        }
        #expect(Self.loaded(sets)?.records.count == 50 + Self.rounds)
        routineRefresh.report(p95Budget: Self.frameMs)
        setRefresh.report(p95Budget: Self.frameMs)
        elsewhere.report(p95Budget: Self.frameMs)
      }
    }

    // The whole-type view of every set, which a screen of every set's history observes: a set logged anywhere reaches it.
    @Test func everySetAfterACommit() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"))
        let sets = try phone.engine.records(Gym.scope, Gym.Types.set)
        await phone.engine.settle()
        var refresh = Samples("view refresh · every set (whole-type view of 10 000) after a set is logged")
        for round in 0..<Self.rounds {
          let set = try phone.engine.mintID(Gym.Types.set)
          refresh.add(try await ViewTimes.untilNotified(sets) {
            try phone.commit(Gestures.logSet(in: history.sessions[round], of: history.exercises[3], id: .given(set), number: round))
            return ContinuousClock.now
          })
          #expect(Self.loaded(sets)?.record(set) != nil)
          await phone.sync()
          await phone.engine.settle()
        }
        refresh.report(p95Budget: Self.frameMs)
      }
    }

    // What a set logged in another session costs the views of a screen open beside the session's, of routines, exercises
    // and sessions, drawn and stored: none of them reads.
    @Test func afterACommitBesideViewsOfOtherTypes() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let (phone, _) = try await history.bootPhone(at: directory.appending(path: "sync.sqlite"))
        let session = try Self.sessionOfFifty(on: phone, history: history)
        var views = [try phone.engine.records(Gym.scope, Gym.Types.set, where: "sessionId", is: session)]
        for type in [Gym.Types.routine, Gym.Types.exercise, Gym.Types.session] {
          for mode in [ViewMode.drawn, .stored] { views.append(try phone.engine.records(Gym.scope, type, mode)) }
        }
        await phone.sync()
        await phone.engine.settle()
        var settle = Samples("view refresh · a set logged in another session, beside the session's view and six views of other types, until the views settle")
        for round in 0..<Self.rounds {
          try phone.commit(Gestures.logSet(in: history.sessions[round], of: history.exercises[3], id: .minted, number: round))
          let committed = ContinuousClock.now
          await phone.engine.settle()
          settle.add(ContinuousClock.now - committed)
          await phone.sync()
          await phone.engine.settle()
        }
        withExtendedLifetime(views) {}
        settle.report(p95Budget: Self.frameMs)
      }
    }

    // A set logged in a session while the view of every set makes its first load, 10 000 sets long: the session's view
    // is told as soon as with no load beside it. Each round is a process of its own over the phone's store, so the view
    // of every set loads anew.
    @Test func afterACommitBesideAFirstLoad() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let path = directory.appending(path: "sync.sqlite")
        let keys = Phone.Keys()
        let (phone, _) = try await history.bootPhone(at: path, keys: keys)
        let session = try Self.sessionOfFifty(on: phone, history: history)
        await phone.sync()
        var refresh = Samples("view refresh · a session's 50 sets (narrowed view) after a set is logged in it, beside the first load of every set")
        var firstLoad = Samples("cold start · first RecordsView of sets (every set) beside the refresh, until loaded")
        for round in 0..<Self.rounds / 4 {
          let relaunched = try Phone.onDisk(path, registry: SyncSchema.registry, transport: history.network, keys: keys)
          let sets = try relaunched.engine.records(Gym.scope, Gym.Types.set, where: "sessionId", is: session)
          await relaunched.engine.settle()
          let made = ContinuousClock.now
          let every = try relaunched.engine.records(Gym.scope, Gym.Types.set)
          let everyLoaded = ViewTimes.notification(of: every)
          refresh.add(try await ViewTimes.untilNotified(sets) {
            try relaunched.commit(Gestures.logSet(in: session, of: history.exercises[3], id: .minted, number: round))
            return ContinuousClock.now
          })
          guard case .loading = every.state else { throw BenchError("the view of every set loaded before the session's view was told") }
          firstLoad.add(try await everyLoaded() - made)
          await relaunched.engine.settle()
        }
        refresh.report(p95Budget: Self.frameMs)
        firstLoad.report()
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
        let sets = try phone.engine.records(Gym.scope, Gym.Types.set, where: "sessionId", is: session)
        await phone.engine.settle()
        var refresh = Samples("view refresh · a session's 50 sets (narrowed view) after a pull page carrying another phone's set in it")
        for round in 0..<Self.rounds {
          let set = try history.writer.engine.mintID(Gym.Types.set)
          try history.writer.commit(Gestures.logSet(in: session, of: history.exercises[4], id: .given(set), number: round))
          await history.writer.push()
          times.reset()
          refresh.add(try await ViewTimes.untilNotified(sets) {
            await phone.pull(only: [Gym.scope])
            guard let committed = times.firstCommit(of: .pullPage) else { throw BenchError("no page was applied") }
            return committed
          })
          #expect(Self.loaded(sets)?.record(set) != nil)
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

    static func loaded(_ view: RecordsView) -> RecordsView.Snapshot? {
      guard case .loaded(let snapshot) = view.state else { return nil }
      return snapshot
    }
  }
}
