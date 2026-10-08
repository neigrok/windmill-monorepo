import Foundation
import DomainKit
import JournalDomain
import GymDomain
import SyncSchema
import SyncEngine
#if DEBUG && targetEnvironment(simulator)
import SwiftUI
import UIKit
import SyncCore
import struct SyncModelServer.ScopeKey
#endif

// Launch fixtures use the same actions, persistence and sign-in door as the app.
enum BoardFixture {
  static let prose = "Long day. The walk home was the best part — the rain had just stopped and the street smelled of it.\nI want more evenings like that."
  static let shortProse = "Long day. The walk home was the best part — the rain had just stopped and the street smelled of it."
  static func prepare(_ board: String, model: AppModel) async {
    #if DEBUG && targetEnvironment(simulator)
    if await JournalEchoFixture.prepare(board, model: model) { return }
    if ProcessInfo.processInfo.arguments.contains("-routines-proposal-fixture"),
       let server = model.runtime?.auth.fake {
      do { try await model.signIn(server.identity(email: "routines-proposal-fixture@example.com")) }
      catch {
        let reason = CoachFixture.failureReason(error)
        NSLog("Gym Proposal fixture failed: %@", reason)
        model.gym.error = "Proposal fixture could not be prepared (\(reason))."; return
      }
      guard model.gym.coachAccountAvailable else {
        NSLog("Gym Proposal fixture failed: account_unavailable")
        model.gym.error = "Proposal fixture account is unavailable."; return
      }
    }
    if await WorkoutFixture.prepare(board, model: model) { return }
    model.keepDismissed = false
    if board.hasPrefix("shell-") {
      if board == "shell-anonymous" { model.welcome = true; return }
      model.openJournal()
      if board == "shell-adoption-two-rooms", let runtime = model.runtime, let server = runtime.auth.fake {
        try? await model.signIn(server.identity(email: "shell@example.com"))
        model.journal.type("An account page."); model.journal.done()
        var remote = Draft(new: Routine(id: model.runner.mint(Routine.self), name: "Account routine", entries: [RoutineEntry(exerciseId: ID("back-squat"))]))
        _ = model.gym.save(&remote)
        await model.beginSignOut(); await model.finishSignOut(.discard)
        model.openJournal()
        var local = Draft(new: Routine(id: model.runner.mint(Routine.self), name: "Phone routine", entries: [RoutineEntry(exerciseId: ID("back-squat"))]))
        _ = model.gym.save(&local)
      }
      model.journal.type("A page on this phone."); model.journal.done(); model.journal.dismissScales()
      if board == "shell-adoption-two-rooms" { model.keep() }
      return
    }
    model.welcome = board.hasPrefix("01") || board.hasPrefix("02")
    guard !model.welcome else { return }
    model.preferences.set(true, forKey: "journalOpened")
    if board.hasPrefix("23") || board.hasPrefix("24"), let runtime = model.runtime, let server = runtime.auth.fake {
      let identity = server.identity(email: "sam@example.com")
      try? await model.signIn(identity)
      model.journal.type("An earlier page in Sam's account."); model.journal.save(); model.journal.done()
      await runtime.engine.start(); try? await AppScenario.backedUp(model)
      if board.hasPrefix("24") {
        model.sheet = .you; await model.loadSignInMethods()
        if board == "24b" || board == "24c" {
          await model.authenticateApple { token in try runtime.auth.authorizeFakeApple(token: token) }
          if board == "24c" { model.removingApple = true }
        }
        if board == "24d" {
          server.state.withLock { state in
            state.appleDoors[state.appleSubject] = "model-other@example.com"
            state.dataAccounts.insert("model-other@example.com")
          }
          await model.authenticateApple { token in try runtime.auth.authorizeFakeApple(token: token) }
        }
        return
      }
      await model.beginSignOut(); await model.finishSignOut(.discard)
      model.welcome = false; model.preferences.set(true, forKey: "journalOpened")
    }
    if board.hasPrefix("05") { return }
    if board == "journal-read-only" { model.working = true; return }
    if board.hasPrefix("journal-empty-later") || board.hasPrefix("journal-one-line") || board.hasPrefix("journal-history") {
      guard let engine = model.runtime?.engine else { return }
      let count = board.hasPrefix("journal-history") ? 12 : 1
      for offset in 1...count {
        // Each saved page is today to its fixture runner; the app's past-day guard stays intact.
        let zone = FixedZone(offsetSeconds: DeviceZone().offsetSeconds(at: Instant(ms: BoardClock().nowMs())) - offset * 86_400)
        let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: zone)
        guard let saved = try? runner.run(SavePage(day: model.journal.today.adding(days: -offset), document: PageDocument(body: shortProse), retiring: ["placeholder", "scales"])), saved.refusal == nil else {
          model.error = "Couldn't prepare the journal board."; return
        }
      }
      model.keepDismissed = true
      model.refresh()
      if board.hasPrefix("journal-one-line") || board.hasPrefix("journal-history") {
        model.journal.type("Short walk, then an early night."); model.journal.save(); model.journal.done()
      }
      return
    }
    model.journal.type(board.hasPrefix("21") ? shortProse : prose)
    model.journal.save(); model.journal.done()
    if !board.hasPrefix("07-journal") && !board.hasPrefix("06") {
      model.journal.setScale("mood", 7); model.journal.setScale("energy", 4)
    }
    if board.hasPrefix("21") {
      model.keepDismissed = true; model.journal.document.mood = nil; model.journal.document.energy = nil
    }
    if board.hasPrefix("07b") || board.hasPrefix("21b") {
      if let identity = try? model.runtime?.auth.fakeApple() { try? await model.signIn(identity) }
      await model.runtime?.engine.start()
      for _ in 0..<30 {
        model.refresh()
        if model.journal.backup == "backed up" { break }
        try? await Task.sleep(for: .milliseconds(100))
      }
    }
    if board == "paused-backup", let runtime = model.runtime, let identity = try? runtime.auth.fakeApple() {
      try? await model.signIn(identity)
      await runtime.engine.start()
      try? await AppScenario.backedUp(model)
      try? await runtime.auth.logout(token: identity.token)
      await runtime.engine.start(); model.refresh(); model.sheet = .you
    }
    if board.hasPrefix("14") { model.keep() }
    if board.hasPrefix("23"), let runtime = model.runtime {
      model.keep()
      if board != "23-start" {
        await model.authenticateApple { token in try runtime.auth.authorizeFakeApple(token: token) }
        if board == "23b" || board == "23c" || board == "23d" {
          model.useAppleAccount(); model.email = "sam@example.com"
          if board == "23c", let ticket = model.appleTicket {
            try? await runtime.auth.requestCode(email: model.email)
            if let identity = try? await runtime.auth.verifyCode(email: model.email, code: "482913", appleTicket: ticket) {
              model.appleTicket = nil; model.appleReceiptEmail = identity.email; model.code = "482913"
              model.appleLinkedReceipt = true; model.sheet = .appleAdded
            }
          }
          if board == "23d" { await model.sendCode(); model.code = "482913"; await model.verifyCode() }
        }
      }
    }
    if board.hasPrefix("15") {
      model.email = "you@example.com"; model.codeSentAt = Date(); model.sheet = .code
    }
    if board.hasPrefix("06") { model.journal.editing = true }
    #endif
  }
}

enum AppScenario {
  static func run(model: AppModel) async {
    #if DEBUG && targetEnvironment(simulator)
    if model.runtime?.settings.scenario?.hasPrefix("gym-e2e") == true {
      model.openRoom(.gym)
      if model.runtime?.settings.restoreBoard == true { return }
      guard let runtime = model.runtime, runtime.settings.scenario != "gym-e2e-anonymous" else { return }
      do {
        if runtime.settings.scenario == "gym-e2e-conflict" {
          try await GymConflictFixture.prepare(model: model)
          return
        }
        let identity: AuthIdentity
        if let path = runtime.settings.codeFile {
          let data = try Data(contentsOf: URL(fileURLWithPath: path))
          guard let values = try JSONSerialization.jsonObject(with: data) as? [String: String],
                let account = values["account"], let token = values["token"], let email = values["email"] else {
            throw AppFailure(message: "The Gym verification session is unreadable.")
          }
          identity = AuthIdentity(account: account, token: SessionToken(token), name: "Gym QA", email: email)
        } else if let fake = runtime.auth.fake { identity = fake.identity(email: "gym-e2e@example.com") }
        else { throw AppFailure(message: "The Gym verification session is unavailable.") }
        try await model.signIn(identity)
      } catch { model.error = error.localizedDescription }
      return
    }
    guard let runtime = model.runtime, let report = runtime.settings.report else { return }
    var steps: [String] = []
    do {
      model.openJournal(); model.journal.type("A page written before signing in."); guard model.journal.save() else { throw AppFailure(message: "anonymous save failed") }
      model.journal.done(); model.journal.dismissScales(); guard model.journal.keepDue else { throw AppFailure(message: "Keep not due") }; steps.append("anonymous-writing")
      model.keep(); steps.append("keep"); model.email = "journal-e2e@example.com"
      if runtime.settings.codeFile == nil { await model.sendCode() } else { model.sheet = .code }
      if let path = runtime.settings.codeFile { model.code = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }
      else { model.code = "482913" }
      await model.verifyCode(); if model.sheet == .adoption { await model.adopt(.add) }
      try await backedUp(model); let expectedPage = model.journal.document.body; steps.append("email-sign-in-backed-up")
      let account = try runtime.account() ?? ""
      let replica = try runtime.store.read { try $0.device().activeReplica.meta.replica }
      if runtime.settings.codeFile != nil {
        try await checkpoint(report, pending: "revoke-session", values: ["account": account], steps: steps)
      } else if let token = runtime.tokens.token(for: account) {
        try await runtime.auth.logout(token: token)
      }
      await runtime.engine.start()
      for _ in 0..<200 {
        if model.authPaused { break }
        try await Task.sleep(for: .milliseconds(100))
      }
      guard model.authPaused else { throw AppFailure(message: "revoked session did not pause backup") }
      steps.append("session-revoked-backup-paused")
      model.sheet = .you
      if runtime.settings.codeFile == nil { model.codeSentAt = nil; await model.sendCode() }
      else { model.sheet = .code }
      model.code = try runtime.settings.codeFile.map { try String(contentsOfFile: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) } ?? "482913"
      await model.verifyCode(); try await backedUp(model)
      guard !model.authPaused, try runtime.store.read({ try $0.device().activeReplica.meta.replica }) == replica else {
        throw AppFailure(message: "reauthentication changed replica lineage")
      }
      steps.append("same-account-reauthenticated-backed-up")
      let signingOutToken = runtime.tokens.token(for: account)?.value ?? ""
      await model.beginSignOut(); await model.finishSignOut(.keep)
      guard model.account == nil else { throw AppFailure(message: "sign-out failed") }; steps.append("sign-out-keep")
      if runtime.settings.codeFile != nil {
        try await checkpoint(report, pending: "signed-out", values: ["account": account, "revokedToken": signingOutToken], steps: steps)
        model.sheet = .code
      } else { model.codeSentAt = nil; await model.sendCode() }
      model.code = try runtime.settings.codeFile.map { try String(contentsOfFile: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) } ?? "482913"
      await model.verifyCode(); try await backedUp(model); steps.append("sign-in-again-backed-up")
      guard !expectedPage.isEmpty && model.journal.document.body == expectedPage else { throw AppFailure(message: "restored page differs from the backed-up page") }
      if runtime.settings.scenario == "telemetry-first-run" {
        model.codeSentAt = nil
        await model.sendCode()
        if model.error != nil { steps.append("forced-handled-auth-failure") }
      }
      try JSONSerialization.data(withJSONObject: ["ok": true, "steps": steps]).write(to: URL(fileURLWithPath: report))
    } catch {
      try? JSONSerialization.data(withJSONObject: ["ok": false, "steps": steps, "error": error.localizedDescription]).write(to: URL(fileURLWithPath: report))
    }
    #endif
  }
  static func checkpoint(_ report: String, pending: String, values: [String: String], steps: [String]) async throws {
    var payload: [String: Any] = values
    payload["ok"] = false; payload["pending"] = pending; payload["steps"] = steps
    try JSONSerialization.data(withJSONObject: payload).write(to: URL(fileURLWithPath: report), options: .atomic)
    for _ in 0..<600 {
      if (try? String(contentsOfFile: report + ".ready", encoding: .utf8)) == pending { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw AppFailure(message: "local server checkpoint timed out: \(pending)")
  }
  static func backedUp(_ model: AppModel) async throws {
    for _ in 0..<200 {
      model.refresh(); if model.journal.backup == "backed up" { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw AppFailure(message: "backup did not confirm: \(model.error ?? model.journal.backup)")
  }
}

#if DEBUG && targetEnvironment(simulator)
enum GymConflictFixture {
  static let email = "gym-conflict@example.com"
  static let workout = ID<Session>("ci-conflict-account-workout")
  static let set = ID<TrainingSet>("ci-conflict-account-set")
  static var prepared = false

  static func prepare(model: AppModel) async throws {
    prepared = false
    guard let server = model.runtime?.auth.fake else { throw AppFailure(message: "The conflict model server is missing.") }
    let now = server.now, startedAt = Instant(ms: now - 60_000), completedAt = Instant(ms: now - 30_000)
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server"]),
      directory: directory, service: UUID().uuidString, syncTransport: server)
    let identity = server.identity(email: email)
    defer { try? remote.tokens.delete(for: identity.account) }
    _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
    guard try remote.runner.run(StartSession(id: workout, startedAt: startedAt)).refusal == nil,
          try remote.runner.run(AppendSet(TrainingSet(id: set, sessionId: workout, exerciseId: ID("barbell-row"),
            weightKg: 35, reps: 11, completedAt: completedAt))).refusal == nil else {
      throw AppFailure(message: "The account workout could not be prepared.")
    }
    try remote.engine.leave(); await remote.engine.flushOnLeave()
    let confirmed = server.state.withLock { state in
      let rows = state.server.state.rows[ScopeKey(.product(account: identity.account, name: "gym"))] ?? [:]
      return !state.persistenceFailed && rows[RecordKey(Session.type, workout.record)]?.lattice.fields["startedAt"]?.value == .of(startedAt)
        && rows[RecordKey(TrainingSet.type, set.record)]?.lattice.fields["completedAt"]?.value == .of(completedAt)
    }
    guard confirmed else { throw AppFailure(message: "The account workout did not reach its persistent model server.") }
    prepared = true
  }

  static func snapshot(model: AppModel) -> JSON {
    guard let server = model.runtime?.auth.fake else { return ["error": "The conflict model server is missing."] }
    return server.state.withLock { state in
      if state.persistenceFailed { return ["error": "The conflict model server could not save its snapshot."] }
      if let error = model.error { return ["error": .string(error)] }
      let accountRows = state.server.state.rows[ScopeKey(.product(account: "model-" + email, name: "gym"))] ?? [:]
      guard prepared || model.runtime?.settings.restoreBoard == true,
            let startedAt = try? accountRows[RecordKey(Session.type, workout.record)]?.lattice.fields["startedAt"]?.value.asInteger(),
            let completedAt = try? accountRows[RecordKey(TrainingSet.type, set.record)]?.lattice.fields["completedAt"]?.value.asInteger() else {
        return ["ready": false]
      }
      let rows = accountRows.values.filter(\.isAlive)
      func fields(_ row: Row) -> JSON {
        var values = JSON.Object(uniqueKeysWithValues: row.lattice.fields.filter { !$0.value.value.isNull }.map { ($0.key, $0.value.value) })
        values["id"] = row.key.id.json
        return .object(values)
      }
      let sessions = rows.filter { $0.key.type == Session.type }.sorted { $0.key.id < $1.key.id }.map { session -> JSON in
        let sets = rows.filter { $0.key.type == TrainingSet.type && $0.lattice.fields["sessionId"]?.value == session.key.id.json }
        return ["session": fields(session), "sets": .array(sets.sorted { $0.key.id < $1.key.id }.map(fields))]
      }
      return ["ready": true,
        "identity": ["email": .string(email), "openSession": workout.json, "openSet": set.json,
        "openStartedAt": .string(String(startedAt)), "openCompletedAt": .string(String(completedAt))], "sessions": .array(sessions)]
    }
  }
}

struct GymConflictFixtureStatus: UIViewRepresentable {
  let model: AppModel
  func makeUIView(context: Context) -> StatusView {
    let view = StatusView()
    view.isAccessibilityElement = true
    view.accessibilityIdentifier = "gym-conflict-server"
    view.accessibilityLabel = "Confirmed conflict workouts"
    view.model = model
    return view
  }
  func updateUIView(_ view: StatusView, context: Context) { view.model = model }
  final class StatusView: UIView {
    weak var model: AppModel?
    override var accessibilityValue: String? {
      get { model.map { GymConflictFixture.snapshot(model: $0).jcsText } }
      set { super.accessibilityValue = newValue }
    }
  }
}
#endif
