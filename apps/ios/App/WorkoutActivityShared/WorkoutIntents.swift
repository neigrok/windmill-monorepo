import AppIntents
import Foundation
#if !WORKOUT_ACTIVITY_WIDGET
import UIKit
#endif

// Where a workout act outside the app came from (docs/design/ios/ios-redesign.md §7.19); each one runs in the app.
nonisolated enum WorkoutSurface: String, Sendable { case activity, shortcut }

struct WorkoutLogSetIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Log set"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let isDiscoverable = false
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

  @Parameter(title: "Owner") var ownerID: String
  @Parameter(title: "Session") var sessionID: String
  @Parameter(title: "Movement") var movementID: String
  @Parameter(title: "Load") var weightKg: Double
  @Parameter(title: "Repetitions") var reps: Int
  @Parameter(title: "Set") var setID: String

  init() {}
  init(offer: WorkoutActivityOffer) {
    ownerID = offer.ownerID
    sessionID = offer.sessionID
    movementID = offer.movementID
    weightKg = offer.weightKg
    reps = offer.reps
    setID = offer.setID
  }

  func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
    await Self.log(WorkoutActivityOffer(ownerID: ownerID, sessionID: sessionID, movementID: movementID,
                                        weightKg: weightKg, reps: reps, setID: setID), surface: .activity)
  }

  // The one Log set outside the app: the Live Activity's offer, or, from the shortcut, the rack's.
  static func log(_ offer: WorkoutActivityOffer?, surface: WorkoutSurface) async -> some IntentResult & ProvidesDialog & OpensIntent {
    #if WORKOUT_ACTIVITY_WIDGET
    return .result(dialog: "")
    #else
    switch await WorkoutActivityIntentHandler.logSet(offer: offer, surface: surface) {
    case .logged(let shown, let spoken):
      return .result(dialog: surface == .shortcut ? IntentDialog(full: "\(spoken)", supporting: "\(shown)") : "")
    case .absent:
      return .result(dialog: "No workout is open.")
    case .opened:
      if #available(iOS 18.2, *) { return .result(opensIntent: WorkoutOpenIntent(), dialog: "") }
      await MainActor.run {
        UIApplication.shared.open(WorkoutActivityAttributes.workoutURL, options: [:], completionHandler: nil)
      }
      return .result(dialog: "")
    }
    #endif
  }
}

// The Log set shortcut. An App Shortcut's intent shows every parameter in Shortcuts, so this one has none.
struct WorkoutLogRackSetIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Log set"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

  func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
    await WorkoutLogSetIntent.log(nil, surface: .shortcut)
  }
}

// Brings Windmill forward on the door a background act already chose.
struct WorkoutOpenIntent: AppIntent {
  static let title: LocalizedStringResource = "Open workout"
  static let isDiscoverable = false
  @available(iOS, introduced: 18.0, deprecated: 26.0)
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }

  func perform() async throws -> some IntentResult { .result() }
}

// Routines at its root, or the logger while a workout is open. It starts nothing: a start is the lifter's choice.
struct WorkoutStartIntent: AppIntent {
  static let title: LocalizedStringResource = "Start workout"
  @available(iOS, introduced: 18.0, deprecated: 26.0)
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }

  func perform() async throws -> some IntentResult {
    #if !WORKOUT_ACTIVITY_WIDGET
    await WorkoutActivityIntentHandler.open(.routines, surface: .shortcut)
    #endif
    return .result()
  }
}

#if !WORKOUT_ACTIVITY_WIDGET
struct WorkoutShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: WorkoutLogRackSetIntent(), phrases: [
      "Log a set in \(.applicationName)", "Log my set in \(.applicationName)", "\(.applicationName) log set",
    ], shortTitle: "Log set", systemImageName: "plus")
    AppShortcut(intent: WorkoutStartIntent(), phrases: [
      "Start a workout in \(.applicationName)", "Start my workout in \(.applicationName)", "\(.applicationName) start workout",
    ], shortTitle: "Start workout", systemImageName: "dumbbell.fill")
  }
}
#endif
