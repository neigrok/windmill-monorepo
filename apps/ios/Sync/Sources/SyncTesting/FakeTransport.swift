import SyncCore
import SyncEngine
import Synchronization

// Wire doubles (design §6.8): `ScriptedTransport` for component tests, `TranscriptTransport` for the corpus's
// transcripts, and `FakeLiveConnection`, the live socket each of them and `SimNetwork` hand out, whose server end the
// test or the network holds.

// MARK: - Scripted

// Canned replies, one queue per call kind, each classified as `HTTPTransport` classifies a status and its body; and a
// log of every call with its token, in order. An unscripted call finds no network. A reply may wait behind a gate the
// test opens, so the test can act while a call is in flight.
public final class ScriptedTransport: SyncTransport {
  public enum Call: Sendable, Hashable {
    case hello(token: SessionToken?)
    case push(PushRequest, token: SessionToken)
    case pull(PullRequest, token: SessionToken?)
    case openLive(token: SessionToken)
  }

  struct Scripted<Body: Sendable>: Sendable {
    let reply: Reply<Body>
    let gate: Gate?
  }

  struct State {
    var hellos: [Scripted<HelloResponse>] = []
    var pushes: [Scripted<PushResponse>] = []
    var pulls: [Scripted<PullResponse>] = []
    var sockets: [Scripted<any LiveConnection>] = []
    var calls: [Call] = []
    var pushesInFlight = 0
    var mostPushesInFlight = 0
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

  public func willDropPull(after gate: Gate? = nil) {
    state.withLock { $0.pulls.append(Scripted(reply: .unreachable, gate: gate)) }
  }

  public func willOpenLive(_ connection: any LiveConnection, after gate: Gate? = nil) {
    state.withLock { $0.sockets.append(Scripted(reply: .answered(.ok(connection)), gate: gate)) }
  }

  // The handshake answered with `status` and no socket.
  public func willRefuseLive(_ status: Int, after gate: Gate? = nil) {
    state.withLock { $0.sockets.append(Scripted(reply: .answered(.failed(HTTPFailure(status: status))), gate: gate)) }
  }

  // MARK: What was sent

  public var calls: [Call] { state.withLock(\.calls) }

  public var pushes: [PushRequest] {
    calls.compactMap { if case .push(let request, _) = $0 { request } else { nil } }
  }

  public var pulls: [PullRequest] {
    calls.compactMap { if case .pull(let request, _) = $0 { request } else { nil } }
  }

  // The most pushes that were ever in flight at once.
  public var mostPushesInFlight: Int { state.withLock(\.mostPushesInFlight) }

  // Replies scripted and not yet taken.
  public var unansweredPushes: Int { state.withLock(\.pushes.count) }

  // MARK: SyncTransport

  public func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    await answer(.hello(token: token), \.hellos)
  }

  public func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    state.withLock { state in
      state.pushesInFlight += 1
      state.mostPushesInFlight = max(state.mostPushesInFlight, state.pushesInFlight)
    }
    defer { state.withLock { $0.pushesInFlight -= 1 } }
    return await answer(.push(request, token: token), \.pushes)
  }

  public func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    await answer(.pull(request, token: token), \.pulls)
  }

  public func openLive(token: SessionToken) async -> Reply<any LiveConnection> {
    await answer(.openLive(token: token), \.sockets)
  }

  func answer<Body>(_ call: Call, _ queue: WritableKeyPath<State, [Scripted<Body>]>) async -> Reply<Body> {
    let scripted = state.withLock { state in
      state.calls.append(call)
      return state[keyPath: queue].isEmpty ? nil : state[keyPath: queue].removeFirst()
    }
    guard let scripted else { return .unreachable }
    await scripted.gate?.pass()
    return scripted.reply
  }
}

// A call held until the test opens it; `arrival()` returns once a call has reached it, so the test acts while the call
// is in flight.
public final class Gate: Sendable {
  struct State {
    var open = false
    var reached = false
    var waiters: [CheckedContinuation<Void, Never>] = []
    var arrivals: [CheckedContinuation<Void, Never>] = []
  }

  let state = Mutex(State())

  public init() {}

  // Returns once a call has reached the gate; at once if one has.
  public func arrival() async {
    await withCheckedContinuation { continuation in
      let reached = state.withLock { state -> Bool in
        if !state.reached { state.arrivals.append(continuation) }
        return state.reached
      }
      if reached { continuation.resume() }
    }
  }

  public func open() {
    let waiters = state.withLock { state in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume() }
  }

  // Waits until the gate is open.
  public func pass() async {
    await withCheckedContinuation { continuation in
      let (open, arrivals) = state.withLock { state -> (Bool, [CheckedContinuation<Void, Never>]) in
        state.reached = true
        if !state.open { state.waiters.append(continuation) }
        defer { state.arrivals = [] }
        return (state.open, state.arrivals)
      }
      if open { continuation.resume() }
      for arrival in arrivals { arrival.resume() }
    }
  }
}

// MARK: - The live socket

// A socket the test holds the server's end of: each frame it delivers waits for the engine to receive it, the server
// may end the socket, and every request the engine sends is logged and handed to `onSend`, as a server would take it.
// `drained()` returns once the engine has taken every frame delivered.
public final class FakeLiveConnection: LiveConnection {
  public struct Closed: Error {}

  struct State {
    var frames: [LiveFrame] = []
    var sent: [LiveRequest] = []
    var ended = false
    var closed = false
    var receiver: CheckedContinuation<LiveFrame?, Never>?
    var drains: [CheckedContinuation<Void, Never>] = []
  }

  let state = Mutex(State())
  let onSend: @Sendable (LiveRequest) -> Void

  public init(onSend: @escaping @Sendable (LiveRequest) -> Void = { _ in }) {
    self.onSend = onSend
  }

  // MARK: The server's end

  public func deliver(_ frame: LiveFrame) {
    let receiver = state.withLock { state -> CheckedContinuation<LiveFrame?, Never>? in
      guard !state.ended, !state.closed else { return nil }
      guard let receiver = state.receiver else {
        state.frames.append(frame)
        return nil
      }
      state.receiver = nil
      return receiver
    }
    receiver?.resume(returning: frame)
  }

  public func deliver(_ frame: JSON) throws {
    deliver(try LiveFrame(json: frame))
  }

  // The server closes the socket: the engine receives the frames already delivered, then nil.
  public func end() {
    let receiver = state.withLock { state in
      state.ended = true
      defer { state.receiver = nil }
      return state.frames.isEmpty ? state.receiver : nil
    }
    receiver?.resume(returning: nil)
  }

  public var sent: [LiveRequest] { state.withLock(\.sent) }
  public var isClosed: Bool { state.withLock(\.closed) }

  // A receive answers at once: a frame waits, or the socket has ended or closed.
  public var canReceive: Bool { state.withLock { !$0.frames.isEmpty || $0.ended || $0.closed } }

  // MARK: Faults on the way (design §9.3)

  // The frames delivered and not yet received, in the order the engine will receive them.
  public var waitingFrames: Int { state.withLock(\.frames.count) }

  public func dropFrame(at index: Int) {
    state.withLock { _ = $0.frames.remove(at: index) }
  }

  public func duplicateFrame(at index: Int) {
    state.withLock { $0.frames.insert($0.frames[index], at: index) }
  }

  // The frame at `index` overtakes every frame before it.
  public func overtake(at index: Int) {
    state.withLock { $0.frames.insert($0.frames.remove(at: index), at: 0) }
  }

  // Returns once the engine waits for the next frame, having received every frame delivered, or once the socket is
  // closed; at once if it is so now.
  public func drained() async {
    await withCheckedContinuation { continuation in
      let now = state.withLock { state -> Bool in
        if state.receiver != nil || state.closed { return true }
        state.drains.append(continuation)
        return false
      }
      if now { continuation.resume() }
    }
  }

  // MARK: LiveConnection

  public func send(_ request: LiveRequest) async throws {
    let open = state.withLock { state in
      if !state.closed && !state.ended { state.sent.append(request) }
      return !state.closed && !state.ended
    }
    guard open else { throw Closed() }
    onSend(request)
  }

  public func receive() async throws -> LiveFrame? {
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<LiveFrame?, Never>) in
        let (ready, drains) = state.withLock { state -> (LiveFrame??, [CheckedContinuation<Void, Never>]) in
          if !state.frames.isEmpty { return (.some(state.frames.removeFirst()), []) }
          if state.ended || state.closed || Task.isCancelled { return (.some(nil), []) }
          state.receiver = continuation
          defer { state.drains = [] }
          return (nil, state.drains)
        }
        if let ready { continuation.resume(returning: ready) }
        for drain in drains { drain.resume() }
      }
    } onCancel: {
      close()
    }
  }

  public func close() {
    let (receiver, drains) = state.withLock { state in
      state.closed = true
      state.frames = []
      defer {
        state.receiver = nil
        state.drains = []
      }
      return (state.receiver, state.drains)
    }
    receiver?.resume(returning: nil)
    for drain in drains { drain.resume() }
  }
}

// MARK: - Transcripts

// protocol/*.jsonl from one device's side (design §6.8): the runner names each exchange the device makes next, the
// request the engine sends is checked against the transcript's by JCS, and the transcript's response answers it, or
// none when the transcript lost it. Frames come through the one socket it opens, whose server end the runner holds.
public final class TranscriptTransport: SyncTransport {
  public struct Exchange: Sendable {
    public let call: String
    public let request: JSON?
    public let response: JSON
    public let lost: Bool
    public let place: String

    // `call`: hello, push or pull; `request` nil for a hello, whose request is `{}`; `response` `{status, body}`.
    public init(call: String, request: JSON?, response: JSON, lost: Bool, place: String) {
      self.call = call
      self.request = request
      self.response = response
      self.lost = lost
      self.place = place
    }
  }

  struct State {
    var expected: [Exchange] = []
    var differences: [String] = []
  }

  let state = Mutex(State())
  public let socket = FakeLiveConnection()

  public init() {}

  public func expect(_ exchange: Exchange) {
    state.withLock { $0.expected.append(exchange) }
  }

  // Where the engine's calls and the transcript disagreed since the last settle, the exchanges expected and not made
  // included; both are cleared.
  public func settle() -> [String] {
    state.withLock { state in
      defer { state = State() }
      return state.differences + state.expected.map { "\($0.place): the engine made no \($0.call)" }
    }
  }

  public func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    answer("hello", nil)
  }

  public func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    answer("push", request.json)
  }

  public func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    answer("pull", request.json)
  }

  public func openLive(token: SessionToken) async -> Reply<any LiveConnection> {
    .answered(.ok(socket))
  }

  func answer<Body: ResponseBody>(_ call: String, _ request: JSON?) -> Reply<Body> {
    state.withLock { state in
      guard !state.expected.isEmpty, state.expected[0].call == call else {
        state.differences.append("the engine made a \(call) the transcript does not: \(request?.jcsText ?? "{}")")
        return .unreachable
      }
      let exchange = state.expected.removeFirst()
      if let expected = exchange.request, let request, request != expected {
        state.differences.append("\(exchange.place): the engine sent \(request.jcsText), not \(expected.jcsText)")
      }
      guard !exchange.lost, let status = try? exchange.response.member("status").asInteger() else { return .unreachable }
      return Reply(status: Int(status), body: exchange.response["body"])
    }
  }
}
