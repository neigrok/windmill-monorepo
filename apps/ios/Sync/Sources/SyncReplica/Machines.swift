// §8 the state machines as data: every outbox and replica state change goes through a table, so a move the table
// lacks throws.

public struct TransitionError: Error, Hashable, CustomStringConvertible {
  public let description: String
}

// A table of rows `(from, event, to)`; `from` nil is a thing not yet created.
public struct StateMachine<From: Hashable & Sendable, Event: RawRepresentable & Hashable & Sendable, To: Hashable & Sendable>: Sendable
where Event.RawValue == String {
  let rows: [(from: [From?], event: Event, to: [To])]

  // The node `event` moves a thing to from `from`: `to` if the table allows it, else the table's first target.
  public func transition(from: From?, _ event: Event, to target: To? = nil) throws(TransitionError) -> To {
    let origin = from.map { "\($0)" } ?? "none"
    guard let row = rows.first(where: { $0.event == event && $0.from.contains(from) }) else {
      throw TransitionError(description: "no \(event.rawValue) from \(origin)")
    }
    let next = target ?? row.to[0]
    guard row.to.contains(next) else { throw TransitionError(description: "\(event.rawValue) from \(origin) cannot reach \(next)") }
    return next
  }
}

// MARK: - Intents (§8.1)

public enum EntryState: String, Sendable, Hashable, CaseIterable {
  case held, ready, sent, acked
}

// D-15 the terminal outcomes; an entry that reaches one leaves the outbox.
public enum Outcome: String, Sendable, Hashable, CaseIterable {
  case undone, resolved, refused, discarded
}

// Where an intent can be: an outbox state, or a terminal outcome.
public enum IntentNode: Sendable, Hashable, CustomStringConvertible {
  case state(EntryState)
  case ended(Outcome)

  public init?(rawValue: String) {
    if let state = EntryState(rawValue: rawValue) {
      self = .state(state)
    } else if let outcome = Outcome(rawValue: rawValue) {
      self = .ended(outcome)
    } else {
      return nil
    }
  }

  public var description: String {
    switch self {
    case .state(let state): state.rawValue
    case .ended(let outcome): outcome.rawValue
    }
  }
}

// The events of §8.1's rows, named as `machine/intent.json` names them.
public enum IntentEvent: String, Sendable, Hashable, CaseIterable {
  case commit, release, undo, retire
  case silentFold = "silent-fold"
  case number, outgrown, fold
  case targetMerged = "target-merged"
  case ok, recover, refuse
  case transport, reidentify
  case skewReturn = "skew-return"
  case rewind, resolve, epoch, discard
}

// MARK: - Replicas (§8.2)

public enum ReplicaNode: String, Sendable, Hashable, CaseIterable {
  case anon, bound, dormant, deleted
}

public enum ReplicaEvent: String, Sendable, Hashable, CaseIterable {
  case firstLaunch = "first-launch"
  case signIn = "sign-in"
  case signOutKeep = "sign-out-keep"
  case signOutDiscard = "sign-out-discard"
  case discard, reidentify
}

public enum Machines {
  public static let intent = StateMachine<EntryState, IntentEvent, IntentNode>(rows: [
    ([nil], .commit, [.state(.held), .state(.ready)]),
    ([.held], .release, [.state(.ready)]),
    ([.held], .undo, [.ended(.undone)]),
    ([.held], .retire, [.ended(.undone)]),
    ([.ready], .number, [.state(.sent)]),
    ([.ready], .outgrown, [.ended(.refused)]),
    ([.held, .ready], .silentFold, [.ended(.undone)]),
    ([.held, .ready], .fold, [.ended(.refused)]),
    ([.held, .ready], .targetMerged, [.ended(.refused)]),
    ([.sent], .ok, [.state(.acked)]),
    ([.sent], .recover, [.state(.ready)]),
    ([.sent], .refuse, [.ended(.refused)]),
    ([.sent], .transport, [.state(.sent)]),
    ([.sent], .reidentify, [.state(.ready)]),
    ([.sent], .skewReturn, [.state(.ready)]),
    ([.sent], .rewind, [.state(.ready)]),
    ([.acked], .resolve, [.ended(.resolved)]),
    ([.acked], .epoch, [.state(.ready)]),
    ([.held, .ready, .sent, .acked], .discard, [.ended(.discarded)]),
  ])

  public static let replica = StateMachine<ReplicaNode, ReplicaEvent, ReplicaNode>(rows: [
    ([nil], .firstLaunch, [.anon]),
    ([nil], .signIn, [.bound]),
    ([.dormant], .signIn, [.bound, .dormant]),
    ([.anon], .signIn, [.bound, .deleted, .anon]),
    ([.bound], .signOutKeep, [.dormant]),
    ([.bound], .signOutDiscard, [.deleted]),
    ([.dormant], .discard, [.deleted]),
    ([.anon], .reidentify, [.anon]),
    ([.bound], .reidentify, [.bound]),
    ([.dormant], .reidentify, [.dormant]),
  ])
}
