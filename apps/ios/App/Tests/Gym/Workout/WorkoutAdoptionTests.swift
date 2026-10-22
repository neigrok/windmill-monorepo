import Testing
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncTesting
import SyncSchema
import SyncStore
@testable import Windmill

// A saved copy the phone would hold after a sign-in, written straight into the device key.
struct SaveSignedOutWorkouts: Action {
  let workouts: [SignedOutWorkout]
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> [SignedOutWorkout] { try SignedOutWorkout.read(read) }
  func decide(_ loaded: [SignedOutWorkout], ids: IDSource) -> Decision<Void, GymRefusal> {
    var plan = Plan()
    plan.device(SignedOutWorkout.key, .object(JSON.Object(uniqueKeysWithValues: (loaded + workouts).map { ($0.session.id.description, $0.json) })))
    return .write(plan)
  }
}

@Suite @MainActor struct WorkoutAdoptionTests {
  func finished(_ id: String, routine: String? = nil, exercise: ID<Exercise>, from start: Int64, to finish: Int64, sets: [Int64]) -> SignedOutWorkout {
    let session = Session(id: ID(RecordID(id)), startedAt: Instant(ms: start), finishedAt: Instant(ms: finish), closedBy: "finish",
                          routineId: routine.map { _ in ID(RecordID("\(id)-routine")) },
                          plan: routine.map { SessionPlan(routine: $0, entries: [RoutineEntry(exerciseId: exercise)]) })
    return SignedOutWorkout(session: session, sets: sets.enumerated().map { index, offset in
      TrainingSet(id: ID(RecordID("\(id)-set-\(index)")), sessionId: session.id, exerciseId: exercise, weightKg: 60, reps: 5,
                  note: "Private set note", completedAt: Instant(ms: start + offset))
    })
  }

  func recovered(_ recorder: TelemetryRecorder) -> [[String: String]] {
    recorder.entries.withLock { $0.filter { $0.name == "gym_import_recovery" }.map(\.properties) }
  }

  @Test func inspectSaysAWorkoutIsOnItsWayUntilTheLogConfirmsIt() throws {
    let fixture = WorkoutStateTests(), (harness, gym) = try fixture.fixture(anonymous: false, telemetry: TelemetryRecorder())
    let now = fixture.start.ms
    let copy = finished("kept-copy", exercise: fixture.first, from: now - 60_000, to: now - 50_000, sets: [1_000])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [copy]))?.receipt != nil)
    #expect(gym.workoutsToReview.map(\.reason) == [.unsent] && gym.addingLine(copy.session.id) == nil)
    #expect(gym.keepAdoptedWorkout(copy.session.id))
    #expect(gym.workoutsToReview.isEmpty && gym.addingLine(copy.session.id) == "Adding \(Readout.noRoutine) to your log.")
    harness.sync(); gym.refresh()
    #expect(gym.adoptionWorkouts.isEmpty && gym.addingLine(copy.session.id) == nil)
  }

  // The log's head says what waits in one row: one workout is its own row, two or more count the ones that need the lifter.
  @Test func onThisPhoneIsOneRowWhateverWaits() throws {
    let fixture = WorkoutStateTests(), (_, gym) = try fixture.fixture(anonymous: false)
    let now = fixture.start.ms, day = gym.dates.day(Instant(ms: now - 60_000))
    let first = finished("first-copy", routine: "Push A", exercise: fixture.first, from: now - 60_000, to: now - 50_000, sets: [1_000])
    let second = finished("second-copy", routine: "Legs", exercise: fixture.first, from: now - 40_000, to: now - 30_000, sets: [1_000, 2_000])
    let read = { gym.waitingRows.map { "\($0.title) | \($0.reason ?? "on its way")" } }
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [first]))?.receipt != nil)
    #expect(read() == ["Push A · \(day) · 1 set | Not on your log yet — retry to add it."])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [second]))?.receipt != nil)
    #expect(read() == ["Legs · \(day) · 2 sets | Not on your log yet — retry to add it.",
                       "Push A · \(day) · 1 set | Not on your log yet — retry to add it."])
    #expect(OnThisPhoneSection.summary(gym.waitingRows) == "2 need you")
    #expect(gym.keepAdoptedWorkout(first.session.id))
    #expect(read().last == "Push A · \(day) · 1 set | on its way" && OnThisPhoneSection.summary(gym.waitingRows) == "1 needs you")
    #expect(gym.keepAdoptedWorkout(second.session.id) && OnThisPhoneSection.summary(gym.waitingRows) == "Adding…")
  }

  @Test func aDiscardRemovesItsLocalCopyDurablyAndRecordsOneOutcome() throws {
    let recorder = TelemetryRecorder(), fixture = WorkoutStateTests(), (_, gym) = try fixture.fixture(anonymous: false, telemetry: recorder)
    let now = fixture.start.ms
    let copy = finished("local-copy", exercise: fixture.first, from: now - 60_000, to: now - 50_000, sets: [1_000])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [copy]))?.receipt != nil)
    #expect(gym.discardWorkout(copy.session.id))
    #expect(gym.waitingWorkouts.isEmpty && gym.workoutsToReview.isEmpty && gym.adoptionWorkouts.isEmpty)
    #expect(GymModel(runner: gym.runner).adoptionWorkouts.isEmpty)
    #expect(recovered(recorder) == [["action": "discard", "reason": "unsent", "outcome": "completed"]])
  }

  @Test func reviewStepsOverAHarnessRecordBoundedLabelsAndMoveEveryRefusedWorkout() throws {
    let recorder = TelemetryRecorder(), fixture = WorkoutStateTests(), (harness, gym) = try fixture.fixture(anonymous: false, telemetry: recorder)
    let now = fixture.start.ms, squat = fixture.first
    let landed = finished("on-the-log", exercise: squat, from: now - 100_000, to: now - 80_000, sets: [1_000])
    #expect(gym.run(landed.importAction)?.receipt != nil)
    harness.sync(); gym.refresh()
    let unsent = finished("unsent-copy", exercise: squat, from: now - 60_000, to: now - 50_000, sets: [1_000])
    let crossing = finished("crossing", exercise: squat, from: now - 90_000, to: now - 70_000, sets: [1_000, 15_000])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [unsent, crossing]))?.receipt != nil)
    #expect(gym.workoutsToReview.map { "\($0.id) \($0.reason.rawValue) \($0.retry)" } == ["crossing session-overlap importWorkout", "unsent-copy unsent importWorkout"])
    #expect(gym.inspectWorkout(ID("nope")) == nil)
    #expect(gym.inspectWorkout(unsent.session.id)?.movementNames == [squat: "Workout squat"])

    gym.keepAdoptedWorkout(crossing.session.id)
    #expect(gym.refusal == .sessionOverlap(Refused(Gym.Codes.sessionOverlap, subject: crossing.session.id.ref, detail: ["sessionId": landed.session.id.json], path: .predicted)))
    #expect(gym.error == "Overlaps another workout — fix its times." && gym.adoptionWorkouts == [crossing, unsent])
    var fix = try #require(gym.fixWorkout(crossing.session.id))
    #expect(gym.fixRefusal(fix) == gym.refusal)
    fix.startedAt = Instant(ms: now - 40_000); fix.finishedAt = Instant(ms: now - 20_000)
    fix.sets[0].completedAt = Instant(ms: now - 39_000); fix.sets[1].completedAt = Instant(ms: now - 25_000)
    #expect(gym.fixRefusal(fix) == nil)
    #expect(gym.saveAndRetryWorkout(fix))
    #expect(gym.error == nil && gym.adoptionWorkouts == [fix.workout, unsent])
    #expect(gym.workoutsToReview.map(\.id) == [unsent.session.id])
    gym.retryWorkout(unsent.session.id)
    #expect(gym.workoutsToReview.isEmpty && gym.adoptionWorkouts.first == fix.workout)
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().map { $0.command.args["id"] } } == [crossing.session.id.json, unsent.session.id.json])
    harness.sync(); gym.refresh()
    #expect(gym.adoptionWorkouts.isEmpty)
    #expect(gym.sessions.map(\.id) == [crossing.session.id, unsent.session.id, landed.session.id])
    #expect(gym.sets.filter { $0.sessionId == crossing.session.id }.map(\.completedAt) == [Instant(ms: now - 39_000), Instant(ms: now - 25_000)])

    let id = ID<Session>("landed-open")
    #expect(gym.run(StartSession(id: id, startedAt: Instant(ms: now - 15_000)))?.receipt != nil)
    harness.sync(); gym.refresh()
    let inside = TrainingSet(id: ID("inside-set"), sessionId: id, exerciseId: squat, weightKg: 60, reps: 5, completedAt: Instant(ms: now - 12_000))
    let late = TrainingSet(id: ID("late-set"), sessionId: id, exerciseId: squat, weightKg: 65, reps: 3, note: "Private late note", completedAt: Instant(ms: now - 5_000))
    #expect(gym.run(AppendSet(inside))?.receipt != nil)
    #expect(gym.run(AppendSet(late))?.receipt != nil)
    #expect(gym.run(FinishSession(id: id, finishedAt: Instant(ms: now - 10_000)))?.receipt != nil)
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [SignedOutWorkout(session: Session(id: id, startedAt: Instant(ms: now - 15_000)), sets: [inside, late])]))?.receipt != nil)
    harness.server.refuse(next: 2, code: Gym.Codes.sessionFinished)
    harness.sync()
    gym.recoveryNotices = try harness.notices(GymRefusal.self); gym.refresh()
    #expect(gym.recoveryNotices.map(\.subject) == [inside.id.ref, late.id.ref] && gym.sets.filter { $0.sessionId == id }.isEmpty)
    #expect(gym.workoutsToReview.map { "\($0.id) \($0.reason.rawValue) \($0.retry) \($0.strandedSets.map(\.id.description)) fix=\($0.canFix)" }
      == ["landed-open session-finished restoreSets [\"inside-set\", \"late-set\"] fix=true"])
    #expect(gym.fixWorkout(id)?.sets.map(\.id) == [inside.id, late.id])
    gym.retryWorkout(id)
    #expect(gym.recoveryNotices.count == 2 && gym.workoutsToReview.isEmpty && gym.error == nil)
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().map(\.command.name) } == [Gym.Commands.correctSession, Gym.Commands.importSession])
    harness.sync(); gym.refresh()
    #expect(gym.adoptionWorkouts.isEmpty && gym.sessions.count == 5)
    let separate = try #require(gym.sets.first { $0.id == late.id }?.sessionId)
    #expect(separate != id && gym.sets.first { $0.id == inside.id }?.sessionId == id)
    #expect(gym.sessions.first { $0.id == id }?.finishedAt == Instant(ms: now - 10_000))
    let separateSession = try #require(gym.sessions.first { $0.id == separate })
    #expect(separateSession.startedAt == late.completedAt && separateSession.finishedAt == late.completedAt)

    let refusedCopy = finished("refused-copy", exercise: squat, from: now - 4_000, to: now - 3_000, sets: [500])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [refusedCopy]))?.receipt != nil)
    #expect(gym.keepAdoptedWorkout(refusedCopy.session.id))
    harness.server.refuse(code: Gym.Codes.unknownExercise)
    harness.sync()
    gym.recoveryNotices = try harness.notices(GymRefusal.self); gym.refresh()
    #expect(gym.workoutsToReview.map { "\($0.id) \($0.reason.rawValue) fix=\($0.canFix)" } == ["refused-copy unknown-exercise fix=true"])
    gym.refresh()
    #expect(gym.discardWorkout(refusedCopy.session.id))
    #expect(gym.adoptionWorkouts.isEmpty && gym.workoutsToReview.isEmpty)

    #expect(recovered(recorder) == [
      ["action": "inspect", "reason": "unsent", "state": "opened"],
      ["action": "keep", "reason": "session-overlap", "outcome": "refused"],
      ["action": "fix", "reason": "session-overlap", "state": "opened"],
      ["action": "fix", "reason": "session-overlap", "outcome": "completed"],
      ["action": "retry", "reason": "unsent", "outcome": "completed"],
      ["action": "fix", "reason": "session-finished", "state": "opened"],
      ["action": "retry", "reason": "session-finished", "outcome": "completed"],
      ["action": "keep", "reason": "unsent", "outcome": "completed"],
      ["action": "keep", "reason": "unknown-exercise", "outcome": "refused"],
      ["action": "discard", "reason": "unknown-exercise", "outcome": "completed"],
    ])
    for properties in recovered(recorder) {
      #expect(TelemetryPrivacy.properties(properties).count == properties.count)
      #expect(!properties.values.contains { $0.contains("Private") || $0.contains("squat") || $0.contains("set") })
    }
  }

  @Test func refusedImportIsReviewedInspectedFixedAndRetriedAgainstTheAccount() async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "refused-import-recovery@example.com")
    try await remote.signIn(identity)
    let now = try remote.runner.moment().now.ms
    let onTheLog = finished("account-finished", exercise: ID("bench-press"), from: now - 40_000, to: now - 37_000, sets: [1_000])
    #expect(try remote.runner.run(onTheLog.importAction).receipt != nil)
    await remote.runtime?.engine.start()
    try await AppModelTests().workoutSettled(remote, onTheLog.session.id)

    let recorder = TelemetryRecorder()
    let local = try LineageFlowTests().fixture(server, seed: 23, telemetry: recorder)
    let crossing = ID<Session>("phone-finished")
    #expect(try local.runner.run(StartSession(id: crossing, startedAt: Instant(ms: now - 39_000))).receipt != nil)
    let sets = (0..<2).map { index in
      TrainingSet(id: local.runner.mint(TrainingSet.self), sessionId: crossing, exerciseId: ID("bench-press"), weightKg: Double(60 + index), reps: 8,
                  note: "Private set \(index)", completedAt: Instant(ms: now - 39_000 + Int64(index + 1) * 1_000))
    }
    for set in sets { #expect(try local.runner.run(AppendSet(set)).receipt != nil) }
    #expect(try local.runner.run(FinishSession(id: crossing, finishedAt: Instant(ms: now - 36_000))).receipt != nil)
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.pendingAdoptions.map(\.product) == ["gym"])
    await local.adopt(.add, asked: local.pendingAdoptions)
    await local.runtime?.engine.start()
    for _ in 0..<200 where local.gym.recoveryNotices.isEmpty { try await Task.sleep(for: .milliseconds(50)); local.refresh() }

    let review = try #require(local.gym.workoutsToReview.first)
    #expect(local.gym.workoutsToReview.count == 1 && review.id == crossing && review.reason == .overlap && review.retry == .importWorkout)
    let notice = try #require(local.gym.recoveryNotices.first)
    #expect(local.gym.recoveryNotices.count == 1 && local.gym.notices.isEmpty && GymTransient(gym: local.gym).shown == nil)
    #expect(review.noticeIds == [notice.id] && review.refusal == notice.refusal && notice.subject == crossing.ref)
    #expect(review.workout.sets.map(\.fields) == sets.map(\.fields) && review.movementNames == [ID("bench-press"): "Bench Press"])
    #expect(local.gym.inspectWorkout(crossing) == review)
    var fix = try #require(local.gym.fixWorkout(crossing))
    #expect(local.gym.fixRefusal(fix) == .sessionOverlap(Refused(Gym.Codes.sessionOverlap, subject: crossing.ref, detail: ["sessionId": onTheLog.session.id.json], path: .predicted)))
    fix.startedAt = Instant(ms: now - 30_000); fix.finishedAt = Instant(ms: now - 27_000)
    fix.sets[0].completedAt = Instant(ms: now - 29_000); fix.sets[1].completedAt = Instant(ms: now - 28_000)
    #expect(local.gym.fixRefusal(fix) == nil)
    #expect(local.gym.saveAndRetryWorkout(fix))
    #expect(local.gym.adoptionWorkouts == [fix.workout] && local.gym.workoutsToReview.isEmpty && local.gym.notices.isEmpty)
    try await AppModelTests().workoutSettled(local, crossing)
    #expect(await WorkoutStateTests.until { local.refresh(); return local.gym.adoptionWorkouts.isEmpty })
    let moved = try #require(local.gym.sessions.first { $0.id == crossing })
    #expect(moved.startedAt == fix.startedAt && moved.finishedAt == fix.finishedAt && moved.closedBy == "finish")
    #expect(local.gym.sets.filter { $0.sessionId == crossing }.map { ($0.id, $0.completedAt, $0.note) }.elementsEqual(
      [(sets[0].id, Instant(ms: now - 29_000), "Private set 0"), (sets[1].id, Instant(ms: now - 28_000), "Private set 1")], by: ==))
    #expect(local.gym.sessions.contains { $0.id == onTheLog.session.id } && local.gym.notices.isEmpty)
    #expect(try local.runtime!.store.read { try $0.device().activeReplica.notices.allSatisfy(\.isDismissed) })
    #expect(recovered(recorder) == [
      ["action": "inspect", "reason": "session-overlap", "state": "opened"],
      ["action": "fix", "reason": "session-overlap", "state": "opened"],
      ["action": "fix", "reason": "session-overlap", "outcome": "completed"],
    ])
    remote.gym.stop(); local.gym.stop()
  }

  @Test func aSavedWorkoutsRefusalIsItsRowsNotTheRoomsAndARetryAnswersIt() async throws {
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server)
    try await model.signIn(server.identity(email: "recovery-notices@example.com"))
    let runtime = try #require(model.runtime), gym = model.gym
    await runtime.engine.start()
    #expect(await WorkoutStateTests.until { model.refresh(); return gym.log?.firstPullComplete == true })
    let now = try gym.runner.moment().now.ms
    var routine = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Private routine", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    server.state.withLock { $0.server.refuse(code: .invalid) }
    guard case .saved = gym.save(&routine) else { Issue.record("the routine is saved on the phone"); return }
    await runtime.engine.flushOnLeave()
    let copy = finished("refused-on-the-phone", exercise: ID("bench-press"), from: now - 90_000, to: now - 80_000, sets: [1_000])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [copy]))?.receipt != nil)
    server.state.withLock { $0.server.refuse(code: Gym.Codes.unknownExercise) }
    #expect(gym.keepAdoptedWorkout(copy.session.id))
    await runtime.engine.flushOnLeave()
    #expect(await WorkoutStateTests.until { model.refresh(); return gym.recoveryNotices.count == 2 })
    let room = try #require(gym.recoveryNotices.first), owned = try #require(gym.recoveryNotices.last)
    #expect(room.subject == routine.current.id.ref && owned.subject == copy.session.id.ref)
    #expect(gym.notices.map(\.id) == [room.id] && gym.error == nil)
    #expect(GymTransient(gym: gym).shown == .notice(room.id, "Gym could not accept this change. Try again."))
    let waiting = { gym.workoutsToReview.map { "\($0.id) \($0.reason.rawValue) \($0.noticeIds)" } }
    #expect(waiting() == ["refused-on-the-phone unknown-exercise [\"\(owned.id)\"]"])

    #expect(gym.retryWorkout(copy.session.id))
    #expect(gym.recoveryNotices.map(\.notice.isDismissed) == [false, true] && gym.notices.map(\.id) == [room.id])
    #expect(waiting().isEmpty && gym.adoptionWorkouts == [copy])
    await runtime.engine.flushOnLeave()
    #expect(await WorkoutStateTests.until { model.refresh(); return gym.adoptionWorkouts.isEmpty })
    #expect(gym.notices.map(\.id) == [room.id] && gym.recoveryNotices.map(\.notice.isDismissed) == [false, true])
    #expect(GymTransient(gym: gym).shown == .notice(room.id, "Gym could not accept this change. Try again."))
    gym.stop()
  }

  @Test func aRecoveryCommitThatFailsReportsUnderItsOwnOperationAndKeepsTheCopy() async throws {
    let server = JournalModelTransport(), fault = GymStoreFault(), recorder = TelemetryRecorder()
    let model = try LineageFlowTests().fixture(server, crashPoints: CrashPoints { point in
      if fault.point.withLock({ $0 == point }) { throw AppFailure(message: "private recovery failure detail") }
    }, telemetry: recorder)
    try await model.signIn(server.identity(email: "recovery-failure@example.com"))
    await model.runtime?.engine.start()
    let gym = model.gym
    #expect(await WorkoutStateTests.until { model.refresh(); return gym.log?.firstPullComplete == true })
    let now = try gym.runner.moment().now.ms
    let kept = finished("failing-keep", exercise: ID("bench-press"), from: now - 90_000, to: now - 80_000, sets: [1_000])
    let dropped = finished("failing-discard", exercise: ID("bench-press"), from: now - 70_000, to: now - 60_000, sets: [1_000])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [kept, dropped]))?.receipt != nil)
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    #expect(!gym.keepAdoptedWorkout(kept.session.id))
    #expect(!gym.discardWorkout(dropped.session.id))
    fault.point.withLock { $0 = nil }
    #expect(gym.adoptionWorkouts == [dropped, kept] && gym.workoutsToReview.map(\WorkoutRecovery.id) == [dropped.session.id, kept.session.id])
    #expect(gym.error == "Gym could not save this change. Try again.")
    #expect(recovered(recorder) == [
      ["action": "keep", "reason": "unsent", "outcome": "failed"],
      ["action": "discard", "reason": "unsent", "outcome": "failed"],
    ])
    let failures = recorder.entries.withLock { $0.filter { $0.name == "client_error" && $0.properties["operation"]?.hasPrefix("gym_import_") == true } }
    #expect(failures.map(\.properties) == [["operation": "gym_import_keep", "failure_kind": "storage"],
                                            ["operation": "gym_import_discard", "failure_kind": "storage"]])
    #expect(failures.allSatisfy { TelemetryPrivacy.properties($0.properties).count == 2 })
    gym.stop()
  }

  @Test func liveActivityOffersCannotCrossConflictingAdoptionOrKeepImports() async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "activity-conflict-adoption@example.com")
    try await remote.signIn(identity)
    let accountWorkout = try #require(remote.gym.startWorkout(following: ID("bench-press")))
    await remote.runtime?.engine.start()
    try await AppModelTests().workoutSettled(remote, accountWorkout)

    let connectivity = SwitchedConnectivity()
    let local = try LineageFlowTests().fixture(server, seed: 22, connectivity: connectivity)
    let finished = try #require(local.gym.startWorkout(following: ID("bench-press")))
    let finishedOffer = try #require(local.gym.workout.activityOffer())
    #expect(local.gym.workout.logActivityOffer(finishedOffer))
    await local.gym.workout.finish()
    #expect(local.gym.sessions.first { $0.id == finished }?.isOpen == false)
    let open = try #require(local.gym.startWorkout(following: ID("bench-press")))
    let openOffer = try #require(local.gym.workout.activityOffer())
    #expect(local.gym.workout.logActivityOffer(openOffer))
    let expected = local.gym.sets
    #expect(Set(expected.map { $0.id.description }) == [finishedOffer.setID, openOffer.setID])
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.pendingAdoptions.map(\.product) == ["gym"])
    #expect(try local.runner.read(Gym.scope) { try $0.commands().filter {
      $0.command.name == Gym.Commands.importSession && $0.command.args["id"] == finished.json
    }.count } == 1)
    #expect(local.gym.workout.activityOffer() == nil && !local.gym.workout.logActivityOffer(openOffer))
    await local.adopt(.add, asked: local.pendingAdoptions)
    await local.runtime?.engine.start()
    try await AppModelTests().workoutSettled(local, finished)
    #expect(await WorkoutStateTests.until {
      local.refresh()
      return (try? local.runner.read(Gym.scope) { read in
        for set in expected where set.sessionId == finished {
          guard let row = try read.confirmed(TrainingSet.self, set.id), row.isVisible else { return false }
          let imported = try TrainingSet(Fields(row))
          guard imported.id == set.id, imported.fields == set.fields else { return false }
        }
        return local.gym.adoptionWorkouts.map { $0.session.id } == [open]
      }) == true
    })
    #expect(local.account == identity.account && local.gym.openSession?.id == accountWorkout)
    #expect(local.gym.adoptionWorkouts.map { $0.session.id } == [open])
    #expect(!local.gym.workout.logActivityOffer(finishedOffer) && !local.gym.workout.logActivityOffer(openOffer))
    #expect(local.gym.workout.activityOffer() == nil)
    #expect(Set(local.gym.sets.filter { $0.sessionId == finished }.map { $0.id.description }) == [finishedOffer.setID])
    connectivity.set(online: false)
    for _ in 0..<100 where local.runtime!.engine.status.online { try await Task.sleep(for: .milliseconds(5)) }
    #expect(!local.runtime!.engine.status.online)
    local.gym.keepAdoptedWorkout(open)
    local.gym.keepAdoptedWorkout(open)
    #expect(try local.runner.read(Gym.scope) { try $0.commands().filter { $0.command.name == Gym.Commands.importSession && $0.command.args["id"] == open.json }.count } == 1)
    #expect(!local.gym.workout.logActivityOffer(openOffer) && local.gym.openSession?.id == accountWorkout)
    connectivity.set(online: true)
    local.runtime!.engine.foreground()
    try await AppModelTests().workoutSettled(local, open)
    #expect(await WorkoutStateTests.until { local.refresh(); return local.gym.adoptionWorkouts.isEmpty })
    #expect(local.gym.adoptionWorkouts.isEmpty && local.gym.openSession?.id == accountWorkout)
    #expect(Set(local.gym.sets.map { $0.id.description }) == [finishedOffer.setID, openOffer.setID])
    #expect(local.gym.sets.allSatisfy { $0.sessionId != accountWorkout })
    #expect(local.gym.sessions.first { $0.id == open }?.finishedAt == expected.first { $0.sessionId == open }?.completedAt)
    #expect(local.gym.restoreWorkout())
    local.gym.workout.add(ID("bench-press"))
    let resumed = try #require(local.gym.workout.activityOffer())
    #expect(resumed.sessionID == accountWorkout.description && resumed.ownerID != finishedOffer.ownerID && resumed.ownerID != openOffer.ownerID)
    #expect(resumed.setID != finishedOffer.setID && resumed.setID != openOffer.setID)
    #expect(!local.gym.workout.logActivityOffer(finishedOffer) && !local.gym.workout.logActivityOffer(openOffer))
    #expect(local.gym.workout.activityOffer() == resumed)
    #expect(Set(local.gym.sets.map { $0.id.description }) == [finishedOffer.setID, openOffer.setID])
    remote.gym.stop(); local.gym.stop()
  }

  // A restart is one decision: the phone refuses the whole copy at the first set it would refuse, and once corrected the
  // start and every set queue together, so no valid set is ever left behind a permanent adding.
  @Test func aRestartSendsEverySetOrNone() throws {
    let recorder = TelemetryRecorder(), fixture = WorkoutStateTests(), (harness, gym) = try fixture.fixture(anonymous: false, telemetry: recorder)
    let now = fixture.start.ms, squat = fixture.first
    let id = ID<Session>("open-copy-restart"), session = Session(id: id, startedAt: Instant(ms: now - 30_000))
    let s1 = TrainingSet(id: ID("restart-set-1"), sessionId: id, exerciseId: squat, weightKg: 60, reps: 5, completedAt: Instant(ms: now - 29_000))
    let s2 = TrainingSet(id: ID("restart-set-2"), sessionId: id, exerciseId: ID("ghost-movement"), weightKg: 20, reps: 10, completedAt: Instant(ms: now - 28_000))
    let s3 = TrainingSet(id: ID("restart-set-3"), sessionId: id, exerciseId: squat, weightKg: 65, reps: 5, completedAt: Instant(ms: now - 27_000))
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [SignedOutWorkout(session: session, sets: [s1, s2, s3])]))?.receipt != nil)
    #expect(gym.workoutsToReview.map { "\($0.id) \($0.reason.rawValue) \($0.retry) fix=\($0.canFix)" } == ["open-copy-restart unknown-exercise restartWorkout fix=true"])
    var fix = try #require(gym.fixWorkout(id))
    #expect(gym.fixRefusal(fix) == .unknownExercise(Refused(Gym.Codes.unknownExercise, subject: s2.id.ref, path: .predicted)))
    #expect(!gym.saveAndRetryWorkout(fix) && gym.error == "A movement is missing — fix its sets, then retry.")
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().isEmpty } && gym.sets.isEmpty)
    fix.sets[1].exerciseId = squat
    #expect(gym.fixRefusal(fix) == nil && gym.saveAndRetryWorkout(fix))
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().map(\.command.name) } == [Gym.Commands.start])
    #expect(gym.sets.map(\.id) == [s1.id, s2.id, s3.id] && gym.openSession?.id == id && gym.workoutsToReview.isEmpty)
    harness.sync(); gym.refresh()
    #expect(gym.adoptionWorkouts.isEmpty && gym.sets.filter { $0.sessionId == id }.count == 3 && gym.openSession?.id == id)
    #expect(recovered(recorder).map { $0["outcome"] ?? $0["state"]! } == ["opened", "refused", "completed"])
  }

  // A landed workout whose saved sets the log does not draw is a row with Retry, never adding; while it is open the
  // retry appends them into it in one plan.
  @Test func aLandedOpenWorkoutsMissingSetsAreARowAndRetryAppendsThem() throws {
    let fixture = WorkoutStateTests(), (harness, gym) = try fixture.fixture(anonymous: false)
    let now = fixture.start.ms, squat = fixture.first
    let id = ID<Session>("landed-still-open")
    #expect(gym.run(StartSession(id: id, startedAt: Instant(ms: now - 15_000)))?.receipt != nil)
    harness.sync(); gym.refresh()
    let a = TrainingSet(id: ID("open-stranded-a"), sessionId: id, exerciseId: squat, weightKg: 60, reps: 5, completedAt: Instant(ms: now - 12_000))
    let b = TrainingSet(id: ID("open-stranded-b"), sessionId: id, exerciseId: squat, weightKg: 62.5, reps: 5, completedAt: Instant(ms: now - 11_000))
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [SignedOutWorkout(session: Session(id: id, startedAt: Instant(ms: now - 15_000)), sets: [a, b])]))?.receipt != nil)
    let row = try #require(gym.workoutsToReview.first)
    #expect(row.reason == .unsent && row.retry == .restoreSets && row.strandedSets.map(\.id) == [a.id, b.id] && row.canFix)
    #expect(row.line == "Not on your log yet — retry to add it." && row.discardTitle == "Discard 2 sets")
    #expect(gym.retryWorkout(id) && gym.error == nil)
    #expect(gym.sets.filter { $0.sessionId == id }.map(\.id) == [a.id, b.id] && gym.workoutsToReview.isEmpty)
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().filter { $0.command.name != Gym.Commands.start }.isEmpty })
    harness.sync(); gym.refresh()
    #expect(gym.adoptionWorkouts.isEmpty && gym.sets.filter { $0.sessionId == id }.count == 2 && gym.openSession?.id == id)
  }

  // A refused recovery correction has the session as its subject; its reason, the newest the copy owns, names the row.
  @Test func aRefusedCorrectionsReasonReachesTheRow() throws {
    let fixture = WorkoutStateTests(), (harness, gym) = try fixture.fixture(anonymous: false)
    let now = fixture.start.ms, squat = fixture.first
    let id = ID<Session>("landed-correction")
    #expect(gym.run(StartSession(id: id, startedAt: Instant(ms: now - 15_000)))?.receipt != nil)
    harness.sync(); gym.refresh()
    let a = TrainingSet(id: ID("correction-a1"), sessionId: id, exerciseId: squat, weightKg: 60, reps: 5, completedAt: Instant(ms: now - 12_000))
    #expect(gym.run(AppendSet(a))?.receipt != nil)
    #expect(gym.run(FinishSession(id: id, finishedAt: Instant(ms: now - 10_000)))?.receipt != nil)
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [SignedOutWorkout(session: Session(id: id, startedAt: Instant(ms: now - 15_000)), sets: [a])]))?.receipt != nil)
    harness.server.refuse(next: 1, code: Gym.Codes.sessionFinished)
    harness.sync()
    gym.recoveryNotices = try harness.notices(GymRefusal.self); gym.refresh()
    #expect(gym.workoutsToReview.first?.reason == .strandedSets && gym.workoutsToReview.first?.title(gym.dates).hasPrefix("1 set from") == true)
    #expect(gym.retryWorkout(id))
    harness.server.refuse(next: 1, code: .invalid)
    harness.sync()
    gym.recoveryNotices = try harness.notices(GymRefusal.self); gym.refresh()
    let row = try #require(gym.workoutsToReview.first)
    #expect(row.reason == .other && row.strandedSets.map(\.id) == [a.id] && row.primary == .fix && row.noticeIds.last == gym.recoveryNotices.last?.id)
    #expect(gym.recoveryNotices.map(\.subject) == [a.id.ref, id.ref] && gym.notices.isEmpty)
  }

  // Stranded sets outside their workout's window become a saved copy of their own: its refusal is that copy's row, with
  // Fix, and never the room's band; the workout they left is confirmed and leaves.
  @Test func strandedSetsOutsideTheWindowBecomeTheirOwnFixableCopy() throws {
    let fixture = WorkoutStateTests(), (harness, gym) = try fixture.fixture(anonymous: false)
    let now = fixture.start.ms, squat = fixture.first
    let id = ID<Session>("landed-late-copy")
    #expect(gym.run(StartSession(id: id, startedAt: Instant(ms: now - 60_000)))?.receipt != nil)
    harness.sync(); gym.refresh()
    let late = TrainingSet(id: ID("late-outside-1"), sessionId: id, exerciseId: squat, weightKg: 70, reps: 3, completedAt: Instant(ms: now - 5_000))
    #expect(gym.run(AppendSet(late))?.receipt != nil)
    #expect(gym.run(FinishSession(id: id, finishedAt: Instant(ms: now - 30_000)))?.receipt != nil)
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [SignedOutWorkout(session: Session(id: id, startedAt: Instant(ms: now - 60_000)), sets: [late])]))?.receipt != nil)
    harness.server.refuse(next: 1, code: Gym.Codes.sessionFinished)
    harness.sync()
    gym.recoveryNotices = try harness.notices(GymRefusal.self); gym.refresh()
    #expect(gym.workoutsToReview.map(\.reason) == [.strandedSets])
    #expect(gym.retryWorkout(id))
    let separate = try #require(gym.adoptionWorkouts.first { $0.session.id != id })
    #expect(separate.sets.map { ($0.id, $0.sessionId) }.elementsEqual([(late.id, separate.session.id)], by: ==))
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().map { "\($0.command.name) \($0.command.args["id"] ?? .null)" } } == ["\(Gym.Commands.importSession) \(separate.session.id.json)"])
    harness.server.refuse(next: 1, code: Gym.Codes.sessionOverlap)
    harness.sync()
    gym.recoveryNotices = try harness.notices(GymRefusal.self); gym.refresh()
    let newest = try #require(gym.recoveryNotices.last)
    #expect(newest.subject == separate.session.id.ref && separate.owns(newest) && gym.notices.isEmpty)
    #expect(gym.adoptionWorkouts.map(\.session.id) == [separate.session.id])
    #expect(gym.workoutsToReview.map { "\($0.id) \($0.reason.rawValue) \($0.retry) fix=\($0.canFix)" } == ["\(separate.session.id) session-overlap importWorkout fix=true"])
    #expect(gym.workoutsToReview.first?.primary == .fix)
    #expect(gym.fixWorkout(separate.session.id)?.sets.map(\.id) == [late.id])
  }

  // A copy kept for a stranded set owns the gestures recovery queued, not every later write on its records: a refused
  // edit of a set that landed reaches the room's band.
  @Test func aSavedCopyOwnsOnlyRecoverysGestures() async throws {
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server)
    try await model.signIn(server.identity(email: "recovery-owns@example.com"))
    let runtime = try #require(model.runtime), gym = model.gym
    await runtime.engine.start()
    #expect(await WorkoutStateTests.until { model.refresh(); return gym.log?.firstPullComplete == true })
    let now = try gym.runner.moment().now.ms
    let id = ID<Session>("owned-session"), bench = ID<Exercise>("bench-press")
    #expect(gym.run(StartSession(id: id, startedAt: Instant(ms: now - 60_000)))?.receipt != nil)
    await runtime.engine.flushOnLeave()
    let stranded = TrainingSet(id: ID("owned-stranded"), sessionId: id, exerciseId: bench, weightKg: 60, reps: 5, completedAt: Instant(ms: now - 50_000))
    server.state.withLock { $0.server.refuse(code: Gym.Codes.sessionFinished) }
    #expect(gym.run(AppendSet(stranded))?.receipt != nil)
    await runtime.engine.flushOnLeave()
    let landed = TrainingSet(id: ID("owned-landed"), sessionId: id, exerciseId: bench, weightKg: 60, reps: 5, completedAt: Instant(ms: now - 40_000))
    #expect(gym.run(AppendSet(landed))?.receipt != nil)
    #expect(gym.run(FinishSession(id: id, finishedAt: Instant(ms: now - 30_000)))?.receipt != nil)
    await runtime.engine.flushOnLeave()
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [SignedOutWorkout(session: Session(id: id, startedAt: Instant(ms: now - 60_000)), sets: [stranded, landed])]))?.receipt != nil)
    #expect(await WorkoutStateTests.until { model.refresh(); return gym.recoveryNotices.count == 1 && gym.sets.contains { $0.id == landed.id } })
    #expect(gym.workoutsToReview.map { "\($0.id) \($0.reason.rawValue) \($0.strandedSets.map(\.id.description))" } == ["owned-session session-finished [\"owned-stranded\"]"] && gym.notices.isEmpty)
    let current = try #require(gym.sets.first { $0.id == landed.id })
    var edited = current; edited.weightKg = 70
    server.state.withLock { $0.server.refuse(code: .invalid) }
    #expect(gym.run(CorrectSet(edited, original: current))?.receipt != nil)
    await runtime.engine.flushOnLeave()
    #expect(await WorkoutStateTests.until { model.refresh(); return gym.recoveryNotices.count == 2 })
    #expect(gym.notices.map(\.subject) == [landed.id.ref] && gym.error == "Gym could not accept this change. Try again.")
    #expect(gym.workoutsToReview.map(\.reason) == [.strandedSets])
    gym.stop()
  }

  // The saved workouts are parsed and reconciled once per engine change, not on every refresh.
  @Test func savedWorkoutsAreReadOncePerChange() async throws {
    let fault = WorkoutFaultTransport(), runtime = try WorkoutStateTests.faultRuntime(fault), engine = runtime.engine
    let identity = fault.model.identity(email: "recovery-read-once@example.com")
    #expect(try await engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    let copy = finished("read-once", exercise: WorkoutStateTests().first, from: 1_000_000, to: 2_000_000, sets: [1_000])
    #expect(gym.run(SaveSignedOutWorkouts(workouts: [copy]))?.receipt != nil)
    #expect(gym.adoptionWorkouts == [copy])
    gym.adoptionWorkouts = []
    gym.refresh()
    #expect(gym.adoptionWorkouts.isEmpty, "a refresh with nothing changed reads no saved workout")
    #expect(gym.run(CreateExercise(Exercise(id: ID("read-once-movement"), name: "Read once", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    #expect(gym.adoptionWorkouts == [copy], "a change reads them again")
    gym.stop()
  }
}
