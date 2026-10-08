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
    func offsetSeconds(at instant: Instant) -> Int { value.secondsFromGMT(for: LogPresentation.date(instant)) }
  }
  @Test(arguments: [("America/Santiago", "2026-09-06"), ("America/Havana", "2026-03-08"), ("Europe/Belgrade", "2026-03-29")])
  func momentsStayOnTheirDayAcrossOffsetChanges(value: (String, String)) throws {
    let day = try #require(LocalDay(value.1)), zone = try #require(TimeZone(identifier: value.0))
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
    let expected = try #require(calendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day)))
    #expect(LogPresentation.instant(day, in: CalendarZone(value: zone)).ms == Int64(expected.timeIntervalSince1970 * 1000))
  }

  @Test func finishedCorrectionPreservesPlanIdentityAndHistoryAndRetriesStorageFailure() throws {
    let (harness, gym) = fixture()
    let value = try session(gym, daysAgo: 1)
    let original = try #require(gym.sets.first { $0.sessionId == value.id })
    var correction = original; correction.weightKg = 80; correction.reps = 8; correction.rpe = 8.5; correction.note = "Private note"
    harness.failNextCommit()
    #expect(!gym.correctLoggedSet(original, to: correction, account: nil))
    #expect(gym.sets.first { $0.id == original.id } == original)
    #expect(gym.correctLoggedSet(original, to: correction, account: nil))
    #expect(gym.sets.first { $0.id == original.id } == correction)
    #expect(gym.sessions.first { $0.id == value.id } == value)
    #expect(!gym.correctLoggedSet(original, to: correction, account: nil))
    #expect(gym.refusal == .stale(original.id.ref, .predicted))
    #expect(gym.error == "This changed elsewhere. Review the latest version.")
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
    #expect(!gym.correctLoggedSet(original, to: original, account: nil))
    fault.point.withLock { $0 = nil }; gym.refresh()
    #expect(!gym.readFailed && gym.log?.sets(session: value.id) == saved)
    #expect(gym.log?.readout(session: value.id)?.workingSetCount == 1)
  }

  @Test func correctionRefusesChangedAccountAndGoneSet() throws {
    let (_, gym) = fixture(), value = try session(gym, daysAgo: 1)
    let original = try #require(gym.sets.first { $0.sessionId == value.id })
    var changed = original; changed.weightKg = 62.5
    #expect(!gym.correctLoggedSet(original, to: changed, account: "some-account"))
    gym.run(DeleteSet(original.id))
    #expect(!gym.correctLoggedSet(original, to: changed, account: nil))
    #expect(gym.error == "That set is no longer here.")
  }

  @Test func finishedCorrectionAcceptsCanonicalAdmissionAndRefusesCompetingEdit() throws {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000),
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let gym = GymModel(runner: harness.runner)
    let id = gym.runner.mint(Exercise.self)
    #expect(gym.run(CreateExercise(Exercise(id: id, name: "Test press", pattern: "press", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let session = try #require(gym.startWorkout())
    let set = TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: session, exerciseId: id,
                          weightKg: 60, reps: 5, completedAt: try gym.runner.moment().now)
    #expect(gym.run(AppendSet(set))?.receipt != nil)
    let original = try #require(gym.sets.first)
    #expect(original.setNumber == nil)
    harness.sync(); gym.refresh()
    var corrected = original; corrected.weightKg = 62.5
    #expect(gym.correctLoggedSet(original, to: corrected, account: nil))
    let latest = try #require(gym.sets.first)
    #expect(latest.weightKg == 62.5 && latest.setNumber == 1)
    var concurrent = latest; concurrent.note = "Another edit"
    #expect(gym.run(CorrectSet(concurrent))?.receipt != nil)
    var stale = latest; stale.reps = 8
    #expect(!gym.correctLoggedSet(latest, to: stale, account: nil) && gym.refusal == .stale(latest.id.ref, .predicted))
    #expect(gym.sets == [concurrent])
  }

  @Test func fixDraftAcceptsSignedLoadsClearEffortAndNotesAndRefusesBounds() throws {
    let (_, gym) = fixture(); _ = try session(gym, daysAgo: 1)
    var draft = FinishedSetDraft(try #require(gym.sets.first))
    draft.weight = "-20,5"; draft.reps = "99"; draft.rpe = nil; draft.note = ""
    #expect(draft.value?.weightKg == -20.5 && draft.value?.reps == 99 && draft.value?.rpe == nil && draft.value?.note == "")
    draft.weight = "1.2.3"; #expect(draft.problem == "One decimal point only.")
    draft.weight = "NaN"; #expect(draft.problem == "That is not a number yet.")
    draft.weight = "501"; #expect(draft.problem == "Between −500 and 500 kg — check the number.")
    draft.weight = "-500"; draft.reps = "100"; #expect(draft.problem == "Whole reps, 1–99.")
    draft.reps = "1"; draft.note = String(repeating: "é", count: 2001)
    #expect(draft.problem == "A set note runs to 4000 bytes.")
    draft.note = String(repeating: "é", count: 2000); #expect(draft.problem == nil)
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
    #expect(LogPresentation.comparison(set, preceding: [], plan: SessionPlan(routine: "Frozen", entries: [])) == "added today")
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
    let chart = LogDatedChart(points: [], from: first, through: last, gapDays: 21)
    let middle = chart.dateInterval(in: CGRect(x: 306, y: 0, width: 300, height: 220), contentWidth: 912)
    let whole = chart.dateInterval(in: CGRect(x: 0, y: 0, width: 912, height: 220), contentWidth: 912)
    let leading = chart.dateInterval(in: CGRect(x: -30, y: 0, width: 336, height: 220), contentWidth: 912)
    let trailing = chart.dateInterval(in: CGRect(x: 606, y: 0, width: 336, height: 220), contentWidth: 912)
    #expect(middle == (thirtyDays...sixtyDays))
    #expect(whole == (first...last))
    #expect(leading == (first...thirtyDays))
    #expect(trailing == (sixtyDays...last))
    let empty = LogDatedChart(points: [], from: first, through: first, gapDays: 7)
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
