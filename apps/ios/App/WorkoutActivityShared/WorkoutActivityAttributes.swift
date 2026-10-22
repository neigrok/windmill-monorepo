import ActivityKit
import Foundation

// The one working set the lock screen may log: the rack as the phone last drew it, under the set id it will carry.
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
    let staleAt: Date
    let unsentSetCount: Int
    let offer: WorkoutActivityOffer?

    // The set's place: *Set 2 of 4* within the plan, *Set 5* past it or without one, and none before a movement is chosen.
    var place: String? {
      guard !movement.isEmpty else { return nil }
      let planned = plannedWorkingSetCount.flatMap { $0 >= workingSetOrdinal ? $0 : nil }
      return planned.map { "Set \(workingSetOrdinal) of \($0)" } ?? "Set \(workingSetOrdinal)"
    }
  }
}

// An Activity the previous build started keeps drawing across an update: its state named this count `unsyncedSetCount`.
nonisolated extension WorkoutActivityAttributes.ContentState {
  enum PreviousKeys: CodingKey { case unsyncedSetCount }

  init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    title = try values.decode(String.self, forKey: .title)
    movement = try values.decode(String.self, forKey: .movement)
    load = try values.decode(String.self, forKey: .load)
    reps = try values.decode(Int.self, forKey: .reps)
    workingSetOrdinal = try values.decode(Int.self, forKey: .workingSetOrdinal)
    plannedWorkingSetCount = try values.decodeIfPresent(Int.self, forKey: .plannedWorkingSetCount)
    startedAt = try values.decode(Date.self, forKey: .startedAt)
    lastSetAt = try values.decodeIfPresent(Date.self, forKey: .lastSetAt)
    staleAt = try values.decode(Date.self, forKey: .staleAt)
    offer = try values.decodeIfPresent(WorkoutActivityOffer.self, forKey: .offer)
    let previous = try decoder.container(keyedBy: PreviousKeys.self)
    unsentSetCount = try values.decodeIfPresent(Int.self, forKey: .unsentSetCount)
      ?? previous.decodeIfPresent(Int.self, forKey: .unsyncedSetCount) ?? 0
  }
}
