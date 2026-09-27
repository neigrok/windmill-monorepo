import SyncCore
import SyncEngine
import Synchronization

// Wire doubles for component tests (design §6.8).

// Canned replies, one queue per call kind, each classified as `HTTPTransport` classifies a status and its body; and a
// log of every call with its token, in order. An unscripted call finds no network. A reply may wait behind a gate the
// test opens, so the test can act while a push is in flight.
public final class ScriptedTransport: SyncTransport {
  public enum Call: Sendable, Hashable {
    case hello(token: SessionToken?)
    case push(PushRequest, token: SessionToken)
    case pull(PullRequest, token: SessionToken?)
  }

  struct Scripted<Body: Sendable>: Sendable {
    let reply: Reply<Body>
    let gate: Gate?
  }

  struct State {
    var hellos: [Scripted<HelloResponse>] = []
    var pushes: [Scripted<PushResponse>] = []
    var pulls: [Scripted<PullResponse>] = []
    var calls: [Call] = []
    var inFlight = 0
    var mostInFlight = 0
  }

  let state = Mutex(State())

  public init() {}

  // MARK: Scripting

  // `body` nil: a response with no JSON body; a 200 without one finds no network.
  public func willAnswerHello(_ status: Int, _ body: JSON? = nil, after gate: Gate? = nil) {
    state.withLock { $0.hellos.append(Scripted(reply: Reply(status: status, body: body), gate: gate)) }
  }

  public func willAnswerPush(_ status: Int, _ body: JSON? = nil, after gate: Gate? = nil) {
    state.withLock { $0.pushes.append(Scripted(reply: Reply(status: status, body: body), gate: gate)) }
  }

  public func willDropPush(after gate: Gate? = nil) {
    state.withLock { $0.pushes.append(Scripted(reply: .unreachable, gate: gate)) }
  }

  public func willAnswerPull(_ status: Int, _ body: JSON? = nil, after gate: Gate? = nil) {
    state.withLock { $0.pulls.append(Scripted(reply: Reply(status: status, body: body), gate: gate)) }
  }

  // MARK: What was sent

  public var calls: [Call] { state.withLock(\.calls) }

  public var pushes: [PushRequest] {
    calls.compactMap { if case .push(let request, _) = $0 { request } else { nil } }
  }

  // The most pushes that were ever in flight at once.
  public var mostPushesInFlight: Int { state.withLock(\.mostInFlight) }

  // Replies scripted and not yet taken.
  public var unansweredPushes: Int { state.withLock(\.pushes.count) }

  // MARK: SyncTransport

  public func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    let scripted = state.withLock { state in
      state.calls.append(.hello(token: token))
      return state.hellos.isEmpty ? nil : state.hellos.removeFirst()
    }
    return await answer(scripted)
  }

  public func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    let scripted = state.withLock { state in
      state.calls.append(.push(request, token: token))
      state.inFlight += 1
      state.mostInFlight = max(state.mostInFlight, state.inFlight)
      return state.pushes.isEmpty ? nil : state.pushes.removeFirst()
    }
    let reply = await answer(scripted)
    state.withLock { $0.inFlight -= 1 }
    return reply
  }

  public func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    let scripted = state.withLock { state in
      state.calls.append(.pull(request, token: token))
      return state.pulls.isEmpty ? nil : state.pulls.removeFirst()
    }
    return await answer(scripted)
  }

  func answer<Body>(_ scripted: Scripted<Body>?) async -> Reply<Body> {
    guard let scripted else { return .unreachable }
    await scripted.gate?.pass()
    return scripted.reply
  }
}

// A reply held until the test opens it; `reached` says whether a call waits at it.
public final class Gate: Sendable {
  struct State {
    var open = false
    var reached = false
    var waiters: [CheckedContinuation<Void, Never>] = []
  }

  let state = Mutex(State())

  public init() {}

  public var reached: Bool { state.withLock(\.reached) }

  public func open() {
    let waiters = state.withLock { state in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume() }
  }

  func pass() async {
    await withCheckedContinuation { continuation in
      let open = state.withLock { state -> Bool in
        state.reached = true
        if !state.open { state.waiters.append(continuation) }
        return state.open
      }
      if open { continuation.resume() }
    }
  }
}
