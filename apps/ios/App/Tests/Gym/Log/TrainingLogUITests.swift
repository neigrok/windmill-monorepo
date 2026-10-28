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
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
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
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: false)
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
    let retainedPlan: JSON? = try runner.read(Gym.scope) { try $0.repository(Session.self).find(id, in: .stored)?.fields["plan"] }
    #expect(retainedPlan == plan)
    #expect(gym.run(DiscardSession(id))?.receipt != nil)
    #expect(telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_read" }.map(\.properties) } ==
            [["operation": "gym_read", "failure_kind": "unexpected"]])
    #expect(try runner.read(Gym.scope) { try $0.repository(Session.self).find(id, in: .stored) } == nil)
    #expect(telemetry.entries.withLock { $0.allSatisfy { !$0.properties.values.contains { $0.contains("PRIVATE_FROZEN_PLAN") } } })
  }

  @Test func dayGroupedTimelineFiltersOpenAndFutureAndPagesAllLocalRows() throws {
    let (_, gym) = fixture()
    for day in 1...35 { _ = try session(gym, daysAgo: day, kg: 60) }
    let open = gym.runner.mint(Session.self); gym.run(StartSession(id: open))
    let months = gym.logTimeline(limit: 30)
    let visible = months.flatMap(\.entries).compactMap { row -> Session? in if case .session(let value, _) = row.kind { value } else { nil } }
    #expect(visible.count == 30 && visible.allSatisfy { !$0.isOpen })
    let allRows = gym.logTimeline(limit: 60).flatMap(\.entries)
    let allSessions = allRows.filter { $0.priority == -1 }
    #expect(allSessions.count == 35)
    #expect(months.map(\.id) == months.map(\.id).sorted(by: >))
    #expect(visible.map(\.startedAt) == visible.map(\.startedAt).sorted(by: >))
  }

  @Test func allWeightsRemainVisibleAlongsideTheWeeklyStrengthMoment() throws {
    let (_, gym) = fixture()
    _ = try session(gym, daysAgo: 2, kg: 60)
    let last = try session(gym, daysAgo: 1, kg: 70)
    for (days, kg) in [(1, 82.0), (0, 82.2)] {
      var draft = Draft(new: WeighIn(day: gym.log!.moment.today.adding(days: -days), kg: kg)); gym.save(&draft)
    }
    let rows = gym.logTimeline(limit: 30).flatMap(\.entries).filter { $0.priority >= 0 }
    #expect(rows.map { row -> String in
      switch row.kind {
      case .weight(let weight): "weight:\(weight.kg)"
      case .best(_, let record): record.point.id == last.id ? "best" : "unexpected best"
      default: row.id
      }
    } == ["weight:82.2", "best", "weight:82.0"])
  }

  @Test func theNewestWeightAppearsEvenWithoutAWorkoutAndAllDaysAreKept() {
    let (_, gym) = fixture(), today = gym.log!.moment.today
    var newest = Draft(new: WeighIn(day: today, kg: 82.4)); gym.save(&newest)
    #expect(gym.finishedLogSessions.isEmpty)
    #expect(gym.logTimeline(limit: 30).flatMap(\.entries).map(\.id) == ["weight:\(today)"])
    for offset in 1...8 {
      var older = Draft(new: WeighIn(day: today.adding(days: -offset), kg: 83)); gym.save(&older)
    }
    #expect(gym.logTimeline(limit: 30).flatMap(\.entries).map(\.id) == (0...8).map { "weight:\(today.adding(days: -$0))" })
  }

  @Test func sameDayWeightsSitBetweenWorkoutsAndBackdatedWeightsStayOnTheirChosenDay() throws {
    let (harness, gym) = fixture(), today = try #require(gym.log?.moment.today)
    let first = try session(gym, daysAgo: 0)
    var weight = Draft(new: WeighIn(day: today, kg: 82.4)); gym.save(&weight)
    harness.advance(ms: 7_200_000); gym.refresh()
    let second = try session(gym, daysAgo: 0)
    var yesterday = Draft(new: WeighIn(day: today.adding(days: -1), kg: 83)); gym.save(&yesterday)
    let rows = gym.logTimeline(limit: 30).flatMap(\.entries)
    #expect(rows.map(\.id) == ["session:\(second.id)", "weight:\(today)", "session:\(first.id)", "weight:\(today.adding(days: -1))"])
    #expect(gym.bodyweight?.entry(on: today.adding(days: -1))?.time(in: gym.log!.moment.zone) == nil)
    let dates = gym.logTimeline(limit: 30).map(\.id)
    #expect(dates == [today.text, today.adding(days: -1).text])
  }

  @Test func pagingKeepsEveryWeightInEachLoadedDayWithoutDuplicatingIt() throws {
    let (_, gym) = fixture(), today = try #require(gym.log?.moment.today)
    for day in 1...35 {
      _ = try session(gym, daysAgo: day)
      var weight = Draft(new: WeighIn(day: today.adding(days: -day), kg: 82)); gym.save(&weight)
    }
    let firstPage = gym.logTimeline(limit: 30).flatMap(\.entries)
    let all = gym.logTimeline(limit: 60).flatMap(\.entries)
    #expect(firstPage.filter { $0.priority == 2 }.map(\.id) == (1...30).map { "weight:\(today.adding(days: -$0))" })
    #expect(all.filter { $0.priority == 2 }.map(\.id) == (1...35).map { "weight:\(today.adding(days: -$0))" })
    #expect(Set(all.map(\.id)).count == all.count)
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

  // Wednesday Mar 10, 2027: February trained in each of its four weeks is an annotation on its last day.
  @Test func aMonthMomentKeepsItsDateGroupAndIsNotAttachedToAWorkout() throws {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_804_680_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let gym = GymModel(runner: harness.runner), zone = try #require(gym.log?.moment.zone)
    let read = {
      gym.logTimeline(limit: 30).map { month in
        "\(month.id): " + month.entries.map { entry -> String in
          switch entry.kind {
          case .session(let session, _): LocalDay(session.startedAt, in: zone).text
          case .month(let first): LogPresentation.trainedEvery(first, dates: gym.dates)
          default: entry.id
          }
        }.joined(separator: ", ")
      }
    }
    for daysAgo in [37, 30, 23, 16, 9] { _ = try session(gym, daysAgo: daysAgo, kg: 0, reps: 12) }
    #expect(read() == ["2027-03-01: 2027-03-01", "2027-02-28: Trained every week of February",
                       "2027-02-22: 2027-02-22", "2027-02-15: 2027-02-15", "2027-02-08: 2027-02-08", "2027-02-01: 2027-02-01"])
    _ = try session(gym, daysAgo: 1, kg: 0, reps: 12)
    #expect(read() == ["2027-03-09: 2027-03-09", "2027-03-01: 2027-03-01", "2027-02-28: Trained every week of February",
                       "2027-02-22: 2027-02-22", "2027-02-15: 2027-02-15", "2027-02-08: 2027-02-08", "2027-02-01: 2027-02-01"])
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

  @Test func finishedDeleteAndDiscardPersistSessionReadout() throws {
    let (_, gym) = fixture(), value = try session(gym, daysAgo: 1)
    let set = try #require(gym.sets.first)
    let removed = try #require(gym.run(DeleteSet(set.id))?.receipt)
    #expect(gym.log?.readout(session: value.id)?.workingSetCount == 0)
    #expect(removed.releaseAt == nil && gym.log?.readout(session: value.id)?.volumeKg == 0)
    let discarded = try #require(gym.run(DiscardSession(value.id))?.receipt)
    #expect(gym.finishedLogSessions.isEmpty)
    #expect(discarded.releaseAt == nil && GymModel(runner: gym.runner).finishedLogSessions.isEmpty)
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
    #expect(LogPresentation.comparison(set, preceding: [set], plan: plan) == nil)
    #expect(LogPresentation.comparison(set, preceding: [], plan: SessionPlan(routine: "Frozen", entries: [])) == nil)
  }

  @Test func aMovementsPlanLineNamesItsTargetsOrThatThePlanDidNotHoldIt() {
    let bench = ID<Exercise>(RecordID("bench-press")), squat = ID<Exercise>(RecordID("back-squat"))
    let plan = SessionPlan(routine: "Push A", entries: [RoutineEntry(exerciseId: bench, sets: [SetTarget(reps: 5, weightKg: 60)])])
    #expect(LogPresentation.planLine(bench, plan: plan) == "plan 1 × 5 · 60")
    #expect(LogPresentation.planLine(squat, plan: plan) == "not in plan")
    #expect(LogPresentation.planLine(bench, plan: nil) == nil)
    let twice = SessionPlan(routine: "Push A", entries: plan.entries + plan.entries)
    #expect(LogPresentation.planLine(bench, plan: twice) == nil)
  }

  @Test func aSessionRowReadsItsWorkingSetsAndDuration() throws {
    let (_, gym) = fixture(), value = try session(gym, daysAgo: 1)
    let readout = try #require(gym.log?.readout(session: value.id))
    #expect(LogPresentation.sessionFacts(readout) == "1 working set · 33m")
    #expect(!gym.sessionIsUnsent(value.id))
  }

  // Saturday Sep 26: a Monday baseline, a Tuesday and a Wednesday best in one week, an equal Wednesday the next week.
  @Test func aRecordIsStatedOnceAndAFirstSessionSetsNone() throws {
    let (_, gym) = fixture()
    let baseline = try session(gym, daysAgo: 12, kg: 60), tuesday = try session(gym, daysAgo: 11, kg: 65)
    let wednesday = try session(gym, daysAgo: 10, kg: 70), equal = try session(gym, daysAgo: 3, kg: 70)
    let names = [baseline.id: "baseline", tuesday.id: "tuesday", wednesday.id: "wednesday", equal.id: "equal"]
    let rows = gym.logTimeline(limit: 30).flatMap(\.entries).map { row -> String in
      switch row.kind {
      case .session(let value, let recordDot): "\(names[value.id]!)\(recordDot ? " ●" : "")"
      case .best(_, let record): "best \(names[record.point.id]!) over \(names[record.previous.id]!)"
      default: row.id
      }
    }
    #expect(rows == ["equal", "wednesday", "best wednesday over tuesday", "tuesday ●", "baseline"])
    let record = try #require(gym.logRecords?.movements.values.first?.last)
    #expect(Readout.estimatedWeight(record.estimate) == "81.7")
    #expect(record.point.id == wednesday.id && record.previous.id == tuesday.id)
  }

  // The log's end is its total from two finished workouts, and an empty log with a workout open says none is finished yet.
  @Test func theEndCountsTheWorkoutsAndAnEmptyLogNamesTheOpenOne() throws {
    let (_, gym) = fixture()
    #expect([LogTab(gym: gym).emptyTitle, LogTab(gym: gym).total] == ["No workouts yet", nil])
    _ = try #require(gym.startWorkout(following: ID("back-squat")))
    #expect([LogTab(gym: gym).emptyTitle, LogTab(gym: gym).total] == ["No finished workouts yet", nil])
    _ = try session(gym, daysAgo: 3)
    #expect(LogTab(gym: gym).total == nil)
    _ = try session(gym, daysAgo: 2)
    #expect(LogTab(gym: gym).total == "2 workouts")
  }

  // While the open workout is hidden, iOS 18's head brings it back; iOS 26 leaves that door to the tab bar's accessory.
  @Test func theHiddenRowBringsBackAHiddenWorkoutWhereTheTabBarHasNoAccessory() throws {
    let (harness, _) = fixture(), recorder = TelemetryRecorder()
    let gym = GymModel(runner: harness.runner, telemetry: recorder)
    var routine = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Lower A", entries: [
      RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 5, weightKg: 100)])]))
    guard case .saved = gym.save(&routine) else { Issue.record("The routine was not saved"); return }
    _ = try #require(gym.startWorkout(routineId: routine.current.id))
    #expect(LogTab(gym: gym, tabBarAccessory: false).hiddenRow == nil)
    #expect(gym.hideWorkout() && !gym.workout.isPresented)
    let open = try #require(gym.openSession)
    let row = try #require(LogTab(gym: gym, tabBarAccessory: false).hiddenRow)
    #expect(row.title == "Lower A" && row.meta == "Open since \(gym.dates.time(open.startedAt))" && row.trailing == .door)
    #expect(LogTab(gym: gym, tabBarAccessory: true).hiddenRow == nil)
    LogTab(gym: gym, tabBarAccessory: false).openHiddenWorkout()
    #expect(gym.workout.isPresented && LogTab(gym: gym, tabBarAccessory: false).hiddenRow == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_hidden_workout" }.map(\.properties) } ==
            [["action": "hide"], ["action": "open", "door": "row"]])
  }

  @Test func theMomentEventIsAllowlisted() {
    #expect(TelemetryPrivacy.events.contains("gym_moment_opened"))
    #expect(TelemetryPrivacy.properties(["screen": "log"]) == ["screen": .label("log")])
  }

  @Test func aChartsWindowLineNamesItsSpanThenWhatItHolds() {
    #expect([ChartWindow.recent.line(recent: "90 days", holding: "6 weigh-ins"), ChartWindow.all.line(recent: "90 days", holding: "14 weigh-ins")]
            == ["last 90 days · 6 weigh-ins", "the whole series · 14 weigh-ins"])
  }

  @Test func chartAxesSitOnTheSeriesStep() {
    #expect(LogDatedChart.axis([61.88, 109.62], step: 5) == 60...110)
    #expect(LogDatedChart.axis([100, 100], step: 5) == 95...105)
    let bodyweight = LogDatedChart.axis([81.4, 84.5], step: 0.1)
    #expect([bodyweight.lowerBound, (bodyweight.lowerBound + bodyweight.upperBound) / 2, bodyweight.upperBound].map { Readout.weight($0) } == ["81.4", "83", "84.6"])
    let flat = LogDatedChart.axis([82.4], step: 0.1)
    #expect([flat.lowerBound, flat.upperBound].map { Readout.weight($0) } == ["81.4", "83.4"])
  }

  @Test func chartAxesAndCoordinatesRemainFiniteForExtremeLoads() {
    let maximum = Double.greatestFiniteMagnitude
    let first = Date(timeIntervalSince1970: 0), last = Date(timeIntervalSince1970: 2)
    for values in [[1e308], [maximum], [-maximum], [maximum.nextDown, maximum],
                   [-maximum, -maximum.nextDown], [8e307, 1e308], [-1e308, -8e307], [-maximum, 0, maximum]] {
      for series in [LogDatedChart.Series.strength, .bodyweight] {
        let points = values.enumerated().map { LogPlotPoint(id: "\($0.offset)", date: first, value: $0.element, label: "Load") }
        let chart = LogDatedChart(points: points, from: first, through: last, series: series, dates: GymDate(), caption: "Series")
        #expect(chart.low.isFinite && chart.high.isFinite && chart.low < chart.high)
        #expect(chart.low <= values.min()! && chart.high >= values.max()!)
        #expect(chart.ticks.allSatisfy { $0.isFinite && (chart.low...chart.high).contains($0) })
        #expect(Set(chart.ticks).count == 3)
        #expect((values + chart.ticks).allSatisfy { (6...170).contains(chart.y($0, height: 176)) })
        #expect(zip(values.sorted(), values.sorted().dropFirst()).allSatisfy { chart.y($0, height: 176) >= chart.y($1, height: 176) })
      }
    }
    let symmetric = LogDatedChart(points: [-maximum, 0, maximum].enumerated().map {
      LogPlotPoint(id: "\($0.offset)", date: first, value: $0.element, label: "Load")
    }, from: first, through: last, series: .strength, dates: GymDate(), caption: "Series")
    #expect(symmetric.ticks == [maximum, 0, -maximum])
    #expect([-maximum, 0, maximum].map { symmetric.y($0, height: 176) } == [170, 88, 6])
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
    #expect(progress.logPlotPoints(gym.dates).count == 4)
  }

  @Test func dateAxesDescribeOnlyTheVisibleCanvasAndClampOverscroll() {
    let first = Date(timeIntervalSince1970: 0)
    let thirtyDays = first.addingTimeInterval(2_592_000)
    let sixtyDays = first.addingTimeInterval(5_184_000)
    let last = first.addingTimeInterval(7_776_000)
    let chart = LogDatedChart(points: [], from: first, through: last, series: .strength, dates: GymDate(), caption: "last 12 weeks · 0 workouts")
    let middle = chart.dateInterval(in: CGRect(x: 306, y: 0, width: 300, height: 220), contentWidth: 912)
    let whole = chart.dateInterval(in: CGRect(x: 0, y: 0, width: 912, height: 220), contentWidth: 912)
    let leading = chart.dateInterval(in: CGRect(x: -30, y: 0, width: 336, height: 220), contentWidth: 912)
    let trailing = chart.dateInterval(in: CGRect(x: 606, y: 0, width: 336, height: 220), contentWidth: 912)
    #expect(middle == (thirtyDays...sixtyDays))
    #expect(whole == (first...last))
    #expect(leading == (first...thirtyDays))
    #expect(trailing == (sixtyDays...last))
    let empty = LogDatedChart(points: [], from: first, through: first, series: .bodyweight, dates: GymDate(), caption: "last 90 days · 0 weigh-ins")
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
