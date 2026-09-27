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
  case readerEnded
  case notAScope(ScopeRef)
  case notInScope(type: String, scope: ScopeRef)
  case mintsNoIDs(type: String)
  case notSignedIn

  public var description: String {
    switch self {
    case .readerEnded: "a reader serves only inside the call that passed it"
    case .notAScope(let scope): "\(scope) is no product, tree or overlay scope of the registry"
    case .notInScope(let type, let scope): "\(type) is no type of \(scope)"
    case .mintsNoIDs(let type): "\(type) mints no ids"
    case .notSignedIn: "no account is signed in on this device"
    }
  }
}
