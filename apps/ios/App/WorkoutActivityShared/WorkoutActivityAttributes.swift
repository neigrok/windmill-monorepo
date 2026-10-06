import ActivityKit
import AppIntents
import Foundation
#if !WORKOUT_ACTIVITY_WIDGET
import UIKit
#endif

nonisolated struct WorkoutActivityOffer: Codable, Hashable, Sendable {
  let ownerID: String
  let sessionID: String
  let movementID: String
  let weightKg: Double
  let reps: Int
  let kind: String
  let setID: String
}

nonisolated struct WorkoutActivityAttributes: ActivityAttributes, Sendable {
  let sessionID: String
  static let workoutURL = URL(string: "windmill://workout")!

  nonisolated struct ContentState: Codable, Hashable, Sendable {
    let title: String
    let movement: String
    let load: String
    let reps: Int
    let setKind: String
    let workingSetOrdinal: Int
    let plannedWorkingSetCount: Int?
    let startedAt: Date
    let lastSetAt: Date?
    let staleAt: Date
    let unsyncedSetCount: Int
    let offer: WorkoutActivityOffer?
  }
}

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
  @Parameter(title: "Set kind") var kind: String
  @Parameter(title: "Set") var setID: String

  init() {}
  init(offer: WorkoutActivityOffer) {
    ownerID = offer.ownerID
    sessionID = offer.sessionID
    movementID = offer.movementID
    weightKg = offer.weightKg
    reps = offer.reps
    kind = offer.kind
    setID = offer.setID
  }

  func perform() async throws -> some IntentResult & OpensIntent {
    #if WORKOUT_ACTIVITY_WIDGET
    return .result()
    #else
    let offer = WorkoutActivityOffer(ownerID: ownerID, sessionID: sessionID, movementID: movementID,
                                     weightKg: weightKg, reps: reps, kind: kind, setID: setID)
    if await WorkoutActivityIntentHandler.logSet(offer: offer) { return .result() }
    if #available(iOS 18.2, *) { return .result(opensIntent: WorkoutOpenIntent()) }
    await MainActor.run {
      UIApplication.shared.open(WorkoutActivityAttributes.workoutURL, options: [:], completionHandler: nil)
    }
    return .result()
    #endif
  }
}

struct WorkoutOpenIntent: AppIntent {
  static let title: LocalizedStringResource = "Open workout"
  static let isDiscoverable = false
  @available(iOS, introduced: 18.0, deprecated: 26.0)
  static var openAppWhenRun: Bool { true }
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }

  func perform() async throws -> some IntentResult { .result() }
}
