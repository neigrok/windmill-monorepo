import SyncCore
import SyncEngine
import struct SyncModelServer.LiveSocket
import struct SyncModelServer.ModelServer
import Synchronization

// Wire doubles (design §6.8): `ScriptedTransport` for component tests, `TranscriptTransport` for the corpus's
// transcripts, `SimNetwork` for devices over one in-memory server, and `FakeLiveConnection`, the live socket each of
// them hands out, whose server end the test or the network holds.

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

// MARK: - One in-memory server

// One server process in memory for every device of a test (design §9.4): each call goes to the `ModelServer` at the
// server clock's time as the account its token names, and a token the network did not issue is unauthenticated. Every
// open socket receives the frames the server publishes to it as the call that published them returns; a `sub` is
// answered at once for scopes its principal may not read, and a ping with a pong.
public final class SimNetwork: SyncTransport {
  struct State {
    var server: ModelServer
    var accounts: [String: String] = [:]
    var sockets: [(socket: LiveSocket, connection: FakeLiveConnection)] = []
  }

  let state: Mutex<State>
  let clock: any WallClock

  public init(server: ModelServer, clock: any WallClock) {
    state = Mutex(State(server: server))
    self.clock = clock
  }

  public var server: ModelServer { state.withLock(\.server) }

  // Every socket the network has opened, in the order it opened them.
  public var connections: [FakeLiveConnection] { state.withLock { $0.sockets.map(\.connection) } }

  // The session token that signs `account` in on this network.
  public func token(for account: String) -> SessionToken {
    state.withLock { $0.accounts["token-\(account)"] = account }
    return SessionToken("token-\(account)")
  }

  public func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    let answered = serve(as: token) { server, account, at in server.hello(account: account, at: at) }
    return Reply(status: answered.status, body: answered.body)
  }

  public func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    let answered = serve(as: token) { server, account, at in server.push(received: request.body, account: account, at: at) }
    return Reply(status: answered.status, body: answered.body)
  }

  public func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    let answered = serve(as: token) { server, account, at in server.pull(received: request.body, account: account, at: at) }
    return Reply(status: answered.status, body: answered.body)
  }

  public func openLive(token: SessionToken) async -> Reply<any LiveConnection> {
    let opened = state.withLock { state -> LiveSocket? in
      guard let account = state.accounts[token.value] else { return nil }
      return state.server.connect(account: account)
    }
    guard let opened else { return .answered(.failed(HTTPFailure(status: 401))) }
    let connection = FakeLiveConnection { [weak self] request in self?.take(request, on: opened) }
    state.withLock { $0.sockets.append((opened, connection)) }
    return .answered(.ok(connection))
  }

  // One call as its token's account, at the server clock's time; then every socket gets what the call published.
  func serve<Answer>(as token: SessionToken?, _ call: (inout ModelServer, String?, Int64) -> Answer) -> Answer {
    let at = clock.nowMs()
    let answer = state.withLock { state in call(&state.server, token.flatMap { state.accounts[$0.value] }, at) }
    deliverFrames()
    return answer
  }

  func take(_ request: LiveRequest, on socket: LiveSocket) {
    switch request {
    case .sub(let scopes): state.withLock { $0.server.subscribe(socket, to: scopes) }
    case .unsub(let scopes): state.withLock { $0.server.unsubscribe(socket, from: scopes) }
    case .ping: state.withLock { $0.sockets.first { $0.socket == socket } }?.connection.deliver(.pong)
    }
    deliverFrames()
  }

  // Each socket's frames, delivered under the network's lock, so two calls answered at once keep every socket's frames
  // in the order the server published them.
  func deliverFrames() {
    state.withLock { state in
      for (socket, connection) in state.sockets {
        for frame in state.server.frames(for: socket) { try? connection.deliver(frame) }
      }
    }
  }
}
