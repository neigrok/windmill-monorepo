import Foundation
import Observation
import SwiftUI
import Testing
import UIKit
import SyncAPI
import SyncCore
import SyncEngine
import SyncStore
import Synchronization
@testable import Windmill

@Suite(.serialized) @MainActor struct StartupRecoveryTests {
  // Simulator disposal removes UUID databases after engine tasks and SQLite handles have ended.
  func pendingRuntime(transport: RecoveryTransport, directory: URL, service: String) async throws -> (AppRuntime, AuthIdentity) {
    let settings = AppSettings(arguments: ["app"])
    var initial: AppRuntime? = try AppRuntime(settings: settings, directory: directory, service: service, syncTransport: transport)
    let identity = transport.base.identity(email: "startup@example.com")
    await #expect(throws: EngineError.unreachable) { try await initial!.engine.signIn(account: identity.account, token: identity.token) }
    #expect(try initial!.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == identity.account)
    initial = nil
    return (try AppRuntime(settings: settings, directory: directory, service: service, syncTransport: transport), identity)
  }

  func waiting(_ transport: RecoveryTransport) async throws {
    for _ in 0..<200 {
      if await transport.gate.waiting { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Startup did not reach the delayed hello")
    throw CancellationError()
  }

  func completed(_ model: AppModel) async throws {
    for _ in 0..<500 {
      if model.syncStarted { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Pending sign-in did not resume")
    throw CancellationError()
  }

  @Test(arguments: [false, true]) func authControlsDuringRestoredHelloKeepRecoveryUsable(close: Bool) async throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString), service = "works.windmill.startup-tests.\(UUID())"
    let transport = RecoveryTransport()
    let (runtime, identity) = try await pendingRuntime(transport: transport, directory: directory, service: service)
    let preferences = UserDefaults(suiteName: service)!
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime)
    defer {
      model.timerTask?.cancel(); model.observationTask?.cancel(); model.gym.stop()
      try? runtime.tokens.delete(for: identity.account)
      preferences.removePersistentDomain(forName: service)
    }
    await transport.hold()
    let start = Task { await model.start() }
    try await waiting(transport)
    if close {
      model.cancelAuthentication(); model.sheet = nil
      await start.value
      #expect(model.signInDeferred && !model.editorReadOnly && !model.accountTransition)
      #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == identity.account)
      model.journal.type("Writing while recovery is deferred"); model.journal.done()
      await transport.release()
      model.sheet = .authPending
      model.performAuthentication { await model.retryAuthenticatedSignIn() }
      await model.authTask?.value
      #expect(model.journal.document.body == "Writing while recovery is deferred")
    } else {
      model.performAuthentication { await model.retryAuthenticatedSignIn() }
      await model.authTask?.value
      await transport.release()
      await start.value
    }
    #expect(model.syncStarted && model.account == identity.account && !model.accountTransition)
    #expect(!model.restoringSignIn && !model.signInDeferred && !model.editorReadOnly && model.pendingSignIn == nil && model.sheet == nil)
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == nil)
  }

  @Test func upgradedPreviouslyOpenedInstallDoesNotShowInkDuringRealStartup() async throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString), service = "works.windmill.ink-upgrade-tests.\(UUID())"
    let runtime = try AppRuntime(settings: AppSettings(arguments: ["app"]), directory: directory, service: service,
                                 syncTransport: JournalModelTransport())
    let preferences = UserDefaults(suiteName: service)!, recorder = TelemetryRecorder()
    preferences.set(true, forKey: "journalOpened")
    #expect(preferences.object(forKey: "inkShown") == nil)
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime, telemetry: recorder)
    defer {
      model.timerTask?.cancel(); model.observationTask?.cancel()
      preferences.removePersistentDomain(forName: service)
    }
    #expect(!model.welcome && model.journal.room?.firstRunKnown == true && model.journal.room?.stance == .empty && model.journal.room?.days.isEmpty == true)
    await model.start()
    #expect(model.syncStarted && !model.restoringSignIn && !model.editorReadOnly)
    #expect(!model.journal.inkVisible && preferences.object(forKey: "inkShown") == nil)
    #expect(recorder.entries.withLock { $0.map(\.name) } == ["auth_restore"])
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [["outcome": "anonymous"]])
    model.journal.automaticallyShowInk(); model.openJournal()
    #expect(!model.journal.inkVisible && preferences.object(forKey: "inkShown") == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.isEmpty })
  }

  @Test func pendingSignInSurvivesInactiveThenActiveDuringDelayedHello() async throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString), service = "works.windmill.startup-tests.\(UUID())"
    let transport = RecoveryTransport()
    let (runtime, identity) = try await pendingRuntime(transport: transport, directory: directory, service: service)
    let preferences = UserDefaults(suiteName: service)!, recorder = TelemetryRecorder()
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime, telemetry: recorder)
    #expect(model.restoringSignIn && model.pendingSignIn != nil && model.sheet == .authPending && model.editorReadOnly)
    let phase = RecoveryPhase()
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = scene.screen.bounds
    window.rootViewController = UIHostingController(rootView: RecoveryHost(model: model, phase: phase))
    defer {
      window.isHidden = true; window.rootViewController = nil
      model.timerTask?.cancel(); model.observationTask?.cancel()
      try? runtime.tokens.delete(for: identity.account)
      preferences.removePersistentDomain(forName: service)
    }
    await transport.hold()
    window.isHidden = false
    try await waiting(transport)
    #expect(model.accountTransition && !model.syncStarted)
    phase.value = .inactive
    try await Task.sleep(for: .milliseconds(450))
    #expect(model.accountTransition && !model.syncStarted)
    #expect(transport.state.withLock { $0.active == 1 && $0.maximumActive == 1 })
    #expect(await transport.gate.cancelled == 0)
    phase.value = .active
    try await Task.sleep(for: .milliseconds(50))
    await transport.release()
    try await completed(model)
    #expect(model.account == identity.account && !model.accountTransition)
    #expect(!model.restoringSignIn && model.pendingSignIn == nil && model.sheet == nil)
    #expect(!model.journal.inkVisible && !preferences.bool(forKey: "inkShown"))
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == nil)
    #expect(transport.state.withLock { $0.maximumActive } == 1)
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [["outcome": "signed_in"]])
    #expect(await transport.gate.cancelled == 0)
  }

  @Test func cancelledRecoveryKeepsPendingSignInAndRetriesWithoutOverlap() async throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString), service = "works.windmill.startup-tests.\(UUID())"
    let transport = RecoveryTransport()
    let (runtime, identity) = try await pendingRuntime(transport: transport, directory: directory, service: service)
    let preferences = UserDefaults(suiteName: service)!, recorder = TelemetryRecorder()
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime, telemetry: recorder)
    defer {
      model.timerTask?.cancel(); model.observationTask?.cancel()
      try? runtime.tokens.delete(for: identity.account)
      preferences.removePersistentDomain(forName: service)
    }
    await transport.hold()
    let first = Task { await model.start() }
    try await waiting(transport)
    let repeated = Task { await model.start() }
    await Task.yield()
    await model.resumeBackup()
    #expect(transport.state.withLock { $0.active == 1 && $0.maximumActive == 1 })
    first.cancel()
    await first.value
    await repeated.value
    #expect(!model.syncStarted && !model.accountTransition)
    #expect(model.restoringSignIn && model.pendingSignIn != nil && model.sheet == .authPending)
    #expect(!model.journal.inkVisible && !preferences.bool(forKey: "inkShown"))
    #expect(model.recoveryDue == nil && model.recoveryDelayMs == Constants.backoffBaseMs)
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == identity.account)
    #expect(recorder.entries.withLock { $0.isEmpty })
    #expect(await transport.gate.cancelled == 1)
    await transport.release()
    try await completed(model)
    model.refresh()
    #expect(model.account == identity.account && !model.accountTransition)
    #expect(!model.restoringSignIn && model.pendingSignIn == nil && model.sheet == nil)
    #expect(!model.journal.inkVisible && !preferences.bool(forKey: "inkShown"))
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == nil)
    #expect(transport.state.withLock { $0.maximumActive } == 1)
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [["outcome": "signed_in"]])
  }

  @Test func failedRecoveryRemainsRetryableUntilHelloSucceeds() async throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString), service = "works.windmill.startup-tests.\(UUID())"
    let transport = RecoveryTransport()
    let (runtime, identity) = try await pendingRuntime(transport: transport, directory: directory, service: service)
    let preferences = UserDefaults(suiteName: service)!, recorder = TelemetryRecorder()
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime, telemetry: recorder)
    defer {
      model.timerTask?.cancel(); model.observationTask?.cancel()
      try? runtime.tokens.delete(for: identity.account)
      preferences.removePersistentDomain(forName: service)
    }
    await model.start()
    #expect(!model.syncStarted && !model.accountTransition)
    #expect(model.restoringSignIn && model.pendingSignIn != nil && model.sheet == .authPending)
    #expect(!model.journal.inkVisible && !preferences.bool(forKey: "inkShown"))
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == identity.account)
    #expect(recorder.entries.withLock { $0.map(\.name) } == ["auth_restore"])
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [["outcome": "failed"]])
    let calls = transport.state.withLock { $0.calls }
    try await Task.sleep(for: .milliseconds(500))
    #expect(transport.state.withLock { $0.calls } == calls)
    #expect(model.recoveryDelayMs == 2_000)
    model.recoveryDue = ContinuousClock.now
    await model.resumeBackup()
    #expect(!model.syncStarted && !model.accountTransition)
    #expect(transport.state.withLock { $0.calls } == calls + 2)
    #expect(model.recoveryDelayMs == 4_000)
    await transport.release()
    try await completed(model)
    model.refresh()
    #expect(model.account == identity.account && !model.accountTransition)
    #expect(!model.restoringSignIn && model.pendingSignIn == nil && model.sheet == nil)
    #expect(!model.journal.inkVisible && !preferences.bool(forKey: "inkShown"))
    #expect(try runtime.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == nil)
    #expect(transport.state.withLock { $0.maximumActive } == 1)
    #expect(model.recoveryDue == nil && model.recoveryDelayMs == Constants.backoffBaseMs)
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [["outcome": "failed"], ["outcome": "signed_in"]])
  }
}

@Observable @MainActor final class RecoveryPhase {
  var value = ScenePhase.active
}

private struct RecoveryHost: View {
  let model: AppModel
  let phase: RecoveryPhase
  var body: some View {
    Color.clear
      .onChange(of: phase.value) { _, value in model.scenePhaseChanged(value) }
      .modifier(AppStartup(model: model))
      .environment(\.scenePhase, phase.value)
  }
}

actor RecoveryGate {
  var waiting = false
  var cancelled = 0
  var blocked = false
  var continuations: [UUID: CheckedContinuation<Bool, Never>] = [:]

  func setBlocked() { blocked = true }

  func wait() async -> Bool {
    guard blocked else { return !Task.isCancelled }
    let id = UUID()
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        guard !Task.isCancelled else { cancelled += 1; continuation.resume(returning: false); return }
        waiting = true
        continuations[id] = continuation
      }
    } onCancel: {
      Task { await self.cancel(id) }
    }
  }

  func cancel(_ id: UUID) {
    guard let continuation = continuations.removeValue(forKey: id) else { return }
    cancelled += 1; waiting = !continuations.isEmpty
    continuation.resume(returning: false)
  }

  func release() {
    blocked = false; waiting = false
    let waiting = continuations.values
    continuations.removeAll()
    for continuation in waiting { continuation.resume(returning: true) }
  }
}

nonisolated final class RecoveryTransport: SyncTransport {
  struct State { var online = false; var active = 0; var maximumActive = 0; var calls = 0 }
  let state = Mutex(State())
  let base = JournalModelTransport()
  let gate = RecoveryGate()

  func hold() async { state.withLock { $0.online = true }; await gate.setBlocked() }
  func release() async { state.withLock { $0.online = true }; await gate.release() }

  func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    let online = state.withLock { state in
      state.calls += 1
      state.active += 1; state.maximumActive = max(state.maximumActive, state.active)
      return state.online
    }
    defer { state.withLock { $0.active -= 1 } }
    guard online, await gate.wait() else { return .unreachable }
    return await base.hello(token: token)
  }
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> { await base.push(request, token: token) }
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> { await base.pull(request, token: token) }
  func openLive(token: SessionToken) async -> Reply<any LiveConnection> { .unreachable }
}
