import SyncCore

// The engine-only public types. The values products share live in SyncAPI.

public struct EngineConfig: Sendable {
  public var appVersion: String
  public var surface: Surface
  public var drivesLoops: Bool

  // `surface`: the products a bound replica subscribes are those whose registry `surfaces` include it (§7.9).
  // `drivesLoops` false builds the loops without starting them, for step-mode tests and the simulator.
  public init(appVersion: String, surface: Surface, drivesLoops: Bool = true) {
    self.appVersion = appVersion
    self.surface = surface
    self.drivesLoops = drivesLoops
  }
}

public enum EngineError: Error, Hashable, CustomStringConvertible {
  case notSignedIn

  public var description: String {
    switch self {
    case .notSignedIn: "no account is signed in on this device"
    }
  }
}

// An error a commit's body threw of its own, carried out of the transaction to its caller unchanged.
struct BodyError: Error {
  let error: any Error
}
