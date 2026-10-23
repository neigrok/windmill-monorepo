import Foundation
import SwiftUI

// Simulator fixtures for the shell go through the launch policy, the journal actions and the real sign-in door.
enum OnboardingFixture {
  static func prepare(_ board: String, model: AppModel) -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("onboarding-") else { return false }
    model.welcome = true
    return true
    #else
    return false
    #endif
  }
  static var appearance: ColorScheme? {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    if let index = arguments.firstIndex(of: "-onboarding-appearance"), arguments.count > index + 1 {
      return arguments[index + 1] == "dark" ? .dark : arguments[index + 1] == "light" ? .light : nil
    }
    #endif
    return nil
  }
}

enum ShellFixture {
  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard ["keep-gym", "update-required", "update-sign-in"].contains(board), let runtime = model.runtime, let server = runtime.auth.fake else { return false }
    if board == "keep-gym" { model.openRoom(.gym); model.keep(); return true }
    if board == "update-required" { try? await model.signIn(server.identity(email: "update@example.com")) }
    model.openJournal(); model.journal.type("A page on this phone."); model.journal.done(); model.journal.dismissScales()
    server.state.withLock { $0.upgradeRequired = true }
    if board == "update-required" { await runtime.engine.start() } else { model.keep() }
    return true
    #else
    return false
    #endif
  }
}
