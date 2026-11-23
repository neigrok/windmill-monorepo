import Foundation
import Testing
import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
@testable import Windmill

// The Board's budget (Roadmap on iOS §5: from the tap that opens a roadmap of 5,000 steps to the Board's first frame is
// under a second) on the 5,000-step handbook, planted through the domain as the simulator's board plants it: the
// room's read of the open roadmap, which is the Board's work before it draws, and the Board read again under each
// query a person asks of it. Each measure prints one `bench` line beside its budget with the share of the budget it
// used, and fails when it passes it. A query's read, which Find takes at every key, is held to a frame at 60 a second,
// the frame the keystroke's redraw stands in. The budgets are held here on the Mac that runs the simulator: the share
// says how wide the margin is for a phone, which is slower. The screen's own benchmark, `RoadmapBoardBenchmarks`, measures
// the first frame and a scroll. Recolor and Delete N Steps are measured as the acts they write, against the App Hang
// report's two seconds. The suite runs only under WM_BOARD_BENCH=1, which `Tools/board_bench.sh` sets on a
// Release-configuration build.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["WM_BOARD_BENCH"] == "1", "the Board's benchmarks run under WM_BOARD_BENCH=1"))
@MainActor struct BoardBenchmarks {
  // The handbook planted on a phone in memory, and its records as the room's model reads them.
  func handbook() throws -> RoadmapTree {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let id = try RoadmapFixture.plantHandbook(phone.runner).tree
    return try RoadmapTree(id: id, listed: phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(id, in: .drawn) },
                           tree: phone.runner.read(id.tree) { try $0.records(in: .drawn) },
                           overlay: phone.runner.read(id.overlay) { try $0.records(in: .drawn) })
  }

  func ms(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1e15
  }

  // One measure's line: its samples' spread, whether the median holds the budget and how much of it the median used.
  func report(_ measure: String, _ samples: [Double], budgetMs: Double) -> Bool {
    let sorted = samples.sorted()
    let median = sorted[sorted.count / 2]
    print(String(format: "bench [simulator] board · %@: n=%d min=%.2fms p50=%.2fms max=%.2fms | budget p50 ≤ %.1fms → %@, %.0f%% of it",
                 measure, sorted.count, sorted[0], median, sorted[sorted.count - 1], budgetMs, median > budgetMs ? "OVER" : "under",
                 median / budgetMs * 100))
    return median <= budgetMs
  }

  // §5: the room's read of the open roadmap, as the model takes it at every change of the phone's copy: the account's
  // read, the domain's Board and legend, every step's row, the groups and what follows each step.
  @Test func theRoomsReadOfFiveThousandStepsIsTakenWithinTheFirstFramesSecond() throws {
    let tree = try handbook()
    var reading: [Double] = []
    for _ in 0..<5 {
      let began = ContinuousClock.now
      let account = RoadmapAccount([tree])
      let open = try #require(account.list().first.flatMap { RoadmapModel.OpenRoadmap($0, in: account) })
      reading.append(ms(ContinuousClock.now - began))
      #expect(open.board.overall.total == 5_000 && open.board.overall.done == 120 && open.rows.count == 5_000)
    }
    #expect(report("the room's read of the open roadmap", reading, budgetMs: 1_000))
  }

  // Each query the Board asks of the domain's read: another order, a kind shown, Find's words a key at a time, and a
  // branch, each read over the whole roadmap as the Board's list draws it.
  @Test func eachQueryOfFiveThousandStepsIsReadWithinAFrame() throws {
    let tree = try handbook()
    let account = RoadmapAccount([tree])
    let open = try #require(account.list().first.flatMap { RoadmapModel.OpenRoadmap($0, in: account) })
    let middle = open.tree.index.nodes[2_500].id
    let asked: [(measure: String, ask: (BoardReading) -> Void)] = [
      ("Newest First", { $0.pick(.newest) }),
      ("one kind shown", { $0.toggle(open.tree.index.nodes[0].color) }),
      ("Find, a word's first key", { $0.finding = "c" }),
      ("Find, a word", { $0.finding = "anchor" }),
      ("a branch", { $0.view(branch: middle) }),
    ]
    var held: [Bool] = []
    for (measure, ask) in asked {
      let reading = BoardReading(telemetry: NoopTelemetry())
      reading.finds = true
      ask(reading)
      var taking: [Double] = []
      for _ in 0..<10 {
        let began = ContinuousClock.now
        let shown = reading.shown(in: open)
        taking.append(ms(ContinuousClock.now - began))
        #expect(!shown.groups.isEmpty)
      }
      held.append(report("the Board read under \(measure)", taking, budgetMs: 1_000.0 / 60))
    }
    #expect(held == [true, true, true, true, true])
  }

  // Recolor and Delete N Steps on the handbook (02.11, 02.10c): each one act of N parts, a `ChangeStep` or a `DeleteStep`
  // a step, composed through the kit's runner as the selection writes it, on a phone never signed in that holds the
  // handbook it planted, a hundred steps and a thousand. The room writes on the main actor, so each is held to the two
  // seconds past which the App Hang report names the app frozen.
  @Test func anActOnSeveralOfFiveThousandStepsIsWrittenBeforeTheAppHangs() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let planted = try RoadmapFixture.plantHandbook(phone.runner)
    let steps = planted.steps.map(\.id)
    let write = { (acts: [AnyActAction<RoadmapRefusal>]) throws -> Double in
      let began = ContinuousClock.now
      guard case .committed = try phone.runner.runComposed(acts) else { throw AppFailure(message: "The act on several steps wrote nothing.") }
      return self.ms(ContinuousClock.now - began)
    }
    // One act a measure: on a phone never signed in, an act of a thousand parts takes minutes in a Debug build.
    var held: [Bool] = []
    for parts in [100, 1_000] {
      let recoloring = try write(steps.prefix(parts).map { (step: ID<RoadmapStep>) -> AnyActAction<RoadmapRefusal> in
        AnyActAction(ChangeStep(tree: planted.tree, step: step, changes: RoadmapStep.Changes(color: "plum")))
      })
      held.append(report("Recolor of \(parts) steps", [recoloring], budgetMs: 2_000))
    }
    // Each delete takes steps the delete before it left: a hundred from the thousandth step on, a thousand from the
    // two-thousandth.
    for (parts, from) in [(100, 1_000), (1_000, 2_000)] {
      let deleting = try write(steps[from..<(from + parts)].map { (step: ID<RoadmapStep>) -> AnyActAction<RoadmapRefusal> in
        AnyActAction(DeleteStep(tree: planted.tree, step: step))
      })
      held.append(report("Delete of \(parts) steps", [deleting], budgetMs: 2_000))
    }
    #expect(held == [true, true, true, true])
  }
}
