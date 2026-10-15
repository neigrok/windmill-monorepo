import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct TrainingLogUITests {
  func fixture() -> (Harness, GymModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }
  func session(_ gym: GymModel, daysAgo: Int, kg: Double = 60, reps: Int = 5, rpe: Double? = nil) throws -> Session {
    let now = try #require(gym.log?.moment.now)
    let start = Instant(ms: now.ms - Int64(daysAgo) * 86_400_000 - 3_600_000)
    let id = gym.runner.mint(Session.self), exercise = SeedExercises.all.first!
    let set = ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: exercise.id, weightKg: kg, reps: reps,
                          completedAt: Instant(ms: start.ms + 600_000), rpe: rpe)
    let outcome = try #require(gym.run(ImportSession(id: id, startedAt: start, finishedAt: Instant(ms: start.ms + 2_000_000), sets: [set])))
    #expect(outcome.refusal == nil)
    return try #require(gym.sessions.first { $0.id == id })
  }

  @Test func unreadablePlanReportsStaticFailureWhileFactsCorrectionsAndDiscardRemainAvailable() throws {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: nil,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let id = ID<Session>(RecordID("sessionP2")), setID = ID<TrainingSet>(RecordID("set00001"))
    let plan: JSON = ["routine": "PRIVATE_FROZEN_PLAN", "entries": "broken"]
    let session = Session(id: id, startedAt: Instant(ms: 100), finishedAt: Instant(ms: 900), closedBy: "finish", unreadablePlan: plan)
    let set = TrainingSet(id: setID, sessionId: id, exerciseId: ID("bench-press"), weightKg: 80, reps: 5, completedAt: Instant(ms: 500))
    _ = try engine.replica.commit(Gym.scope, Gesture(changes: [], command: Command(name: "gym.importSession", args: [
      "id": id.json, "startedAt": 100, "finishedAt": 900, "sets": []]), predict: [
        .create(Session.type, id: .given(id.record), session.fields),
        .create(TrainingSet.type, id: .given(setID.record), set.fields)]))
    let telemetry = TelemetryRecorder(), gym = GymModel(runner: runner, telemetry: telemetry)
    #expect(!gym.readFailed && gym.sessions == [session] && gym.sets == [set])
    #expect(telemetry.entries.withLock { $0.map(\.properties) } == [["operation": "gym_read", "failure_kind": "unexpected"]])
    var corrected = set; corrected.reps = 9
    #expect(gym.run(CorrectSet(corrected))?.receipt != nil)
    #expect(gym.run(DiscardSession(id))?.receipt != nil)
    let retainedPlan: JSON? = try runner.read(Gym.scope) { try $0.repository(Session.self).find(id, in: .stored)?.fields["plan"] }
    #expect(retainedPlan == plan)
    #expect(telemetry.entries.withLock { $0.allSatisfy { !$0.properties.values.contains { $0.contains("PRIVATE_FROZEN_PLAN") } } })
  }

  @Test func monthGroupedTimelineFiltersOpenAndFutureAndPagesAllLocalRows() throws {
    let (_, gym) = fixture()
    for day in 1...35 { _ = try session(gym, daysAgo: day, kg: 60) }
    let open = gym.runner.mint(Session.self); gym.run(StartSession(id: open))
    let months = gym.logTimeline(limit: 30)
    let visible = months.flatMap(\.entries).compactMap { row -> Session? in if case .session(let value) = row.kind { value } else { nil } }
    #expect(visible.count == 30 && visible.allSatisfy { !$0.isOpen })
    let allRows = gym.logTimeline(limit: 60).flatMap(\.entries)
    let allSessions = allRows.filter { $0.priority == -1 }
    #expect(allSessions.count == 35)
    #expect(months.map(\.id) == months.map(\.id).sorted(by: >))
    #expect(visible.map(\.startedAt) == visible.map(\.startedAt).sorted(by: >))
  }

  @Test func weeklyMomentsChooseLatestStrengthBeforeWeighIn() throws {
    let (_, gym) = fixture()
    _ = try session(gym, daysAgo: 2, kg: 60)
    let last = try session(gym, daysAgo: 1, kg: 70)
    var draft = Draft(new: WeighIn(day: gym.log!.moment.today, kg: 82)); gym.save(&draft)
    let rows = gym.logTimeline(limit: 30).flatMap(\.entries).filter { $0.priority >= 0 }
    let monday = gym.log!.moment.today.adding(days: 1 - gym.log!.moment.today.weekday)
    let thisWeek = rows.filter { LocalDay($0.at, in: gym.log!.moment.zone) >= monday }
    #expect(thisWeek.count == 1)
    if let row = thisWeek.first, case .best(_, let point, _) = row.kind { #expect(point.id == last.id) }
    else { Issue.record("Strength moment should win this week") }
  }

  @Test func weighInCreatesAMomentWithoutInventingASession() {
    let (_, gym) = fixture()
    var draft = Draft(new: WeighIn(day: gym.log!.moment.today, kg: 82.4)); gym.save(&draft)
    let rows = gym.logTimeline(limit: 30).flatMap(\.entries)
    #expect(gym.finishedLogSessions.isEmpty && rows.count == 1)
    #expect(rows.first?.priority == 2)
  }

  @Test func completedMonthRequiresWorkingSetsInEveryCalendarWeek() throws {
    let (_, gym) = fixture()
    let today = gym.log!.moment.today
    let lastDay = LocalDay(String(today.text.prefix(7)) + "-01")!.adding(days: -1)
    let first = LocalDay(String(lastDay.text.prefix(7)) + "-01")!
    var day = first
    while day <= lastDay { _ = try session(gym, daysAgo: day.days(until: today), kg: 0, reps: 12); day = day.adding(days: 7) }
    _ = try session(gym, daysAgo: lastDay.days(until: today), kg: 0, reps: 12)
    let moments = gym.logTimeline(limit: 60).flatMap(\.entries).filter { $0.priority == 1 }
    #expect(moments.count == 1)
    #expect(moments.first.map { LocalDay($0.at, in: gym.log!.moment.zone) } == lastDay)
  }

  @Test(arguments: [-43200, 0, 7200, 50400]) func momentDaysUseTheInjectedZone(offset: Int) {
    let day = LocalDay("2026-09-28")!, zone = FixedZone(offsetSeconds: offset)
    let instant = LogPresentation.instant(day, in: zone)
    #expect(LocalDay(instant, in: zone) == day)
    #expect((instant.ms + Int64(offset) * 1000) % 86_400_000 == 0)
  }

  nonisolated struct CalendarZone: Zone {
    let value: TimeZone
    func offsetSeconds(at instant: Instant) -> Int { value.secondsFromGMT(for: instant.date) }
  }
  @Test(arguments: [("America/Santiago", "2026-09-06"), ("America/Havana", "2026-03-08"), ("Europe/Belgrade", "2026-03-29")])
  func momentsStayOnTheirDayAcrossOffsetChanges(value: (String, String)) throws {
    let day = try #require(LocalDay(value.1)), zone = try #require(TimeZone(identifier: value.0))
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
    let expected = try #require(calendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day)))
    #expect(LogPresentation.instant(day, in: CalendarZone(value: zone)).ms == Int64(expected.timeIntervalSince1970 * 1000))
  }

  @Test func finishedDeleteDiscardAndUndoRestoreSessionReadout() throws {
    let (_, gym) = fixture(), value = try session(gym, daysAgo: 1)
    let set = try #require(gym.sets.first)
    let removed = try #require(gym.run(DeleteSet(set.id))?.receipt)
    #expect(gym.log?.readout(session: value.id)?.workingSetCount == 0)
    #expect(gym.undo(removed.gestureId))
    #expect(gym.log?.readout(session: value.id)?.volumeKg == 300)
    let discarded = try #require(gym.run(DiscardSession(value.id))?.receipt)
    #expect(gym.finishedLogSessions.isEmpty)
    #expect(gym.undo(discarded.gestureId))
    #expect(gym.log?.sets(session: value.id) == [set])
  }

  @Test func failedRereadRetainsFinishedSetsAndSessionsForRetry() throws {
    let fault = GymStoreFault(), runtime = try GymModelTests().runtime(failing: fault)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    let value = try session(gym, daysAgo: 1), saved = gym.log?.sets(session: value.id)
    let original = try #require(saved?.first)
    fault.point.withLock { $0 = .read }; gym.refresh()
    #expect(gym.readFailed && gym.log?.sets(session: value.id) == saved)
    #expect(gym.finishedLogSessions.contains { $0.id == value.id })
    let draft = SetFixDraft(original, account: nil)
    #expect(!draft.save(gym) && draft.failure == "The workout changed. Check the current set")
    fault.point.withLock { $0 = nil }; gym.refresh()
    #expect(!gym.readFailed && gym.log?.sets(session: value.id) == saved)
    #expect(gym.log?.readout(session: value.id)?.workingSetCount == 1)
  }

  @Test func performedVersusFrozenPlanUsesNthWorkingSlotAndLoadBeforeReps() throws {
    let (_, gym) = fixture(); _ = try session(gym, daysAgo: 1)
    var set = try #require(gym.sets.first)
    let plan = SessionPlan(routine: "Frozen", entries: [RoutineEntry(exerciseId: set.exerciseId, sets: [SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 5, weightKg: 80)])])
    set.weightKg = 62.5; set.reps = 5
    #expect(LogPresentation.comparison(set, preceding: [], plan: plan) == "+2.5 over plan")
    set.weightKg = 60
    #expect(LogPresentation.comparison(set, preceding: [], plan: plan) == "three short")
    set.weightKg = 80
    #expect(LogPresentation.comparison(set, preceding: [set], plan: plan) == "on plan")
    set.kind = "warmup"
    #expect(LogPresentation.comparison(set, preceding: [], plan: plan) == "warmup")
    set.kind = "working"
    #expect(LogPresentation.comparison(set, preceding: [], plan: SessionPlan(routine: "Frozen", entries: [])) == nil)
  }

  @Test func aMovementsPlanLineNamesItsTargetsOrThatThePlanDidNotHoldIt() {
    let bench = ID<Exercise>(RecordID("bench-press")), squat = ID<Exercise>(RecordID("back-squat"))
    let plan = SessionPlan(routine: "Push A", entries: [RoutineEntry(exerciseId: bench, sets: [SetTarget(reps: 5, weightKg: 60)])])
    #expect(LogPresentation.planLine(bench, plan: plan) == "plan 1 × 5 · 60")
    #expect(LogPresentation.planLine(squat, plan: plan) == "added today")
    #expect(LogPresentation.planLine(bench, plan: nil) == nil)
    let twice = SessionPlan(routine: "Push A", entries: plan.entries + plan.entries)
    #expect(LogPresentation.planLine(bench, plan: twice) == nil)
  }

  @Test func aSessionRowReadsItsWorkingSetsAndDurationAndItsRecord() throws {
    let (_, gym) = fixture(), value = try session(gym, daysAgo: 1)
    let readout = try #require(gym.log?.readout(session: value.id))
    #expect(LogPresentation.sessionFacts(readout) == "1 working set · 33m")
    #expect(gym.logRecordFact(value.id) == "Record · \(SeedExercises.all.first!.name) 60 × 5")
    let second = try session(gym, daysAgo: 0, kg: 50)
    #expect(gym.logRecordFact(second.id) == nil)
    #expect(!gym.sessionIsUnsent(value.id))
  }

  @Test func theMomentEventIsAllowlisted() {
    #expect(TelemetryPrivacy.events.contains("gym_moment_opened"))
    #expect(TelemetryPrivacy.properties(["screen": "log"]) == ["screen": .label("log")])
  }

  @Test func aDayNamesItsYearOnlyWhenItIsNotThisOne() {
    let today = LocalDay("2026-09-28")!
    #expect(LogPresentation.brief(LocalDay("2026-09-26")!, today: today) == LogPresentation.brief(LogPresentation.date(LocalDay("2026-09-26")!)))
    #expect(LogPresentation.brief(LocalDay("2025-12-30")!, today: today).contains("2025"))
    #expect(!LogPresentation.brief(LocalDay("2026-01-02")!, today: today).contains("2026"))
    #expect([0, 1, 3].map(Readout.ago(days:)) == ["today", "yesterday", "3 days ago"])
    let best = LocalDay("2026-09-23")!
    #expect(LogPresentation.since(LocalDay("2026-09-20")!, best: best) == LogPresentation.brief(LogPresentation.date(LocalDay("2026-09-20")!)))
    #expect(LogPresentation.since(LocalDay("2026-08-30")!, best: best) == LogPresentation.date(LocalDay("2026-08-30")!).formatted(.dateTime.month(.wide)))
    #expect(LogPresentation.since(LocalDay("2025-12-30")!, best: best).contains("2025"))
  }

  @Test func chartAxesSitOnTheSeriesStep() {
    #expect(LogDatedChart.axis([61.88, 109.62], step: 5) == 60...110)
    #expect(LogDatedChart.axis([100, 100], step: 5) == 95...105)
    let bodyweight = LogDatedChart.axis([81.4, 84.5], step: 0.1)
    #expect([bodyweight.lowerBound, bodyweight.upperBound].map { Readout.weight($0) } == ["81.4", "84.5"])
    let flat = LogDatedChart.axis([82.4], step: 0.1)
    #expect([flat.lowerBound, flat.upperBound].map { Readout.weight($0) } == ["81.4", "83.4"])
  }

  @Test func recordQualificationWindowGapsAndStandingProgression() throws {
    let (_, gym) = fixture()
    for (days, kg) in [(100, 50.0), (60, 60), (30, 65), (1, 70)] { _ = try session(gym, daysAgo: days, kg: kg) }
    _ = try session(gym, daysAgo: 2, kg: 200, reps: 11)
    _ = try session(gym, daysAgo: 3, kg: 300, reps: 5, rpe: 6.5)
    let progress = gym.log!.progress.movement(SeedExercises.all.first!.id)
    #expect(progress.estimates.count == 4 && progress.records.count == 4)
    #expect(progress.best?.fact.estimate?.e1rm == GymEstimate.value(weightKg: 70, reps: 5))
    #expect(progress.heaviest?.fact.heaviest.weightKg == 300)
    #expect(progress.hasChart(in: gym.log!.moment.zone))
    #expect(progress.gaps(in: gym.log!.moment.zone).count == 3)
    #expect(progress.window(now: gym.log!.moment.now, zone: gym.log!.moment.zone).estimates.count == 3)
    #expect(progress.logPlotPoints.count == 4)
  }

  @Test func bodyweightProgressRemainsVisibleBesideLoadedSets() throws {
    let (_, gym) = fixture()
    let zero = try session(gym, daysAgo: 2, kg: 0, reps: 12)
    _ = try session(gym, daysAgo: 1, kg: 10, reps: 12)
    let progress = try #require(gym.log).progress.movement(SeedExercises.all.first!.id)
    let zeroSet = try #require(gym.sets.first { $0.sessionId == zero.id })
    #expect(LogPresentation.progressEfforts(progress).last == PerformedFact(zeroSet))
    #expect(LogPresentation.progressEfforts(progress).map(\.weightKg) == [10, 0])
  }

  @Test func dateAxesDescribeOnlyTheVisibleCanvasAndClampOverscroll() {
    let first = Date(timeIntervalSince1970: 0)
    let thirtyDays = first.addingTimeInterval(2_592_000)
    let sixtyDays = first.addingTimeInterval(5_184_000)
    let last = first.addingTimeInterval(7_776_000)
    let chart = LogDatedChart(points: [], from: first, through: last, series: .strength)
    let middle = chart.dateInterval(in: CGRect(x: 306, y: 0, width: 300, height: 220), contentWidth: 912)
    let whole = chart.dateInterval(in: CGRect(x: 0, y: 0, width: 912, height: 220), contentWidth: 912)
    let leading = chart.dateInterval(in: CGRect(x: -30, y: 0, width: 336, height: 220), contentWidth: 912)
    let trailing = chart.dateInterval(in: CGRect(x: 606, y: 0, width: 336, height: 220), contentWidth: 912)
    #expect(middle == (thirtyDays...sixtyDays))
    #expect(whole == (first...last))
    #expect(leading == (first...thirtyDays))
    #expect(trailing == (sixtyDays...last))
    let empty = LogDatedChart(points: [], from: first, through: first, series: .bodyweight)
    let emptyInterval = empty.dateInterval(in: .zero, contentWidth: 0)
    #expect(emptyInterval == (first...first))
  }

  @Test func globalRenameKeepsIdentityAndFrozenPlan() throws {
    let (_, gym) = fixture()
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: "My press", pattern: "press", equipment: "barbell", stepKg: 2.5)
    gym.run(CreateExercise(exercise))
    let routine = Routine(id: gym.runner.mint(Routine.self), name: "Custom day", entries: [RoutineEntry(exerciseId: exercise.id, sets: [SetTarget(reps: 5, weightKg: 60)])])
    var draft = Draft(new: routine); gym.save(&draft)
    let now = gym.log!.moment.now, id = gym.runner.mint(Session.self)
    gym.run(ImportSession(id: id, startedAt: Instant(ms: now.ms - 600_000), finishedAt: now,
      sets: [ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: exercise.id, weightKg: 60, reps: 5, completedAt: now)], routineId: routine.id))
    let frozen = try #require(gym.sessions.first { $0.id == id }?.plan), history = gym.sets
    #expect(gym.run(RenameExercise(exercise.id, name: "New press"))?.refusal == nil)
    #expect(gym.catalogue.find(exercise.id)?.name == "New press")
    #expect(gym.sessions.first { $0.id == id }?.plan == frozen && gym.sets == history)
    #expect(gym.log?.progress.movement(exercise.id).sessions.count == 1)
    #expect(gym.run(RenameExercise(exercise.id, name: "New press"))?.receipt == nil)
    #expect(gym.run(RenameExercise(exercise.id, name: "  "))?.refusal != nil)
    #expect(gym.catalogue.find(exercise.id)?.name == "New press")
  }
}
