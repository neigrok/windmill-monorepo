import SyncCore

public enum GymUnits: String, CaseIterable, Sendable {
  case kg, lb

  public static let kilogramsPerPound = 0.45359237

  public init(reading value: String?) { self = value == "lb" ? .lb : .kg }

  public func display(_ kilograms: Double) -> Double {
    self == .lb ? Quantum(0.1)!.rounded(kilograms / Self.kilogramsPerPound) : kilograms
  }

  public func kilograms(from displayed: Double) -> Double {
    Quantum(0.01)!.rounded(self == .lb ? displayed * Self.kilogramsPerPound : displayed)
  }
}

public enum WeightLadder {
  public struct Steps: Equatable, Sendable {
    public let small: Double
    public let large: Double
  }

  public static func steps(magnitude: Double, lightening: Bool = false) -> Steps {
    if lightening ? magnitude <= 20 : magnitude < 20 { return Steps(small: 1, large: 2.5) }
    if lightening ? magnitude <= 50 : magnitude < 50 { return Steps(small: 2.5, large: 5) }
    return Steps(small: 2.5, large: 10)
  }

  public static func round(_ weight: Double) -> Double { Quantum(0.01)!.rounded(weight) }

  public static func onGrid(_ weight: Double) -> Double {
    let step = steps(magnitude: abs(weight)).small
    let magnitude = (abs(weight) / step).rounded(.toNearestOrAwayFromZero) * step
    return round(weight < 0 ? -magnitude : magnitude)
  }

  public static func bump(_ weight: Double, direction: Int, big: Bool = false) -> Double {
    let step = steps(magnitude: abs(weight), lightening: Double(direction) * weight < 0)
    return round(weight + Double(direction) * (big ? step.large : step.small))
  }

  public static func labels(_ weight: Double) -> [String] {
    let down = steps(magnitude: abs(weight), lightening: weight > 0)
    let up = steps(magnitude: abs(weight), lightening: weight < 0)
    return ["−\(Readout.weight(down.large))", "−\(Readout.weight(down.small))", "+\(Readout.weight(up.small))", "+\(Readout.weight(up.large))"]
  }

  public static func bumpReps(_ reps: Int, direction: Int) -> Int {
    if direction < 0 { return reps <= 1 ? 1 : reps - 1 }
    return reps == Int.max ? reps : max(1, reps + 1)
  }
}

public typealias Ladder = WeightLadder
