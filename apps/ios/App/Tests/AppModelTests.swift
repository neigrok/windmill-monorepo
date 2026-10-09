import Foundation
import Testing
import DomainKit
import GymDomain
import JournalDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncStore
import Synchronization
import SyncReplica
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite @MainActor struct AppModelTests {
  @Test func ordinaryBackupPreservesAnUnfinishedAdoptionAndItsAnswers() async throws {
    let (_, owner, model, localRoutine) = try await twoRooms()
    await model.adopt(.add)
    let session = try #require(model.signInSession)
    let decision = try #require(model.currentAdoption)
    #expect(!model.syncStarted && !model.restoringSignIn && model.pendingSignIn == nil)
    await model.resumeBackup()
    #expect(model.signInSession === session && model.currentAdoption == decision)
    #expect(model.adoptionAnswers == ["journal": .add] && model.account == nil && model.sheet == .adoption)
    await model.adopt(.add)
    #expect(model.account == owner.account && model.sheet == nil && !model.editorReadOnly)
    #expect(model.journal.document.body == "Local page" && model.gym.routines.contains { $0.id == localRoutine })
  }

  @Test func adoptionCanBeDeferredWithoutDiscardingLocalWork() async throws {
    let (_, _, model, _) = try await twoRooms()
    let session = try #require(model.signInSession)
    model.cancelAuthentication(); model.sheet = nil
    #expect(!model.editorReadOnly && !model.gym.accountTransition && model.account == nil)
    model.journal.type("Written while sign-in is deferred"); model.journal.done()
    #expect(model.journal.document.body == "Written while sign-in is deferred" && !model.journal.dirty)
    await model.retryAuthenticatedSignIn()
    #expect(model.sheet == .adoption && model.editorReadOnly && !model.gym.accountTransition && model.signInSession === session)
    #expect(model.account == nil)
  }

  @Test func stalledLaunchKeepsLocalEditingAndRoomSwitchingAvailable() async throws {
    let server = JournalModelTransport(), transport = DelayedJournalTransport(base: server, delayHello: true)
    let model = try LineageFlowTests().fixture(server, syncTransport: transport)
    model.openJournal()
    let start = Task { await model.start() }
    await transport.gate.untilWaiting()
    #expect(!model.editorReadOnly && !model.gym.accountTransition && model.timerTask != nil)
    model.journal.type("Saved while hello has no answer")
    model.journal.done()
    #expect(model.journal.document.body == "Saved while hello has no answer" && !model.journal.dirty)
    model.switchRoom(.gym)
    #expect(model.selectedRoom == .gym)
    model.scenePhaseChanged(.background); model.scenePhaseChanged(.active)
    model.switchRoom(.journal)
    #expect(model.selectedRoom == .journal && !model.editorReadOnly)
    await transport.gate.release(); await start.value
    model.timerTask?.cancel(); model.observationTask?.cancel(); model.gym.stop()
  }

  @Test func cancelledPendingHelloCannotSwitchAccountsOrLockOfflineWriting() async throws {
    let server = JournalModelTransport(), transport = DelayedJournalTransport(base: server, delayHello: true)
    let model = try LineageFlowTests().fixture(server, syncTransport: transport)
    model.openJournal(); model.sheet = .code; model.email = "offline@example.com"; model.code = "482913"
    let request = Task { await model.verifyCode() }
    model.authTask = request
    await transport.gate.untilWaiting()
    model.cancelAuthentication(); model.sheet = nil
    #expect(!model.editorReadOnly && model.signInDeferred)
    model.journal.type("Still local after cancel"); model.journal.done()
    await transport.gate.release(); await request.value
    #expect(model.account == nil && model.sheet == nil && model.journal.document.body == "Still local after cancel")
  }

  func routine(_ model: AppModel, name: String) throws -> ID<Routine> {
    let id = model.runner.mint(Routine.self)
    var draft = Draft(new: Routine(id: id, name: name, entries: [RoutineEntry(exerciseId: ID("back-squat"))]))
    let result = model.runner.save(&draft, SaveRoutine.self)
    let receipt: CommitReceipt? = if case .saved(let receipt) = result { receipt } else { nil }
    _ = try #require(receipt)
    model.refresh()
    return id
  }

  func twoRooms() async throws -> (JournalModelTransport, AuthIdentity, AppModel, ID<Routine>) {
    let server = JournalModelTransport(), existing = try LineageFlowTests().fixture(server)
    let owner = server.identity(email: "two-rooms@example.com")
    try await existing.signIn(owner)
    existing.journal.type("Account page"); existing.journal.done()
    _ = try routine(existing, name: "Account routine")
    await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let local = try LineageFlowTests().fixture(server)
    local.journal.type("Local page"); local.journal.done()
    let localRoutine = try routine(local, name: "Local routine")
    try await local.signIn(server.identity(email: "two-rooms@example.com"))
    return (server, owner, local, localRoutine)
  }

  func workoutSettled(_ model: AppModel, _ id: ID<Session>) async throws {
    for _ in 0..<200 {
      let settled = try model.runner.read(Gym.scope) { try $0.confirmed(Session.self, id) != nil }
      let pending = try model.runtime!.store.read { try $0.device().activeReplica.outbox.contains { $0.scope == Gym.scope } }
      if settled && !pending { model.refresh(); return }
      try await Task.sleep(for: .milliseconds(50))
    }
    throw AppFailure(message: "Gym writes did not settle")
  }

  @Test func adoptingFinishedAndOpenWorkoutsNeverLosesSetsOrJoinsAnotherDevice() async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "workout-adoption@example.com")
    try await remote.signIn(identity)
    let accountWorkout = ID<Session>("remote-workout-01")
    let now = try remote.runner.moment().now.ms
    _ = try remote.runner.run(StartSession(id: accountWorkout, startedAt: Instant(ms: now - 60_000)))
    await remote.runtime?.engine.start()
    try await workoutSettled(remote, accountWorkout)

    let connectivity = SwitchedConnectivity()
    let local = try LineageFlowTests().fixture(server, seed: 21, connectivity: connectivity)
    let finished = ID<Session>("anon-finished-01"), open = ID<Session>("anon-open-01")
    var expected: [TrainingSet] = []
    for (id, start) in [(finished, now - 40_000), (open, now - 10_000)] {
      _ = try local.runner.run(StartSession(id: id, startedAt: Instant(ms: start)))
      for i in 0..<2 {
        let set = TrainingSet(id: local.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID("bench-press"),
                              weightKg: Double(60 + i), reps: 8, kind: i == 0 ? "warmup" : "working", rpe: 8,
                              note: "Preserved set \(i)", completedAt: Instant(ms: start + Int64(i + 1) * 1_000))
        _ = try local.runner.run(AppendSet(set)); expected.append(set)
      }
      if id == finished { _ = try local.runner.run(FinishSession(id: id, finishedAt: Instant(ms: start + 3_000))) }
    }
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.currentAdoption?.product == "gym")
    await local.adopt(.add)
    await local.runtime?.engine.start()
    try await workoutSettled(local, finished)
    local.refresh()
    #expect(local.account == identity.account)
    #expect(local.gym.sessions.contains { $0.id == finished && !$0.isOpen })
    #expect(Set(local.gym.sets.filter { $0.sessionId == finished }.map(\.id)) == Set(expected.filter { $0.sessionId == finished }.map(\.id)))
    #expect(local.gym.sets.allSatisfy { $0.sessionId != accountWorkout })
    #expect(local.gym.openSession?.id == accountWorkout)
    #expect(try local.runtime!.store.read { try $0.device().activeReplica.outbox.allSatisfy { $0.scope != Gym.scope || !$0.isQueued } })
    #expect(local.gym.adoptionWorkouts.map { $0.session.id } == [open])
    let captured = try #require(local.gym.adoptionWorkouts.first)
    #expect(captured.sets.map(\.fields) == expected.filter { $0.sessionId == open }.map(\.fields))
    for notice in local.gym.notices { local.gym.dismissNotice(notice.id) }
    local.gym.stop()
    let reopened = try AppModel(runner: local.runner, preferences: local.preferences, runtime: local.runtime)
    #expect(reopened.gym.adoptionWorkouts == [captured])
    connectivity.set(online: false)
    for _ in 0..<100 where reopened.runtime!.engine.status.online { try await Task.sleep(for: .milliseconds(5)) }
    #expect(!reopened.runtime!.engine.status.online)
    reopened.gym.keepAdoptedWorkout(open)
    reopened.gym.keepAdoptedWorkout(open)
    #expect(try reopened.runner.read(Gym.scope) { try $0.commands().filter { $0.command.name == "gym.importSession" && $0.command.args["id"] == open.json }.count } == 1)
    connectivity.set(online: true)
    reopened.runtime!.engine.foreground()
    try await workoutSettled(reopened, open)
    reopened.refresh()
    #expect(reopened.gym.adoptionWorkouts.isEmpty)
    #expect(reopened.gym.sessions.count == 3 && reopened.gym.openSession?.id == accountWorkout)
    #expect(reopened.gym.sessions.first { $0.id == open }?.finishedAt == captured.sets.last?.completedAt)
    #expect(Set(reopened.gym.sets.map(\.id)) == Set(expected.map(\.id)))
    for set in expected { #expect(reopened.gym.sets.first { $0.id == set.id }?.fields == set.fields) }
    remote.runtime?.engine.foreground()
    for _ in 0..<200 {
      remote.refresh()
      if Set(remote.gym.sets.map(\.id)) == Set(expected.map(\.id)) { break }
      try await Task.sleep(for: .milliseconds(50))
    }
    #expect(Set(remote.gym.sets.map(\.id)) == Set(expected.map(\.id)))
    #expect(try reopened.runtime!.store.read { try $0.device().activeReplica.outbox.allSatisfy { $0.scope != Gym.scope || !$0.isQueued } })
    remote.gym.stop(); reopened.gym.stop()
  }

  @Test func sequentialDecisionsCountBothRoomsAndBindOnlyAfterLastAnswer() async throws {
    let (_, owner, model, localRoutine) = try await twoRooms()
    #expect(model.account == nil && model.editorReadOnly && model.sheet == .adoption)
    #expect(model.currentAdoption?.product == "journal" && model.currentAdoption?.counts["page"] == 1)
    await model.adopt(.add)
    #expect(model.account == nil && model.editorReadOnly && model.sheet == .adoption)
    #expect(model.adoptionAnswers == ["journal": .add])
    #expect(model.currentAdoption?.product == "gym" && model.currentAdoption?.counts == ["routine": 1])
    await model.adopt(.discard)
    #expect(model.account == owner.account && !model.editorReadOnly && model.sheet == nil)
    #expect(model.adoptionAnswers.isEmpty && model.preferences.data(forKey: "roomAdoption") == nil)
    #expect(!model.gym.routines.contains { $0.id == localRoutine })
    #expect(try model.runner.read(Journal.scope) { try $0.devices(prefix: "pendingClaim:").members.count } == 1)
  }

  @Test func partialAnswerSurvivesModelRelaunchWithoutAskingJournalAgain() async throws {
    let (_, owner, model, localRoutine) = try await twoRooms()
    await model.adopt(.add)
    let restored = try AppModel(runner: model.runner, preferences: model.preferences, runtime: model.runtime)
    await restored.start()
    defer {
      restored.timerTask?.cancel(); restored.observationTask?.cancel(); restored.gym.stop()
    }
    #expect(restored.account == nil && restored.sheet == .adoption && restored.editorReadOnly)
    #expect(restored.adoptionAnswers == ["journal": .add])
    #expect(restored.currentAdoption?.product == "gym" && restored.currentAdoption?.counts == ["routine": 1])
    await restored.adopt(.add)
    #expect(restored.account == owner.account && restored.sheet == nil && restored.currentAdoption == nil)
    #expect(restored.gym.routines.contains { $0.id == localRoutine })
  }

  @Test func changedGymWorkRevokesItsAnswerAndPreservesJournalApproval() async throws {
    let (_, _, model, _) = try await twoRooms()
    await model.adopt(.add)
    _ = try routine(model, name: "Another local routine")
    await model.adopt(.discard)
    #expect(model.account == nil && model.sheet == .adoption && model.error != nil)
    #expect(model.adoptionAnswers == ["journal": .add])
    #expect(model.currentAdoption?.product == "gym" && model.currentAdoption?.counts == ["routine": 2])
    #expect(model.gym.routines.count == 2)
    await model.adopt(.discard)
    #expect(model.account != nil && model.sheet == nil)
    #expect(!model.gym.routines.contains { $0.name == "Local routine" || $0.name == "Another local routine" })
  }

  @Test func gymAdoptionNamesWeighInsAndPreferencesInTheDiscardConfirmation() async throws {
    let server = JournalModelTransport(), existing = try LineageFlowTests().fixture(server)
    try await existing.signIn(server.identity(email: "gym-counts@example.com"))
    _ = try routine(existing, name: "Account routine")
    await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let model = try LineageFlowTests().fixture(server)
    var weighIn = Draft(new: WeighIn(day: model.journal.today, kg: 82.4))
    let weighInResult = model.runner.save(&weighIn, SaveWeighIn.self)
    let weighInReceipt: CommitReceipt? = if case .saved(let receipt) = weighInResult { receipt } else { nil }
    _ = try #require(weighInReceipt)
    var preferences = Draft(new: GymPreferences())
    preferences.current.units = "lb"
    let preferencesResult = model.runner.save(&preferences, SavePreferences.self)
    let preferencesReceipt: CommitReceipt? = if case .saved(let receipt) = preferencesResult { receipt } else { nil }
    _ = try #require(preferencesReceipt)
    _ = try #require(try model.runner.run(RenameExercise(ID("back-squat"), name: "Renamed squat")).receipt)
    try await model.signIn(server.identity(email: "gym-counts@example.com"))
    #expect(model.account == nil && model.currentAdoption?.product == "gym")
    #expect(model.currentAdoption?.counts == [WeighIn.type: 1, GymPreferences.type: 1, ExerciseName.type: 1])
    #expect(model.adoptionSummary == "1 weigh-in · 1 movement name · 1 training preference")
    model.sheet = .discardAdoption
    #expect(model.adoptionAlertTitle == "Discard 1 weigh-in · 1 movement name · 1 training preference?")
    #expect(AppModel.summary([Page.type: 1, JournalState.type: 1]) == "1 page")
  }

  @Test func existingGymAloneSuppressesIntroductionAndWelcome() throws {
    let model = try OnboardingLaunchTests().model()
    _ = try routine(model, name: "A routine already here")
    #expect(model.journal.room?.days.isEmpty == true && model.preferences.string(forKey: "lastRoom") == nil)
    let restored = try AppModel(runner: model.runner, preferences: model.preferences)
    #expect(restored.gym.hasData && !restored.welcome)
    #expect(try !OnboardingLaunch.shouldPresent(model: restored, deepLink: false))
  }

  @Test func anonymousLastRoomPersistsWithoutGymOrJournalWriting() throws {
    let model = try OnboardingLaunchTests().model()
    model.openRoom(.gym)
    let gymLaunch = try AppModel(runner: model.runner, preferences: model.preferences)
    #expect(gymLaunch.account == nil && gymLaunch.selectedRoom == .gym && !gymLaunch.welcome)
    #expect(!gymLaunch.gym.hasData && gymLaunch.journal.room?.days.isEmpty == true)
    gymLaunch.switchRoom(.journal)
    let journalLaunch = try AppModel(runner: model.runner, preferences: model.preferences)
    #expect(journalLaunch.account == nil && journalLaunch.selectedRoom == .journal && !journalLaunch.welcome)
  }

  @Test func leavingTheAppleRemovalQuestionCountsAsOneCancel() throws {
    let recorder = TelemetryRecorder()
    let (_, model) = try JournalModelTests().fixture(telemetry: recorder)
    let cancels = { recorder.entries.withLock { $0.filter { $0.name == "first_run_choice" && $0.properties == ["screen": "24c", "action": "cancel"] }.count } }
    model.askToRemoveApple()
    #expect(model.removingApple)
    model.cancelAppleRemoval(); model.cancelAppleRemoval()
    #expect(!model.removingApple && cancels() == 1)
    model.askToRemoveApple(); model.confirmAppleRemoval(); model.cancelAppleRemoval()
    #expect(!model.removingApple && cancels() == 1)
  }

  @Test func failedGymReadBlocksSignInUntilRoomCanBeFlushed() async throws {
    let fault = GymStoreFault(), recorder = TelemetryRecorder()
    let runtime = try GymModelTests().runtime(failing: fault, telemetry: recorder)
    let model = try AppModel(runner: runtime.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!,
                             runtime: runtime, telemetry: recorder)
    fault.point.withLock { $0 = .read }; model.gym.refresh()
    #expect(model.gym.readFailed)
    let identity = AuthIdentity(account: "blocked-account", token: SessionToken("unused-token"), name: "You", email: "blocked@example.com")
    await #expect(throws: AppFailure.self) { try await model.signIn(identity) }
    #expect(model.account == nil && model.signInSession == nil && !model.accountTransition)
    #expect(model.gym.readFailed && model.error == "Gym could not be read from this phone. Try again.")
    fault.point.withLock { $0 = nil }
    #expect(model.flushRooms() && !model.gym.readFailed)
    #expect(try runtime.account() == nil)
  }

  @Test func signOutKeepPreservesBothRoomsForTheirAccountOnly() async throws {
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server)
    let owner = server.identity(email: "gym-lineage@example.com")
    try await model.signIn(owner)
    model.journal.type("Owner page before autosave"); model.journal.saveTask?.cancel()
    let id = try routine(model, name: "Owner routine")
    await model.beginSignOut(); await model.finishSignOut(.keep)
    #expect(model.account == nil && model.journal.document.body.isEmpty && model.gym.routines.isEmpty)
    try await model.signIn(server.identity(email: "other-gym-lineage@example.com"))
    #expect(model.journal.document.body.isEmpty && model.gym.routines.isEmpty)
    await model.beginSignOut(); await model.finishSignOut(.keep)
    try await model.signIn(server.identity(email: "gym-lineage@example.com"))
    await model.runtime?.engine.start(); try await AppScenario.backedUp(model)
    model.refresh()
    #expect(model.account == owner.account && model.journal.document.body == "Owner page before autosave")
    #expect(model.gym.routines.map(\.id) == [id])
    #expect(model.journal.backup == "backed up")
  }
}
