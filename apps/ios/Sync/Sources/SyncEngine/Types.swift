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

public enum EngineError: Error, Equatable, CustomStringConvertible {
  // Sign-out or re-authentication with no account signed in.
  case notSignedIn
  // A sign-in while another account is signed in: that account signs out first (§7.10 account change).
  case signedIn(account: String)
  // The server refused the sign-in's token, or a pending sign-in has none left: the app signs in again.
  case unauthenticated
  // The hello a sign-in needs got no answer: the sign-in stays pending, and resumes when it does.
  case unreachable
  // The server requires a newer app (§9.2 `minSchema`, a 426).
  case upgradeRequired
  // A due signed-out decision has no answer.
  case decisionMissing(product: String)
  // What the decisions counted changed since the person was asked: ask again from `resumeSignIn()`.
  case signInChanged
  // The sign-in was cancelled, completed, or replaced by another.
  case signInEnded
  // Discard would delete unsent work the sign-out's confirmation did not state: ask again from `signOut()`.
  case signOutChanged(ready: Int, sent: Int)
  // The sign-out finished, was cancelled, or another sign-out replaced it.
  case signOutEnded

  public var description: String {
    switch self {
    case .notSignedIn: "no account is signed in on this device"
    case .signedIn(let account): "\(account) is signed in on this device; sign it out first"
    case .unauthenticated: "the server did not accept the sign-in"
    case .unreachable: "the server could not be reached"
    case .upgradeRequired: "the server requires a newer app"
    case .decisionMissing(let product): "the signed-out decision for \(product) has no answer"
    case .signInChanged: "the work made signed out changed since the question was asked"
    case .signInEnded: "the sign-in was cancelled, completed or replaced"
    case .signOutChanged(let ready, let sent): "\(ready + sent) changes are unsent now, not the ones the confirmation stated"
    case .signOutEnded: "the sign-out finished, was cancelled or was replaced"
    }
  }

  // Accounts and products are the same only byte for byte (§9.1).
  public static func == (lhs: EngineError, rhs: EngineError) -> Bool {
    switch (lhs, rhs) {
    case (.signedIn(let a), .signedIn(let b)), (.decisionMissing(let a), .decisionMissing(let b)): a.utf8.elementsEqual(b.utf8)
    case (.signOutChanged(let a, let b), .signOutChanged(let c, let d)): (a, b) == (c, d)
    case (.notSignedIn, .notSignedIn), (.unauthenticated, .unauthenticated), (.unreachable, .unreachable),
         (.upgradeRequired, .upgradeRequired), (.signInChanged, .signInChanged), (.signInEnded, .signInEnded),
         (.signOutEnded, .signOutEnded):
      true
    default: false
    }
  }
}

// A replica an account left on this device at sign-out with Keep (§7.10): its unsent entries, which go on the account's
// next sign-in here. A sent entry may already have landed.
public struct DormantReplica: Sendable, Hashable {
  public let account: String
  public let ready: Int
  public let sent: Int

  public init(account: String, ready: Int, sent: Int) {
    self.account = account
    self.ready = ready
    self.sent = sent
  }

  public static func == (lhs: DormantReplica, rhs: DormantReplica) -> Bool {
    lhs.account.utf8.elementsEqual(rhs.account.utf8) && lhs.ready == rhs.ready && lhs.sent == rhs.sent
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(account.utf8))
    hasher.combine(ready)
    hasher.combine(sent)
  }
}

// An error a commit's body threw of its own, carried out of the transaction to its caller unchanged.
struct BodyError: Error {
  let error: any Error
}
