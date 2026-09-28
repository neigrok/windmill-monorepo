import SyncCore
import SyncEngine
import enum SyncModelServer.Credential
import struct SyncModelServer.LiveSocket
import struct SyncModelServer.ModelServer
import struct SyncModelServer.PushFaults
import struct SyncModelServer.ScopeKey
import struct SyncModelServer.ServerCall
import struct SyncModelServer.ServerState
import Synchronization

// One server process in memory for every device of a test, and the network between them (design §9.3, §9.4). The
// handle is the process: the `ModelServer` on its own wall clock, the sessions it issued, and what a test scripts of it.
// The network carries each device's calls to it, with the faults a simulation arms for the next call, and hands every
// frame the server publishes to the socket it was published to.

// MARK: - The server process

// Every call runs as its token's account at the clock's time; a token the process did not issue, or revoked, resolves to
// no account and is answered 401, and revoking a session closes every socket opened under it (§6.8). Two ledgers serve a
// simulation's checks: the version of the server's rows, which moves whenever a scope's rows change or the epoch does,
// and every intent admitted fresh, by epoch, replica and `n`, so one admitted twice (INV-4) is caught.
public final class ModelServerHandle: Sendable {
  struct Process {
    var server: ModelServer
    var sessions: [String: String] = [:]
    // The session token each open socket's upgrade was served under.
    var sockets: [LiveSocket: String] = [:]
    var issued: [String: Int] = [:]
    var admitted: Set<AdmittedIntent> = []
    var admittedTwice: [String] = []
  }

  struct AdmittedIntent: Hashable {
    let epoch: [UInt8]
    let replica: [UInt8]
    let n: Int64
  }

  // Where the server's rows stand: equal versions hold equal rows.
  struct RowsVersion: Hashable {
    let epoch: [UInt8]
    let scopes: Int
    let seqs: Int64
  }

  let process: Mutex<Process>
  let clock: any WallClock

  package init(_ server: ModelServer, clock: any WallClock) {
    process = Mutex(Process(server: server))
    self.clock = clock
  }

  // MARK: Scripting (kit ER-9)

  // The next `count` replica intents are refused with `code`, stored as step R stores a refusal, so a replay answers
  // the same.
  public func refuse(next count: Int = 1, code: RefusalCode, detail: JSON? = nil) {
    process.withLock { $0.server.refuse(next: count, code: code, detail: detail) }
  }

  // MARK: Reading

  public var state: ServerState { process.withLock(\.server.state) }

  // The alive typed rows of `scope` as `account` names it, in record order: what a client holding the scope confirmed
  // holds once it has pulled to the head.
  public func rows(_ scope: ScopeRef, of account: String?) -> [Row] {
    guard let key = ScopeKey(scope, account: account) else { return [] }
    return (state.rows[key] ?? [:]).values.filter(\.isAlive).sorted { $0.key < $1.key }
  }

  var rowsVersion: RowsVersion {
    process.withLock { process in
      let state = process.server.state
      return RowsVersion(epoch: Array(state.epoch.utf8), scopes: state.scopes.count,
                         seqs: state.scopes.values.reduce(0) { $0 &+ $1.seq })
    }
  }

  // Each intent this process admitted twice under one epoch, as `<epoch> <replica> <n>`; empty while INV-4 holds.
  var admittedTwice: [String] { process.withLock(\.admittedTwice) }

  // MARK: Sessions

  // The session token that signs `account` in, issued at the first ask.
  package func token(for account: String) -> SessionToken {
    process.withLock { process in
      if let issued = process.sessions.first(where: { $0.value.utf8.elementsEqual(account.utf8) }) { return SessionToken(issued.key) }
      return process.issue(for: account)
    }
  }

  // A session of its own for one device of `account`, as each sign-in on a device gets (§8.2).
  package func issueToken(for account: String) -> SessionToken {
    process.withLock { $0.issue(for: account) }
  }

  // The session ends: every call under it is unauthenticated, and every socket opened under it is closed before it sends
  // another frame.
  package func revoke(_ token: SessionToken) {
    process.withLock { process in
      process.sessions[token.value] = nil
      for (socket, opener) in process.sockets where opener.utf8.elementsEqual(token.value.utf8) {
        process.server.close(socket)
        process.sockets[socket] = nil
      }
    }
  }

  // MARK: Serving, at the clock's time

  // Every call is served with what its token resolves to (§9.1): no token is the anonymous caller, and a token the
  // process did not issue, or revoked, resolves to no account, which the server answers 401.
  func hello(as token: SessionToken?) -> (status: Int, body: JSON) {
    let at = clock.nowMs()
    return process.withLock { process in
      let reply = process.server.hello(credential: process.credential(of: token), at: at)
      return (reply.status, reply.body)
    }
  }

  // A push as received; an intent whose result is stored by this push, having had none, was admitted fresh.
  func push(_ request: PushRequest, as token: SessionToken?, faults: PushFaults) -> (status: Int, body: JSON) {
    let at = clock.nowMs()
    return process.withLock { process in
      let before = process.server.state.results[request.replica] ?? [:]
      let reply = process.server.push(received: request.body, credential: process.credential(of: token), at: at, faults: faults)
      let after = process.server.state.results[request.replica] ?? [:]
      let epoch = Array(process.server.state.epoch.utf8)
      for n in request.intents.compactMap(\.n) where before[n]?.result == nil && after[n]?.result != nil {
        let intent = AdmittedIntent(epoch: epoch, replica: Array(request.replica.utf8), n: n)
        if !process.admitted.insert(intent).inserted {
          process.admittedTwice.append("\(process.server.state.epoch) \(request.replica) \(n)")
        }
      }
      return (reply.status, reply.body)
    }
  }

  func pull(_ request: PullRequest, as token: SessionToken?) -> (status: Int, body: JSON) {
    let at = clock.nowMs()
    return process.withLock { process in
      let reply = process.server.pull(received: request.body, credential: process.credential(of: token), at: at)
      return (reply.status, reply.body)
    }
  }

  // The same pull as `account`, whatever its sessions: what that account would be answered.
  func pull(_ request: PullRequest, asAccount account: String?) -> JSON {
    let at = clock.nowMs()
    let credential = account.map(Credential.account) ?? .absent
    return process.withLock { $0.server.pull(received: request.body, credential: credential, at: at).body }
  }

  // A failure answered for this process, as a proxy or a failing server answers it: the server's time and epoch, and
  // the error its status names.
  func failure(_ status: Int) -> (status: Int, body: JSON) {
    let at = clock.nowMs()
    let error = switch status {
    case 400: "malformed"
    case 413: "request-too-large"
    case 503: "unavailable"
    default: "internal"
    }
    return process.withLock { process in
      var body: JSON.Object = ["serverTime": JSON(at), "epoch": .string(process.server.state.epoch), "error": .string(error)]
      if status == 503 { body["retryAfterMs"] = JSON(ModelServer.transientRetryAfterMs) }
      return (status, .object(body))
    }
  }

  func call(_ call: ServerCall) -> JSON? {
    let at = clock.nowMs()
    return process.withLock { $0.server.call(call, at: at) }
  }

  // The upgrade under `token`, or none; nil when the server answers it 401.
  func connect(as token: SessionToken?) -> LiveSocket? {
    process.withLock { process in
      let socket = process.server.connect(process.credential(of: token))
      if let socket, let token { process.sockets[socket] = token.value }
      return socket
    }
  }

  func isOpen(_ socket: LiveSocket) -> Bool {
    process.withLock { $0.server.isOpen(socket) }
  }

  func subscribe(_ socket: LiveSocket, to scopes: [ScopeRef]) {
    process.withLock { $0.server.subscribe(socket, to: scopes) }
  }

  func unsubscribe(_ socket: LiveSocket, from scopes: [ScopeRef]) {
    process.withLock { $0.server.unsubscribe(socket, from: scopes) }
  }

  func frames(for socket: LiveSocket) -> [JSON] {
    process.withLock { $0.server.frames(for: socket) }
  }

  // MARK: Operating

  // A restore from a backup (§6, epoch and restore): the tables as `snapshot` holds them, under a new epoch. The process
  // runs on, its sessions, sockets and clock with it.
  package func restore(_ snapshot: ServerState, epoch: String) {
    var restored = snapshot
    restored.epoch = epoch
    process.withLock { $0.server.restore(restored) }
  }
}

extension ModelServerHandle.Process {
  // A token is sent as the transport sends it, `Authorization: Bearer <token>`, and read as §9.1 reads raw headers: no
  // token is no credential; a token of a live session resolves to its account, and any other to none.
  func credential(of token: SessionToken?) -> Credential {
    Credential(headers: token.map { [(name: "Authorization", value: "Bearer \($0.value)")] } ?? [], sessions: sessions)
  }

  mutating func issue(for account: String) -> SessionToken {
    let count = (issued[account] ?? 0) + 1
    issued[account] = count
    let token = count == 1 ? "token-\(account)" : "token-\(account)-\(count)"
    sessions[token] = account
    return SessionToken(token)
  }
}

// MARK: - The network

// A `sub` is answered at once for scopes its principal may not read, and a ping with a pong; a socket the server closed
// ends. What the wire does to a call is armed before it (design §9.3), and taken by the next call of its kind: a request
// dropped on the way, a reply lost after the server acted, a request served twice whose caller gets the second reply, a
// push queued at the server and served when a later action says (the caller finding no network now), a credential lost
// on the way, so the server serves the request as anonymous (§9.1), or an answer the server never made. A push may also
// meet the server's own faults (§6.6), and every push of a poisoned intent faults until it is poisoned. The network keeps
// whom the server served the last answer of each kind as, for a simulation's checks.
public final class SimNetwork: SyncTransport {
  package enum Call: Hashable, Sendable {
    case hello, push, pull, live
  }

  package enum Fate: Hashable, Sendable {
    case deliver, drop, loseReply, duplicate, delay, loseCredential
    case answer(status: Int)
  }

  // The last answer the server made to a call of one kind: whom it was served as, an account or null, and the scopes a
  // pull asked; nil for any other call, whose answer may touch every scope.
  struct Answered: Sendable {
    let servedAs: JSON
    let scopes: Set<ScopeRef>?
  }

  // One push served: the request, and the server's answer, which its sender may never see.
  struct ServedPush: Sendable {
    let request: PushRequest
    let status: Int
    let body: JSON
  }

  struct Poisoned: Hashable {
    let replica: [UInt8]
    let n: Int64
  }

  struct Wire {
    var sockets: [(socket: LiveSocket, connection: FakeLiveConnection)] = []
    var fates: [Call: Fate] = [:]
    var answered: [Call: Answered] = [:]
    var pushFaults = PushFaults()
    var poisoned: Set<Poisoned> = []
    var delayed: [(request: PushRequest, token: SessionToken)] = []
    var watcher: (@Sendable (ServedPush) -> Void)?
  }

  public let server: ModelServerHandle
  let wire = Mutex(Wire())

  package init(server: ModelServerHandle) {
    self.server = server
  }

  public convenience init(server: ModelServer, clock: any WallClock) {
    self.init(server: ModelServerHandle(server, clock: clock))
  }

  // Every socket the network has opened, in the order it opened them.
  public var connections: [FakeLiveConnection] { wire.withLock { $0.sockets.map(\.connection) } }

  // MARK: SyncTransport

  public func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    let fate = take(.hello)
    guard fate != .drop else { return .unreachable }
    let answered = served(.hello, server.hello(as: fate == .loseCredential ? nil : token))
    return Reply(status: answered.status, body: answered.body)
  }

  public func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    let fate = take(.push)
    switch fate {
    case .drop:
      return .unreachable
    case .delay:
      wire.withLock { $0.delayed.append((request, token)) }
      return .unreachable
    case .answer(let status):
      let answered = server.failure(status)
      return Reply(status: answered.status, body: answered.body)
    case .deliver, .loseReply, .duplicate, .loseCredential:
      let sentUnder = fate == .loseCredential ? nil : token
      var answered = serve(request, as: sentUnder)
      if fate == .duplicate { answered = serve(request, as: sentUnder) }
      return fate == .loseReply ? .unreachable : Reply(status: answered.status, body: served(.push, answered).body)
    }
  }

  public func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    let fate = take(.pull)
    switch fate {
    case .drop, .delay:
      return .unreachable
    case .answer(let status):
      let answered = server.failure(status)
      return Reply(status: answered.status, body: answered.body)
    case .deliver, .loseReply, .duplicate, .loseCredential:
      let sentUnder = fate == .loseCredential ? nil : token
      var answered = server.pull(request, as: sentUnder)
      if fate == .duplicate { answered = server.pull(request, as: sentUnder) }
      deliverFrames()
      let body = served(.pull, answered, scopes: Set(request.scopes.map(\.scope))).body
      return fate == .loseReply ? .unreachable : Reply(status: answered.status, body: body)
    }
  }

  public func openLive(token: SessionToken) async -> Reply<any LiveConnection> {
    let fate = take(.live)
    guard fate != .drop else { return .unreachable }
    guard let opened = server.connect(as: fate == .loseCredential ? nil : token) else {
      return .answered(.failed(HTTPFailure(status: 401)))
    }
    let connection = FakeLiveConnection { [weak self] request in self?.take(request, on: opened) }
    wire.withLock { $0.sockets.append((opened, connection)) }
    return .answered(.ok(connection))
  }

  // MARK: A simulation's hands

  // `fate` meets the next call of `call`'s kind.
  func arm(_ fate: Fate, for call: Call) {
    wire.withLock { $0.fates[call] = fate }
  }

  // The server's own faults meet the next push served.
  func arm(_ faults: PushFaults) {
    wire.withLock { $0.pushFaults = faults }
  }

  // The fates and faults armed and not taken, which the call they were armed for never came to; true when any was. What
  // the last answers were served as is forgotten with them.
  @discardableResult
  func disarm() -> Bool {
    wire.withLock { wire in
      defer {
        wire.fates = [:]
        wire.pushFaults = PushFaults()
        wire.answered = [:]
      }
      return !wire.fates.isEmpty || wire.pushFaults != PushFaults()
    }
  }

  // The last answer the server made to a call of `call`'s kind since the network was last disarmed: nil when it made
  // none, or when a proxy's answer stood in for it.
  func lastAnswer(to call: Call) -> Answered? {
    wire.withLock { $0.answered[call] }
  }

  // Every admission of intent `n` of `replica` faults (§6.6).
  func poison(replica: String, n: Int64) {
    wire.withLock { _ = $0.poisoned.insert(Poisoned(replica: Array(replica.utf8), n: n)) }
  }

  var delayedPushes: Int { wire.withLock(\.delayed.count) }

  // The push queued at `index` reaches the server now; its answer reaches no one.
  func admitDelayed(at index: Int) {
    guard let delayed = wire.withLock({ $0.delayed.indices.contains(index) ? $0.delayed.remove(at: index) : nil }) else { return }
    _ = serve(delayed.request, as: delayed.token)
  }

  // The wire works again: nothing is armed, nothing poisoned, and every push still queued is lost.
  func heal() {
    wire.withLock { wire in
      wire.fates = [:]
      wire.pushFaults = PushFaults()
      wire.poisoned = []
      wire.delayed = []
    }
  }

  // `watcher` sees every push the server serves, as it is served, before its sender reads the answer.
  func watchPushes(_ watcher: @escaping @Sendable (ServedPush) -> Void) {
    wire.withLock { $0.watcher = watcher }
  }

  // A server-origin call (§6.3); every socket then gets what it published.
  func call(_ call: ServerCall) -> JSON? {
    let answered = server.call(call)
    deliverFrames()
    return answered
  }

  // MARK: Carrying

  func take(_ call: Call) -> Fate {
    wire.withLock { $0.fates.removeValue(forKey: call) } ?? .deliver
  }

  // An answer the server made to a call of `call`'s kind, kept as whom it was served as and the scopes it answers.
  func served(_ call: Call, _ answered: (status: Int, body: JSON), scopes: Set<ScopeRef>? = nil) -> (status: Int, body: JSON) {
    wire.withLock { $0.answered[call] = Answered(servedAs: answered.body["as"] ?? .null, scopes: scopes) }
    return answered
  }

  // One push served, with the server's faults armed for it and those of its poisoned intents; then every socket gets
  // what it published.
  func serve(_ request: PushRequest, as token: SessionToken?) -> (status: Int, body: JSON) {
    let (faults, watcher) = wire.withLock { wire in
      var faults = wire.pushFaults
      wire.pushFaults = PushFaults()
      for n in request.intents.compactMap(\.n) where wire.poisoned.contains(Poisoned(replica: Array(request.replica.utf8), n: n)) {
        faults.byN[n] = .fault
      }
      return (faults, wire.watcher)
    }
    let answered = server.push(request, as: token, faults: faults)
    watcher?(ServedPush(request: request, status: answered.status, body: answered.body))
    deliverFrames()
    return answered
  }

  func take(_ request: LiveRequest, on socket: LiveSocket) {
    switch request {
    case .sub(let scopes): server.subscribe(socket, to: scopes)
    case .unsub(let scopes): server.unsubscribe(socket, from: scopes)
    case .ping where server.isOpen(socket): wire.withLock { $0.sockets.first { $0.socket == socket } }?.connection.deliver(.pong)
    case .ping: break
    }
    deliverFrames()
  }

  // Each socket's frames, delivered under the network's lock, so two calls answered at once keep every socket's frames
  // in the order the server published them; a socket the server closed ends, once the frames it sent are received.
  func deliverFrames() {
    wire.withLock { wire in
      for (socket, connection) in wire.sockets {
        for frame in server.frames(for: socket) { try? connection.deliver(frame) }
      }
      for (socket, connection) in wire.sockets where !server.isOpen(socket) { connection.end() }
    }
  }
}
