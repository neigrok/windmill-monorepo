import Foundation
import SwiftUI

// Simulator fixtures go through the launch policy and journal actions.
enum OnboardingFixture {
  static func prepare(_ board: String, model: JournalModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("onboarding-") else { return false }
    model.preferences.removePersistentDomain(forName: "board-\(board)")
    model.welcome = true
    if board == "onboarding-room" {
      model.openJournal(); model.liftInk(); model.type("A page already on this phone."); model.save(); model.done(); model.dismissScales()
      model.preferences.removeObject(forKey: OnboardingLaunch.shownKey)
    }
    if board == "onboarding-signed-in", let identity = try? model.runtime?.auth.fakeApple() {
      try? await model.signIn(identity)
    }
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
