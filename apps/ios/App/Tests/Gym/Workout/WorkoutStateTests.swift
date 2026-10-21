import Foundation
import Testing
import Synchronization
import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import enum SyncEngine.Reply
import SyncModelServer
import SyncSchema
import SyncStore
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct WorkoutStateTests {
  let start = Instant(ms: 1_790_424_000_000)
  var first: ID<Exercise> { ID("workout-squat") }
  var second: ID<Exercise> { SeedExercises.all[1].id }
  var third: ID<Exercise> { SeedExercises.all[2].id }

  func fixture(anonymous: Bool = true, telemetry: any Telemetry = NoopTelemetry()) throws -> (Harness, GymModel) {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: start, account: anonymous ? nil : "workout-tests",
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    // The model server starts without the app's seed catalogue.
    let exercise = Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)
    #expect(try harness.runner.run(CreateExercise(exercise)).receipt != nil)
    if !anonymous {
      harness.sync()
      #expect(try harness.notices(GymRefusal.self).isEmpty)
    }
    return (harness, GymModel(runner: harness.runner, telemetry: telemetry))
  }

  func routine(_ gym: GymModel, scheme: [SetTarget]) throws -> Routine {
    var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Private training name", entries: [
      RoutineEntry(exerciseId: first, sets: scheme), RoutineEntry(exerciseId: second),
    ]))
    #expect(saved(gym.save(&draft)))
    return try #require(gym.routines.first { $0.id == draft.current.id })
  }

  func begin(_ gym: GymModel, routine: Routine? = nil) throws -> WorkoutState {
    _ = try #require(gym.startWorkout(routineId: routine?.id))
    if routine == nil { gym.workout.add(first) }
    return gym.workout
  }

  func value(_ gym: GymModel, session: Session, exercise: ID<Exercise>? = nil, weight: Double = 80, reps: Int = 5,
             kind: String = "working", at: Instant? = nil) -> TrainingSet {
    TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: session.id, exerciseId: exercise ?? first,
                weightKg: weight, reps: reps, kind: kind, completedAt: at ?? start)
  }

  func finished(_ gym: GymModel, routine: Routine? = nil) -> Session {
    Session(id: gym.runner.mint(Session.self), startedAt: start, finishedAt: Instant(ms: start.ms + 60_000),
            closedBy: "finish", routineId: routine?.id, plan: routine.map(SessionPlan.init))
  }

  @Test func explicitStartRefusesExistingWorkoutAndAdoptsItsIdentity() throws {
    let (_, gym) = try fixture(), workout = try begin(gym), existing = try #require(workout.sessionId)
    #expect(gym.startWorkout() == existing)
    #expect(gym.sessions.map(\.id) == [existing] && gym.openSession?.id == existing)
    #expect(gym.refusal != nil && gym.error == "Finish the open workout first.")
    #expect(workout.sessionId == existing)
  }

  @Test(arguments: ["load", "reps"])
  func rackEditReplacesTheDurableOfferAtFlushBeforeColdLaunch(field: String) throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    let old = try #require(workout.activityOffer())
    if field == "load" { workout.weightKg = old.weightKg + 2.5 } else { workout.reps = old.reps + 1 }
    #expect(gym.flush())
    let durable = try #require(try workout.activityRecord()?.offer)
    #expect(durable != old && durable.setID != old.setID)
    #expect(durable.weightKg == workout.weightKg && durable.reps == workout.reps)
    let reopened = GymModel(runner: harness.runner), cold = reopened.workout
    #expect(cold.weightKg == workout.weightKg && cold.reps == workout.reps)
    #expect(!cold.logActivityOffer(old) && cold.sets.isEmpty)
    #expect(try harness.drawn(TrainingSet.self).isEmpty)
    #expect(cold.logActivityOffer(durable))
    #expect(cold.sets.map(\.id.description) == [durable.setID])
  }

  @Test(arguments: ["load", "reps"])
  func failedRackOfferWriteRejectsTheEditAndRevokesBeforeColdLaunch(field: String) throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixture(telemetry: recorder), workout = try begin(gym)
    let old = try #require(workout.activityOffer())
    harness.failNextCommit()
    if field == "load" { workout.weightKg = old.weightKg + 2.5 } else { workout.reps = old.reps + 1 }
    #expect(!workout.flushRack())
    #expect(workout.weightKg == old.weightKg && workout.reps == old.reps)
    #expect(workout.message == "The rack could not be changed. Try again.")
    #expect(try workout.activityRecord()?.offer == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == [["operation": "gym_activity_update", "failure_kind": "storage"]])
    let reopened = GymModel(runner: harness.runner), cold = reopened.workout
    #expect(!cold.logActivityOffer(old) && cold.sets.isEmpty)
    #expect(try harness.drawn(TrainingSet.self).isEmpty)
  }

  @Test func unavailableRackStorageRejectsBothWritesAndRecoversWithoutAcceptingTheEdit() throws {
    let fault = GymStoreFault(), recorder = TelemetryRecorder()
    let runtime = try GymModelTests().runtime(failing: fault, telemetry: recorder)
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: recorder)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let workout = try begin(gym), old = try #require(workout.activityOffer())
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    defer { fault.point.withLock { $0 = nil } }
    workout.weightKg = old.weightKg + 2.5
    #expect(!workout.flushRack())
    #expect(workout.weightKg == old.weightKg && workout.reps == old.reps)
    #expect(workout.message == "The rack could not be changed. Try again." && gym.readFailed)
    #expect(try workout.activityRecord()?.offer == old)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == [
      ["operation": "gym_activity_update", "failure_kind": "storage"],
      ["operation": "gym_activity_update", "failure_kind": "storage"],
    ])
    let reopened = GymModel(runner: runtime.runner, runtime: runtime), cold = reopened.workout
    #expect(cold.weightKg == old.weightKg && !cold.logActivityOffer(old) && cold.sets.isEmpty)
    fault.point.withLock { $0 = nil }
    cold.retryRead(); cold.weightKg = old.weightKg + 2.5
    let replacement = try #require(cold.activityOffer())
    #expect(replacement.weightKg == old.weightKg + 2.5 && replacement.setID != old.setID)
    #expect(!cold.logActivityOffer(old) && cold.sets.isEmpty)
    #expect(cold.logActivityOffer(replacement) && cold.sets.map(\.id.description) == [replacement.setID])
  }

  @Test func delayedRackSaveDoesNotRetainOrAccessReleasedOwner() async throws {
    weak var owner: GymModel?
    let retained = try autoreleasepool {
      let (_, gym) = try fixture(), workout = try begin(gym)
      owner = gym
      workout.weightKg = 47.5
      return workout
    }
    #expect(owner == nil)
    try await Task.sleep(for: .milliseconds(90))
    #expect(owner == nil && retained.weightKg == 47.5)
  }

  @Test func rapidRackEditsSurviveReconcileAndFlushBeforeAccountChange() throws {
    let (_, gym) = try fixture(), workout = try begin(gym), session = try #require(workout.session)
    workout.weightKg = 55; workout.reps = 8; workout.weightKg = 57.5
    #expect(workout.weightKg == 57.5 && workout.reps == 8)
    #expect(gym.run(AppendSet(value(gym, session: session, weight: 75, reps: 6)))?.receipt != nil)
    workout.reconcile()
    #expect(workout.weightKg == 57.5 && workout.reps == 8)
    #expect(gym.flush())
    let offer = try #require(try workout.activityRecord()?.offer)
    #expect(offer.weightKg == 57.5 && offer.reps == 8)
    workout.weightKg = 60
    gym.accountChanging = true
    #expect(!workout.flushRack())
    #expect(workout.weightKg == 57.5 && workout.reps == 8)
    #expect(try workout.activityRecord()?.offer == offer)
  }

  @Test func hidingAndRestoringWorkoutIsDurableAndKeepsItsSets() throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    workout.logSet()
    let session = try #require(workout.session), retained = workout.sets
    #expect(gym.hideWorkout() && gym.workoutHidden && !workout.isPresented)
    #expect(workout.session == session && workout.sets == retained && gym.openSession?.id == session.id)
    let reopened = GymModel(runner: harness.runner)
    #expect(reopened.workoutHidden && !reopened.workout.isPresented && reopened.workout.sets == retained)
    harness.failNextCommit()
    #expect(!reopened.restoreWorkout() && reopened.workoutHidden && !reopened.workout.isPresented)
    #expect(reopened.restoreWorkout() && !reopened.workoutHidden && reopened.workout.isPresented)
    #expect(reopened.workout.session == session && reopened.workout.sets == retained)
    harness.failNextCommit()
    #expect(!reopened.hideWorkout() && !reopened.workoutHidden && reopened.workout.isPresented)
  }

  @Test func explicitStartRestoresHiddenWorkoutWhilePreservingItsRefusal() throws {
    let (_, gym) = try fixture(), workout = try begin(gym), id = try #require(workout.sessionId)
    #expect(gym.hideWorkout())
    #expect(gym.startWorkout() == id && !gym.workoutHidden && workout.isPresented)
    #expect(gym.refusal != nil && gym.error == "Finish the open workout first." && gym.sessions.map(\.id) == [id])
  }

  @Test func realPushFailureShowsOnlyStrandedSetsAndKeepsServerWorkoutOpenUntilRecovery() async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault, drivesLoops: true), engine = runtime.engine
    let identity = fault.model.identity(email: "stranded-workout@example.com")
    #expect(try await engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    await engine.flushOnLeave(); gym.refresh()
    let workout = try begin(gym)
    await engine.flushOnLeave(); gym.refresh(); workout.reconcile()
    #expect(try runtime.runner.read(Gym.scope) { try $0.confirmed(Session.self, try #require(workout.sessionId)) } == nil)
    #expect(try runtime.runner.read(Gym.scope) { try $0.commands().contains { $0.command.name == Gym.Commands.start && $0.isAdmitted } })
    workout.logSet()
    let pending = try #require(workout.sets.first)
    #expect(gym.unsentSets(gym.workout.sets).isEmpty)
    fault.failure.withLock { $0 = 503 }
    await engine.flushOnLeave()
    for _ in 0..<100 where !workout.syncFailed { try await Task.sleep(for: .milliseconds(2)) }
    gym.refresh(); workout.reconcile()
    #expect(workout.syncFailed && gym.unsentSets(gym.workout.sets) == [pending.id])
    #expect(workout.logSet())
    let retained = workout.sets
    #expect(retained.count == 2 && gym.unconfirmedSets(retained) == Set(retained.map(\.id)))
    #expect(gym.unsentSets(gym.workout.sets) == [pending.id])
    await workout.finish()
    #expect(workout.session?.isOpen == true && workout.receipt == nil && workout.isPresented)
    #expect(workout.sets == retained && workout.message == "Finish needs a connection — keep logging, or hide the workout.")
    #expect(workout.canLog && gym.hideWorkout() && !workout.isPresented)
    #expect(gym.restoreWorkout())
    fault.failure.withLock { $0 = nil }
    await engine.flushOnLeave()
    await engine.start()
    #expect(await Self.until {
      gym.refresh(); workout.reconcile()
      return !workout.syncFailed && gym.unconfirmedSets(workout.sets).isEmpty
    })
    #expect(!workout.syncFailed && gym.unsentSets(gym.workout.sets).isEmpty && gym.unconfirmedSets(workout.sets).isEmpty)
    await workout.finish()
    #expect(workout.session?.isOpen == false && workout.receipt != nil && workout.isPresented)
    workout.closeReceipt()
    workout.reconcile()
    #expect(!workout.isPresented && workout.handoff == .detail(workout.sessionId))
  }

  @Test func finishConfirmsReceiptWithoutLockingControlsWhenLiveIsUnavailable() async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault, drivesLoops: true)
    let identity = fault.model.identity(email: "finish-without-live@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    await runtime.engine.flushOnLeave()
    let workout = try begin(gym)
    workout.logSet()
    #expect(gym.unconfirmedSets(workout.sets).count == 1)
    await runtime.engine.start()
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    #expect(await Self.until { gym.refresh(); workout.reconcile(); return gym.unconfirmedSets(workout.sets).isEmpty })
    let finishing = Task { await workout.finish() }
    #expect(await Self.until { workout.finishQueued || workout.receipt != nil })
    #expect(!workout.finishing)
    await finishing.value
    let receipt = try #require(workout.receipt)
    #expect(!receipt.session.isOpen && receipt.sets.count == 1 && workout.isPresented && !workout.finishing)
    #expect(gym.unconfirmedSets(receipt.sets).isEmpty && workout.message == nil)
    #expect(try runtime.runner.read(Gym.scope) { try $0.commands().isEmpty })
  }

  @Test func finishWaitsOnlineForTheConfirmationOfASetTheLogJustAccepted() async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault, drivesLoops: true)
    let identity = fault.model.identity(email: "finish-after-fix@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout, id = try #require(workout.sessionId)
    workout.add(ID("back-squat")); workout.logSet()
    await runtime.engine.start()
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    #expect(await Self.until { gym.refresh(); workout.reconcile(); return gym.unconfirmedSets(workout.sets).isEmpty })
    let original = try #require(workout.sets.first)
    var fixed = original; fixed.weightKg += 2.5
    fault.pullFailure.withLock { $0 = 503 }
    #expect(gym.run(CorrectSet(fixed, original: original))?.refusal == nil)
    await runtime.engine.flushOnLeave()
    let accepted = try runtime.runner.read(Gym.scope) { read in
      let loaded = try FinishWorkout(id: id).load(read)
      return try loaded.serverHeld && loaded.stranded && read.commands().isEmpty
    }
    #expect(accepted)
    fault.pullFailure.withLock { $0 = nil }
    await workout.finish()
    let receipt = try #require(workout.receipt)
    #expect(!receipt.session.isOpen && receipt.sets.map(\.weightKg) == [fixed.weightKg] && workout.message == nil)
  }

  enum ConfirmationWait: CaseIterable { case stalledServer, cancelledWait, offline }

  @Test(arguments: ConfirmationWait.allCases)
  func finishOnASetTheLogHasNotConfirmedDecidesWithinItsWait(_ wait: ConfirmationWait) async throws {
    let fault = WorkoutFaultTransport(), network = SwitchedConnectivity()
    let runtime = try Self.faultRuntime(fault, connectivity: network, drivesLoops: true)
    let identity = fault.model.identity(email: "finish-unconfirmed@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let recorder = TelemetryRecorder(), gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: recorder)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout, id = try #require(workout.sessionId)
    workout.add(ID("back-squat")); workout.logSet()
    await runtime.engine.start()
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    #expect(await Self.until { gym.refresh(); workout.reconcile(); return gym.unconfirmedSets(workout.sets).isEmpty })
    let original = try #require(workout.sets.first)
    var fixed = original; fixed.weightKg += 2.5
    fault.pullFailure.withLock { $0 = 503 }
    #expect(gym.run(CorrectSet(fixed, original: original))?.refusal == nil)
    await runtime.engine.flushOnLeave()
    #expect(try runtime.runner.read(Gym.scope) { read in
      let loaded = try FinishWorkout(id: id).load(read)
      return try loaded.serverHeld && loaded.stranded && read.commands().isEmpty
    })
    fault.pullFailure.withLock { $0 = nil }
    fault.pullDelay.withLock { $0 = .seconds(30) }
    if wait == .offline { network.set(online: false) }
    let requests = fault.pullRequests.withLock { $0 }, tapped = ContinuousClock.now
    let finishing = Task { await workout.finish() }
    if wait == .cancelledWait {
      #expect(await Self.until { workout.finishing && fault.pullRequests.withLock { $0 } > requests })
      finishing.cancel()
    }
    await finishing.value
    let decided = tapped.duration(to: .now)
    switch wait {
    case .stalledServer: #expect(decided >= WorkoutState.confirmationWait && decided < WorkoutState.confirmationWait + .seconds(2))
    case .cancelledWait, .offline: #expect(decided < .seconds(1))
    }
    #expect(!workout.finishing && !workout.finishQueued && workout.session?.isOpen == true && workout.receipt == nil && workout.canLog)
    #expect(workout.message == "Finish needs a connection — keep logging, or hide the workout.")
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_session_finished" }.map(\.properties) } == [["screen": "workout", "outcome": "refused"]])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
  }

  @Test func aFinishConfirmedAfterItsWaitStillEndsInItsReceipt() async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault, drivesLoops: true)
    let identity = fault.model.identity(email: "finish-confirmed-late@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout, id = try #require(workout.sessionId)
    workout.add(ID("back-squat")); workout.logSet()
    await runtime.engine.start()
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    #expect(await Self.until { gym.refresh(); workout.reconcile(); return gym.unconfirmedSets(workout.sets).isEmpty })
    fault.pullFailure.withLock { $0 = 503 }
    await workout.finish()
    #expect(workout.receipt == nil && workout.finishQueued && gym.openSession?.id == id)
    fault.pullFailure.withLock { $0 = nil }
    runtime.engine.foreground()
    #expect(await Self.until { (try? runtime.runner.read(Gym.scope) { try $0.commands().isEmpty }) == true })
    workout.reconcile()
    gym.refresh(); workout.reconcile()
    #expect(gym.openSession == nil && workout.receipt?.session.id == id)
  }

  @Test(arguments: [true, false])
  func confirmationWaitStopsForCancellationOrAccountTransition(cancel: Bool) async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault, drivesLoops: true)
    let identity = fault.model.identity(email: "confirmation-interrupted@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let recorder = TelemetryRecorder(), gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: recorder)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout
    workout.add(ID("back-squat")); workout.logSet()
    await runtime.engine.start()
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    #expect(await Self.until { gym.refresh(); workout.reconcile(); return gym.unconfirmedSets(workout.sets).isEmpty })
    let retained = workout.sets
    let requests = fault.pullRequests.withLock { $0 }
    fault.pullFailure.withLock { $0 = 503 }
    let finishing = Task { await workout.finish() }
    #expect(await Self.until { workout.finishQueued && !workout.finishing && fault.pullRequests.withLock { $0 > requests } })
    #expect(gym.hideWorkout() && !workout.isPresented)
    let interrupted = ContinuousClock.now
    if cancel { finishing.cancel() } else { gym.accountChanging = true }
    await finishing.value
    #expect(interrupted.duration(to: .now) < .seconds(1))
    #expect(!workout.finishing && workout.session?.isOpen == true && workout.receipt == nil && workout.sets == retained)
    #expect(workout.message == "Finish is saved on this phone. It will be confirmed when a connection is available.")
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
    #expect(try runtime.runner.read(Gym.scope) { try $0.commands().contains { $0.command.name == Gym.Commands.finish } })
  }

  @Test func clockAheadStartAndSetsStayOnDeviceAfterRefusalAndReplayWithTheSameIdentities() async throws {
    let fault = WorkoutFaultTransport(), clock = SimClock(wallMs: Int64(Date().timeIntervalSince1970 * 1_000))
    let runtime = try Self.faultRuntime(fault, clock: EngineClock(wall: clock, sleeper: clock), drivesLoops: true)
    let identity = fault.model.identity(email: "clock-ahead-workout@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    clock.skew(ms: 600_000)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout
    workout.add(ID("back-squat")); workout.logSet()
    let started = try #require(workout.session), retained = workout.sets
    await runtime.engine.flushOnLeave(); gym.refresh(); workout.reconcile()
    #expect(workout.session == started && workout.sets == retained && gym.notices.isEmpty)
    #expect(try runtime.runner.read(Gym.scope) { try $0.confirmed(Session.self, started.id) } == nil)
    let reopened = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(reopened.workout.session == started && reopened.workout.sets == retained && reopened.workout.canLog)
    await runtime.engine.flushOnLeave(); reopened.refresh(); reopened.workout.reconcile()
    await runtime.engine.start()
    #expect(await Self.until {
      reopened.refresh(); reopened.workout.reconcile()
      return reopened.unconfirmedSets(reopened.workout.sets).isEmpty
    })
    #expect(reopened.workout.session?.id == started.id && reopened.workout.session?.isOpen == true)
    #expect(reopened.workout.sets.map(\.id) == retained.map(\.id) && reopened.workout.sets.map(\.weightKg) == retained.map(\.weightKg))
    #expect(reopened.notices.isEmpty && reopened.unconfirmedSets(reopened.workout.sets).isEmpty)
  }

  @Test func neverAdmittedStartCanFinishOnDeviceWhileItsPushIsUnavailable() async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault)
    let identity = fault.model.identity(email: "unadmitted-workout@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout
    workout.add(ID("back-squat")); workout.logSet()
    fault.failure.withLock { $0 = 503 }
    await workout.finish()
    #expect(workout.receipt != nil && workout.session?.isOpen == false && workout.isPresented)
    #expect(try runtime.runner.read(Gym.scope) { try $0.commands().contains { $0.command.name == Gym.Commands.start && !$0.isAdmitted } })
    #expect(gym.unconfirmedSets(workout.sets) == Set(workout.sets.map(\.id)))
  }

  @Test func localFinishDoesNotWaitForAStalledPush() async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault)
    let identity = fault.model.identity(email: "stalled-workout@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout
    workout.add(ID("back-squat")); #expect(workout.logSet())
    let retained = workout.sets
    fault.pushDelay.withLock { $0 = .seconds(10) }
    let finishing = Task { await workout.finish() }
    try await Task.sleep(for: .milliseconds(100))
    #expect(!workout.finishing && workout.receipt?.sets == retained && workout.session?.isOpen == false)
    finishing.cancel(); await finishing.value
    #expect(workout.sets == retained)
  }

  @Test func backwardClockFinishPreservesTheWorkoutAndShowsItsSpecificRefusal() async throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    #expect(workout.logSet())
    let started = try #require(workout.session), retained = workout.sets
    harness.clock.skew(ms: -60_000)
    await workout.finish()
    #expect(gym.refusal == .badInstant(Refused(Gym.Codes.badInstant, subject: started.id.ref, path: .predicted)))
    #expect(workout.message == "Check the workout's start and finish times." && workout.message == gym.error)
    #expect(workout.session == started && workout.sets == retained && workout.receipt == nil && workout.isPresented && !workout.finishing)
    #expect(try gym.runner.read(Gym.scope) { try !$0.commands().contains { $0.command.name == Gym.Commands.finish } })
    harness.clock.skew(ms: 0)
    await workout.finish()
    let receipt = try #require(workout.receipt)
    #expect(receipt.session.id == started.id && !receipt.session.isOpen && receipt.sets == retained)
    #expect(workout.sets == retained && workout.message == nil && gym.refusal == nil)
  }

  @Test func previousAnonymousFinishQueueCannotBlockLoggingANewWorkout() async throws {
    let (_, gym) = try fixture(), workout = try begin(gym)
    let old = try #require(workout.activityOffer()), previousID = try #require(workout.sessionId)
    #expect(workout.logActivityOffer(old))
    let retained = workout.sets
    await workout.finish()
    #expect(workout.receipt?.sets == retained && workout.finishQueued)
    #expect(try gym.runner.read(Gym.scope) { try $0.commands().contains {
      $0.command.name == Gym.Commands.finish && $0.command.args["sessionId"] == previousID.json
    } })
    let fresh = try begin(gym), currentID = try #require(fresh.sessionId)
    #expect(currentID != previousID && !fresh.finishQueued && fresh.canLog)
    let current = try #require(fresh.activityOffer())
    #expect(current.sessionID == currentID.description && current.setID != old.setID)
    #expect(fresh.logActivityOffer(current))
    #expect(fresh.sets.map { $0.id.description } == [current.setID] && fresh.sets.allSatisfy { $0.sessionId == currentID })
    #expect(gym.log?.sets(session: previousID) == retained)
    #expect(try gym.runner.read(Gym.scope) { try $0.commands().filter { $0.command.name == Gym.Commands.finish }.count } == 1)
  }

  @Test func failedWorkoutRestoreBlocksLoggingUntilItsQueueCanBeRead() throws {
    let fault = GymStoreFault(), runtime = try GymModelTests().runtime(failing: fault)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let workout = try begin(gym)
    #expect(workout.logSet())
    let started = try #require(workout.session), retained = workout.sets, walk = workout.walk
    fault.point.withLock { $0 = .read }; workout.restore()
    #expect(workout.finishQueued && !workout.canLog)
    #expect(workout.session == started && workout.sets == retained && workout.walk == walk)
    fault.point.withLock { $0 = nil }; workout.restore()
    #expect(!workout.finishQueued && workout.canLog)
    #expect(workout.session == started && workout.sets == retained && workout.walk == walk)
    #expect(workout.logSet() && workout.sets.count == retained.count + 1)
  }

  @Test(arguments: [true, false])
  func transientWorkoutRestoreReadNeverOverwritesTheSavedWalk(cold: Bool) async throws {
    let failRead = Mutex(false), recorder = TelemetryRecorder()
    let store = try Store.inMemory(registry: SyncSchema.registry, crashPoints: CrashPoints { point in
      if point == .read, failRead.withLock({ armed in
        guard armed else { return false }; armed = false; return true
      }) { throw AppFailure(message: "Private one-shot restore failure") }
    })
    let tokens = InMemoryTokenStore()
    let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: false), store: store,
      transport: JournalModelTransport(), tokens: tokens, forkGuard: InMemoryForkGuardStore(), clock: .system,
      random: SeededRandomSource(seed: 88), connectivity: SwitchedConnectivity())
    let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: false)
    let runtime = AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://gym.invalid"]),
      store: store, engine: engine, auth: NativeAuth(baseURL: URL(string: "https://gym.invalid")), runner: runner,
      tokens: tokens, revocations: InMemoryTokenStore())
    let gym = GymModel(runner: runner, runtime: runtime, telemetry: recorder)
    for (index, id) in [first, second, third].enumerated() {
      #expect(gym.run(CreateExercise(Exercise(id: id, name: "Restore movement \(index)", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    }
    let plan = try routine(gym, scheme: [SetTarget(reps: 5, weightKg: 40)]), workout = try begin(gym, routine: plan)
    workout.add(third); workout.move(from: IndexSet(integer: 2), to: 0); workout.select(first)
    workout.weightKg = 50; #expect(workout.logSet())
    let stale = try #require(workout.activityOffer())
    workout.select(second)
    #expect(workout.activityOffer() == nil)
    var activity = try #require(try workout.activityRecord())
    activity.dismissed = true; #expect(workout.keepActivity(activity))
    let sessionID = try #require(workout.sessionId), saved = workout.walk, offer = try #require(workout.deviation), sets = workout.sets
    #expect(saved.order == [third, first, second] && saved.selected == second && saved.pending == first)
    let targetGym = cold ? GymModel(runner: runner, runtime: runtime, telemetry: recorder) : gym
    failRead.withLock { $0 = true }
    let target: WorkoutState
    if cold { target = targetGym.workout }
    else { target = workout; target.restore() }
    #expect(target.finishQueued && !target.canLog)
    #expect(try runner.read(Gym.scope) { try WorkoutWalk($0.device(WorkoutWalk.key(sessionID))) } == saved)
    await WorkoutActivityController(gym: targetGym).reconcile()
    #expect(target.walk == saved && target.deviation == offer)
    #expect(target.activityOffer() == nil)
    #expect(try runner.read(Gym.scope) { try WorkoutWalk($0.device(WorkoutWalk.key(sessionID))) } == saved)
    #expect(try target.activityRecord() == activity && target.sets == sets)
    #expect(!target.logActivityOffer(stale) && target.sets == sets)
  }

  static func until(_ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(3)
    while !condition(), ContinuousClock.now < deadline { await Task.yield() }
    return condition()
  }

  static func faultRuntime(_ fault: WorkoutFaultTransport, clock: EngineClock = .system, connectivity: SwitchedConnectivity = SwitchedConnectivity(),
                           drivesLoops: Bool = false) throws -> AppRuntime {
    let store = try Store.inMemory(registry: SyncSchema.registry, commandResultWrites: AppRuntime.commandResultWrites), tokens = InMemoryTokenStore()
    let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: drivesLoops), store: store,
                                transport: fault, tokens: tokens, forkGuard: InMemoryForkGuardStore(), clock: clock,
                                random: SeededRandomSource(seed: 73), connectivity: connectivity)
    let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: false)
    return AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://gym.invalid"]), store: store, engine: engine,
                      auth: NativeAuth(baseURL: URL(string: "https://gym.invalid")), runner: runner,
                      tokens: tokens, revocations: InMemoryTokenStore())
  }

  @Test func startedRoutinePlanRemainsFrozenWhenRoutineIsEdited() throws {
    let (_, gym) = try fixture(), plan = try routine(gym, scheme: [SetTarget(reps: 5, weightKg: 40)])
    let workout = try begin(gym, routine: plan), session = try #require(workout.session)
    var edited = Draft(opening: plan)
    edited.current.name = "Changed routine"; edited.current.entries[0].sets = [SetTarget(reps: 8, weightKg: 60)]
    #expect(saved(gym.save(&edited)))
    workout.reconcile()
    #expect(workout.session == session && workout.entry?.sets == plan.entries[0].sets)
    #expect(workout.weightKg == 40 && workout.reps == 5)
    #expect(gym.routines.first?.name == "Changed routine")
  }

  @Test func reconciliationAdoptsAuthoritativeWorkoutAfterTerminalStartRefusal() throws {
    let (harness, winner) = try fixture(anonymous: false), other = harness.device()
    let gym = GymModel(runner: other.runner)
    let authoritative = try begin(winner), predicted = try begin(gym)
    let serverId = try #require(authoritative.sessionId), localId = try #require(predicted.sessionId)
    #expect(serverId != localId)
    harness.sync(); gym.refresh(); predicted.reconcile()
    #expect(gym.openSession?.id == serverId && gym.sessions.map(\.id) == [serverId])
    #expect(predicted.sessionId == serverId && predicted.session?.id == serverId)
    let notices = try other.notices(GymRefusal.self)
    #expect(notices.count == 1)
    guard case .sessionOpen = notices.first?.refusal else { Issue.record("Expected terminal start refusal"); return }
  }

  @Test func ladderBandsHonorDirectionAtBoundariesAndAssistance() {
    #expect(WeightLadder.labels(19.99) == ["−2.5", "−1", "+1", "+2.5"])
    #expect(WeightLadder.labels(20) == ["−2.5", "−1", "+2.5", "+5"])
    #expect(WeightLadder.labels(49.99) == ["−5", "−2.5", "+2.5", "+5"])
    #expect(WeightLadder.labels(50) == ["−5", "−2.5", "+2.5", "+10"])
    #expect(WeightLadder.labels(-20) == ["−5", "−2.5", "+1", "+2.5"])
    #expect(WeightLadder.labels(-50) == ["−10", "−2.5", "+2.5", "+5"])
    #expect(WeightLadder.bump(20, direction: -1) == 19)
    #expect(WeightLadder.bump(20, direction: 1) == 22.5)
    #expect(WeightLadder.bump(-20, direction: 1) == -19)
    #expect(WeightLadder.bump(-50, direction: -1, big: true) == -60)
  }

  @Test func clocksUseLatestRetainedSetAcrossSessionAndFreeze() throws {
    let (_, gym) = try fixture(), session = finished(gym)
    let earlier = value(gym, session: session, at: Instant(ms: start.ms + 10_000))
    let latest = value(gym, session: session, exercise: second, kind: "warmup", at: Instant(ms: start.ms + 30_000))
    let foreign = value(gym, session: finished(gym), at: Instant(ms: start.ms + 59_000))
    let clocks = WorkoutClocks(session: session, sets: [latest, earlier, foreign], now: Instant(ms: start.ms + 9_000_000))
    #expect(clocks.workoutMs == 60_000 && clocks.sinceSetMs == 30_000)
    let empty = WorkoutClocks(session: session, sets: [foreign], now: Instant(ms: start.ms + 9_000_000))
    #expect(empty.workoutMs == 60_000 && empty.sinceSetMs == nil)
    #expect(WorkoutClocks.reading(-1) == "0:00")
    #expect(WorkoutClocks.reading(59_999) == "0:59")
    #expect(WorkoutClocks.reading(3_661_000) == "1:01:01")
  }

  @Test func setsLoggedOnAStillClockKeepTheirLoggedOrderOnTheLedgerAndTheReceipt() async throws {
    let (_, gym) = try fixture(), workout = try begin(gym)
    for load in [60.0, 80, 70, 90, 50] { workout.weightKg = load; #expect(workout.logSet()) }
    #expect(workout.sets.map(\.weightKg) == [60, 80, 70, 90, 50])
    #expect(workout.sets.map(\.completedAt.ms) == (0..<5).map { start.ms + Int64($0) })
    #expect(LogWorkoutSet.completedAt(Instant(ms: start.ms + 60_000), after: workout.sets) == Instant(ms: start.ms + 60_000))
    await workout.finish()
    #expect(try #require(workout.receipt).sets.map(\.weightKg) == [60, 80, 70, 90, 50])
  }

  @Test func receiptNamesTheWorkoutWithNounTilesAndItsMovementsInLoggedOrder() throws {
    let (_, gym) = try fixture(), session = finished(gym)
    let sets = [value(gym, session: session, exercise: second, weight: 100, at: Instant(ms: start.ms + 10_000)),
                value(gym, session: session, weight: 60, reps: 8, kind: "warmup", at: Instant(ms: start.ms + 20_000)),
                value(gym, session: session, weight: 80, at: Instant(ms: start.ms + 30_000)),
                value(gym, session: session, weight: 85, at: Instant(ms: start.ms + 40_000))]
    let receipt = WorkoutReceiptData(session: session, sets: sets.reversed(), routineId: gym.runner.mint(Routine.self), routinePosition: 0)
    #expect(receipt.sets == sets && receipt.title == "Ended early.")
    #expect(receipt.subtitle(GymDate(gym.dates.moment, locale: Locale(identifier: "en_US"))) == "Free workout · Sat, Sep 26")
    #expect(FactTiles(receipt.readout).facts == [FactTiles.Fact(value: "1m", label: "Duration"), FactTiles.Fact(value: "3", label: "Working sets"),
                                                 FactTiles.Fact(value: "1325 kg", label: "Volume")])
    #expect(receipt.performed.map(\.exerciseId) == [second, first] && receipt.performed.map(\.reading) == ["1 × 5 · 100", "2 × 5 · 80–85"])
  }

  // A row keeps its place as sets are logged: the set takes over the current row, the next planned row becomes current, and
  // the plan line and This workout's count read the same working sets.
  @Test func aLoggedSetTakesOverTheCurrentRowAndTheNextPlannedRowMovesUp() throws {
    let (_, gym) = try fixture(), plan = try routine(gym, scheme: Array(repeating: SetTarget(reps: 5, weightKg: 40), count: 3))
    let workout = try begin(gym, routine: plan)
    let before = workout.ledger(first)
    #expect(before.rows.map(\.id) == [0, 1, 2] && before.rows.map(\.marker) == ["1", "2", "3"])
    #expect(before.rows.map(\.place) == [.current, .planned, .planned] && before.rows.map(\.reading) == ["40 × 5", "40 × 5", "40 × 5"])
    #expect(before.planLine == nil && before.tally == "0 of 3 sets" && !before.complete)
    #expect(workout.logSet())
    let set = try #require(workout.sets.first), logged = workout.ledger(first)
    #expect(logged.rows.map(\.id) == [0, 1, 2] && logged.rows.map(\.place) == [.logged(set), .current, .planned])
    #expect(logged.tally == "1 of 3 sets")
    let session = try #require(workout.session)
    #expect(gym.run(AppendSet(value(gym, session: session, weight: 20, kind: "warmup", at: Instant(ms: set.completedAt.ms + 1))))?.refusal == nil)
    workout.reconcile()
    let warmed = workout.ledger(first)
    #expect(warmed.rows.map(\.marker) == ["1", "W", "2", "3"] && warmed.rows.map(\.id) == [0, 1, 2, 3] && warmed.tally == "1 of 3 sets")
    #expect(workout.logSet() && workout.logSet())
    let done = workout.ledger(first)
    #expect(done.rows.map(\.marker) == ["1", "W", "2", "3", "4"] && done.current.reading == Readout.openTarget)
    #expect(done.tally == "3 of 3 sets" && done.complete)
    let open = workout.ledger(second)
    #expect(open.planLine == "plan open" && open.tally == "0 sets" && !open.complete && open.rows.map(\.place) == [.current])
    let free = MovementLedger(sets: [set], plan: nil)
    #expect(free.planLine == nil && free.tally == "1 set" && !free.complete)
  }

  @Test func deletionMovesRestClockToRetainedLatestSetAcrossRelaunch() throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    let session = try #require(workout.session)
    let early = value(gym, session: session, at: start)
    #expect(gym.run(AppendSet(early))?.receipt != nil)
    harness.advance(ms: 10_000)
    let latest = value(gym, session: session, exercise: second, at: Instant(ms: harness.clock.nowMs()))
    #expect(gym.run(AppendSet(latest))?.receipt != nil)
    harness.advance(ms: 10_000)
    let now = Instant(ms: harness.clock.nowMs())
    #expect(WorkoutClocks(session: session, sets: workout.sets, now: now).sinceSetMs == 10_000)
    let removal = try #require(gym.run(DeleteSet(latest.id))?.receipt)
    #expect(WorkoutClocks(session: session, sets: workout.sets, now: now).sinceSetMs == 20_000)
    #expect(removal.releaseAt == nil)
    let reopenedGym = GymModel(runner: harness.runner), reopened = reopenedGym.workout
    #expect(WorkoutClocks(session: try #require(reopened.session), sets: reopened.sets, now: now) ==
            WorkoutClocks(session: session, sets: workout.sets, now: now))
  }

  @Test func fourHourIdleClosesDeviceWorkoutAtLastSetAndFreezesClocks() throws {
    let (harness, gym) = try fixture(), workout = try begin(gym), id = try #require(workout.sessionId)
    harness.advance(ms: 10_000); workout.logSet()
    let last = try #require(workout.sets.last)
    harness.advance(ms: SessionRules.staleAfterMs - 1); gym.refresh(); workout.reconcile()
    #expect(gym.openSession?.id == id && workout.session?.isOpen == true && workout.canLog)
    harness.advance(ms: 1); gym.refresh(); workout.reconcile()
    let closed = try #require(workout.session)
    #expect(gym.openSession == nil && !workout.canLog && !workout.isPresented)
    #expect(closed.finishedAt == last.completedAt && closed.closedBy == "stale" && workout.sets == [last])
    #expect(try harness.stored(Session.self).first?.isOpen == true)
    let clocks = WorkoutClocks(session: closed, sets: workout.sets, now: Instant(ms: harness.clock.nowMs()))
    #expect(clocks.workoutMs == 10_000 && clocks.sinceSetMs == 0)
    harness.advance(ms: 60_000)
    let reopened = GymModel(runner: harness.runner)
    #expect(reopened.openSession == nil && reopened.sessions == [closed] && reopened.sets == [last])
    #expect(WorkoutClocks(session: try #require(reopened.sessions.first), sets: reopened.sets,
                          now: Instant(ms: harness.clock.nowMs())) == clocks)
  }

  @Test func walkPersistsAdditionSelectionReorderAndEmptyRemoval() throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    workout.add(second); workout.add(third); workout.add(first)
    #expect(workout.walk.order == [first, second, third] && workout.selected == third)
    workout.move(from: IndexSet(integer: 2), to: 0); workout.select(second)
    #expect(workout.walk.order == [third, first, second] && workout.selected == second)
    let position = try #require(workout.walk.position(of: second))
    #expect(position.index == 2 && position.count == 3 && workout.walk.position(of: nil) == nil)
    workout.remove(second)
    #expect(workout.walk.order == [third, first] && workout.selected == third)
    workout.remove(first)
    #expect(workout.walk.order == [third] && workout.walk.position(of: third) == nil)
    let reopenedGym = GymModel(runner: harness.runner), reopened = reopenedGym.workout
    #expect(reopened.walk == workout.walk)
    let json = try harness.runner.read(Gym.scope) { try $0.device(WorkoutWalk.key(try #require(workout.sessionId))) }
    #expect(try WorkoutWalk(json) == workout.walk)
  }

  @Test func addingMovementSelectsItsHistoricalRackAndLogsTheNextSetThere() throws {
    let (harness, gym) = try fixture()
    let priorId = gym.runner.mint(Session.self)
    let priorSet = ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: second, weightKg: 67.5, reps: 8,
                               completedAt: Instant(ms: start.ms - 90_000))
    #expect(gym.run(ImportSession(id: priorId, startedAt: Instant(ms: start.ms - 120_000),
                                finishedAt: Instant(ms: start.ms - 60_000), sets: [priorSet]))?.receipt != nil)
    let workout = try begin(gym)
    workout.weightKg = 35; workout.reps = 6; workout.logSet()
    let firstSet = try #require(workout.sets.first)
    workout.add(second)
    #expect(workout.selected == second && workout.weightKg == 67.5 && workout.reps == 8)
    harness.advance(ms: 1_000); workout.logSet()
    #expect(workout.sets.first == firstSet)
    #expect(workout.sets.map(\.exerciseId) == [first, second])
    #expect(workout.sets.map(\.weightKg) == [35, 67.5] && workout.sets.map(\.reps) == [6, 8])
    let reopened = GymModel(runner: harness.runner)
    #expect(reopened.workout.selected == second && reopened.workout.weightKg == 67.5 && reopened.workout.reps == 8)
  }

  @Test func plannedAndLoggedMovementsCannotBeRemoved() throws {
    let (_, gym) = try fixture(), plan = try routine(gym, scheme: [SetTarget(reps: 5, weightKg: 80)])
    let workout = try begin(gym, routine: plan)
    workout.add(third); workout.select(third); workout.logSet()
    #expect(!workout.canRemove(first) && !workout.canRemove(second) && !workout.canRemove(third))
    let held = workout.walk
    for id in [first, second, third] { workout.remove(id); #expect(workout.walk == held) }
    #expect(workout.message == "A movement with sets or planned targets stays in this workout.")
  }

  @Test func failedWalkCommitRetainsOrderAndSelection() throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    workout.add(second)
    let held = workout.walk
    harness.failNextCommit(); workout.select(first)
    #expect(workout.walk == held && workout.message == "Gym could not save this change. Try again.")
    harness.failNextCommit(); workout.move(from: IndexSet(integer: 1), to: 0)
    #expect(workout.walk == held)
    let reopenedGym = GymModel(runner: harness.runner)
    #expect(reopenedGym.workout.walk == held)
  }

  @Test func variedPrefillSkipsWarmupsAndKeepsMovementUntilExplicitSwitch() throws {
    let (harness, gym) = try fixture(), plan = try routine(gym, scheme: [SetTarget(reps: 8, weightKg: 40), SetTarget(reps: 5, weightKg: 60)])
    let workout = try begin(gym, routine: plan)
    #expect(workout.weightKg == 40 && workout.reps == 8)
    workout.weightKg = 20; workout.reps = 10; workout.logSet()
    let logged = try #require(workout.sets.first)
    var warmup = logged; warmup.kind = "warmup"
    #expect(gym.run(CorrectSet(warmup, original: logged))?.refusal == nil)
    workout.reconcile()
    #expect(workout.weightKg == 40 && workout.reps == 8 && workout.selected == first)
    harness.advance(ms: 1_000); workout.logSet()
    #expect(workout.weightKg == 60 && workout.reps == 5 && workout.selected == first)
    harness.advance(ms: 1_000); workout.logSet()
    #expect(workout.weightKg == 60 && workout.reps == 5 && workout.selected == first && workout.sets.count == 3)
  }

  @Test func straightPrefillKeepsLastWorkingLoadAndPerMovementDraft() throws {
    let (_, gym) = try fixture(), plan = try routine(gym, scheme: Array(repeating: SetTarget(reps: 5, weightKg: 40), count: 3))
    let workout = try begin(gym, routine: plan)
    workout.weightKg = 35; workout.reps = 7; workout.logSet()
    #expect(workout.weightKg == 35 && workout.reps == 7)
    workout.weightKg = 37.5; workout.reps = 6; workout.select(second)
    workout.weightKg = 70; workout.reps = 3; workout.select(first)
    #expect(workout.weightKg == 37.5 && workout.reps == 6)
    workout.select(second)
    #expect(workout.weightKg == 70 && workout.reps == 3)
  }

  @Test func lastTimePrefillsFreeWorkoutAndPlanOverridesIt() throws {
    let (_, gym) = try fixture(), workout = try begin(gym)
    workout.weightKg = 65; workout.reps = 7; workout.logSet()
    #expect(gym.run(FinishSession(id: try #require(workout.sessionId)))?.receipt != nil)
    let free = try begin(gym)
    #expect(free.weightKg == 65 && free.reps == 7)
    #expect(gym.run(FinishSession(id: try #require(free.sessionId)))?.receipt != nil)
    let plan = try routine(gym, scheme: [SetTarget(reps: 4, weightKg: 50)])
    let planned = try begin(gym, routine: plan)
    #expect(planned.weightKg == 50 && planned.reps == 4)
  }

  @Test(arguments: [false, true])
  func admittedSetNumberDoesNotInvalidateTheOfferedRack(refreshProjection: Bool) throws {
    let (harness, gym) = try fixture(anonymous: false), workout = try begin(gym)
    harness.sync(); gym.refresh(); workout.reconcile()
    workout.weightKg = 60; workout.reps = 8
    #expect(workout.logSet())
    let offered = try #require(workout.sets.first)
    #expect(offered.setNumber == nil)
    harness.sync()
    let admitted = try #require(try harness.drawn(TrainingSet.self).first { $0.id == offered.id })
    #expect(admitted.setNumber == 1 && admitted.fields == offered.fields)
    if refreshProjection { gym.refresh() }
    #expect(workout.offerSets == [offered])
    harness.advance(ms: 1_000)
    #expect(workout.logSet())
    #expect(workout.sets.count == 2 && workout.sets.contains(admitted))
    #expect(workout.weightKg == 60 && workout.reps == 8 && workout.message == nil)
    #expect(try harness.drawn(TrainingSet.self).count == 2)
  }

  @Test(arguments: ["added", "corrected"])
  func staleRackAndActionRefuseWithoutAppending(change: String) throws {
    let (_, gym) = try fixture(), workout = try begin(gym), session = try #require(workout.session)
    if change == "corrected" { #expect(workout.logSet()) }
    let observed = workout.sets
    var concurrent = change == "corrected" ? try #require(observed.first) : value(gym, session: session, weight: 90)
    if change == "corrected" {
      concurrent.weightKg = 90
      #expect(gym.run(CorrectSet(concurrent))?.receipt != nil)
    } else { #expect(gym.run(AppendSet(concurrent))?.receipt != nil) }
    workout.weightKg = 100; #expect(!workout.logSet())
    #expect(workout.message == "The workout changed. Check the current set." && workout.sets == [concurrent])
    let attempt = value(gym, session: session, weight: 100)
    #expect(gym.run(LogWorkoutSet(value: attempt, session: session, previousSets: observed))?.refusal == .stale(session.id.ref, .predicted))
    #expect(workout.sets == [concurrent])
  }

  @Test func failedSetCommitRetainsRackOfferAndClocksUntilRetry() throws {
    let (harness, gym) = try fixture(), workout = try begin(gym), session = try #require(workout.session)
    harness.advance(ms: 20_000)
    workout.weightKg = -25.5; workout.reps = 8
    #expect(workout.flushRack())
    let before = WorkoutClocks(session: session, sets: workout.sets, now: Instant(ms: harness.clock.nowMs()))
    harness.failNextCommit(); workout.logSet()
    #expect(workout.sets.isEmpty && workout.weightKg == -25.5 && workout.reps == 8)
    #expect(workout.offerSession == session && workout.offerSets.isEmpty)
    #expect(WorkoutClocks(session: session, sets: workout.sets, now: Instant(ms: harness.clock.nowMs())) == before)
    #expect(workout.message == "Gym could not save this change. Try again.")
    workout.logSet()
    #expect(workout.sets.count == 1 && workout.sets[0].weightKg == -25.5 && workout.message == nil)
    #expect(WorkoutClocks(session: session, sets: workout.sets, now: Instant(ms: harness.clock.nowMs())).sinceSetMs == 0)
  }

  @Test func pagingInvalidRackAndAccountTransitionBlockLogging() throws {
    let (_, gym) = try fixture(), workout = try begin(gym)
    workout.paging = true; workout.logSet(); #expect(workout.sets.isEmpty && !workout.canLog)
    workout.paging = false; gym.accountChanging = true; workout.logSet(); #expect(workout.sets.isEmpty && !workout.canLog)
    gym.accountChanging = false; gym.readFailed = true; workout.logSet(); #expect(workout.sets.isEmpty && !workout.canLog)
    gym.readFailed = false
    for weight in [Double.nan, .infinity, 500.01, -500.01] { workout.weightKg = weight; workout.logSet(); #expect(workout.sets.isEmpty) }
    workout.weightKg = 20
    for reps in [0, 100] { workout.reps = reps; workout.logSet(); #expect(workout.sets.isEmpty) }
    #expect(workout.message == "Check the weight and reps before logging.")
  }

  @Test func retryReadRecoversLoggingWithUnchangedSessionAndSets() async throws {
    let fault = GymStoreFault(), transport = JournalModelTransport()
    let runtime = try GymModelTests().runtime(failing: fault, transport: transport)
    let owner = transport.identity(email: "read-failure-workout@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let workout = try begin(gym)
    workout.logSet()
    let session = try #require(workout.session), retained = workout.sets, walk = workout.walk
    fault.point.withLock { $0 = .read }; workout.reconcile()
    #expect(gym.readFailed && workout.finishQueued && !workout.canLog)
    #expect(gym.error == "Gym could not be read from this phone. Try again.")
    #expect(workout.session == session && workout.sets == retained && workout.walk == walk)
    #expect(gym.unconfirmedSets(retained) == Set(retained.map(\.id)))
    fault.point.withLock { $0 = nil }; workout.retryRead()
    #expect(!gym.readFailed && gym.error == nil && !workout.finishQueued && workout.canLog)
    #expect(workout.session == session && workout.sets == retained && workout.walk == walk)
    workout.logSet()
    #expect(workout.sets.count == retained.count + 1)
  }

  @Test func nothingIsUnsentSignedOutAndEveryUnconfirmedSetIsWhilePaused() async throws {
    let (_, anonymous) = try fixture(), local = try begin(anonymous)
    #expect(local.logSet() && local.sets.count == 1 && anonymous.unconfirmedSets(local.sets) == Set(local.sets.map(\.id)))
    #expect(anonymous.unsentSets(local.sets).isEmpty)
    let transport = JournalModelTransport(), runtime = try GymModelTests().runtime(transport: transport)
    let owner = transport.identity(email: "unsent-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    await runtime.engine.flushOnLeave(); gym.refresh()
    #expect(!gym.isAnonymous && !gym.authPaused && runtime.engine.status.online && gym.unsentSets(gym.workout.sets).isEmpty)
    transport.state.withLock { $0.sessions[owner.token.value] = nil }
    let workout = try begin(gym)
    #expect(workout.logSet())
    await runtime.engine.flushOnLeave()
    for _ in 0..<100 where !runtime.engine.status.authPaused { try await Task.sleep(for: .milliseconds(2)) }
    gym.refresh(); workout.reconcile()
    #expect(gym.authPaused && workout.sets.count == 1 && gym.unsentSets(gym.workout.sets) == Set(workout.sets.map(\.id)))
  }

  @Test func offlineWorkoutAndSetsSurviveReopeningAndAdmitAfterReconnect() async throws {
    let connectivity = SwitchedConnectivity(), transport = JournalModelTransport()
    let telemetry = TelemetryRecorder(), tokens = InMemoryTokenStore(), forkGuard = InMemoryForkGuardStore()
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    var seed: UInt64 = 17
    weak var openedStore: Store?
    func reopen() throws -> AppRuntime {
      seed += 1
      let store = try Store(path: directory.appending(path: "sync.sqlite").path, registry: SyncSchema.registry)
      openedStore = store
      let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: true), store: store,
                                  transport: transport, tokens: tokens, forkGuard: forkGuard, clock: .system,
                                  random: SeededRandomSource(seed: seed), connectivity: connectivity, telemetry: telemetry)
      let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: false)
      return AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://gym.invalid"]), store: store, engine: engine,
                        auth: NativeAuth(baseURL: URL(string: "https://gym.invalid")), runner: runner,
                        tokens: tokens, revocations: InMemoryTokenStore(), telemetry: NoopTelemetry())
    }
    func keepOffline() async throws -> (Session, [TrainingSet], WorkoutWalk) {
      let runtime = try reopen(), engine = runtime.engine
      let owner = transport.identity(email: "offline-workout@example.com")
      #expect(try await engine.signIn(account: owner.account, token: owner.token).isComplete)
      let gym = GymModel(runner: runtime.runner, runtime: runtime)
      #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
      await engine.flushOnLeave(); gym.refresh()
      #expect(gym.notices.isEmpty)
      connectivity.set(online: false)
      for _ in 0..<100 where engine.status.online { try await Task.sleep(for: .milliseconds(2)) }
      #expect(!engine.status.online)
      let workout = try begin(gym)
      workout.weightKg = -20; workout.reps = 8; workout.logSet()
      try await Task.sleep(for: .milliseconds(2))
      workout.weightKg = 35; workout.reps = 6; workout.logSet()
      let session = try #require(workout.session), retained = workout.sets
      #expect(retained.count == 2 && gym.unconfirmedSets(retained) == Set(retained.map(\.id)))
      #expect(gym.unsentSets(gym.workout.sets) == Set(retained.map(\.id)))
      await engine.flushOnLeave(); gym.refresh()
      #expect(try runtime.runner.read(Gym.scope) { try $0.confirmed(Session.self, session.id) } == nil)
      return (session, retained, workout.walk)
    }
    let (session, retained, walk) = try await keepOffline()
    for _ in 0..<200 where openedStore != nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(openedStore == nil)
    func admitRestored() async throws {
      let runtime = try reopen(), engine = runtime.engine, runner = runtime.runner
      let reopened = GymModel(runner: runner, runtime: runtime), restored = reopened.workout
      #expect(restored.session == session && restored.sets == retained && restored.walk == walk && restored.canLog)
      #expect(restored.weightKg == 35 && restored.reps == 6 && reopened.unconfirmedSets(retained) == Set(retained.map(\.id)))
      connectivity.set(online: true)
      for _ in 0..<100 where !engine.status.online { try await Task.sleep(for: .milliseconds(2)) }
      await engine.start()
      await engine.flushOnLeave()
      for _ in 0..<200 {
        reopened.refresh(); restored.reconcile()
        if try runner.read(Gym.scope, { try $0.commands().isEmpty }), reopened.unconfirmedSets(restored.sets).isEmpty { break }
        try await Task.sleep(for: .milliseconds(10))
      }
      #expect(reopened.notices.isEmpty && reopened.unconfirmedSets(restored.sets).isEmpty,
              "Replay diagnostics: \(telemetry.entries.withLock { $0.map { ($0.name, $0.properties) } })")
      #expect(restored.session?.id == session.id && restored.session?.isOpen == true && restored.walk == walk)
      #expect(restored.sets.map(\.id) == retained.map(\.id))
      #expect(restored.sets.map(\.weightKg) == [-20, 35] && restored.sets.map(\.reps) == [8, 6])
      #expect(restored.sets.map(\.completedAt) == retained.map(\.completedAt))
      #expect(reopened.unsentSets(reopened.workout.sets).isEmpty && restored.canLog)
      #expect(try runner.read(Gym.scope) { try $0.commands().isEmpty })
    }
    try await admitRestored()
    for _ in 0..<200 where openedStore != nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(openedStore == nil)
  }

  @Test func terminalSetRefusalShowsRetainedContentAndDismissesDurably() async throws {
    let transport = JournalModelTransport(), runtime = try GymModelTests().runtime(transport: transport)
    let owner = transport.identity(email: "set-refusal-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    await runtime.engine.flushOnLeave(); gym.refresh()
    let workout = try begin(gym)
    await runtime.engine.flushOnLeave(); gym.refresh(); workout.reconcile()
    #expect(gym.notices.isEmpty && gym.workoutNotice == nil)
    workout.weightKg = 82.5; workout.reps = 7; workout.logSet()
    let refused = try #require(workout.sets.first)
    transport.state.withLock { $0.server.refuse(code: .cap, detail: ["type": .string(TrainingSet.type), "cap": 10]) }
    await runtime.engine.flushOnLeave(); gym.refresh(); workout.reconcile()
    let notice = try #require(gym.notices.last)
    #expect(notice.subject == refused.id.ref && notice.refusal == .full(type: TrainingSet.type, cap: 10, .notice))
    #expect(workout.sets.isEmpty && workout.session?.isOpen == true)
    #expect(gym.workoutNotice == "Workout squat 82.5 × 7 not sent. Room for 10 sets — remove one.")
    gym.dismissNotice(notice.id)
    #expect(gym.notices.isEmpty && gym.workoutNotice == nil && gym.refusal == nil && gym.error == nil)
    let reopened = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(reopened.notices.isEmpty && reopened.workoutNotice == nil && reopened.sets.isEmpty)
  }

  @Test func dismissingLocalWorkoutFailurePreservesTheHiddenDurableRefusal() async throws {
    let transport = JournalModelTransport(), runtime = try GymModelTests().runtime(transport: transport)
    let owner = transport.identity(email: "notice-source-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    await runtime.engine.flushOnLeave()
    let workout = try begin(gym)
    await runtime.engine.flushOnLeave(); gym.refresh(); workout.reconcile()
    transport.state.withLock { $0.server.refuse(code: .cap, detail: ["type": .string(TrainingSet.type), "cap": 10]) }
    workout.logSet(); await runtime.engine.flushOnLeave(); gym.refresh(); workout.reconcile()
    let durable = try #require(gym.notices.last), explanation = try #require(gym.workoutNotice)
    workout.message = "Check the weight and reps before logging."
    let local = GymTransient(gym: gym, message: workout.message, dismiss: { workout.message = nil })
    local.dismissal(try #require(local.shown))?()
    #expect(workout.message == nil && gym.notices.map(\.id) == [durable.id] && gym.workoutNotice == explanation)
    let reopened = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(reopened.notices.map(\.id) == [durable.id] && reopened.workoutNotice == explanation)
    let notice = GymTransient(gym: reopened, message: nil, dismiss: { Issue.record("A durable refusal must not clear unrelated local input") })
    notice.dismissal(try #require(notice.shown))?()
    #expect(reopened.notices.isEmpty && reopened.workoutNotice == nil)
    #expect(GymModel(runner: runtime.runner, runtime: runtime).notices.isEmpty)
  }

  @Test(arguments: [true, false])
  func dismissingLocalWorkoutFailureClearsOnlyItsMirroredError(matching: Bool) throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    let offer = try #require(workout.activityOffer())
    harness.failNextCommit(); #expect(!workout.logSet())
    let failure = try #require(workout.message)
    #expect(gym.error == failure)
    #expect(workout.sets.isEmpty)
    #expect(try workout.activityRecord()?.offer == offer)
    if !matching { gym.error = "A newer unrelated failure." }
    let notice = GymTransient(gym: gym, message: workout.message, dismiss: { workout.message = nil })
    notice.dismissal(try #require(notice.shown))?()
    #expect(workout.message == nil)
    #expect(gym.error == (matching ? nil : "A newer unrelated failure."))
    #expect(gym.notices.isEmpty && workout.sets.isEmpty)
    #expect(try workout.activityRecord()?.offer == offer)
  }

  @Test func deviationRefusesAnotherSwitchAndIsAskedOnceAfterTodayOnly() throws {
    let (harness, gym) = try fixture(), plan = try routine(gym, scheme: Array(repeating: SetTarget(reps: 5, weightKg: 40), count: 3))
    let workout = try begin(gym, routine: plan)
    workout.add(third); workout.select(first); workout.weightKg = 50; workout.reps = 7; workout.logSet(); workout.select(second)
    let offer = try #require(workout.deviation)
    #expect(!offer.varied && offer.proposed == Array(repeating: SetTarget(reps: 5, weightKg: 50), count: 3))
    workout.select(third)
    #expect(workout.selected == second && workout.deviation == offer)
    #expect(workout.message?.hasSuffix("first — that question is still open.") == true)
    let reopenedGym = GymModel(runner: harness.runner)
    #expect(reopenedGym.workout.deviation == offer)
    workout.resolveDeviation(save: false)
    #expect(workout.walk.asked == [first] && workout.deviation == nil && workout.message == nil)
    #expect(gym.routines.first?.entries == plan.entries)
    workout.select(first); workout.weightKg = 60; workout.logSet(); workout.select(third)
    #expect(workout.deviation == nil && workout.walk.asked == [first])
  }

  @Test func deviationSavesStraightLoadsWithoutChangingFrozenPlan() throws {
    let (_, gym) = try fixture(), plan = try routine(gym, scheme: Array(repeating: SetTarget(reps: 5, weightKg: 40), count: 3))
    let workout = try begin(gym, routine: plan), frozen = try #require(workout.session?.plan)
    workout.weightKg = 50; workout.reps = 7; workout.logSet(); workout.select(second); workout.resolveDeviation(save: true)
    #expect(gym.routines.first?.entries[0].sets == Array(repeating: SetTarget(reps: 5, weightKg: 50), count: 3))
    #expect(workout.session?.plan == frozen && workout.walk.asked == [first] && workout.deviation == nil)
    #expect(workout.sets.map(\.reps) == [7])
  }

  @Test(arguments: [true, false])
  func deviationSaveRefusesMovedServerRevisionAndRebuildsTheOffer(changeTargets: Bool) throws {
    let (harness, gym) = try fixture(anonymous: false)
    #expect(gym.run(CreateExercise(Exercise(id: second, name: "Workout second", pattern: "hinge", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let created = try routine(gym, scheme: Array(repeating: SetTarget(reps: 5, weightKg: 40), count: 3))
    harness.sync(); gym.refresh()
    let plan = try #require(gym.routines.first { $0.id == created.id })
    #expect(plan.revision == 1)
    let other = harness.device(), remote = GymModel(runner: other.runner)
    harness.sync(); remote.refresh()
    let workout = try begin(gym, routine: plan), frozen = try #require(workout.session?.plan)
    workout.weightKg = 50; workout.reps = 7; workout.logSet(); workout.select(second)
    let offered = try #require(workout.deviation)
    #expect(offered.revision == plan.revision && offered.offeredEntry == plan.entries[0])
    var edited = Draft(opening: try #require(remote.routines.first { $0.id == plan.id }))
    edited.current.name = "Updated elsewhere"
    if changeTargets { edited.current.entries[0].sets = Array(repeating: SetTarget(reps: 9, weightKg: 45), count: 2) }
    #expect(saved(remote.save(&edited)))
    harness.sync(); gym.refresh()
    let updated = try #require(gym.routines.first { $0.id == plan.id })
    #expect(updated.revision == 2)
    #expect(workout.deviation == offered)
    let reopened = GymModel(runner: harness.runner)
    #expect(reopened.workout.deviation == offered)
    workout.resolveDeviation(save: true)
    #expect(gym.routines.first { $0.id == plan.id } == updated)
    #expect(workout.walk.asked.isEmpty && workout.walk.pending == first)
    #expect(workout.message == "The routine changed. Today’s sets are saved; review the new offer before changing its targets.")
    let rebuilt = try #require(workout.deviation)
    #expect(rebuilt.routine == updated.name && rebuilt.scheme == updated.entries[0].sets)
    #expect(rebuilt.proposed == updated.entries[0].sets?.map { SetTarget(reps: $0.reps, weightKg: 50) })
    #expect(workout.session?.plan == frozen && workout.sets.map(\.weightKg) == [50])
    harness.sync(); gym.refresh()
    #expect(gym.routines.first { $0.id == plan.id } == updated)
    workout.resolveDeviation(save: true)
    #expect(gym.routines.first { $0.id == plan.id }?.entries[0].sets == rebuilt.proposed)
    #expect(workout.walk.asked == [first] && workout.deviation == nil)
  }

  @Test func deviationRevisionGuardRejectsAnUnpulledRemoteEditAndRestoresItsOffer() throws {
    let (harness, gym) = try fixture(anonymous: false)
    #expect(gym.run(CreateExercise(Exercise(id: second, name: "Workout second", pattern: "hinge", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let created = try routine(gym, scheme: Array(repeating: SetTarget(reps: 5, weightKg: 40), count: 3))
    harness.sync(); gym.refresh()
    let plan = try #require(gym.routines.first { $0.id == created.id })
    let other = harness.device(), remote = GymModel(runner: other.runner)
    harness.sync(); remote.refresh()
    let workout = try begin(gym, routine: plan)
    workout.weightKg = 50; workout.logSet()
    harness.sync(); gym.refresh(); workout.reconcile(); workout.select(second)
    let offered = try #require(workout.deviation), frozen = workout.session?.plan
    var edited = Draft(opening: try #require(remote.routines.first { $0.id == plan.id }))
    edited.current.name = "Changed on another device"
    #expect(saved(remote.save(&edited)))
    other.leave(); remote.refresh()
    let serverRoutine = try #require(harness.server.rows(Gym.scope, of: "workout-tests").first { $0.key == plan.id.ref.key })
    #expect(serverRoutine.lattice.fields["revision"]?.value == JSON(2) && gym.routines.first?.revision == 1)
    workout.resolveDeviation(save: true)
    #expect(workout.deviation == nil && workout.walk.asked == [first])
    harness.sync(); gym.refresh()
    gym.notices = try harness.notices(GymRefusal.self)
    workout.reconcile()
    let refused = try #require(gym.notices.last)
    #expect(refused.subject == plan.id.ref)
    #expect(refused.refusal == .stale(plan.id.ref, .notice))
    let current = try #require(gym.routines.first { $0.id == plan.id })
    #expect(current.name == edited.current.name && current.entries == plan.entries && current.revision == 2)
    let rebuilt = try #require(workout.deviation)
    #expect(rebuilt.revision == 2 && rebuilt.offeredEntry == current.entries[0] && rebuilt.routine == current.name)
    #expect(rebuilt.proposed == offered.proposed && workout.walk.asked.isEmpty)
    #expect(workout.session?.plan == frozen && workout.sets.map(\.weightKg) == [50])
    let reopenedGym = GymModel(runner: harness.runner)
    #expect(reopenedGym.workout.deviation == rebuilt)
    workout.resolveDeviation(save: true)
    workout.reconcile()
    #expect(workout.deviation == nil && workout.walk.asked == [first] && workout.message == nil)
    harness.sync(); gym.refresh(); workout.reconcile()
    #expect(gym.routines.first { $0.id == plan.id }?.entries[0].sets == rebuilt.proposed)
    #expect(gym.routines.first { $0.id == plan.id }?.revision == 3 && workout.walk.offer == nil)
    #expect(workout.deviation == nil && workout.message == nil)
  }

  @Test func variedDeviationSavesExactWorkingSchemeAndRetainsQuestionOnFailure() throws {
    let (harness, gym) = try fixture(), plan = try routine(gym, scheme: [SetTarget(reps: 8, weightKg: 40), SetTarget(reps: 5, weightKg: 60)])
    let workout = try begin(gym, routine: plan)
    #expect(gym.run(AppendSet(value(gym, session: try #require(workout.session), kind: "warmup")))?.refusal == nil)
    workout.reconcile(); workout.weightKg = 45; workout.reps = 9; workout.logSet()
    harness.advance(ms: 1_000); workout.weightKg = 65; workout.reps = 4; workout.logSet(); workout.select(second)
    let offer = try #require(workout.deviation)
    #expect(offer.varied && offer.proposed == [SetTarget(reps: 9, weightKg: 45), SetTarget(reps: 4, weightKg: 65)])
    #expect(offer.saveLabel == "Save today’s sets")
    harness.failNextCommit(); workout.resolveDeviation(save: true)
    #expect(workout.deviation == offer && workout.walk.asked.isEmpty && gym.routines.first?.entries == plan.entries)
    workout.resolveDeviation(save: true)
    #expect(workout.deviation == nil && workout.walk.asked == [first] && gym.routines.first?.entries[0].sets == offer.proposed)
    #expect(workout.session?.plan == SessionPlan(plan))
  }

  @Test func deviationIgnoresWarmupsAndEqualOrLowerWorkingLoad() throws {
    let (_, gym) = try fixture(), plan = try routine(gym, scheme: [SetTarget(reps: 5, weightKg: 40)])
    let workout = try begin(gym, routine: plan)
    #expect(gym.run(AppendSet(value(gym, session: try #require(workout.session), kind: "warmup")))?.refusal == nil)
    workout.reconcile(); workout.weightKg = 40; workout.logSet(); workout.select(second)
    #expect(workout.deviation == nil && workout.walk.asked.isEmpty)
  }

  @Test func failedFinishKeepsWorkoutOpenAndRetryCreatesReceipt() async throws {
    let (harness, gym) = try fixture(), workout = try begin(gym)
    workout.logSet(); harness.advance(ms: 5_000); harness.failNextCommit()
    await workout.finish()
    #expect(workout.receipt == nil && workout.session?.isOpen == true && !workout.finishing)
    #expect(workout.message == "Gym could not save this change. Try again.")
    await workout.finish()
    let receipt = try #require(workout.receipt)
    #expect(!receipt.session.isOpen && receipt.session.closedBy == "finish" && receipt.sets == workout.sets)
    #expect(gym.openSession == nil && workout.message == nil && receipt.readout.durationMs == 5_000)
    workout.closeReceipt()
    #expect(workout.receipt == nil && workout.handoff == .detail(workout.sessionId))
  }

  @Test func confirmedFinishQueuesCommandWithoutPredictingClosedSession() throws {
    let (harness, gym) = try fixture(anonymous: false), workout = try begin(gym)
    #expect(workout.canLog)
    workout.logSet()
    let appended = try #require(workout.sets.first, "Logging failed: \(workout.message ?? "no message")")
    harness.sync(); gym.refresh(); workout.reconcile()
    let notices = try harness.notices(GymRefusal.self)
    #expect(notices.isEmpty, "Admission refusals: \(notices.map(\.refusal)); refused fields: \(notices.map { $0.values(of: appended.id.ref) })")
    let session = try #require(workout.session)
    #expect(gym.run(FinishWorkout(id: session.id))?.receipt != nil)
    #expect(workout.session == session && gym.openSession?.id == session.id)
    let commands = try harness.runner.read(Gym.scope) { try $0.commands() }
    #expect(commands.count == 1 && commands[0].command.name == Gym.Commands.finish)
    #expect(commands[0].command.args["sessionId"] == session.id.json)
    harness.sync(); gym.refresh()
    #expect(workout.session?.isOpen == false && gym.openSession == nil)
  }

  @Test func pendingCorrectionBlocksFinishAndImmediateDeletionQueuesBeforeFinish() throws {
    let (harness, gym) = try fixture(anonymous: false), workout = try begin(gym)
    #expect(workout.canLog)
    workout.logSet()
    let appended = try #require(workout.sets.first, "Logging failed: \(workout.message ?? "no message")")
    harness.sync(); gym.refresh(); workout.reconcile()
    let notices = try harness.notices(GymRefusal.self)
    #expect(notices.isEmpty, "Admission refusals: \(notices.map(\.refusal)); refused fields: \(notices.map { $0.values(of: appended.id.ref) })")
    #expect(try harness.drawn(TrainingSet.self).map(\.id) == [appended.id])
    let session = try #require(workout.session)
    var corrected = try #require(workout.sets.first); corrected.weightKg = 25
    #expect(gym.run(CorrectSet(corrected))?.receipt != nil)
    #expect(gym.run(FinishWorkout(id: session.id))?.refusal != nil && workout.session?.isOpen == true)
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().isEmpty })
    harness.sync(); gym.refresh()
    let removal = try #require(gym.run(DeleteSet(corrected.id))?.receipt)
    #expect(workout.sets.isEmpty && removal.releaseAt == nil)
    #expect(gym.run(FinishWorkout(id: session.id))?.receipt != nil && workout.session?.isOpen == true)
    harness.sync(); gym.refresh()
    #expect(workout.session?.isOpen == false && workout.sets.isEmpty)
  }

  @Test func unsyncedAppendPreventConfirmedFinishUntilAdmission() throws {
    let (harness, gym) = try fixture(anonymous: false), workout = try begin(gym)
    harness.sync(); gym.refresh(); workout.reconcile(); workout.logSet()
    #expect(gym.run(FinishWorkout(id: try #require(workout.sessionId)))?.refusal != nil)
    #expect(workout.session?.isOpen == true)
    harness.sync(); gym.refresh()
    #expect(gym.run(FinishWorkout(id: try #require(workout.sessionId)))?.receipt != nil)
  }

  @Test func queuedFinishLocksLoggingAndRetryUntilServerResolvesIt() async throws {
    let (harness, gym) = try fixture(anonymous: false), workout = try begin(gym)
    workout.logSet(); harness.sync(); gym.refresh(); workout.reconcile()
    let retained = workout.sets
    await workout.finish()
    #expect(workout.session?.isOpen == true && workout.receipt == nil && !workout.finishing)
    #expect(!workout.canLog)
    workout.weightKg = 100; workout.logSet()
    #expect(workout.sets == retained)
    await workout.finish()
    let commands = try harness.runner.read(Gym.scope) { try $0.commands() }
    #expect(commands.count == 1 && commands[0].command.name == Gym.Commands.finish)
    harness.server.refuse(code: Gym.Codes.sessionOpen); harness.sync(); gym.refresh(); workout.reconcile()
    #expect(workout.session?.isOpen == true && workout.canLog)
    #expect(try harness.runner.read(Gym.scope) { try $0.commands().isEmpty })
    workout.logSet()
    #expect(workout.sets.count == retained.count + 1)
  }

  @Test func accountChangeClearsPreviousWorkoutContentAndTransientState() async throws {
    let transport = JournalModelTransport(), runtime = try GymModelTests().runtime(transport: transport)
    let owner = transport.identity(email: "workout-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let workout = try begin(gym)
    workout.logSet()
    let old = try #require(workout.session)
    var closed = old; closed.finishedAt = Instant(ms: old.startedAt.ms + 1_000); closed.closedBy = "finish"
    workout.receipt = WorkoutReceiptData(session: closed, sets: workout.sets, routineId: gym.runner.mint(Routine.self), routinePosition: 0)
    workout.receipt?.routine.current.name = "Private previous account name"
    workout.handoff = .coach; workout.message = "Private previous account message"
    workout.drafts[first] = Prefill(weightKg: 111, reps: 9)
    workout.weightKg = 111; workout.reps = 9; workout.paging = true
    _ = try await runtime.engine.signOut().finish(.keep)
    let other = transport.identity(email: "workout-other@example.com")
    #expect(try await runtime.engine.signIn(account: other.account, token: other.token).isComplete)
    gym.refresh(); workout.accountChanged()
    #expect(gym.account == other.account && gym.sessions.isEmpty && gym.sets.isEmpty)
    #expect(workout.sessionId == nil && workout.session == nil && workout.walk == WorkoutWalk())
    #expect(workout.receipt == nil && workout.handoff == nil && workout.message == nil && workout.drafts.isEmpty)
    #expect(workout.offerSession == nil && workout.offerSets.isEmpty && !workout.paging && !workout.finishing)
    #expect(workout.weightKg == Prefill.emptyBarKg && workout.reps == Prefill.emptyBarReps)
    #expect(!workout.canLog && !workout.isPresented)
  }

  @Test func serverFinishRefusalKeepsConfirmedWorkoutOpen() throws {
    let (harness, gym) = try fixture(anonymous: false), workout = try begin(gym)
    harness.sync(); gym.refresh()
    harness.server.refuse(code: Gym.Codes.sessionOpen)
    #expect(gym.run(FinishWorkout(id: try #require(workout.sessionId)))?.receipt != nil)
    harness.sync(); gym.refresh()
    #expect(workout.session?.isOpen == true && workout.receipt == nil)
    #expect(try harness.notices(GymRefusal.self).count == 1)
  }

  // Canon's heading: fewer than four working sets read Ended early., planned or free; the plan does not decide it.
  @Test func receiptSaysEndedEarlyBelowFourWorkingSetsPlannedOrFree() throws {
    let (_, gym) = try fixture()
    let title = { (session: Session, working: Int) in
      WorkoutReceiptData(session: session, sets: (0..<working).map { _ in value(gym, session: session) } + [value(gym, session: session, kind: "warmup")],
                         routineId: gym.runner.mint(Routine.self), routinePosition: 0).title
    }
    let single = finished(gym, routine: try routine(gym, scheme: [SetTarget(reps: 12)]))
    let three = finished(gym, routine: try routine(gym, scheme: Array(repeating: SetTarget(reps: 5, weightKg: 80), count: 3)))
    let open = finished(gym, routine: Routine(id: gym.runner.mint(Routine.self), name: "Open", entries: [RoutineEntry(exerciseId: first)]))
    #expect([title(single, 1), title(three, 3), title(three, 4), title(finished(gym), 3), title(finished(gym), 4), title(open, 3), title(open, 4)]
            == ["Ended early.", "Ended early.", "Well done.", "Ended early.", "Well done.", "Ended early.", "Well done."])
  }

  @Test func receiptOffersRoutineOnlyForFourUnplannedWorkingSets() throws {
    let (_, gym) = try fixture(), session = finished(gym)
    let working = (0..<4).map { value(gym, session: session, at: Instant(ms: start.ms + Int64($0))) }
    let warmup = value(gym, session: session, kind: "warmup")
    let three = WorkoutReceiptData(session: session, sets: Array(working.prefix(3)) + [warmup], routineId: gym.runner.mint(Routine.self), routinePosition: 0)
    #expect(three.slight && !three.offersRoutine && three.readout.workingSetCount == 3)
    let four = WorkoutReceiptData(session: session, sets: working + [warmup], routineId: gym.runner.mint(Routine.self), routinePosition: 0)
    #expect(!four.slight && four.offersRoutine && four.readout.workingSetCount == 4 && four.readout.volumeKg == 1_600)
    let plan = try routine(gym, scheme: [SetTarget(reps: 5, weightKg: 80)]), planned = finished(gym, routine: plan)
    let plannedSets = (0..<4).map { _ in value(gym, session: planned) }
    #expect(!WorkoutReceiptData(session: planned, sets: plannedSets, routineId: gym.runner.mint(Routine.self), routinePosition: 0).offersRoutine)
  }

  @Test func receiptRoutineHasExactChronologicalWorkingSchemesAndLoads() throws {
    let (_, gym) = try fixture(), session = finished(gym), foreign = finished(gym)
    let a = value(gym, session: session, weight: 40, reps: 8, at: Instant(ms: start.ms + 10))
    let b = value(gym, session: session, exercise: second, weight: -20, reps: 6, at: Instant(ms: start.ms + 20))
    let c = value(gym, session: session, weight: 50, reps: 5, at: Instant(ms: start.ms + 30))
    let d = value(gym, session: session, exercise: second, weight: 0, reps: 10, at: Instant(ms: start.ms + 40))
    let warmup = value(gym, session: session, weight: 20, kind: "warmup")
    let receipt = WorkoutReceiptData(session: session, sets: [d, c, value(gym, session: foreign), b, warmup, a],
                                     routineId: gym.runner.mint(Routine.self), routinePosition: 7)
    #expect(receipt.sets == [warmup, a, b, c, d])
    #expect(receipt.routine.current.position == 7)
    #expect(receipt.routine.current.entries == [
      RoutineEntry(exerciseId: first, sets: [SetTarget(reps: 8, weightKg: 40), SetTarget(reps: 5, weightKg: 50)]),
      RoutineEntry(exerciseId: second, sets: [SetTarget(reps: 6, weightKg: -20), SetTarget(reps: 10, weightKg: 0)]),
    ])
  }

  @Test func receiptSavesPerformedZeroLoadTargetsWithoutConvertingThemToOpenTargets() throws {
    let (_, gym) = try fixture(), session = finished(gym), id = gym.runner.mint(Routine.self)
    let receipt = WorkoutReceiptData(session: session, sets: (0..<4).map { _ in value(gym, session: session, weight: 0, reps: 10) },
                                     routineId: id, routinePosition: 0)
    receipt.routine.current.name = "Bodyweight routine"
    #expect(receipt.routine.current.entries == [RoutineEntry(exerciseId: first, sets: Array(repeating: SetTarget(reps: 10, weightKg: 0), count: 4))])
    #expect(receipt.saveRoutine(gym) && !receipt.routine.isNew && receipt.routine.current.id == id)
    #expect(receipt.keptName == "Bodyweight routine" && receipt.failure == nil && gym.routines.map(\.id) == [id])
    #expect(gym.routines.first?.entries == receipt.routine.current.entries && gym.refusal == nil)
  }

  @Test func receiptSaveRetainsIdentityThroughFailureAndPreventsDuplicateSave() throws {
    let (harness, gym) = try fixture(), session = finished(gym)
    let sets = (0..<4).map { _ in value(gym, session: session) }, id = gym.runner.mint(Routine.self)
    let receipt = WorkoutReceiptData(session: session, sets: sets, routineId: id, routinePosition: 0)
    receipt.routine.current.name = "Private kept routine"
    harness.failNextCommit()
    #expect(!receipt.saveRoutine(gym) && receipt.routine.isNew && receipt.routine.current.id == id)
    #expect(receipt.keptName == nil && receipt.failure == "Gym could not save this change. Try again." && !receipt.saving)
    #expect(receipt.saveRoutine(gym) && receipt.keptName == "Private kept routine" && receipt.failure == nil)
    #expect(gym.routines.map(\.id) == [id] && !receipt.routine.isNew)
    #expect(!receipt.saveRoutine(gym) && gym.routines.map(\.id) == [id])
  }

  @Test func terminalReceiptRoutineRefusalRetainsIdentityAndAllowsOneRetry() async throws {
    let transport = JournalModelTransport(), runtime = try GymModelTests().runtime(transport: transport)
    let owner = transport.identity(email: "receipt-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    await runtime.engine.flushOnLeave(); gym.refresh()
    #expect(gym.notices.isEmpty && gym.catalogue.find(first) != nil)
    let session = finished(gym), id = gym.runner.mint(Routine.self)
    let receipt = WorkoutReceiptData(session: session, sets: (0..<4).map { _ in value(gym, session: session) },
                                     routineId: id, routinePosition: 3)
    receipt.routine.current.name = "Private refused routine"
    let proposed = receipt.routine.current
    #expect(receipt.saveRoutine(gym) && receipt.keptName == proposed.name && !receipt.routine.isNew)
    #expect(gym.routines == [proposed])
    transport.state.withLock { $0.server.refuse(code: .cap, detail: ["type": .string(Routine.type), "cap": 10]) }
    await runtime.engine.flushOnLeave(); gym.refresh()
    let notice = try #require(gym.notices.last)
    #expect(notice.subject == id.ref && notice.refusal == .full(type: Routine.type, cap: 10, .notice))
    #expect(gym.routines.isEmpty)
    receipt.reconcile(gym)
    #expect(receipt.keptName == nil && receipt.routine.isNew && receipt.routine.current == proposed)
    #expect(!receipt.saving && receipt.failure == "There is room for 10. Remove one before adding another.")
    #expect(receipt.saveRoutine(gym) && receipt.keptName == proposed.name && receipt.failure == nil)
    receipt.reconcile(gym)
    #expect(receipt.keptName == proposed.name && !receipt.routine.isNew && receipt.failure == nil)
    #expect(!receipt.saveRoutine(gym) && gym.routines.map(\.id) == [id])
    await runtime.engine.flushOnLeave(); gym.refresh(); receipt.reconcile(gym)
    #expect(gym.routines.map(\.id) == [id] && gym.notices.map(\.id) == [notice.id])
    #expect(try #require(gym.routines.first).fields == proposed.fields)
    #expect(receipt.keptName == proposed.name && !receipt.routine.isNew && receipt.failure == nil)
    #expect(!receipt.saveRoutine(gym) && gym.routines.map(\.id) == [id])
  }

  @Test func receiptNamesUseNormalizedCharacterCapAndRejectBlank() throws {
    let (_, gym) = try fixture(), session = finished(gym)
    let receipt = WorkoutReceiptData(session: session, sets: (0..<4).map { _ in value(gym, session: session) }, routineId: gym.runner.mint(Routine.self), routinePosition: 0)
    receipt.routine.current.name = " \n "
    #expect(receipt.nameRefusal == "Name it to save it." && !receipt.saveRoutine(gym))
    receipt.routine.current.name = String(repeating: "e\u{301}", count: 60)
    #expect(receipt.nameRefusal == nil)
    receipt.routine.current.name += "a"
    #expect(receipt.nameRefusal == "Use 60 characters or fewer." && !receipt.saveRoutine(gym))
    receipt.routine.current.name = String(repeating: "é", count: 60)
    #expect(receipt.saveRoutine(gym) && receipt.keptName == String(repeating: "é", count: 60))
  }

  @Test func reviewDecodesPlanLastTimePerformedAndMixedComparison() throws {
    let data = Data(#"{"against":{"routine":"Private routine","movements":[{"exerciseId":"one","now":{"sets":2,"reps":4,"weightKg":40},"planned":{"sets":[{"reps":5,"weightKg":40},{"reps":5,"weightKg":40}]}},{"exerciseId":"two","now":{"sets":3,"reps":6,"weightKg":60},"before":{"sets":2,"reps":5,"weightKg":55},"planned":{}},{"exerciseId":"three","now":{"sets":1,"reps":10,"weightKg":0}}]}}"#.utf8)
    let review = try JSONDecoder().decode(WorkoutReview.self, from: data), against = try #require(review.against)
    #expect(against.title == "Comparison" && against.movements.map(\.source) == ["Plan", "Last time", "Performed"])
    #expect(against.movements.map(\.detail) == ["planned 2 × 5 · 40 — did 2 × 4 · 40", "2 × 5 · 55 → 3 × 6 · 60", "1 × 10"])
    for (index, title) in ["Against plan", "Against last Private routine", "Performed"].enumerated() {
      let single = WorkoutReview.Against(routine: "Private routine", movements: [against.movements[index]])
      #expect(single.title == title)
    }
  }

  @Test(arguments: ["e1rm", "heaviest", "reps-at-weight", "unknown"])
  func reviewRecordRequiresPreviousAndHidesUnsupportedKinds(kind: String) throws {
    let (_, gym) = try fixture()
    let object: [String: Any] = ["record": ["kind": kind, "exerciseId": first.record.string ?? "", "value": 100,
      "weightKg": 80, "reps": 8, "previous": 90, "previousAt": start.ms]]
    let review = try JSONDecoder().decode(WorkoutReview.self, from: JSONSerialization.data(withJSONObject: object))
    let record = try #require(review.record), name = gym.catalogue.find(first)?.name ?? "Movement"
    let dates = GymDate(Moment(now: Instant(ms: start.ms + 86_400_000), zone: FixedZone(offsetSeconds: 0)))
    let sentences = ["e1rm": "\(name) e1RM 100 kg — past 90 from yesterday.", "heaviest": "\(name) 100 kg × 8 — past 90 from yesterday.",
                     "reps-at-weight": "\(name) 8 reps at 80 kg — past 90 from yesterday."]
    #expect(record.sentence(gym.catalogue, dates: dates) == sentences[kind])
    let missing = WorkoutReview.Record(kind: kind, exerciseId: first.record.string ?? "", value: 100, weightKg: 80,
                                        reps: 8, previous: nil, previousAt: nil)
    #expect(missing.sentence(gym.catalogue, dates: dates) == nil)
  }

  @Test(arguments: ["now", "before"])
  func reviewRejectsInvalidEffortNumbers(field: String) {
    let valid = #"{"sets":1,"reps":5,"weightKg":40}"#
    let invalid = [
      #"{"sets":0,"reps":5,"weightKg":40}"#, #"{"sets":-1,"reps":5,"weightKg":40}"#,
      #"{"sets":1,"reps":0,"weightKg":40}"#, #"{"sets":1,"reps":501,"weightKg":40}"#,
      #"{"sets":1,"reps":5,"weightKg":500.01}"#, #"{"sets":1,"reps":5,"weightKg":-500.01}"#,
      #"{"sets":1,"reps":5,"weightKg":1e20}"#, #"{"sets":1,"reps":5,"weightKg":"Infinity"}"#,
      #"{"sets":1,"reps":5,"weightKg":"NaN"}"#,
    ]
    let decoder = JSONDecoder()
    decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
    for numbers in invalid {
      let now = field == "now" ? numbers : valid, before = field == "before" ? numbers : valid
      let data = Data("{\"against\":{\"movements\":[{\"exerciseId\":\"one\",\"now\":\(now),\"before\":\(before)}]}}".utf8)
      #expect(throws: DecodingError.self, "Invalid \(field): \(numbers)") { try decoder.decode(WorkoutReview.self, from: data) }
    }
  }

  @Test func reviewRejectsInvalidPlannedTargetNumbers() {
    let invalid = [#"{"reps":0}"#, #"{"reps":101}"#, #"{"weightKg":500.01}"#, #"{"weightKg":-500.01}"#,
                   #"{"weightKg":1e20}"#, #"{"weightKg":"Infinity"}"#, #"{"weightKg":"NaN"}"#]
    let decoder = JSONDecoder()
    decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
    for target in invalid {
      let data = Data("{\"against\":{\"movements\":[{\"exerciseId\":\"one\",\"now\":{\"sets\":1,\"reps\":5,\"weightKg\":40},\"planned\":{\"sets\":[\(target)]}}]}}".utf8)
      #expect(throws: DecodingError.self, "Invalid planned target: \(target)") { try decoder.decode(WorkoutReview.self, from: data) }
    }
  }

  @Test(arguments: ["e1rm", "heaviest", "reps-at-weight", "unknown"])
  func reviewRejectsUnsafeRecordNumbers(kind: String) throws {
    let invalid: [(String, Any)] = [("value", 9_000.01), ("value", -9_000.01), ("previous", 9_000.01),
      ("previous", -9_000.01), ("weightKg", 500.01), ("weightKg", -500.01), ("reps", 0), ("reps", 501),
      ("value", 1e20), ("previous", "Infinity"), ("weightKg", "NaN")]
    let decoder = JSONDecoder()
    decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
    for (field, value) in invalid {
      var record: [String: Any] = ["kind": kind, "exerciseId": "one", "value": 100, "weightKg": 80,
                                   "reps": 8, "previous": 90, "previousAt": start.ms]
      record[field] = value
      let data = try JSONSerialization.data(withJSONObject: ["record": record])
      #expect(throws: DecodingError.self, "Invalid \(kind) \(field): \(value)") { try decoder.decode(WorkoutReview.self, from: data) }
    }
  }

  @Test func reviewAcceptsDomainBoundariesAndMoreThanTwentyPerformedSets() throws {
    let data = Data(#"{"record":{"kind":"e1rm","exerciseId":"one","value":8833.3,"weightKg":500,"reps":500,"previous":-9000,"previousAt":0},"against":{"movements":[{"exerciseId":"one","now":{"sets":21,"reps":500,"weightKg":500},"before":{"sets":1,"reps":1,"weightKg":-500},"planned":{"sets":[{"reps":1,"weightKg":-500},{"reps":100,"weightKg":500},{"reps":null,"weightKg":null},{"weightKg":0}]}}]}}"#.utf8)
    let review = try JSONDecoder().decode(WorkoutReview.self, from: data)
    let record = try #require(review.record), movement = try #require(review.against?.movements.first)
    #expect(record.value == 8_833.3 && record.previous == -9_000 && record.weightKg == 500 && record.reps == 500)
    #expect(movement.now.sets == 21 && movement.now.reading == "21 × 500 · 500")
    #expect(movement.before?.reading == "1 × 1 · −500")
    #expect(movement.planned?.scheme == [SetTarget(reps: 1, weightKg: -500), SetTarget(reps: 100, weightKg: 500), SetTarget(), SetTarget(weightKg: 0)])
    #expect(!movement.detail.isEmpty)
  }

  @Test func malformedReviewFailsDecodingAndReviewFailureKeepsSavedSession() async throws {
    #expect(throws: (any Error).self) { try JSONDecoder().decode(WorkoutReview.self, from: Data(#"{"against":{"movements":[{"exerciseId":"one","now":{"sets":2}}]}}"#.utf8)) }
    let (_, gym) = try fixture(anonymous: false), session = finished(gym)
    let receipt = WorkoutReceiptData(session: session, sets: [], routineId: gym.runner.mint(Routine.self), routinePosition: 0)
    await receipt.loadReview(gym)
    #expect(receipt.reviewFailed && !receipt.readingReview && receipt.review == nil && receipt.session == session)
    let (_, anonymous) = try fixture()
    let local = WorkoutReceiptData(session: session, sets: [], routineId: anonymous.runner.mint(Routine.self), routinePosition: 0)
    await local.loadReview(anonymous)
    #expect(!local.reviewFailed && !local.readingReview && local.review == nil)
  }

  @Test func workoutTelemetryContainsOnlyBoundedLabels() async throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixture(telemetry: recorder)
    let plan = try routine(gym, scheme: [SetTarget(reps: 5, weightKg: 40)]), workout = try begin(gym, routine: plan)
    workout.weightKg = 50; workout.logSet()
    let draft = SetFixDraft(try #require(workout.sets.first), account: gym.account); draft.note = "Private content that must stay local"
    #expect(draft.save(gym))
    workout.select(second); workout.resolveDeviation(save: true)
    harness.advance(ms: 1_000); await workout.finish()
    let entries = recorder.entries.withLock { $0 }
    #expect(entries.filter { $0.name == "gym_session_started" }.map(\.properties) == [["screen": "workout", "outcome": "ok"]])
    #expect(entries.filter { $0.name == "gym_set_logged" }.map(\.properties) == [["screen": "workout", "outcome": "ok"]])
    #expect(entries.filter { $0.name == "gym_session_finished" }.map(\.properties) == [["screen": "workout", "outcome": "ok"]])
    #expect(entries.filter { $0.name == "gym_routine_saved" }.map(\.properties) == [["screen": "workout", "action": "update"]])
    #expect(entries.filter { $0.name == "gym_workout_adjusted" }.map(\.properties) == [["screen": "workout", "field": "weight", "outcome": "ok"]])
    #expect(entries.allSatisfy { Set($0.properties.keys).isSubset(of: ["screen", "action", "field", "outcome", "operation", "failure_kind"]) })
    #expect(entries.allSatisfy { $0.properties.values.allSatisfy { ["workout", "gym", "update", "weight", "ok", "refused", "failed"].contains($0) } })
  }

  @Test func drainReturnsSuccessAndCancelsTimeoutChild() async {
    let started = ContinuousClock.now
    #expect(await WorkoutState.drain(timeout: .seconds(2), operation: {}))
    #expect(started.duration(to: .now) < .seconds(1))
  }

  @Test func finishDrainTimeoutReportsOneBoundedFailureAndRetainsWorkout() async throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixture(telemetry: recorder), workout = try begin(gym)
    workout.logSet()
    let session = try #require(workout.session), retained = workout.sets, started = ContinuousClock.now
    let cancelled = Mutex(false)
    let completed = await workout.drainForFinish(timeout: .milliseconds(30)) {
      do { try await Task.sleep(for: .seconds(10)) }
      catch { cancelled.withLock { $0 = true } }
    }
    #expect(!completed && started.duration(to: .now) < .seconds(1))
    #expect(await Self.until { cancelled.withLock { $0 } })
    #expect(workout.session == session && workout.sets == retained && workout.receipt == nil && workout.canLog)
    let failures = recorder.entries.withLock { $0.filter { $0.name == "client_error" } }
    #expect(failures.map(\.properties) == [["operation": "gym_flush", "failure_kind": "timeout"]])
    #expect(await workout.drainForFinish(timeout: .seconds(1), operation: {}))
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.count } == 1)
  }

  @Test func cancelledFinishDrainReportsNoTimeoutAndRetainsWorkout() async throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixture(telemetry: recorder), workout = try begin(gym)
    workout.logSet()
    let session = try #require(workout.session), retained = workout.sets
    let entered = Mutex(false), cancelled = Mutex(false), started = ContinuousClock.now
    let drain = Task {
      await workout.drainForFinish(timeout: .seconds(10)) {
        entered.withLock { $0 = true }
        do { try await Task.sleep(for: .seconds(10)) }
        catch { cancelled.withLock { $0 = true } }
      }
    }
    for _ in 0..<100 where !entered.withLock({ $0 }) { try await Task.sleep(for: .milliseconds(2)) }
    #expect(entered.withLock { $0 }); drain.cancel()
    #expect(await drain.value == false && started.duration(to: .now) < .seconds(1))
    #expect(await Self.until { cancelled.withLock { $0 } })
    #expect(workout.session == session && workout.sets == retained && workout.receipt == nil && workout.canLog)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
    #expect(await workout.drainForFinish(timeout: .milliseconds(30)) {
      await MainActor.run { gym.accountChanging = true }
      try? await Task.sleep(for: .seconds(10))
    } == false)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
  }

  @Test func drainTimeoutCancelsStalledOperationWithinBound() async {
    let cancelled = Mutex(false), started = ContinuousClock.now
    let result = await WorkoutState.drain(timeout: .milliseconds(30)) {
      do { try await Task.sleep(for: .seconds(10)) }
      catch { cancelled.withLock { $0 = true } }
    }
    #expect(!result)
    #expect(await Self.until { cancelled.withLock { $0 } })
    #expect(started.duration(to: .now) < .seconds(1))
  }

  @Test func drainParentCancellationStopsOperationAndReportsNoSuccess() async throws {
    let entered = Mutex(false), cancelled = Mutex(false), started = ContinuousClock.now
    let drain = Task {
      await WorkoutState.drain(timeout: .seconds(10)) {
        entered.withLock { $0 = true }
        do { try await Task.sleep(for: .seconds(10)) }
        catch { cancelled.withLock { $0 = true } }
      }
    }
    for _ in 0..<100 where !entered.withLock({ $0 }) { try await Task.sleep(for: .milliseconds(2)) }
    #expect(entered.withLock { $0 }); drain.cancel()
    #expect(await drain.value == false)
    #expect(await Self.until { cancelled.withLock { $0 } })
    #expect(started.duration(to: .now) < .seconds(1))
  }

  @Test(arguments: [false, true])
  func drainDoesNotJoinAnOperationThatIgnoresCancellation(cancel: Bool) async throws {
    let pending = Mutex<CheckedContinuation<Void, Never>?>(nil)
    let started = ContinuousClock.now
    let drain = Task {
      await WorkoutState.drain(timeout: cancel ? .seconds(10) : .milliseconds(30)) {
        await withCheckedContinuation { continuation in pending.withLock { $0 = continuation } }
      }
    }
    #expect(await Self.until { pending.withLock { $0 != nil } })
    if cancel { drain.cancel() }
    #expect(await drain.value == false && started.duration(to: .now) < .seconds(1))
    pending.withLock { $0?.resume(); $0 = nil }
  }

  // A push the server will not take — stopped for good by the update it requires, or refused by a status the sender
  // retries — holds its sets back: the ledger, the log, the workout and the lock screen all read them as unsent, and
  // Finish names what holds it.
  @Test(arguments: [426, 403])
  func aPushTheServerWillNotTakeMarksItsSetsUnsent(status: Int) async throws {
    let fault = WorkoutFaultTransport(), runtime = try Self.faultRuntime(fault, drivesLoops: true), engine = runtime.engine
    let identity = fault.model.identity(email: "unsent-\(status)@example.com")
    #expect(try await engine.signIn(account: identity.account, token: identity.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    await engine.flushOnLeave(); gym.refresh()
    let workout = try begin(gym)
    await engine.flushOnLeave(); gym.refresh(); workout.reconcile()
    fault.failure.withLock { $0 = status }
    #expect(workout.logSet())
    await engine.flushOnLeave()
    #expect(await Self.until { status == 426 ? engine.status.upgradeRequired : !engine.status.failedPushes.isEmpty })
    gym.refresh(); workout.reconcile()
    let unconfirmed = gym.unconfirmedSets(workout.sets)
    #expect(unconfirmed.count == 1 && gym.unsentSets(workout.sets) == unconfirmed)
    #expect(gym.sessionIsUnsent(try #require(workout.sessionId)))
    if status == 426 {
      await workout.finish()
      #expect(workout.message == "Finish needs the update — keep logging, or hide the workout.")
    }
    gym.stop()
  }
}

// The server's refusals as it shapes them: a 426 names `upgrade-required`, which the engine reads before it stops.
nonisolated final class WorkoutFaultTransport: SyncTransport {
  let model = JournalModelTransport()
  let failure = Mutex<Int?>(nil)
  let pushDelay = Mutex<Duration?>(nil)
  let pullFailure = Mutex<Int?>(nil)
  let pullDelay = Mutex<Duration?>(nil)
  let pullRequests = Mutex(0)
  func hello(token: SessionToken?) async -> Reply<HelloResponse> { await model.hello(token: token) }
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    if let delay = pushDelay.withLock({ $0 }) {
      do { try await Task.sleep(for: delay) } catch { return .unreachable }
    }
    if let status = failure.withLock({ $0 }) {
      return status == 0 ? .unreachable : .answered(.failed(HTTPFailure(status: status, error: status == 426 ? "upgrade-required" : "refused")))
    }
    return await model.push(request, token: token)
  }
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    pullRequests.withLock { $0 += 1 }
    if let delay = pullDelay.withLock({ $0 }) {
      do { try await Task.sleep(for: delay) } catch { return .unreachable }
    }
    if let status = pullFailure.withLock({ $0 }) { return .answered(.failed(HTTPFailure(status: status))) }
    return await model.pull(request, token: token)
  }
  func openLive(token: SessionToken) async -> Reply<any LiveConnection> { await model.openLive(token: token) }
}
