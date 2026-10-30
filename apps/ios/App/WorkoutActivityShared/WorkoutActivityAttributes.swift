import ActivityKit
import Foundation

// The one set the lock screen may log: the rack as the phone last drew it, under the set id it will carry.
nonisolated struct WorkoutActivityOffer: Codable, Hashable, Sendable {
  let ownerID: String
  let sessionID: String
  let movementID: String
  let weightKg: Double
  let reps: Int
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
    let workingSetOrdinal: Int
    let plannedWorkingSetCount: Int?
    let startedAt: Date
    let lastSetAt: Date?
    // The rest the selected movement asks, in seconds; none when it asks none, or the Activity began before the build drew it.
    let restSeconds: Int?
    let staleAt: Date
    let offer: WorkoutActivityOffer?
    // The offer's numbers as the control reads them, *100 × 5*; none without an offer, or from a build before the Island drew them.
    let effort: String?

    // The set's place: *Set 2 of 4* within the plan, *Set 5* past it or without one, and none before a movement is chosen.
    var place: String? {
      guard !movement.isEmpty else { return nil }
      let planned = plannedWorkingSetCount.flatMap { $0 >= workingSetOrdinal ? $0 : nil }
      return planned.map { "Set \(workingSetOrdinal) of \($0)" } ?? "Set \(workingSetOrdinal)"
    }

    // The rest target as the app's facts row writes it, *2:00*; none without one.
    var restReading: String? { restSeconds.map { "\($0 / 60):" + String(format: "%02d", $0 % 60) } }
  }
}
