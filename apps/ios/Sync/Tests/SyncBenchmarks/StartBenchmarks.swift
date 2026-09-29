import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import Testing

// Cold start and boot with the 10 000-set history, and the memory the engine holds for it. The design names no number
// for these; each line reports what was measured beside the budget this report proposes for it.
extension Benchmarks {
  @Suite struct Start {
    static let runs = 3

    // A new phone's first boot: from an empty store, signed in, to the first pull of gym complete, the model server in
    // this process serving the whole history. Its peak memory counts the server's own work building each page.
    @Test func bootFromEmpty() async throws {
      let history = try await GymHistory.shared.history()
      var boots = Samples("boot · empty store to first pull of gym complete (10 000 sets, in-process model server)")
      var rounds = Samples("boot · one pull round (a page built by the model server, then applied)")
      var pages = Samples("transaction · a boot page")
      for _ in 0..<Self.runs {
        try await Bench.inDirectory { directory in
          let path = directory.appending(path: "sync.sqlite")
          let times = TransactionTimes()
          let before = Memory.now()
          let began = ContinuousClock.now
          let (booted, peak) = try await Memory.peak { try await history.bootPhone(at: path, crashPoints: times.crashPoints) }
          boots.add(ContinuousClock.now - began)
          for round in booted.rounds { rounds.add(round) }
          pages.add(contentsOf: times.durations(of: .pullPage, as: pages.measure))
          Bench.report("boot · memory and disk (the model server's own pages counted)", peak.growth(since: before, as: "peak") + [
            ("pullRounds", "\(booted.rounds.count)"), ("bytesOnDisk", Bench.format(bytes: Phone.bytesOnDisk(path))),
          ])
        }
      }
      boots.report()
      rounds.report()
      pages.report()
    }

    // A process opening a store that holds the history, as a relaunch does: the engine built (the store opened and
    // migrated, engine start's transactions), then the first drawn reads a screen makes, then the views it observes.
    // Each run is a new store and engine over the same file, in this process, so the file's pages may still be cached:
    // a relaunch after the system evicted them reads them from flash.
    @Test @MainActor func coldStart() async throws {
      let history = try await GymHistory.shared.history()
      try await Bench.inDirectory { directory in
        let path = directory.appending(path: "sync.sqlite")
        let keys = Phone.Keys()
        _ = try await history.bootPhone(at: path, keys: keys)
        var open = Samples("cold start · engine built over the store (open, migrate, engine start)")
        var routines = Samples("cold start · first drawn read of the routines list")
        var session = Samples("cold start · first drawn read of a session and its sets (indexed by sessionId)")
        var routinesView = Samples("cold start · first RecordsView of routines, on the main actor")
        var setsView = Samples("cold start · first RecordsView of sets (every set), on the main actor")
        var sessionFromView = Samples("cold start · a session's sets filtered from the sets view, on the main actor")
        var toFirstRead = Samples("cold start · engine built to routines and a session drawn")
        for _ in 0..<Self.runs + 2 {
          let before = Memory.now()
          let began = ContinuousClock.now
          let phone = try open.time { try Phone.onDisk(path, registry: SyncSchema.registry, transport: history.network, keys: keys) }
          let listed = try routines.time { try phone.engine.read(Gym.scope) { try $0.drawn(Gym.Types.routine) } }
          let sets = try session.time {
            try phone.engine.read(Gym.scope) { reader in
              _ = try reader.drawn(Gym.Types.session, history.sessions[7])
              return try reader.drawn(Gym.Types.set, where: "sessionId", is: history.sessions[7])
            }
          }
          toFirstRead.add(ContinuousClock.now - began)
          let idle = Memory.now()
          let routineRecords = routinesView.time { phone.engine.records(Gym.scope, Gym.Types.routine) }
          let setRecords = setsView.time { phone.engine.records(Gym.scope, Gym.Types.set) }
          let filtered = sessionFromView.time {
            setRecords.records.values.filter { $0.values["sessionId"] == history.sessions[7].json }
          }
          let viewing = Memory.now()
          #expect(listed.count == history.routines.count)
          #expect(sets.count == GymHistory.setsPerSession)
          #expect(routineRecords.records.count == history.routines.count)
          #expect(setRecords.records.count == (try phone.engine.read(Gym.scope) { try $0.drawn(Gym.Types.set).count }))
          #expect(filtered.count == GymHistory.setsPerSession)
          Bench.report("memory · engine over the 10 000-set history", idle.growth(since: before, as: "idle") + viewing.growth(since: before, as: "withViews"))
        }
        for samples in [open, routines, session, toFirstRead, routinesView, setsView, sessionFromView] { samples.afterWarmUp(2).report() }
      }
    }
  }
}
