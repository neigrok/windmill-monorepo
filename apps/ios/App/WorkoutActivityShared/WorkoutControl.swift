import Foundation

// What the workout control draws (Figma Gym · iOS 04.1), as the app last published it.
nonisolated enum WorkoutControlState: Codable, Hashable, Sendable {
  case logSet(WorkoutControlOffer, staleAt: Date)
  case openWorkout(staleAt: Date)
  case startWorkout

  static let kind = "works.windmill.app.workout"

  // A workout idle past its four hours is closed, so the control reads one as no workout open.
  func drawn(at now: Date) -> WorkoutControlState {
    switch self {
    case .logSet(_, let staleAt), .openWorkout(let staleAt): now < staleAt ? self : .startWorkout
    case .startWorkout: self
    }
  }

  var symbol: String {
    guard case .logSet = self else { return "dumbbell.fill" }
    return "plus"
  }
  var title: String {
    switch self {
    case .logSet: "Log set"
    case .openWorkout: "Open workout"
    case .startWorkout: "Start workout"
    }
  }
  var offer: WorkoutControlOffer? {
    guard case .logSet(let offer, _) = self else { return nil }
    return offer
  }
  var actionHint: String { offer.map { "Log \($0.value)" } ?? title }
}

// The rack's set as the control offers it: the offer it logs, and its numbers as the rack draws them.
nonisolated struct WorkoutControlOffer: Codable, Hashable, Sendable {
  let offer: WorkoutActivityOffer
  let value: String
}

// The App Group file the app writes the control's state to and the widget extension reads it from.
nonisolated struct WorkoutControlBoard: Sendable {
  static let group = "group.works.windmill.app"
  let url: URL

  init(url: URL) { self.url = url }
  init?() {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else { return nil }
    url = container.appending(path: "workout-control.json")
  }

  func read() -> WorkoutControlState {
    (try? JSONDecoder().decode(WorkoutControlState.self, from: Data(contentsOf: url))) ?? .startWorkout
  }
  func write(_ state: WorkoutControlState) throws {
    try JSONEncoder().encode(state).write(to: url, options: .atomic)
  }
}
