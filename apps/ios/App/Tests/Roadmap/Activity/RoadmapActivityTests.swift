import Foundation
import Testing
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct RoadmapActivityTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone(account: String? = "acct-1") -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: account,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-activity-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views; a band's time never ends unless a test ends it.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
  }

  func reads(_ model: RoadmapModel, on engine: SteppedEngine, until holds: (RoadmapModel) -> Bool) async {
    for _ in 0..<100 where !holds(model) {
      await engine.settleViews()
      model.observe()
    }
    #expect(holds(model))
  }

  // The open roadmap's Activity, or a step's History, as each row says it: what happened, to which step.
  func activity(_ model: RoadmapModel, of step: String? = nil) -> [String] {
    guard let open = model.shown else { return [] }
    return ActivityRead(open.graph, step: step).rows.map { "\($0.kind.rawValue) \(open.tree.step($0.step)?.label ?? $0.step)" }
  }

  func step(_ label: String, in model: RoadmapModel) throws -> String {
    try #require(model.shown?.tree.index.nodes.first { $0.label == label }?.id)
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // The eight steps of *Learn to sail*, each created. Planted in one gesture they share their time, so the read orders them
  // by the roadmap's authored order, which their ids decide, and a test holds them as a set.
  static let planted: Set<String> = ["created Sail solo", "created Sail a triangle", "created Leave the dock", "created Tie a bowline",
                                     "created Read the wind", "created Rig the boat", "created Name the boat parts", "created Choose a sailing course"]

  // Roadmap · iOS 01.13: Activity is the domain's read of the phone's copy, told as it opens, newest first: the three
  // completions a minute apart, then the steps planted before them; a completion made on the account's other phone shows
  // once the copy holds it, and a row opens its step's page.
  @Test func activityIsTheReadOfThePhonesCopyAndFollowsACompletionMadeElsewhere() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try RoadmapFixture.plantLearnToSail(runner, done: [])
    for step in ["choose", "parts", "rig"] {
      engine.advance(ms: 60_000)
      try RoadmapFixture.complete(step, of: planted, by: runner)
      engine.sync()
    }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.done == 3 }
    model.path = [.activity(of: planted.tree.description)]
    #expect(activity(model).prefix(3) == ["completed Rig the boat", "completed Name the boat parts", "completed Choose a sailing course"])
    #expect(Set(activity(model).dropFirst(3)) == Self.planted && activity(model).count == 11)

    let other = engine.device()
    let elsewhere = ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    engine.sync()
    engine.advance(ms: 60_000)
    try RoadmapFixture.complete("read", of: planted, by: elsewhere)
    engine.sync()
    await reads(model, on: engine) { self.activity($0).first == "completed Read the wind" }
    #expect(model.path == [.activity(of: planted.tree.description)])

    model.path.append(.step(try step("Read the wind", in: model), by: .activity))
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_activity read=loaded step=open surface=activity",
      "roadmap_board_step_open column=done door=activity surface=document",
    ])
  }

  // 01.13b: signed out, a roadmap the phone made holds no time the server gave, and Activity reads each step's birth on
  // the phone and each completion's own time. Made in one moment, the completions stand first and the steps fold into one
  // row; the read keeps a row each.
  @Test func signedOutEachCreationIsTimedByItsBirthAndStepsPlantedAtOnceFold() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    let model = room(engine, runner, memory)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.done == 3 }
    #expect(Set(activity(model).prefix(3)) == ["completed Rig the boat", "completed Name the boat parts", "completed Choose a sailing course"])
    #expect(Set(activity(model).dropFirst(3)) == Self.planted && activity(model).count == 11)
    let open = try #require(model.shown)
    #expect(open.tree.index.nodes.allSatisfy { $0.rc == nil && $0.createdAt != nil } && Set(open.tree.index.nodes.map(\.createdAt)).count == 1)

    let days = ActivityDays(ActivityRead(open.graph), now: model.moment, folds: true)
    let laidOut = days.sections.map { (section: ActivityDays.Section) -> String in
      "\(section.day): " + section.entries.map { (entry: ActivityDays.Entry) -> String in
        switch entry {
        case .row(let row): "\(row.kind.rawValue)"
        case .added(let rows): "\(rows.count) added"
        }
      }.joined(separator: ", ")
    }
    #expect(laidOut == ["today: completed, completed, completed, 8 added"])
  }

  // 03.12: a step's History is the same read narrowed to it, told with its surface; a step that goes, here or on another
  // phone, takes the stack back to the Board.
  @Test func aStepsHistoryIsItsOwnRowsAndLeavesWithItsStep() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try RoadmapFixture.plantLearnToSail(runner, done: ["choose"])
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.done == 1 }
    let choose = try step("Choose a sailing course", in: model), tie = try step("Tie a bowline", in: model)
    #expect(activity(model, of: choose) == ["completed Choose a sailing course", "created Choose a sailing course"])
    #expect(activity(model, of: tie) == ["created Tie a bowline"])

    model.path = [.step(tie, by: .card)]
    model.path.append(.history(of: tie))
    let other = engine.device()
    let elsewhere = ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    engine.sync()
    guard case .committed = try elsewhere.runAct(DeleteStep(tree: planted.tree, step: ID(RecordID(tie)))) else {
      Issue.record("Tie a bowline was not deleted on the other phone")
      return
    }
    engine.advance(ms: Constants.holdMs)
    engine.sync()
    await reads(model, on: engine) { $0.shown?.step(tie) == nil }
    #expect(model.path.isEmpty)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_step_open column=locked door=card surface=document", "roadmap_activity read=loaded step=open surface=history",
    ])
  }

  // Activity is its roadmap's: once another phone deletes the open roadmap, the room opens the next and the stack leaves.
  @Test func activityLeavesOnceItsRoadmapIsNoLongerTheOpenOne() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    guard case .committed = try runner.runAct(CreateRoadmap(title: "Night sailing")) else {
      Issue.record("Night sailing was not created")
      return
    }
    engine.sync()
    engine.advance(ms: 60_000)
    let sail = try RoadmapFixture.plantLearnToSail(runner).tree
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.listed.title == "Learn to sail" }
    model.path = [.activity(of: sail.description)]

    let other = engine.device()
    let elsewhere = ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    engine.sync()
    guard case .committed = try elsewhere.runAct(DeleteRoadmap(tree: sail)) else {
      Issue.record("Learn to sail was not deleted on the other phone")
      return
    }
    engine.advance(ms: Constants.holdMs)
    engine.sync()
    await reads(model, on: engine) { $0.shown?.listed.title == "Night sailing" }
    #expect(model.path.isEmpty)

    // A roadmap with no step has no Activity, which its event says; the title menu's Activity pushes the open roadmap's.
    model.showActivity()
    #expect(model.path == [.activity(of: try #require(model.shown).listed.id)] && activity(model).isEmpty)
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_activity") } == [
      "roadmap_activity read=loaded step=open surface=activity", "roadmap_activity read=empty step=open surface=activity",
    ])
  }

  // A read's rows from a roadmap's records as the domain normalizes them: each step created at `rc` and, where `done`
  // names a time, completed then.
  func read(_ steps: [(id: String, at: Int64, done: Int64?)], step: String? = nil) -> ActivityRead {
    let tree = RoadmapTree(id: "T", meta: RoadmapTree.Metadata(root: "T"),
                           nodes: steps.enumerated().map { Step(id: $0.element.id, rc: Instant(ms: $0.element.at), ord: "a\($0.offset)") },
                           marks: steps.compactMap { (step: (id: String, at: Int64, done: Int64?)) -> RoadmapTree.Mark? in
                             step.done.map { RoadmapTree.Mark(node: step.id, status: "complete", outOfOrder: false, recordedAt: Instant(ms: $0), deviceAt: nil) }
                           })
    return ActivityRead(FollowGraph(tree), step: step)
  }

  // The layout as each section and its entries say it.
  func laidOut(_ days: ActivityDays) -> [String] {
    days.sections.map { (section: ActivityDays.Section) -> String in
      "\(section.day): " + section.entries.map { (entry: ActivityDays.Entry) -> String in
        switch entry {
        case .row(let row): "\(row.kind.rawValue) \(row.step)"
        case .added(let rows): "added " + rows.map(\.step).joined(separator: " ")
        }
      }.joined(separator: ", ")
    }
  }

  // 01.13 and 01.13b: each row stands under the day it falls on in the phone's zone, and more than three creations within
  // a minute of the newest of them fold into one entry; three do not, a creation past the minute starts anew, and a
  // completion between them parts them. History never folds.
  @Test func rowsStandUnderTheirDaysAndMoreThanThreeAddedWithinAMinuteFold() {
    let day: Int64 = 86_400_000, minute: Int64 = 60_000
    let noon: Int64 = 1_790_424_000_000
    let now = Moment(now: Instant(ms: noon), zone: FixedZone(offsetSeconds: 0))
    let steps: [(id: String, at: Int64, done: Int64?)] = [
      ("a", noon - 2 * day, nil), ("b", noon - 2 * day + 1_000, nil), ("c", noon - 2 * day + 2_000, nil), ("d", noon - 2 * day + 59_000, nil),
      ("e", noon - day, nil), ("f", noon - day + 10_000, nil), ("g", noon - day + 20_000, nil),
      ("h", noon - 10 * minute, noon - minute), ("i", noon - 10 * minute + 1_000, nil), ("j", noon - 10 * minute + 2_000, nil),
      ("k", noon - 10 * minute + 3_000, nil), ("l", noon - 10 * minute + 3_000 + minute, nil),
    ]
    #expect(laidOut(ActivityDays(read(steps), now: now, folds: true)) == [
      "today: completed h, created l, added k j i h",
      "yesterday: created g, created f, created e",
      "earlier: added d c b a",
    ])
    #expect(laidOut(ActivityDays(read(steps), now: now, folds: false)) == [
      "today: completed h, created l, created k, created j, created i, created h",
      "yesterday: created g, created f, created e",
      "earlier: created d, created c, created b, created a",
    ])
    #expect(laidOut(ActivityDays(read(steps, step: "h"), now: now, folds: false)) == ["today: completed h, created h"])

    // Half an hour past midnight in a zone an hour ahead of UTC: a row a second past that midnight is today's, one a second
    // before it yesterday's, and one a second before the midnight before that is earlier, though UTC puts it yesterday.
    let hour: Int64 = 3_600_000
    let late = Moment(now: Instant(ms: noon + 11 * hour + hour / 2), zone: FixedZone(offsetSeconds: 3_600))
    let aroundMidnight: [(id: String, at: Int64, done: Int64?)] = [
      ("z", noon - 13 * hour - 1_000, nil), ("y", noon + 11 * hour - 1_000, nil), ("x", noon + 11 * hour + 1_000, nil),
    ]
    #expect(laidOut(ActivityDays(read(aroundMidnight), now: late, folds: true)) == ["today: created x", "yesterday: created y", "earlier: created z"])
  }

  // 01.13b: a fold is named by the first step it took, so a step added within that minute joins it under the same name, and
  // the screen keeps it open; one added past the minute stands on its own.
  @Test func aFoldKeepsItsNameAsAStepLandsWithinItsMinute() {
    let noon: Int64 = 1_790_424_000_000
    let now = Moment(now: Instant(ms: noon), zone: FixedZone(offsetSeconds: 0))
    let planted: [(id: String, at: Int64, done: Int64?)] = [("a", noon - 3_600_000, nil), ("b", noon - 3_590_000, nil),
                                                           ("c", noon - 3_580_000, nil), ("d", noon - 3_570_000, nil)]
    let folds = { (steps: [(id: String, at: Int64, done: Int64?)]) -> [String] in
      ActivityDays(self.read(steps), now: now, folds: true).sections.flatMap(\.entries).map(\.id)
    }
    #expect(folds(planted) == ["fold-a"])
    #expect(folds(planted + [("e", noon - 3_550_000, nil)]) == ["fold-a"])
    #expect(laidOut(ActivityDays(read(planted + [("e", noon - 3_550_000, nil)]), now: now, folds: true)) == ["today: added e d c b a"])
    #expect(folds(planted + [("e", noon - 3_550_000, nil), ("f", noon - 3_530_000, nil)]) == ["created-f", "fold-a"])
  }

  // 01.5b: how the first read's wait ended, said as the spinner leaves: the room read its copy, its read failed, or it was
  // put away with the read still under way.
  @Test func theFirstReadsWaitEndsReadFailedOrLeft() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    struct Unreadable: Error {}
    let telemetry = TelemetryRecorder()
    let waiting = room(engine, runner, memory, telemetry: telemetry)
    waiting.firstReadWaits()
    waiting.firstReadEnded()
    let read = room(engine, runner, memory, telemetry: telemetry)
    read.roomOpened()
    await reads(read, on: engine) { $0.shown != nil }
    read.firstReadEnded()
    let failing = RoadmapModel(records: { _, _ in throw Unreadable() }, runner: runner, phone: memory, telemetry: telemetry)
    failing.roomOpened()
    failing.firstReadEnded()
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_first_read") } == [
      "roadmap_first_read step=shown", "roadmap_first_read outcome=left step=ended", "roadmap_first_read outcome=read step=ended",
      "roadmap_first_read outcome=failed step=ended",
    ])
  }

  // Earlier says its date, with the year only for a year that is not this one; Today and Yesterday say the clock time.
  @Test func earlierSaysItsDateWithTheYearOnlyForAnotherYear() {
    let noon: Int64 = 1_790_424_000_000
    let days = ActivityDays(read([]), now: Moment(now: Instant(ms: noon), zone: FixedZone(offsetSeconds: 0)), folds: true)
    let thisYear = days.time(of: Instant(ms: noon - 30 * 86_400_000), on: .earlier)
    let lastYear = days.time(of: Instant(ms: noon - 365 * 86_400_000), on: .earlier)
    #expect(!thisYear.contains("2026") && lastYear.contains("2025"))
    #expect(days.time(of: Instant(ms: noon), on: .today) != days.time(of: Instant(ms: noon), on: .earlier))
  }
}
