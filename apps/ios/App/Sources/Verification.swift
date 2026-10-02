import Foundation
import DomainKit
import JournalDomain

// Launch fixtures use the same actions, persistence and sign-in door as the app.
enum BoardFixture {
  static let prose = "Long day. The walk home was the best part — the rain had just stopped and the street smelled of it.\nI want more evenings like that."
  static let shortProse = "Long day. The walk home was the best part — the rain had just stopped and the street smelled of it."
  static func prepare(_ board: String, model: JournalModel) async {
    #if DEBUG && targetEnvironment(simulator)
    model.preferences.removePersistentDomain(forName: "board-\(board)")
    model.keepDismissed = false
    model.welcome = board.hasPrefix("01") || board.hasPrefix("02")
    guard !model.welcome else { return }
    model.preferences.set(true, forKey: "journalOpened")
    if board.hasPrefix("05") || board.contains("a1-") || board.contains("a5-") || board.contains("a6-") || board.contains("a2-") {
      model.inkVisible = !board.hasPrefix("05")
      model.preferences.set(true, forKey: "inkShown")
      if board.contains("a2-") {
        Task { @MainActor [weak model] in
          try? await Task.sleep(for: .milliseconds(2200))
          model?.type("Long d")
        }
      }
      return
    }
    model.type(board.hasPrefix("21") || board.contains("a4-") ? shortProse : prose)
    model.save(); model.done()
    if !board.hasPrefix("07-journal") && !board.hasPrefix("06") && !board.contains("a3-") {
      model.setScale("mood", 7); model.setScale("energy", 4)
    }
    if board.hasPrefix("21") || board.contains("a4-") {
      model.keepDismissed = true; model.roomMenu = true; model.document.mood = nil; model.document.energy = nil
    }
    if board.hasPrefix("07b") || board.hasPrefix("21b") {
      if let identity = try? model.runtime?.auth.fakeApple() { try? await model.signIn(identity) }
      await model.runtime?.engine.start()
      for _ in 0..<30 {
        model.refresh()
        if model.backup == "backed up" { break }
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
    if board.hasPrefix("15") {
      model.email = "you@example.com"; model.codeSentAt = Date(); model.sheet = .code
    }
    if board.hasPrefix("06") || board.contains("a3-") { model.editing = true }
    #endif
  }
}

enum AppScenario {
  static func run(model: JournalModel) async {
    #if DEBUG && targetEnvironment(simulator)
    guard let runtime = model.runtime, let report = runtime.settings.report else { return }
    var steps: [String] = []
    do {
      model.openJournal(); model.type("A page written before signing in."); guard model.save() else { throw AppFailure(message: "anonymous save failed") }
      model.done(); model.dismissScales(); guard model.keepDue else { throw AppFailure(message: "Keep not due") }; steps.append("anonymous-writing")
      model.keep(); steps.append("keep"); model.email = "journal-e2e@example.com"
      if runtime.settings.codeFile == nil { await model.sendCode() } else { model.sheet = .code }
      if let path = runtime.settings.codeFile { model.code = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }
      else { model.code = "482913" }
      await model.verifyCode(); if model.sheet == .adoption { await model.adopt(.add) }
      try await backedUp(model); let expectedPage = model.document.body; steps.append("email-sign-in-backed-up")
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
      guard !expectedPage.isEmpty && model.document.body == expectedPage else { throw AppFailure(message: "restored page differs from the backed-up page") }
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
  static func backedUp(_ model: JournalModel) async throws {
    for _ in 0..<200 {
      model.refresh(); if model.backup == "backed up" { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw AppFailure(message: "backup did not confirm: \(model.error ?? model.backup)")
  }
}
