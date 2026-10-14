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
  func finished(_ id: String, exercise: ID<Exercise>, from start: Int64, to finish: Int64, sets: [Int64]) -> SignedOutWorkout {
    let session = Session(id: ID(RecordID(id)), startedAt: Instant(ms: start), finishedAt: Instant(ms: finish), closedBy: "finish")
    return SignedOutWorkout(session: session, sets: sets.enumerated().map { index, offset in
      TrainingSet(id: ID(RecordID("\(id)-set-\(index)")), sessionId: session.id, exerciseId: exercise, weightKg: 60, reps: 5,
                  note: "Private set note", completedAt: Instant(ms: start + offset))
    })
  }

  func recovered(_ recorder: TelemetryRecorder) -> [[String: String]] {
    recorder.entries.withLock { $0.filter { $0.name == "gym_import_recovery" }.map(\.properties) }
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
      == ["landed-open session-finished restoreSets [\"inside-set\", \"late-set\"] fix=false"])
    #expect(gym.fixWorkout(id) == nil)
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
    #expect(gym.discardWorkout(refusedCopy.session.id))
    #expect(gym.adoptionWorkouts.isEmpty && gym.workoutsToReview.isEmpty)

    #expect(recovered(recorder) == [
      ["action": "inspect", "reason": "unsent"],
      ["action": "keep", "reason": "session-overlap", "outcome": "refused"],
      ["action": "fix", "reason": "session-overlap"],
      ["action": "fix", "reason": "session-overlap", "outcome": "ok"],
      ["action": "retry", "reason": "unsent", "outcome": "ok"],
      ["action": "retry", "reason": "session-finished", "outcome": "ok"],
      ["action": "keep", "reason": "unsent", "outcome": "ok"],
      ["action": "discard", "reason": "unknown-exercise", "outcome": "ok"],
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
    #expect(local.currentAdoption?.product == "gym")
    await local.adopt(.add)
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
      ["action": "inspect", "reason": "session-overlap"],
      ["action": "fix", "reason": "session-overlap"],
      ["action": "fix", "reason": "session-overlap", "outcome": "ok"],
    ])
    remote.gym.stop(); local.gym.stop()
  }

  @Test func aSavedWorkoutsRefusalIsItsRowsNotTheRoomsAndOutlivesItsDismissal() async throws {
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

    gym.dismissNotice(owned.id)
    #expect(gym.recoveryNotices.map(\.notice.isDismissed) == [false, true] && gym.notices.map(\.id) == [room.id])
    #expect(waiting() == ["refused-on-the-phone unknown-exercise [\"\(owned.id)\"]"])
    #expect(gym.retryWorkout(copy.session.id))
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
    let accountWorkout = try #require(remote.gym.startWorkout())
    await remote.runtime?.engine.start()
    try await AppModelTests().workoutSettled(remote, accountWorkout)

    let connectivity = SwitchedConnectivity()
    let local = try LineageFlowTests().fixture(server, seed: 22, connectivity: connectivity)
    let finished = try #require(local.gym.startWorkout())
    local.gym.workout.add(ID("bench-press"))
    let finishedOffer = try #require(local.gym.workout.activityOffer())
    #expect(local.gym.workout.logActivityOffer(finishedOffer))
    await local.gym.workout.finish()
    #expect(local.gym.sessions.first { $0.id == finished }?.isOpen == false)
    let open = try #require(local.gym.startWorkout())
    local.gym.workout.add(ID("bench-press"))
    let openOffer = try #require(local.gym.workout.activityOffer())
    #expect(local.gym.workout.logActivityOffer(openOffer))
    let expected = local.gym.sets
    #expect(Set(expected.map { $0.id.description }) == [finishedOffer.setID, openOffer.setID])
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.currentAdoption?.product == "gym")
    #expect(try local.runner.read(Gym.scope) { try $0.commands().filter {
      $0.command.name == Gym.Commands.importSession && $0.command.args["id"] == finished.json
    }.count } == 1)
    #expect(local.gym.workout.activityOffer() == nil && !local.gym.workout.logActivityOffer(openOffer))
    await local.adopt(.add)
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
}
