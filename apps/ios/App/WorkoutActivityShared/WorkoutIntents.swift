import AppIntents
import Foundation
#if !WORKOUT_ACTIVITY_WIDGET
import UIKit
#endif

// Where a workout act outside the app came from (docs/design/ios/ios-redesign.md §7.19); each one runs in the app.
nonisolated enum WorkoutSurface: String, Sendable { case activity, control, shortcut }

// What an act outside the app answers: Siri's words, or none, and the app brought forward when it opens.
typealias WorkoutAnswer = IntentResultContainer<Never, Never, Never, IntentDialog>

struct WorkoutLogSetIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Log set"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let isDiscoverable = false
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

  @Parameter(title: "Owner") var ownerID: String
  @Parameter(title: "Workout") var sessionID: String
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

  // The one Log set outside the app: the Live Activity's or the control's offer, or, from the shortcut, the rack's.
  static func log(_ offer: WorkoutActivityOffer?, surface: WorkoutSurface) async -> WorkoutAnswer {
    #if WORKOUT_ACTIVITY_WIDGET
    return .result(dialog: "")
    #else
    let answer = await WorkoutActivityIntentHandler.logSet(offer: offer, surface: surface)
    let words = answer.dialog(surface), dialog = IntentDialog(full: "\(words.spoken)", supporting: "\(words.shown)")
    guard answer == .opened else { return .result(dialog: dialog) }
    return await WorkoutOpenIntent.bringForward(saying: dialog)
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

  static func bringForward(saying dialog: IntentDialog = "") async -> WorkoutAnswer {
    #if !WORKOUT_ACTIVITY_WIDGET
    if #available(iOS 18.2, *) { return .result(opensIntent: WorkoutOpenIntent(), dialog: dialog) }
    await MainActor.run {
      UIApplication.shared.open(WorkoutActivityAttributes.workoutURL, options: [:], completionHandler: nil)
    }
    #endif
    return .result(dialog: dialog)
  }
}

// The control's one button. A control draws one intent type, so its tap carries the offer it drew, or none.
struct WorkoutControlIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Workout"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let isDiscoverable = false
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

  @Parameter(title: "Owner") var ownerID: String?
  @Parameter(title: "Workout") var sessionID: String?
  @Parameter(title: "Movement") var movementID: String?
  @Parameter(title: "Load") var weightKg: Double?
  @Parameter(title: "Repetitions") var reps: Int?
  @Parameter(title: "Set") var setID: String?

  init() {}
  init(_ state: WorkoutControlState) {
    guard let offer = state.offer?.offer else { return }
    ownerID = offer.ownerID
    sessionID = offer.sessionID
    movementID = offer.movementID
    weightKg = offer.weightKg
    reps = offer.reps
    setID = offer.setID
  }

  // Log set logs the drawn offer as the Live Activity's button does; Open and Start take Start workout's door.
  func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
    if let ownerID, let sessionID, let movementID, let weightKg, let reps, let setID {
      let offer = WorkoutActivityOffer(ownerID: ownerID, sessionID: sessionID, movementID: movementID, weightKg: weightKg, reps: reps, setID: setID)
      return await WorkoutLogSetIntent.log(offer, surface: .control)
    }
    #if !WORKOUT_ACTIVITY_WIDGET
    await WorkoutActivityIntentHandler.open(.routines, surface: .control)
    #endif
    return await WorkoutOpenIntent.bringForward()
  }
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
  static let shortcutTileColor = ShortcutTileColor.teal
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
