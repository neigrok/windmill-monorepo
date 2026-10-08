import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import SyncStore
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct WorkoutActivityTests {
  let fixtures = WorkoutStateTests()

  @Test func currentOfferLogsPremintedSetThroughTheDurableEngineQueue() throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixtures.fixture(anonymous: false, telemetry: recorder)
    let workout = try fixtures.begin(gym)
    harness.sync(); gym.refresh(); workout.reconcile()
    workout.weightKg = -25.5; workout.reps = 8
    let offer = try #require(workout.activityOffer()), session = try #require(workout.session)
    #expect(try workout.activityRecord()?.offer == offer)
    #expect(workout.logActivityOffer(offer))
    let expected = TrainingSet(id: ID(RecordID(offer.setID)), sessionId: session.id, exerciseId: fixtures.first,
                               weightKg: -25.5, reps: 8, kind: "working", completedAt: fixtures.start)
    #expect(workout.sets == [expected])
    let pending = try #require(gym.runner.read(Gym.scope) { try $0.repository(TrainingSet.self).record(expected.id, in: .stored) })
    #expect(pending.isPending && pending.isVisible)
    #expect(try gym.runner.read(Gym.scope) { try $0.commands().isEmpty })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.map(\.properties) } == [[:]])
    harness.sync(); gym.refresh(); workout.reconcile()
    let confirmed = TrainingSet(id: expected.id, sessionId: expected.sessionId, exerciseId: expected.exerciseId,
                                weightKg: expected.weightKg, reps: expected.reps, kind: expected.kind, completedAt: expected.completedAt, setNumber: 1)
    #expect(workout.sets == [confirmed] && gym.workoutDeviceSets(workout.sets).isEmpty)
    #expect(try harness.notices(GymRefusal.self).isEmpty)
  }

  @Test func liveActivityBoardHelloLoggingAndFinishUseTheSameClock() async throws {
    let board = "workout-live-activity-planned", suite = "activity-board-clock-" + UUID().uuidString
    let directory = FileManager.default.temporaryDirectory.appending(path: suite), preferences = UserDefaults(suiteName: suite)!
    let runtime = try AppRuntime(settings: AppSettings(arguments: ["app", "-model-server", "-board", board]),
      directory: directory, service: "works.windmill." + suite)
    defer {
      try? runtime.engine.leave()
      preferences.removePersistentDomain(forName: suite)
    }
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime)
    #expect(await WorkoutFixture.prepare(board, model: model))
    let gym = model.gym, workout = gym.workout, started = try #require(workout.session), seeded = workout.sets
    #expect(gym.isAnonymous && seeded.count == 3)
    #expect(runtime.auth.fake?.boardClock == false)
    await runtime.engine.start()
    #expect(await WorkoutStateTests.until {
      (try? runtime.storageRead { try $0.device().activeReplica.meta.offset.clockReading }) != nil
    })
    let offset = try runtime.storageRead { try $0.device().activeReplica.meta.serverOffsetMs }
    #expect(abs(offset) < 1_000)
    gym.refresh(); workout.reconcile()
    let offer = try #require(workout.activityOffer())
    #expect(workout.logActivityOffer(offer))
    let retained = workout.sets
    #expect(retained.count == 4 && Set(retained.map(\.id)) == Set(seeded.map(\.id) + [ID<TrainingSet>(RecordID(offer.setID))]))
    #expect((retained.first { $0.id.description == offer.setID }?.completedAt.ms ?? 0) >= started.startedAt.ms)
    await workout.finish()
    #expect(workout.sets == retained)
    let receipt = try #require(workout.receipt)
    #expect(receipt.session.id == started.id && receipt.session.closedBy == "finish" && receipt.sets == retained)
    #expect(gym.openSession == nil && workout.message == nil && gym.refusal == nil)
  }

  @Test(arguments: [-3_600_000 as Int64, 0, 3_600_000])
  func activityPayloadMapsCorrectedTimestampsToDeviceWallClock(offset: Int64) throws {
    let clock = SimClock(wallMs: fixtures.start.ms), runtime = try WorkoutStateTests.faultRuntime(WorkoutFaultTransport(), clock: clock.engineClock)
    let reading = clock.reading()
    _ = try runtime.store.sample(serverTime: reading.wall + offset, timing: .init(send: reading, recv: reading))
    #expect(try runtime.storageRead { try $0.device().activeReplica.meta.serverOffsetMs } == offset)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: fixtures.first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let workout = try fixtures.begin(gym), session = try #require(workout.session)
    let controller = WorkoutActivityController(gym: gym), offer = try #require(workout.activityOffer())
    let empty = try controller.content(session: session, offer: offer)
    let startedOnDevice = Date(timeIntervalSince1970: Double(clock.nowMs()) / 1000)
    #expect(session.startedAt.ms == clock.nowMs() + offset)
    #expect(empty.state.startedAt == startedOnDevice && empty.state.lastSetAt == nil)
    #expect(empty.state.staleAt == startedOnDevice.addingTimeInterval(Double(SessionRules.staleAfterMs) / 1000))
    #expect(empty.staleDate == empty.state.staleAt && empty.state.offer == offer)

    clock.advance(ms: 90_000)
    #expect(workout.logActivityOffer(offer))
    let retained = workout.sets, last = try #require(retained.first)
    #expect(last.completedAt.ms == clock.nowMs() + offset)
    let next = try #require(workout.activityOffer()), logged = try controller.content(session: session, offer: next)
    let lastOnDevice = Date(timeIntervalSince1970: Double(clock.nowMs()) / 1000)
    #expect(logged.state.startedAt == startedOnDevice && logged.state.lastSetAt == lastOnDevice)
    #expect(lastOnDevice.timeIntervalSince(logged.state.startedAt) == 90)
    #expect(logged.state.staleAt == lastOnDevice.addingTimeInterval(Double(SessionRules.staleAfterMs) / 1000))
    #expect(logged.staleDate == logged.state.staleAt && logged.state.offer == next)

    clock.advance(ms: SessionRules.staleAfterMs - 1)
    gym.refresh(); workout.reconcile()
    let before = Date(timeIntervalSince1970: Double(clock.nowMs()) / 1000)
    #expect(before < logged.state.staleAt && workout.canLog)
    #expect(SessionRules.autoCloseAt(session, sets: retained, now: try runtime.runner.moment().now) == nil)
    clock.advance(ms: 1)
    let atBoundary = Date(timeIntervalSince1970: Double(clock.nowMs()) / 1000)
    #expect(atBoundary == logged.state.staleAt)
    #expect(SessionRules.autoCloseAt(session, sets: retained, now: try runtime.runner.moment().now) == last.completedAt)
    gym.refresh(); workout.reconcile()
    #expect(!workout.canLog && !workout.logActivityOffer(next) && workout.sets == retained)
  }

  @Test func activityPayloadReprojectsDatesWhenTheServerCorrectionChanges() throws {
    let clock = SimClock(wallMs: fixtures.start.ms), runtime = try WorkoutStateTests.faultRuntime(WorkoutFaultTransport(), clock: clock.engineClock)
    let reading = clock.reading(), firstOffset: Int64 = 3_600_000
    _ = try runtime.store.sample(serverTime: reading.wall + firstOffset, timing: .init(send: reading, recv: reading))
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(gym.run(CreateExercise(Exercise(id: fixtures.first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let workout = try fixtures.begin(gym), session = try #require(workout.session), controller = WorkoutActivityController(gym: gym)
    let offer = try #require(workout.activityOffer())
    clock.advance(ms: 30_000)
    #expect(workout.logActivityOffer(offer))
    let retained = workout.sets, before = try controller.content(session: session, offer: workout.activityOffer())
    let corrected = clock.reading(), currentOffset: Int64 = -3_600_000
    _ = try runtime.store.sample(serverTime: corrected.wall + currentOffset, timing: .init(send: corrected, recv: corrected))
    #expect(try runtime.storageRead { try $0.device().activeReplica.meta.serverOffsetMs } == currentOffset)
    let after = try controller.content(session: session, offer: before.state.offer)
    let shift = Double(firstOffset - currentOffset) / 1000
    #expect(after.state.startedAt == before.state.startedAt.addingTimeInterval(shift))
    #expect(after.state.lastSetAt == before.state.lastSetAt?.addingTimeInterval(shift))
    #expect(after.state.staleAt == before.state.staleAt.addingTimeInterval(shift))
    #expect(after.staleDate == after.state.staleAt && after.state.offer == before.state.offer)
    #expect(workout.session == session && workout.sets == retained)
  }

  @Test func activityPayloadRefusesAnUnreadableClockCorrection() throws {
    let fault = GymStoreFault(), runtime = try GymModelTests().runtime(failing: fault)
    let gym = GymModel(runner: runtime.runner, runtime: runtime), workout = try fixtures.begin(gym)
    let session = try #require(workout.session), controller = WorkoutActivityController(gym: gym)
    let previous = try controller.content(session: session, offer: workout.activityOffer())
    fault.point.withLock { $0 = .read }
    defer { fault.point.withLock { $0 = nil } }
    #expect(throws: (any Error).self) { try controller.content(session: session, offer: previous.state.offer) }
  }

  @Test func activityOfferUsesTheOnScreenDomainCommandAndReturnsItsQueueReceipt() throws {
    let (harness, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer()), session = try #require(workout.session)
    let value = TrainingSet(id: ID(RecordID(offer.setID)), sessionId: session.id, exerciseId: fixtures.first,
                            weightKg: offer.weightKg, reps: offer.reps, kind: offer.kind, completedAt: fixtures.start)
    let result = try harness.runner.run(LogWorkoutSet(value: value, session: session, previousSets: workout.sets, offer: offer))
    let receipt = try #require(result.receipt)
    #expect(committed(result) == value.id)
    #expect(receipt.ids == [value.id.record] && receipt.localIds.count == 1)
    gym.refresh(); workout.reconcile()
    #expect(workout.sets == [value])
    #expect(workout.logActivityOffer(offer) && workout.sets == [value])
  }

  @Test func repeatedOfferWritesOneSetAndEmitsOneContentFreeEvent() throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), offer = try #require(workout.activityOffer())
    #expect(workout.logActivityOffer(offer))
    let retained = workout.sets, next = try #require(workout.activityOffer())
    #expect(next.setID != offer.setID)
    #expect(workout.logActivityOffer(offer) && workout.logActivityOffer(offer))
    #expect(workout.sets == retained && retained.map { $0.id.description } == [offer.setID])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.map(\.properties) } == [[:]])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_set_logged" }.map(\.properties) } == [["screen": "workout", "outcome": "ok"]])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.isEmpty })
  }

  @Test func staleIntentOpensTheWorkoutWithoutWriting() async throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), stale = try #require(workout.activityOffer())
    let suite = "activity-intent-" + UUID().uuidString, preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    let app = try AppModel(runner: harness.runner, preferences: preferences, telemetry: recorder)
    #expect(app.gym.hideWorkout())
    let previous = WorkoutActivityIntentHandler.model
    WorkoutActivityIntentHandler.model = app
    defer { WorkoutActivityIntentHandler.model = previous }
    #expect(await WorkoutActivityIntentHandler.logSet(offer: stale) == false)
    #expect(app.selectedRoom == .gym && !app.welcome && !app.gym.workoutHidden)
    #expect(app.gym.workout.isPresented && app.gym.sets.isEmpty)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:]])
  }

  @Test(arguments: [(false, false), (false, true), (true, false), (true, true)])
  func activityOpeningDuringPendingSignInRestoresLocalWorkoutWithoutLogging(viaIntent: Bool, deferred: Bool) async throws {
    let server = JournalModelTransport(), connectivity = SwitchedConnectivity(), recorder = TelemetryRecorder()
    let initial = try LineageFlowTests().fixture(server, connectivity: connectivity, telemetry: recorder)
    let runtime = try #require(initial.runtime), id = try #require(initial.gym.startWorkout())
    let initialWorkout = initial.gym.workout
    initialWorkout.add(ID("bench-press")); #expect(initialWorkout.logSet())
    initialWorkout.weightKg = 62.5; initialWorkout.reps = 9; initialWorkout.kind = .warmup
    let stale = try #require(initialWorkout.activityOffer()), sets = initialWorkout.sets
    #expect(initial.gym.hideWorkout())
    let identity = server.identity(email: "activity-open-pending@example.com")
    connectivity.set(online: false)
    await #expect(throws: EngineError.unreachable) { try await runtime.engine.signIn(account: identity.account, token: identity.token) }

    let app = try AppModel(runner: initial.runner, preferences: initial.preferences, runtime: runtime, telemetry: recorder)
    if deferred { app.cancelAuthentication(); app.sheet = nil }
    let workout = app.gym.workout, record = try #require(try workout.activityRecord())
    #expect(app.pendingSignIn != nil && app.signInDeferred == deferred && app.editorReadOnly == !deferred)
    #expect(!app.gym.accountTransition && app.gym.workoutHidden && !workout.isPresented)
    #expect(workout.sessionId == id && workout.sets == sets)
    #expect(workout.weightKg == 62.5 && workout.reps == 9 && workout.kind == .warmup)
    #expect(!workout.activityIdentityResolved && workout.activityOffer() == nil)
    if viaIntent {
      let previous = WorkoutActivityIntentHandler.model
      WorkoutActivityIntentHandler.model = app
      defer { WorkoutActivityIntentHandler.model = previous }
      #expect(await WorkoutActivityIntentHandler.logSet(offer: stale) == false)
    } else {
      app.openActivityWorkout()
      #expect(!workout.logActivityOffer(stale))
    }
    #expect(app.selectedRoom == .gym && !app.welcome && !app.gym.workoutHidden && workout.isPresented)
    #expect(workout.sessionId == id && workout.sets == sets && !workout.sets.contains { $0.id.description == stale.setID })
    #expect(workout.weightKg == 62.5 && workout.reps == 9 && workout.kind == .warmup)
    #expect(try workout.activityRecord() == record)
    #expect(!workout.activityIdentityResolved && workout.activityOffer() == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:]])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.isEmpty })
  }

  @Test(arguments: ["movement", "load", "reps", "session", "set", "kind"])
  func domainCommandCannotBypassTheExactDurableOffer(field: String) throws {
    let (harness, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer()), session = try #require(workout.session)
    let attempted = TrainingSet(id: field == "set" ? gym.runner.mint(TrainingSet.self) : ID(RecordID(offer.setID)),
      sessionId: field == "session" ? gym.runner.mint(Session.self) : session.id,
      exerciseId: field == "movement" ? fixtures.second : fixtures.first,
      weightKg: field == "load" ? offer.weightKg + 1 : offer.weightKg,
      reps: field == "reps" ? offer.reps + 1 : offer.reps,
      kind: field == "kind" ? "warmup" : offer.kind, completedAt: fixtures.start)
    let result = try harness.runner.run(LogWorkoutSet(value: attempted, session: session, previousSets: workout.sets, offer: offer))
    #expect(result.refusal == .stale(session.id.ref, .predicted) && result.receipt == nil)
    #expect(try harness.stored(TrainingSet.self).isEmpty)
    #expect(try harness.drawn(TrainingSet.self).isEmpty)
    #expect(try workout.activityRecord()?.offer == offer)
  }

  @Test(arguments: ["movement", "load", "reps", "session", "owner", "set", "kind"])
  func staleOfferFieldsWriteNothingAndEmitContentFreeRefusal(field: String) throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), current = try #require(workout.activityOffer())
    let stale = WorkoutActivityOffer(ownerID: field == "owner" ? "other-owner" : current.ownerID,
      sessionID: field == "session" ? "other-session" : current.sessionID,
      movementID: field == "movement" ? fixtures.second.description : current.movementID,
      weightKg: field == "load" ? current.weightKg + 1 : current.weightKg,
      reps: field == "reps" ? current.reps + 1 : current.reps,
      kind: field == "kind" ? "warmup" : current.kind,
      setID: field == "set" ? gym.runner.mint(TrainingSet.self).description : current.setID)
    #expect(!workout.logActivityOffer(stale))
    #expect(workout.sets.isEmpty && workout.activityOffer() == current)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:]])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.isEmpty })
  }

  @Test(arguments: ["movement", "load", "reps", "kind"])
  func changedRackInvalidatesThePersistedOffer(field: String) throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), stale = try #require(workout.activityOffer())
    switch field {
    case "movement": workout.add(fixtures.second); workout.select(fixtures.second)
    case "load": workout.weightKg += 1
    case "reps": workout.reps += 1
    default: workout.kind = .warmup
    }
    #expect(!workout.logActivityOffer(stale) && workout.sets.isEmpty)
    let current = try #require(workout.activityOffer())
    #expect(current != stale && current.setID != stale.setID)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:]])
  }

  @Test func offerFromThePreviousSessionCannotLogIntoTheNewWorkout() throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), stale = try #require(workout.activityOffer())
    #expect(gym.run(FinishSession(id: try #require(workout.sessionId)))?.receipt != nil)
    let replacement = try fixtures.begin(gym)
    #expect(replacement.sessionId?.description != stale.sessionID)
    #expect(!replacement.logActivityOffer(stale) && gym.sets.isEmpty)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:]])
  }

  @Test func otherPhoneHasNoLocalOwnerOrOfferedAction() throws {
    let (harness, gym) = try fixtures.fixture(anonymous: false), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer()), other = harness.device()
    harness.sync()
    let otherGym = GymModel(runner: other.runner), restored = otherGym.workout
    #expect(restored.sessionId == workout.sessionId && restored.session?.isOpen == true)
    #expect(try restored.activityRecord() == nil)
    #expect(restored.activityOffer() == nil && !restored.logActivityOffer(offer))
    #expect(try other.stored(TrainingSet.self).isEmpty)
  }

  @Test func explicitRestoreOnAnotherPhoneCreatesOnlyItsCurrentWorkoutAuthority() throws {
    let (harness, gym) = try fixtures.fixture(anonymous: false), workout = try fixtures.begin(gym)
    let old = try #require(workout.activityOffer()), sessionID = try #require(workout.sessionId)
    let other = harness.device()
    harness.sync()
    let otherGym = GymModel(runner: other.runner), restored = otherGym.workout
    otherGym.refresh(); restored.reconcile()
    #expect(restored.sessionId == sessionID && restored.selected == nil)
    #expect(try restored.activityRecord() == nil)
    #expect(restored.activityOffer() == nil && !restored.logActivityOffer(old))
    #expect(otherGym.restoreWorkout())
    let authority = try #require(try restored.activityRecord())
    #expect(authority.sessionID == sessionID.description && authority.ownerID != old.ownerID && !authority.anonymous)
    #expect(authority.replica == (try other.runner.read(Gym.scope) { $0.replica }))
    #expect(authority.offer == nil && restored.activityOffer() == nil && restored.selected == nil)
    restored.add(fixtures.first)
    let current = try #require(restored.activityOffer())
    #expect(current.ownerID == authority.ownerID && current.sessionID == old.sessionID && current.setID != old.setID)
    #expect(!restored.logActivityOffer(old) && restored.sets.isEmpty && restored.activityOffer() == current)
    #expect(restored.logActivityOffer(current))
    #expect(restored.sets.map(\.id.description) == [current.setID] && restored.sets.map(\.sessionId) == [sessionID])
    harness.sync(); gym.refresh(); workout.reconcile()
    #expect(workout.sets.map(\.id.description) == [current.setID] && workout.sets.map(\.sessionId) == [sessionID])
    #expect(try harness.notices(GymRefusal.self).isEmpty)
  }

  @Test(arguments: ["session", "replica", "anonymous", "finished"])
  func explicitRestoreRefusesChangedSessionOrOwnership(field: String) throws {
    let (harness, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let sessionID = try #require(workout.sessionId), replica = try harness.runner.read(Gym.scope) { $0.replica }
    _ = try #require(workout.activityOffer())
    if field == "finished" { #expect(gym.run(FinishSession(id: sessionID))?.receipt != nil) }
    let before = try harness.runner.read(Gym.scope) { try $0.device(WorkoutActivityRecord.key) }
    let requestedID = field == "session" ? gym.runner.mint(Session.self) : sessionID
    let result = try harness.runner.run(RestoreWorkoutActivity(sessionID: requestedID,
      replica: field == "replica" ? "different-replica" : replica, anonymous: field == "anonymous" ? false : true))
    #expect(result.refusal == .stale(requestedID.ref, .predicted) && result.receipt == nil)
    #expect(try harness.runner.read(Gym.scope) { try $0.device(WorkoutActivityRecord.key) } == before)
    #expect(try harness.stored(TrainingSet.self).isEmpty)
  }

  @Test func failedExplicitRestoreDoesNotCreateAuthorityUntilRetried() throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixtures.fixture(anonymous: false)
    _ = try fixtures.begin(gym)
    let other = harness.device()
    harness.sync()
    let otherGym = GymModel(runner: other.runner, telemetry: recorder), restored = otherGym.workout
    #expect(try restored.activityRecord() == nil && restored.activityOffer() == nil)
    other.failNextCommit()
    #expect(!otherGym.restoreWorkout())
    #expect(otherGym.error == "Gym could not restore this workout. Try again.")
    #expect(try restored.activityRecord() == nil && restored.activityOffer() == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == [["operation": "gym_activity_update", "failure_kind": "storage"]])
    otherGym.refresh(); restored.reconcile()
    #expect(try restored.activityRecord() == nil)
    #expect(otherGym.restoreWorkout())
    #expect(try restored.activityRecord()?.sessionID == gym.openSession?.id.description)
    #expect(restored.activityOffer() == nil && restored.sets.isEmpty)
  }

  @Test func explicitRestoreClearsManualDismissalAndPreservesTheCurrentDraft() throws {
    let (_, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    workout.weightKg = 62.5; workout.reps = 9; workout.kind = .warmup
    let offer = try #require(workout.activityOffer())
    var record = try #require(try workout.activityRecord())
    record.dismissed = true; record.activityID = "previous-system-activity"
    #expect(workout.keepActivity(record))
    workout.restore()
    #expect(try workout.activityRecord() == record)
    #expect(gym.restoreWorkout())
    record.dismissed = false; record.activityID = nil
    #expect(try workout.activityRecord() == record && workout.activityOffer() == offer)
    #expect(workout.weightKg == 62.5 && workout.reps == 9 && workout.kind == .warmup && workout.sets.isEmpty)
  }

  @Test(arguments: [(false, false), (true, false), (true, true)])
  func accountChangeEndsBeforeDormancyAndPreservesManualDismissal(systemActivityGone: Bool, alreadyDismissed: Bool) async throws {
    let transport = JournalModelTransport(), owner = transport.identity(email: "activity-owner@example.com")
    let directory = FileManager.default.temporaryDirectory.appending(path: "activity-owner-" + UUID().uuidString)
    let runtime = try AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://gym.invalid"]),
      directory: directory, service: "works.windmill.activity-test." + UUID().uuidString, syncTransport: transport)
    defer { try? runtime.tokens.delete(for: owner.account) }
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout, replica = try runtime.engine.activeReplica()
    gym.startWorkoutActivity()
    var record = try #require(try workout.activityRecord())
    record.activityID = systemActivityGone ? "previous-system-activity" : nil; record.dismissed = alreadyDismissed
    #expect(workout.keepActivity(record))
    gym.accountChanging = true
    let cancelled = try await runtime.engine.signOut()
    #expect(try workout.activityRecord()?.activityID == nil)
    #expect(try workout.activityRecord()?.dismissed == (systemActivityGone || alreadyDismissed))
    await cancelled.cancel()
    #expect(try runtime.engine.activeReplica() == replica)
    let signOut = try await runtime.engine.signOut()
    _ = try await signOut.finish(.keep)
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    gym.refresh(); workout.reconcile()
    #expect(try runtime.engine.activeReplica() == replica)
    #expect(try workout.activityRecord()?.activityID == nil)
    #expect(try workout.activityRecord()?.dismissed == (systemActivityGone || alreadyDismissed))
    #expect(try workout.activityRecord()?.sessionID == record.sessionID)
  }

  @Test func backupRestorationCannotEraseAnUnobservedSystemDismissal() async throws {
    let (_, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    var record = try #require(try workout.activityRecord())
    record.activityID = "dismissed-while-app-was-stopped"
    #expect(workout.keepActivity(record))
    gym.accountChanging = true
    await WorkoutActivityController(gym: gym).reconcile()
    #expect(try workout.activityRecord()?.dismissed == true)
    #expect(try workout.activityRecord()?.activityID == nil)
  }

  @Test func anonymousAdoptionOnTheSameReplicaRevokesTheOfferUntilExplicitRestore() async throws {
    let fault = WorkoutFaultTransport(), owner = fault.model.identity(email: "activity-adoption@example.com")
    let accountRuntime = try GymModelTests().runtime(transport: fault.model)
    #expect(try await accountRuntime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    let accountGym = GymModel(runner: accountRuntime.runner, runtime: accountRuntime)
    #expect(accountGym.run(SaveNoteCall(Note(id: accountGym.runner.mint(Note.self), title: "Account note")))?.receipt != nil)
    await accountRuntime.engine.flushOnLeave()

    let runtime = try WorkoutStateTests.faultRuntime(fault), recorder = TelemetryRecorder()
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: recorder)
    _ = try #require(gym.startWorkout())
    let workout = gym.workout
    workout.add(ID("back-squat"))
    let old = try #require(workout.activityOffer()), replica = try runtime.engine.activeReplica()
    #expect(gym.isAnonymous && workout.sets.isEmpty)
    let signIn = try await runtime.engine.signIn(account: owner.account, token: owner.token)
    #expect(!signIn.isComplete && signIn.decisions.map(\.product) == ["gym"])
    #expect(!gym.accountTransition && !workout.activityIdentityResolved)
    #expect(workout.activityOffer() == nil && !workout.logActivityOffer(old) && workout.sets.isEmpty)
    try await signIn.complete(["gym": .add])
    gym.refresh(); workout.reconcile()
    #expect(signIn.isComplete && gym.account == owner.account && !gym.isAnonymous)
    #expect(try runtime.engine.activeReplica() == replica)
    #expect(workout.sessionId?.description == old.sessionID && workout.session?.isOpen == true)
    #expect(try workout.activityRecord() == nil)
    #expect(workout.activityOffer() == nil && !workout.logActivityOffer(old) && workout.sets.isEmpty)
    #expect(gym.restoreWorkout())
    let restored = try #require(workout.activityOffer())
    #expect(restored.sessionID == old.sessionID && restored.ownerID != old.ownerID && restored.setID != old.setID)
    #expect(!workout.logActivityOffer(old) && workout.sets.isEmpty)
    #expect(workout.activityOffer() == restored)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:], [:], [:]])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.isEmpty })
  }

  @Test(arguments: [false, true])
  func pendingAdoptionKeepsForegroundLoggingAndRestoreLocal(deferred: Bool) async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "activity-pending-adoption@example.com")
    try await remote.signIn(identity)
    let accountWorkout = try #require(remote.gym.startWorkout())
    await remote.runtime?.engine.start()
    try await AppModelTests().workoutSettled(remote, accountWorkout)
    let connectivity = SwitchedConnectivity()
    let local = try LineageFlowTests().fixture(server, seed: 122, connectivity: connectivity)
    defer { remote.gym.stop(); local.gym.stop() }
    let id = try #require(local.gym.startWorkout()), workout = local.gym.workout
    workout.add(ID("bench-press"))
    #expect(workout.logSet())
    let original = workout.sets, stale = try #require(workout.activityOffer())
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.currentAdoption?.product == "gym")
    if deferred { local.cancelAuthentication(); local.sheet = nil }
    connectivity.set(online: false)
    workout.reconcile()
    #expect(!local.gym.accountTransition && workout.canLog)
    #expect(!workout.activityIdentityResolved && workout.activityOffer() == nil)
    #expect(!workout.logActivityOffer(stale) && workout.sets == original)
    workout.weightKg = 62.5; workout.reps = 9; workout.kind = .warmup
    let coldGym = GymModel(runner: local.runner, runtime: local.runtime), cold = coldGym.workout
    #expect(cold.weightKg == 62.5 && cold.reps == 9 && cold.kind == .warmup)
    #expect(cold.activityOffer() == nil && !cold.logActivityOffer(stale))
    #expect(workout.logSet())
    let retained = workout.sets
    #expect(retained.count == 2 && retained.first == original.first)
    #expect(retained.last?.weightKg == 62.5 && retained.last?.reps == 9 && retained.last?.kind == "warmup")
    #expect(local.gym.hideWorkout() && local.gym.workoutHidden)
    #expect(local.gym.restoreWorkout() && !local.gym.workoutHidden && workout.isPresented)
    #expect(workout.sets == retained && !workout.logActivityOffer(stale))

    connectivity.set(online: true)
    await local.retryAuthenticatedSignIn()
    await local.adopt(.add)
    #expect(local.account == nil && local.currentAdoption?.counts["set"] == 2)
    for _ in 0..<3 where local.currentAdoption != nil { await local.adopt(.add) }
    #expect(local.account == identity.account)
    await local.runtime?.engine.start()
    #expect(await WorkoutStateTests.until {
      local.refresh()
      return local.gym.openSession?.id == accountWorkout && local.gym.adoptionWorkouts.contains { $0.session.id == id }
    })
    let backup = try #require(local.gym.adoptionWorkouts.first { $0.session.id == id })
    #expect(Set(backup.sets.map(\.id)) == Set(retained.map(\.id)))
    local.gym.keepAdoptedWorkout(id)
    try await AppModelTests().workoutSettled(local, id)
    #expect(await WorkoutStateTests.until { local.refresh(); return local.gym.adoptionWorkouts.isEmpty })
    let recovered = local.gym.sets.filter { $0.sessionId == id }
    #expect(Set(recovered.map(\.id)) == Set(retained.map(\.id)))
    for set in retained { #expect(recovered.first { $0.id == set.id }?.fields == set.fields) }
  }

  @Test func setDeletedDuringPendingAdoptionStaysDeletedThroughTheRecoverySnapshot() async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "activity-pending-delete@example.com")
    try await remote.signIn(identity)
    let accountWorkout = try #require(remote.gym.startWorkout())
    await remote.runtime?.engine.start()
    try await AppModelTests().workoutSettled(remote, accountWorkout)
    let local = try LineageFlowTests().fixture(server, seed: 124)
    defer { remote.gym.stop(); local.gym.stop() }
    let id = try #require(local.gym.startWorkout()), workout = local.gym.workout
    workout.add(ID("bench-press"))
    #expect(workout.logSet()); #expect(workout.logSet())
    let deleted = try #require(workout.sets.first)
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.currentAdoption?.product == "gym")
    #expect(local.gym.run(DeleteSet(deleted.id))?.receipt != nil)
    workout.reconcile()
    let retained = workout.sets
    #expect(retained.count == 1 && !retained.contains { $0.id == deleted.id })
    for _ in 0..<4 where local.currentAdoption != nil { await local.adopt(.add) }
    #expect(local.account == identity.account)
    #expect(!local.gym.sets.contains { $0.id == deleted.id })
    await local.runtime?.engine.start()
    #expect(await WorkoutStateTests.until {
      local.refresh()
      return local.gym.openSession?.id == accountWorkout && local.gym.adoptionWorkouts.contains { $0.session.id == id }
    })
    let backup = try #require(local.gym.adoptionWorkouts.first { $0.session.id == id })
    #expect(backup.sets == retained)
    local.gym.keepAdoptedWorkout(id)
    try await AppModelTests().workoutSettled(local, id)
    #expect(await WorkoutStateTests.until { local.refresh(); return local.gym.adoptionWorkouts.isEmpty })
    #expect(local.gym.sets.filter { $0.sessionId == id }.map(\.id) == retained.map(\.id))
  }

  @Test(arguments: ["append", "correct", "delete"])
  func localChangesDuringHelloSurviveAutomaticBindAndRemoteWorkoutConflict(change: String) async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "activity-auto-bind@example.com")
    try await remote.signIn(identity)
    let delayed = CapturedWorkoutHelloTransport(base: server)
    let local = try LineageFlowTests().fixture(server, syncTransport: delayed, seed: 123)
    defer { remote.gym.stop(); local.gym.stop() }
    let id = try #require(local.gym.startWorkout()), workout = local.gym.workout
    workout.add(ID("bench-press"))
    #expect(workout.logSet()); #expect(workout.logSet())
    let first = try #require(workout.sets.first)
    let signIn = Task { try await local.signIn(identity) }
    await delayed.gate.untilWaiting()
    switch change {
    case "append":
      workout.weightKg = 62.5; workout.reps = 9
      #expect(workout.logSet())
    case "correct":
      var corrected = first; corrected.weightKg = 82.5; corrected.reps = 8
      #expect(local.gym.run(CorrectSet(corrected))?.receipt != nil)
    default:
      #expect(local.gym.run(DeleteSet(first.id))?.receipt != nil)
    }
    workout.reconcile()
    let retained = workout.sets
    let accountWorkout = try #require(remote.gym.startWorkout())
    await remote.runtime?.engine.start()
    try await AppModelTests().workoutSettled(remote, accountWorkout)
    await delayed.gate.release(); try await signIn.value
    #expect(local.account == identity.account && local.currentAdoption == nil)
    await local.runtime?.engine.start()
    #expect(await WorkoutStateTests.until {
      local.refresh()
      return local.gym.openSession?.id == accountWorkout && local.gym.adoptionWorkouts.contains { $0.session.id == id }
    })
    let backup = try #require(local.gym.adoptionWorkouts.first { $0.session.id == id })
    #expect(Set(backup.sets.map(\.id)) == Set(retained.map(\.id)))
    for set in retained { #expect(backup.sets.first { $0.id == set.id }?.fields == set.fields) }
    local.gym.keepAdoptedWorkout(id)
    try await AppModelTests().workoutSettled(local, id)
    #expect(await WorkoutStateTests.until { local.refresh(); return local.gym.adoptionWorkouts.isEmpty })
    let recovered = local.gym.sets.filter { $0.sessionId == id }
    #expect(Set(recovered.map(\.id)) == Set(retained.map(\.id)))
    for set in retained { #expect(recovered.first { $0.id == set.id }?.fields == set.fields) }
  }

  @Test func failedRecoverySnapshotAbortsBindAndReleasesTraining() async throws {
    let server = JournalModelTransport(), delayed = CapturedWorkoutHelloTransport(base: server)
    let fault = GymStoreFault(), telemetry = TelemetryRecorder()
    let model = try LineageFlowTests().fixture(server, syncTransport: delayed, crashPoints: CrashPoints { point in
      if fault.point.withLock({ $0 == point }) { throw AppFailure(message: "private recovery snapshot detail") }
    }, telemetry: telemetry)
    let runtime = try #require(model.runtime), originalReplica = try runtime.engine.activeReplica()
    _ = try #require(model.gym.startWorkout())
    let workout = model.gym.workout
    workout.add(ID("bench-press")); #expect(workout.logSet())
    let identity = server.identity(email: "activity-capture-failure@example.com")
    let signingIn = Task { try await model.signIn(identity) }
    await delayed.gate.untilWaiting()
    #expect(!model.gym.accountTransition && workout.logSet())
    let retained = workout.sets
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    await delayed.gate.release()
    await #expect(throws: (any Error).self) { try await signingIn.value }
    fault.point.withLock { $0 = nil }
    model.refresh(); workout.reconcile()
    #expect(model.account == nil && model.gym.isAnonymous)
    #expect(try runtime.engine.activeReplica() == originalReplica)
    #expect(try runtime.storageRead { try $0.device().meta.pendingSignIn } == identity.account)
    #expect(!model.gym.accountTransition && !model.gym.replicaChanging && runtime.gymBinding.seatChanges == 0)
    #expect(workout.sets == retained && workout.logSet())
    let failures = telemetry.entries.withLock { $0.filter { $0.name == "client_error" && $0.properties["operation"] == "gym_action" } }
    #expect(failures.map(\.properties) == [["operation": "gym_action", "failure_kind": "storage"]])
    try await model.signIn(identity)
    #expect(model.account == identity.account && !model.gym.accountTransition)
    #expect(workout.sets.count == retained.count + 1)
  }

  @Test(arguments: [false, true])
  func cancelledBindReleasesTrainingWithoutClearingTheAccountGuard(accountGuard: Bool) async throws {
    let server = JournalModelTransport(), gate = WorkoutSeatGate()
    let model = try LineageFlowTests().fixture(server, bindings: [gate])
    let runtime = try #require(model.runtime), originalReplica = try runtime.engine.activeReplica()
    _ = try #require(model.gym.startWorkout())
    let workout = model.gym.workout
    workout.add(ID("bench-press")); #expect(workout.logSet())
    let retained = workout.sets, identity = server.identity(email: "activity-capture-cancel@example.com")
    let signingIn = Task { try await model.signIn(identity) }
    await gate.gate.untilWaiting()
    #expect(model.gym.replicaChanging && model.gym.accountTransition && !workout.canLog)
    model.gym.accountChanging = accountGuard
    signingIn.cancel(); await gate.gate.release()
    await #expect(throws: CancellationError.self) { try await signingIn.value }
    model.refresh(); workout.reconcile()
    #expect(model.account == nil && model.gym.isAnonymous && workout.sets == retained)
    #expect(try runtime.engine.activeReplica() == originalReplica)
    #expect(!model.gym.replicaChanging && runtime.gymBinding.seatChanges == 0)
    #expect(model.gym.accountTransition == accountGuard)
    model.gym.accountChanging = false
    #expect(workout.canLog && workout.logSet())
  }

  @Test func dismissedRecordSurvivesColdRestoreAndRackUpdatesUntilANewWorkout() throws {
    let (harness, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let first = try #require(workout.activityOffer())
    var dismissed = try #require(try workout.activityRecord())
    dismissed.dismissed = true; dismissed.activityID = nil
    #expect(workout.keepActivity(dismissed))
    let reopened = GymModel(runner: harness.runner), restored = reopened.workout
    #expect(try restored.activityRecord() == dismissed)
    restored.weightKg += 5
    let next = try #require(restored.activityOffer())
    #expect(next.setID != first.setID)
    restored.restore()
    let retained = try #require(try restored.activityRecord())
    #expect(retained.dismissed && retained.activityID == nil && retained.offer == next)
    #expect(reopened.run(FinishSession(id: try #require(restored.sessionId)))?.receipt != nil)
    let fresh = try fixtures.begin(reopened), freshRecord = try #require(try fresh.activityRecord())
    #expect(!freshRecord.dismissed && freshRecord.activityID == nil && freshRecord.ownerID != dismissed.ownerID)
  }

  @Test(arguments: [false, true])
  func fourHourStaleDateHasNoOfferAndRefusesTheDisplayedAction(afterSet: Bool) throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym)
    if afterSet { harness.advance(ms: 10_000); #expect(workout.logSet()) }
    let stale = try #require(workout.activityOffer()), retained = workout.sets
    harness.advance(ms: SessionRules.staleAfterMs - 1); gym.refresh(); workout.reconcile()
    #expect(workout.activityOffer() == stale)
    harness.advance(ms: 1); gym.refresh(); workout.reconcile()
    #expect(workout.activityOffer() == nil && !workout.logActivityOffer(stale))
    #expect(workout.sets == retained && workout.session?.closedBy == "stale")
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:]])
  }

  @Test func finishInFlightHasNoOfferedAction() throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), offer = try #require(workout.activityOffer())
    workout.finishing = true
    #expect(workout.activityOffer() == nil && !workout.logActivityOffer(offer) && workout.sets.isEmpty)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_offer_refused" }.map(\.properties) } == [[:]])
  }

  @Test func queuedFinishHasNoOfferedAction() throws {
    let (harness, gym) = try fixtures.fixture(anonymous: false), workout = try fixtures.begin(gym)
    harness.sync(); gym.refresh(); workout.reconcile()
    let offer = try #require(workout.activityOffer()), session = try #require(workout.session)
    #expect(gym.run(FinishWorkout(id: session.id))?.receipt != nil)
    workout.reconcile()
    #expect(workout.finishQueued && workout.session?.isOpen == true)
    #expect(workout.activityOffer() == nil && !workout.logActivityOffer(offer) && workout.sets.isEmpty)
  }

  @Test func activityReconciliationCannotReopenADismissedFinishReceipt() async throws {
    let (_, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer())
    #expect(workout.logSet())
    await workout.finish()
    #expect(workout.receipt != nil && gym.openSession == nil)
    workout.closeReceipt(); workout.handoff = nil
    workout.finishQueued = true
    await WorkoutActivityController(gym: gym).reconcile()
    #expect(workout.receipt == nil && workout.handoff == nil && !workout.isPresented)
    #expect(!workout.logActivityOffer(offer))
    #expect(workout.receipt == nil && workout.handoff == nil && !workout.isPresented)
  }

  @Test func hiddenWorkoutHasNoOfferedActionUntilRestore() throws {
    let (_, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer())
    #expect(gym.hideWorkout())
    #expect(workout.activityOffer() == nil && !workout.logActivityOffer(offer) && workout.sets.isEmpty)
    #expect(gym.restoreWorkout() && workout.activityOffer()?.setID != offer.setID)
  }

  @Test(arguments: ["editing", "paging", "identity", "read", "weight", "reps"])
  func unresolvedOrInvalidDraftHasNoOfferedAction(state: String) throws {
    let (_, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer())
    switch state {
    case "editing": workout.rackEditing = true
    case "paging": workout.paging = true
    case "identity": gym.accountChanging = true
    case "read": gym.readFailed = true
    case "weight": workout.weightKg = .nan
    default: workout.reps = 0
    }
    #expect(workout.activityOffer() == nil)
    if state != "read" { #expect(!workout.logActivityOffer(offer)) }
    #expect(workout.sets.isEmpty)
  }

  @Test func changedDomainSnapshotHasNoOfferUntilReconciledAndRefusesOldAction() throws {
    let (_, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer()), session = try #require(workout.session)
    let concurrent = fixtures.value(gym, session: session, weight: 90)
    #expect(gym.run(AppendSet(concurrent))?.receipt != nil)
    #expect(workout.activityOffer() == nil)
    #expect(!workout.logActivityOffer(offer) && workout.sets == [concurrent])
    #expect(workout.activityOffer()?.setID != offer.setID)
  }

  @Test func coldRestorePreservesTheDurableDraftAndReplayIdentity() throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym)
    workout.weightKg = 62.5; workout.reps = 9; workout.kind = .warmup
    let offer = try #require(workout.activityOffer())
    let reopened = GymModel(runner: harness.runner, telemetry: recorder), restored = reopened.workout
    #expect(restored.weightKg == 62.5 && restored.reps == 9 && restored.kind == .warmup)
    #expect(restored.activityOffer() == offer)
    #expect(restored.logActivityOffer(offer))
    let retained = restored.sets
    let secondReopen = GymModel(runner: harness.runner, telemetry: recorder)
    #expect(secondReopen.workout.logActivityOffer(offer) && secondReopen.workout.sets == retained)
    #expect(retained.map { $0.id.description } == [offer.setID])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.map(\.properties) } == [[:]])
  }

  @Test func enteringTheKeypadDurablyRevokesTheOfferBeforeProcessExit() throws {
    let (harness, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer())
    workout.rackEditing = true
    #expect(try workout.activityRecord()?.offer == nil)
    let reopened = GymModel(runner: harness.runner), restored = reopened.workout
    #expect(!restored.logActivityOffer(offer) && restored.sets.isEmpty)
    #expect(restored.activityOffer()?.setID != offer.setID)
  }

  @Test func onScreenLogReplaysTheSameOfferedSetWithoutASecondWriter() throws {
    let recorder = TelemetryRecorder(), (_, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), offer = try #require(workout.activityOffer())
    #expect(workout.logSet())
    let retained = workout.sets
    #expect(retained.map { $0.id.description } == [offer.setID])
    #expect(workout.logActivityOffer(offer) && workout.sets == retained)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.isEmpty })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_set_logged" }.count } == 1)
  }

  @Test func failedOfferPersistenceShowsNoActionAndCannotReplayThePreviousDraft() throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), previous = try #require(workout.activityOffer())
    workout.rackEditing = true
    workout.weightKg = 65
    workout.rackEditing = false
    harness.failNextCommit()
    #expect(workout.activityOffer() == nil && workout.sets.isEmpty)
    #expect(try workout.activityRecord()?.offer == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == [["operation": "gym_activity_update", "failure_kind": "storage"]])
    #expect(!workout.logActivityOffer(previous) && workout.sets.isEmpty)
    let current = try #require(workout.activityOffer())
    #expect(current.weightKg == 65 && current.setID != previous.setID)
  }

  @Test func failedSetCommitRetainsThePremintedIdentityForRetry() throws {
    let recorder = TelemetryRecorder(), (harness, gym) = try fixtures.fixture(telemetry: recorder)
    let workout = try fixtures.begin(gym), offer = try #require(workout.activityOffer())
    harness.failNextCommit()
    #expect(!workout.logActivityOffer(offer) && workout.sets.isEmpty)
    #expect(workout.activityOffer() == offer)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_activity_set_logged" }.isEmpty })
    #expect(workout.logActivityOffer(offer) && workout.sets.map { $0.id.description } == [offer.setID])
  }

  @Test func domainCommandRefusesAStoredOfferAgainstAChangedTrainingBaseline() throws {
    let (harness, gym) = try fixtures.fixture(), workout = try fixtures.begin(gym)
    let offer = try #require(workout.activityOffer()), session = try #require(workout.session)
    let concurrent = fixtures.value(gym, session: session, weight: 90)
    #expect(gym.run(AppendSet(concurrent))?.receipt != nil)
    let attempted = TrainingSet(id: ID(RecordID(offer.setID)), sessionId: session.id, exerciseId: fixtures.first,
      weightKg: offer.weightKg, reps: offer.reps, kind: offer.kind, completedAt: fixtures.start)
    let result = try harness.runner.run(LogWorkoutSet(value: attempted, session: session, previousSets: workout.sets, offer: offer))
    #expect(result.refusal == .stale(session.id.ref, .predicted) && result.receipt == nil)
    #expect(try harness.drawn(TrainingSet.self) == [concurrent])
    #expect(try workout.activityRecord()?.offer == offer)
  }

  @Test func routineRevisionChangesPreserveTheFrozenPlanActivityOffer() throws {
    let (harness, gym) = try fixtures.fixture(anonymous: false)
    #expect(gym.run(CreateExercise(Exercise(id: fixtures.second, name: "Workout second", pattern: "hinge", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let created = try fixtures.routine(gym, scheme: [SetTarget(reps: 5, weightKg: 40)])
    harness.sync(); gym.refresh()
    let plan = try #require(gym.routines.first { $0.id == created.id })
    let workout = try fixtures.begin(gym, routine: plan)
    harness.sync(); gym.refresh(); workout.reconcile()
    let offer = try #require(workout.activityOffer()), frozen = try #require(workout.session?.plan)
    let other = harness.device()
    harness.sync()
    let remote = GymModel(runner: other.runner)
    var edit = Draft(opening: try #require(remote.routines.first { $0.id == plan.id }))
    edit.current.entries[0].sets = [SetTarget(reps: 9, weightKg: 45)]
    #expect(saved(remote.save(&edit)))
    harness.sync(); gym.refresh(); workout.reconcile()
    let current = try #require(gym.routines.first { $0.id == plan.id })
    #expect(current.revision == 2 && current.entries == edit.current.entries)
    #expect(workout.activityOffer() == offer && offer.weightKg == 40 && offer.reps == 5)
    #expect(workout.logActivityOffer(offer))
    #expect(workout.sets.map(\.weightKg) == [40] && workout.sets.map(\.reps) == [5])
    #expect(workout.session?.plan == frozen && gym.routines.first { $0.id == plan.id } == current)
  }

  @Test func rebuiltDeviationRevokesActivityLoggingUntilTheReviewIsResolved() throws {
    let (harness, gym) = try fixtures.fixture(anonymous: false)
    #expect(gym.run(CreateExercise(Exercise(id: fixtures.second, name: "Workout second", pattern: "hinge", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let created = try fixtures.routine(gym, scheme: [SetTarget(reps: 5, weightKg: 40)])
    harness.sync(); gym.refresh()
    let plan = try #require(gym.routines.first { $0.id == created.id })
    let workout = try fixtures.begin(gym, routine: plan)
    harness.sync(); gym.refresh(); workout.reconcile()
    workout.weightKg = 50
    let heavier = try #require(workout.activityOffer())
    #expect(workout.logActivityOffer(heavier))
    workout.select(fixtures.second)
    let offered = try #require(workout.deviation), frozen = workout.session?.plan
    #expect(offered.revision == 1 && workout.activityOffer() == nil)
    let other = harness.device()
    harness.sync()
    let remote = GymModel(runner: other.runner)
    var edit = Draft(opening: try #require(remote.routines.first { $0.id == plan.id }))
    edit.current.entries[0].sets = [SetTarget(reps: 9, weightKg: 45)]
    #expect(saved(remote.save(&edit)))
    harness.sync(); gym.refresh(); workout.reconcile()
    let current = try #require(gym.routines.first { $0.id == plan.id })
    workout.resolveDeviation(save: true)
    let rebuilt = try #require(workout.deviation)
    #expect(rebuilt.revision == 2 && rebuilt.offeredEntry == current.entries[0])
    #expect(gym.routines.first { $0.id == plan.id } == current)
    #expect(workout.activityOffer() == nil && workout.session?.plan == frozen)
    let reopenedGym = GymModel(runner: harness.runner), reopened = reopenedGym.workout
    #expect(reopened.deviation == rebuilt && reopened.activityOffer() == nil)
    #expect(reopened.sets.map(\.weightKg) == [50] && reopened.session?.plan == frozen)
    let retained = try #require(reopened.sets.first), session = try #require(reopened.session)
    #expect(retained.id.description == heavier.setID && retained.exerciseId == fixtures.first)
    reopened.resolveDeviation(save: false)
    let next = try #require(reopened.activityOffer())
    #expect(next.movementID == fixtures.second.description && next.setID != heavier.setID)
    #expect(reopened.logActivityOffer(next))
    let logged = TrainingSet(id: ID(RecordID(next.setID)), sessionId: session.id, exerciseId: fixtures.second,
      weightKg: next.weightKg, reps: next.reps, kind: next.kind, completedAt: fixtures.start)
    #expect(reopened.sets.sorted { $0.id < $1.id } == [retained, logged].sorted { $0.id < $1.id })
    harness.sync(); reopenedGym.refresh(); reopened.reconcile()
    let confirmed = TrainingSet(id: logged.id, sessionId: logged.sessionId, exerciseId: logged.exerciseId,
      weightKg: logged.weightKg, reps: logged.reps, kind: logged.kind, completedAt: logged.completedAt, setNumber: 1)
    #expect(reopened.sets.sorted { $0.id < $1.id } == [retained, confirmed].sorted { $0.id < $1.id })
    #expect(reopened.deviation == nil && reopened.walk.asked == [fixtures.first])
    #expect(reopenedGym.routines.first { $0.id == plan.id } == current)
  }
}

nonisolated final class CapturedWorkoutHelloTransport: SyncTransport {
  let base: JournalModelTransport
  let gate = TransportGate()
  init(base: JournalModelTransport) { self.base = base }
  func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    let reply = await base.hello(token: token)
    await gate.wait()
    return reply
  }
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> { await base.push(request, token: token) }
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> { await base.pull(request, token: token) }
  func openLive(token: SessionToken) async -> Reply<any LiveConnection> { .unreachable }
}

nonisolated final class WorkoutSeatGate: ProductBinding {
  let product = "gym-test"
  let gate = TransportGate()
  func seatWillChange() async { await gate.wait() }
}
