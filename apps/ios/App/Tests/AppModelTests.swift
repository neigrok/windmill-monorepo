import Foundation
import Testing
import UIKit
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
  @Test func ordinaryBackupPreservesAnUnfinishedAdoption() async throws {
    let (_, owner, model, localRoutine) = try await twoRooms()
    let session = try #require(model.signInSession)
    let pending = model.pendingAdoptions
    #expect(!model.syncStarted && !model.restoringSignIn && model.pendingSignIn == nil)
    await model.resumeBackup()
    #expect(model.signInSession === session && model.pendingAdoptions == pending && pending.map(\.product) == ["journal", "gym"])
    #expect(model.adoptionAnswers.isEmpty && model.account == nil && model.sheet == .adoption)
    await model.adopt(.add, asked: model.pendingAdoptions)
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

  func twoRooms(telemetry: any Telemetry = NoopTelemetry()) async throws -> (JournalModelTransport, AuthIdentity, AppModel, ID<Routine>) {
    let server = JournalModelTransport(), existing = try LineageFlowTests().fixture(server)
    let owner = server.identity(email: "two-rooms@example.com")
    try await existing.signIn(owner)
    existing.journal.type("Account page"); existing.journal.done()
    _ = try routine(existing, name: "Account routine")
    await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let local = try LineageFlowTests().fixture(server, telemetry: telemetry)
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
                              weightKg: Double(60 + i), reps: 8, rpe: 8,
                              note: "Preserved set \(i)", completedAt: Instant(ms: start + Int64(i + 1) * 1_000))
        _ = try local.runner.run(AppendSet(set)); expected.append(set)
      }
      if id == finished { _ = try local.runner.run(FinishSession(id: id, finishedAt: Instant(ms: start + 3_000))) }
    }
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.pendingAdoptions.map(\.product) == ["gym"])
    await local.adopt(.add, asked: local.pendingAdoptions)
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

  @Test func oneQuestionNamesBothRoomsAndOneAnswerBindsThem() async throws {
    let recorder = TelemetryRecorder()
    let (_, owner, model, localRoutine) = try await twoRooms(telemetry: recorder)
    #expect(model.account == nil && model.editorReadOnly && model.sheet == .adoption)
    #expect(model.pendingAdoptions.map(\.product) == ["journal", "gym"] && model.adoptionCounts[.journal]?[Page.type] == 1)
    #expect(model.adoptionAlertTitle == "Add to your account?")
    #expect(model.adoptionAlertMessage == "This phone has 1 routine and 1 journal page from before you signed in. Your account already has training and journal pages. Add them, or discard them from this phone.")
    model.sheet = .discardAdoption
    #expect(model.adoptionAlertTitle == "Discard 1 routine and 1 journal page?")
    #expect(model.adoptionAlertMessage == "They are deleted from this phone. You can’t undo this.")
    await model.adopt(.discard, asked: model.pendingAdoptions)
    #expect(model.account == owner.account && !model.editorReadOnly && model.sheet == nil)
    #expect(model.adoptionAnswers.isEmpty && model.preferences.data(forKey: "roomAdoption") == nil)
    #expect(!model.gym.routines.contains { $0.id == localRoutine })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "room_adoption_answered" }.map(\.properties) } ==
            [["room": "journal", "action": "discard"], ["room": "gym", "action": "discard"]])
  }

  @Test func partialAnswerSurvivesModelRelaunchWithoutAskingJournalAgain() async throws {
    let (_, owner, model, localRoutine) = try await twoRooms()
    try model.saveAdoptionAnswers(["journal": .add], session: try #require(model.signInSession))
    let restored = try AppModel(runner: model.runner, preferences: model.preferences, runtime: model.runtime)
    await restored.start()
    defer {
      restored.timerTask?.cancel(); restored.observationTask?.cancel(); restored.gym.stop()
    }
    #expect(restored.account == nil && restored.sheet == .adoption && restored.editorReadOnly)
    #expect(restored.adoptionAnswers == ["journal": .add])
    #expect(restored.pendingAdoptions.map(\.product) == ["gym"] && restored.adoptionCounts == [.gym: ["routine": 1]])
    await restored.adopt(.add, asked: restored.pendingAdoptions)
    #expect(restored.account == owner.account && restored.sheet == nil && restored.pendingAdoptions.isEmpty)
    #expect(restored.gym.routines.contains { $0.id == localRoutine })
  }

  @Test func changedGymWorkAsksAgainAboutTheGymAloneAndKeepsTheJournalAnswer() async throws {
    let (_, _, model, _) = try await twoRooms()
    _ = try routine(model, name: "Another local routine")
    await model.adopt(.discard, asked: model.pendingAdoptions)
    #expect(model.account == nil && model.sheet == .adoption && model.error != nil)
    #expect(model.adoptionAnswers == ["journal": .discard])
    #expect(model.pendingAdoptions.map(\.product) == ["gym"] && model.adoptionCounts == [.gym: [Routine.type: 2]])
    #expect(model.gym.routines.count == 2)
    await model.adopt(.discard, asked: model.pendingAdoptions)
    #expect(model.account != nil && model.sheet == nil)
    #expect(!model.gym.routines.contains { $0.name == "Local routine" || $0.name == "Another local routine" })
  }

  @Test func gymAdoptionNamesWeighInsButNeverPreferencesOrMovementNames() async throws {
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
    #expect(model.account == nil && model.pendingAdoptions.map(\.product) == ["gym"])
    #expect(model.adoptionCounts == [.gym: [WeighIn.type: 1, GymPreferences.type: 1, ExerciseName.type: 1]])
    #expect(model.adoptionAlertMessage == "This phone has 1 weigh-in from before you signed in. Your account already has training. Add it, or discard it from this phone.")
    model.sheet = .discardAdoption
    #expect(model.adoptionAlertTitle == "Discard 1 weigh-in?")
    #expect(model.adoptionAlertMessage == "It is deleted from this phone. You can’t undo this.")
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

  @Test func updateRequiredAtSignInAsksOnceKeepsTheSignInPendingAndTheRoomsOpen() async throws {
    let recorder = TelemetryRecorder()
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server, telemetry: recorder)
    let updates = { recorder.entries.withLock { $0.filter { $0.name == "client_update_required" }.map(\.properties) } }
    model.openJournal()
    server.state.withLock { $0.upgradeRequired = true }
    model.sheet = .code; model.email = "update@example.com"; model.code = "482913"
    await model.verifyCode()
    #expect(model.updateAlert && model.updateRequired && model.updateTrigger == "sign_in" && model.signInPending)
    #expect(model.error == nil && model.sheet == .you && model.pendingSignIn != nil && model.account == nil)
    #expect(model.updateMessage == "Update Windmill to sign in. Your work is saved on this phone.")
    #expect(!model.editorReadOnly && recorder.entries.withLock { !$0.contains { $0.name == "client_error" } })
    // Asking records nothing; the alert is recorded by the presenter once it is on screen.
    #expect(updates().isEmpty)
    model.updateAlertPresented()
    model.keepWorkingWithoutUpdate(); model.noticeUpdateRequired()
    #expect(!model.updateAlert)
    model.journal.type("Written while the update waits"); model.journal.done()
    #expect(model.journal.document.body == "Written while the update waits" && !model.journal.dirty)
    model.getUpdate(); model.updateOpened(false)
    #expect(model.updateOpenFailed)
    model.dismissUpdateFailure()
    #expect(!model.updateOpenFailed)
    #expect(updates() == [["state": "shown", "status": "426", "trigger": "sign_in"], ["action": "keep", "trigger": "sign_in"],
                          ["action": "update", "trigger": "sign_in"], ["action": "update", "outcome": "failed", "trigger": "sign_in"]])
  }

  // Signed out nothing syncs, so the alert names what the update unlocks.
  @Test func theUpdateAlertNamesSyncingOnlyForAnAccount() async throws {
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server)
    #expect(model.updateMessage == "Update Windmill to sign in. Your work is saved on this phone.")
    try await model.signIn(server.identity(email: "message@example.com"))
    #expect(model.updateMessage == "Update Windmill to keep syncing. Your work is saved on this phone.")
  }

  // A sign-in an old app cannot finish is not a dead end: You stays You, with Settings, and the sign-in can be given up,
  // which revokes the verified session and leaves nothing for the next launch to resume.
  @Test func aPendingSignInIsASectionOfYouAndCanBeCancelled() async throws {
    let recorder = TelemetryRecorder()
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server, telemetry: recorder)
    let runtime = try #require(model.runtime)
    model.openJournal()
    server.state.withLock { $0.upgradeRequired = true }
    model.sheet = .code; model.email = "update@example.com"; model.code = "482913"
    await model.verifyCode()
    #expect(model.signInPending && model.updateRequired && model.sheet == .you)
    #expect(model.identityTitle == "Not signed in" && model.identityStatus == "Syncing paused · update Windmill")
    let pending = try #require(model.pendingSignIn)
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == pending.identity.account)
    #expect(runtime.tokens.token(for: pending.identity.account) == pending.identity.token)
    model.openYou()
    #expect(model.sheet == .you)
    model.cancelSignIn()
    #expect(!model.signInPending && model.sheet == .you && model.error == nil && !model.editorReadOnly)
    #expect(model.identityStatus == nil, "Signed out with nothing finishing, the identity has no status")
    // The engine heard the server's 426 at the sign-in hello and keeps it; only the sign-in's own flag is cleared.
    #expect(!model.updateRequiredAtSignIn && model.updateTrigger == "sync")
    #expect(model.preferences.string(forKey: "pendingAuthMethod") == nil)
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == nil)
    #expect(runtime.tokens.token(for: pending.identity.account) == nil)
    for _ in 0..<100 where server.state.withLock({ $0.sessions[pending.identity.token.value] != nil }) { try await Task.sleep(for: .milliseconds(20)) }
    #expect(server.state.withLock { $0.sessions[pending.identity.token.value] } == nil, "the verified session is revoked")
    #expect(recorder.entries.withLock { $0.filter { $0.name == "auth_signed_in" }.map(\.properties) } ==
            [["method": "email", "outcome": "failed"], ["method": "email", "outcome": "cancelled"]])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "first_run_choice" }.map(\.properties) }.contains(["screen": "auth_pending", "action": "cancel"]))
    let relaunched = try AppModel(runner: model.runner, preferences: model.preferences, runtime: runtime, telemetry: recorder)
    #expect(relaunched.pendingSignIn == nil && !relaunched.restoringSignIn && relaunched.sheet == nil)
  }

  // Sign out raises one question over You and answers it there; its choices are You's.
  @Test func signOutAsksOverYouAndCountsWhatTheAccountHasNotConfirmed() async throws {
    let recorder = TelemetryRecorder()
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server, telemetry: recorder)
    try await model.signIn(server.identity(email: "asks-once@example.com"))
    model.sheet = .you
    recorder.entries.withLock { $0.removeAll() }
    await model.beginSignOut()
    #expect(model.sheet == .you && model.signOutSession != nil)
    await model.cancelSignOut()
    #expect(model.sheet == .you && model.signOutSession == nil && model.account != nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "first_run_choice" }.map(\.properties) } ==
            [["screen": "you", "action": "sign_out"], ["screen": "you", "action": "cancel"]])
    #expect([0, 1, 3].map(AppModel.signOutMessage(unsent:)) == [
      "Your pages and log stay in your account and leave this phone.",
      "1 change hasn’t been confirmed by your account yet. Keep it on this phone until you sign in again, or discard it from this phone.",
      "3 changes haven’t been confirmed by your account yet. Keep them on this phone until you sign in again, or discard them from this phone."])
  }

  // An answer the sign-out cannot carry out closes the question, keeps the account and says why under Sign out until it is tapped again.
  @Test func aRefusedSignOutEndsItsQuestionAndKeepsTheReasonUntilSignOutIsTappedAgain() async throws {
    let recorder = TelemetryRecorder()
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server, telemetry: recorder)
    let identity = server.identity(email: "refused@example.com")
    try await model.signIn(identity)
    model.journal.type("Counted"); model.journal.save(); model.journal.done()
    model.sheet = .you
    await model.beginSignOut()
    let asked = try #require(model.signOutSession)
    #expect(try model.runner.run(SavePage(day: model.journal.today, document: PageDocument(body: "Written while asked"))).refusal == nil)
    recorder.entries.withLock { $0.removeAll() }
    await model.finishSignOut(.discard)
    #expect(model.account == identity.account && model.sheet == .you && model.signOutSession == nil && !model.editorReadOnly)
    #expect(model.signOutRefusal == "Something changed while you chose. Sign out again." && model.error == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "auth_signed_out" || $0.name == "first_run_choice" }.map(\.properties) } ==
            [["screen": "you", "action": "discard"], ["outcome": "refused"]])
    await model.beginSignOut()
    let askedAnew = try #require(model.signOutSession)
    #expect(model.signOutRefusal == nil && askedAnew !== asked, "Sign out asks anew, counting what changed")
    await model.finishSignOut(.discard)
    #expect(model.account == nil && model.signOutRefusal == nil)
  }

  // A sign-out that cannot begin says why under Sign out and records the refusal after the tap: a room that cannot save
  // says so in its own words, and any other failure is one written sentence. Nothing waits in the sign-in steps' error.
  @Test(arguments: [(TxName.commit, "Couldn't save on this phone. Your writing stays in the editor. Try again."),
                    (TxName.signOutRelease, "Couldn't sign out. Try again.")])
  func aSignOutThatCannotBeginSaysWhyUnderSignOut(_ failing: TxName, _ reason: String) async throws {
    let fault = GymStoreFault(), recorder = TelemetryRecorder(), server = JournalModelTransport()
    let model = try LineageFlowTests().fixture(server, crashPoints: CrashPoints { point in
      if fault.point.withLock({ $0 == point }) { throw AppFailure(message: "private-fault-marker") }
    }, telemetry: recorder)
    let identity = server.identity(email: "cannot-begin@example.com")
    try await model.signIn(identity)
    model.journal.type("Not saved yet")
    model.sheet = .you
    recorder.entries.withLock { $0.removeAll() }
    fault.point.withLock { $0 = .beforeCommit(failing) }
    await model.beginSignOut()
    fault.point.withLock { $0 = nil }
    #expect(model.account == identity.account && model.sheet == .you && model.signOutSession == nil && !model.editorReadOnly)
    #expect(model.signOutRefusal == reason && model.error == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "auth_signed_out" || $0.name == "first_run_choice" }.map(\.properties) } ==
            [["screen": "you", "action": "sign_out"], ["outcome": "refused"]])
    await model.beginSignOut()
    #expect(model.signOutSession != nil && model.signOutRefusal == nil, "Sign out asks anew once the phone can begin it")
  }

  // An answer that fails for a reason of the phone's own is one written sentence under Sign out, never the error's own text.
  @Test func aSignOutAnswerThatFailsSaysOneWrittenSentence() async throws {
    let fault = GymStoreFault(), recorder = TelemetryRecorder(), server = JournalModelTransport()
    let model = try LineageFlowTests().fixture(server, crashPoints: CrashPoints { point in
      if fault.point.withLock({ $0 == point }) { throw AppFailure(message: "private-fault-marker") }
    }, telemetry: recorder)
    let identity = server.identity(email: "answer-fails@example.com")
    try await model.signIn(identity)
    model.sheet = .you
    await model.beginSignOut()
    _ = try #require(model.signOutSession)
    recorder.entries.withLock { $0.removeAll() }
    fault.point.withLock { $0 = .beforeCommit(.signOutFinish) }
    await model.finishSignOut(.keep)
    fault.point.withLock { $0 = nil }
    #expect(model.account == identity.account && model.signOutSession == nil && !model.editorReadOnly)
    #expect(model.signOutRefusal == "Couldn't sign out. Try again." && model.error == nil)
    #expect(recorder.entries.withLock { $0.filter { ["auth_signed_out", "first_run_choice", "client_error"].contains($0.name) }.map(\.properties) } == [
      ["screen": "you", "action": "keep"], ["operation": "auth_sign_out", "failure_kind": "unexpected"], ["outcome": "refused"]])
  }

  // A finished sign-out takes the account's name and address off this phone, whichever way it ends, and the sign-in steps
  // open blank for whoever signs in next.
  @Test(arguments: [SignOutChoice.keep, .discard]) func aFinishedSignOutLeavesNoNameOrAddressOnThePhone(_ choice: SignOutChoice) async throws {
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "residue@example.com")
    let residue = { ["accountName:", "accountEmail:"].map { model.preferences.string(forKey: $0 + identity.account) } }
    let steps = { [model.email, model.code, model.appleReceiptEmail, model.codeSentAt == nil ? "-" : "sent"] }
    model.email = "residue@example.com"; model.code = "482913"; model.codeSentAt = Date(); model.appleReceiptEmail = "residue@example.com"
    model.preferences.set("first-workout", forKey: GymModel.keepReceipt)
    try await model.signIn(identity)
    #expect(residue() == ["Sam", "residue@example.com"])
    await model.beginSignOut(); await model.finishSignOut(choice)
    #expect(model.account == nil && residue() == [nil, nil])
    #expect(model.preferences.string(forKey: GymModel.keepReceipt) == "first-workout", "the receipt's Keep it is offered once per phone")
    #expect(steps() == ["", "", "", "-"])
  }

  // You's identity is the account's name, or its email, never "You"; its one line is the account's backup, paused or not.
  @Test func youNamesTheAccountAndStatesWhetherItIsBackedUp() async throws {
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server)
    #expect(model.identityTitle == "Not signed in" && model.identityStatus == nil)
    let identity = server.identity(email: "named@example.com")
    try await model.signIn(identity)
    model.journal.type("Waiting to send"); model.journal.save(); model.journal.done()
    for _ in 0..<100 where model.identityStatus != "Not backed up yet" { try await Task.sleep(for: .milliseconds(20)) }
    #expect(model.identityTitle == "Sam" && model.identityStatus == "Not backed up yet")
    await model.runtime?.engine.start()
    for _ in 0..<200 where model.identityStatus != "Backed up" { try await Task.sleep(for: .milliseconds(20)) }
    #expect(model.identityStatus == "Backed up")
    let relaunched = try AppModel(runner: model.runner, preferences: model.preferences, runtime: model.runtime)
    #expect(relaunched.identityTitle == "Sam" && relaunched.emailMethodValue == "named@example.com")
    model.preferences.removeObject(forKey: "accountName:\(try #require(model.account))")
    let unnamed = try AppModel(runner: model.runner, preferences: model.preferences, runtime: model.runtime)
    #expect(unnamed.identityTitle == "named@example.com" && unnamed.emailMethodValue == nil, "The address is said once")
    server.state.withLock { $0.sessions[identity.token.value] = nil }
    model.journal.type("Waiting on the sign-in"); model.journal.save(); model.journal.done()
    await model.runtime?.engine.start()
    for _ in 0..<100 where !model.authPaused { try await Task.sleep(for: .milliseconds(20)) }
    #expect(model.identityTitle == "Sam" && model.identityStatus == "Syncing paused · sign in again")
  }

  // Signed out, You lists only the rooms that keep something on this phone.
  @Test func onThisPhoneListsOnlyTheRoomsThatHoldSomething() throws {
    let model = try LineageFlowTests().fixture(JournalModelTransport())
    #expect(model.phoneHoldings.isEmpty)
    _ = try routine(model, name: "Push A")
    #expect(model.phoneHoldings.map { "\($0.room.title) · \($0.summary)" } == ["Gym · 1 routine"])
    model.journal.type("A page"); model.journal.save(); model.journal.done(); model.refresh()
    #expect(model.phoneHoldings.map { "\($0.room.title) · \($0.summary)" } == ["Journal · 1 page", "Gym · 1 routine"])
  }

  @Test func theEnginesUpdateFlagSpeaksOncePerLaunch() async throws {
    let recorder = TelemetryRecorder()
    let server = JournalModelTransport(), model = try LineageFlowTests().fixture(server, telemetry: recorder)
    try await model.signIn(server.identity(email: "flag@example.com"))
    model.noticeUpdateRequired()
    #expect(!model.updateAlert && !model.updateRequired)
    server.state.withLock { $0.upgradeRequired = true }
    await model.runtime?.engine.start()
    for _ in 0..<100 where model.runtime?.engine.status.upgradeRequired != true { try await Task.sleep(for: .milliseconds(20)) }
    model.noticeUpdateRequired()
    #expect(model.updateAlert && model.updateTrigger == "sync" && model.identityStatus == "Syncing paused · update Windmill")
    #expect(model.updateMessage == "Update Windmill to keep syncing. Your work is saved on this phone.")
    model.updateAlertPresented()
    model.getUpdate(); model.updateOpened(true); model.noticeUpdateRequired()
    #expect(!model.updateAlert && !model.updateOpenFailed)
    let relaunched = try AppModel(runner: model.runner, preferences: model.preferences, runtime: model.runtime, telemetry: recorder)
    relaunched.noticeUpdateRequired()
    #expect(relaunched.updateAlert)
    relaunched.updateAlertPresented()
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_update_required" }.map(\.properties) } ==
            [["state": "shown", "status": "426", "trigger": "sync"], ["action": "update", "trigger": "sync"], ["state": "shown", "status": "426", "trigger": "sync"]])
  }

  // The choice is the window's interface style, so every room, sheet and keyboard answers it; System leaves it to the phone.
  @Test func appearanceIsChosenOnceAndRemembered() throws {
    let recorder = TelemetryRecorder()
    let (_, model) = try JournalModelTests().fixture(telemetry: recorder)
    #expect(model.appearance == .system)
    model.chooseAppearance(.dark); model.chooseAppearance(.dark)
    #expect(try AppModel(runner: model.runner, preferences: model.preferences).appearance == .dark)
    #expect(AppModel.Appearance.allCases.map(\.style) == [.light, .dark, .unspecified])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "appearance_chosen" }.map(\.properties) } == [["appearance": "dark"]])
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
