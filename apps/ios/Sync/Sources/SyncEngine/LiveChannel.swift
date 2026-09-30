import SyncAPI
import SyncCore
import SyncReplica
import SyncStore

// §7.5 and §9.5 the live socket: one per device, open while the active replica is bound and not paused, the device
// online and the app in the foreground. It follows the scopes of the subscription set the replica pulls (§7.9): `sub`
// for each it does not follow, unless the scope is in doubt, and `unsub` for each it follows that left the set. It pings
// once LIVE_PING_MS pass with no frame or pong received, and a pong missing LIVE_PONG_MS after the ping fails the socket.
// Change, gone and not-found frames served as the replica's account go to the puller's queue; a gone or not-found ends
// the server's subscription (§6.8), so the scope is followed no more, and is subscribed again while the replica still
// pulls it and it is not in doubt. A frame served as anyone else is a 401 (§9.1), which closes the socket and pauses the
// replica. A pong keeps the heartbeat, and any other op is ignored. An open that fails, and a socket that ends or fails,
// count as a reconnect, so the puller pulls every scope at once; a close the client makes (leaving, going offline, a
// replica change) pulls nothing. The next socket after a reconnect opens after the channel's own backoff, with its own
// `k` and a 30 s ceiling, `k` reset once a socket has stayed open 30 s; a re-authentication that clears the pause opens
// the next one at once, with `k` reset. A 401 at the handshake pauses the replica, and a 426 stops the channel for the
// process. When the loops run, a reader task per socket receives its frames; in step mode the caller receives them.

package enum LiveStep: Sendable, Hashable {
  // Look again now: the socket was closed or replaced while this step waited, the seat changed during the handshake, or a
  // 401 answered a token the account has replaced since.
  case again
  // No socket is wanted: signed out, offline, or in the background. Wait for a kick.
  case idle
  // A socket is open: look again in `ms` for the heartbeat, or at a kick.
  case open(ms: Int64)
  // 401, or no token for the account: wait for re-authentication's kick.
  case paused
  // 426: no socket is opened again by this process.
  case stopped
  // The socket could not open or has ended: open another in `ms`.
  case backoff(ms: Int64)
}

package actor LiveChannel {
  // Appendix B's live reopen backoff: its ceiling, and how long a socket stays open before `k` resets.
  static let reopenCeilingMs: Int64 = 30_000
  static let settledMs: Int64 = 30_000

  // An open socket: the replica and account it was opened for, under `token`.
  struct Socket {
    let connection: any LiveConnection
    let replica: String
    let account: String
    let token: SessionToken
    let generation: Int
    let openedAt: Int64
    var following: [ScopeRef] = []
    // When a frame or pong was last received, or the socket opened.
    var heardAt: Int64
    var pongDue: Int64?
  }

  let core: EngineCore
  let transport: any SyncTransport
  let puller: Puller
  let turns = Turns()
  var socket: Socket?
  var generation = 0
  var reopenAt: Int64?
  var backoff = Backoff()
  var reader: Task<Void, Never>?

  init(core: EngineCore, transport: any SyncTransport, puller: Puller) {
    self.core = core
    self.transport = transport
    self.puller = puller
  }

  package nonisolated var wake: Wake { core.wakes.live }

  package var isOpen: Bool { socket != nil }

  // Step mode: the socket open now, whose frames `receiveNext` takes.
  package var connection: (any LiveConnection)? { socket?.connection }

  // The production driver: a kick ends any sleep early. The socket closes with the loop.
  func run() async {
    while !Task.isCancelled {
      let seen = wake.kicks
      switch await step() {
      case .again: continue
      case .idle, .paused, .stopped: await wake.wait(past: seen)
      case .open(let ms), .backoff(let ms): await wake.wait(past: seen, atMost: .milliseconds(ms), clock: core.clock.sleeper)
      }
    }
    close()
  }

  // Opens, keeps or closes the socket as the seat, the network and the app now want it, once the step in flight has
  // ended.
  package func step() async -> LiveStep {
    guard await turns.take() else { return .idle }
    defer { turns.pass() }
    if core.liveReopensAtOnce.exchange(false, ordering: .acquiringAndReleasing) {
      backoff.reset()
      reopenAt = nil
    }
    guard !core.upgradeRequired else {
      close()
      return .stopped
    }
    let meta: ReplicaMeta?
    do {
      meta = try core.seat()
    } catch {
      return .backoff(ms: nextBackoff())
    }
    guard core.isForeground, core.connectivity.isOnline, let meta, meta.state == .bound, let account = meta.account else {
      close()
      return .idle
    }
    guard !meta.authPaused else {
      close()
      return .paused
    }
    if let socket, !socket.replica.utf8.elementsEqual(meta.replica.utf8) { close() }
    guard socket == nil else { return await keep(meta) }
    let mono = now()
    if let reopenAt, reopenAt > mono { return .backoff(ms: reopenAt - mono) }
    return await open(meta, account: account)
  }

  // Every state that wants no socket: the socket closes, pulling nothing, and the next one opens at once. A socket that
  // stayed open `settledMs` resets the reopen backoff's `k`.
  package func close() {
    if let socket, now() - socket.openedAt >= Self.settledMs { backoff.reset() }
    socket?.connection.close()
    if socket != nil { core.doubts.withLock { $0.follow([], at: now()) } }
    socket = nil
    reader?.cancel()
    reader = nil
    reopenAt = nil
  }

  // The leave flush's end: the socket closes while the app is away. The check and the close are one turn of the actor, so
  // a foreground that lands after the check kicks a step that opens the socket again.
  package func closeInBackground() {
    guard !core.isForeground else { return }
    close()
  }

  // Step mode: receives the socket's next frame, as the reader task does when the loops run; false once there is none.
  package func receiveNext() async -> Bool {
    guard let socket else { return false }
    do {
      guard let frame = try await socket.connection.receive() else {
        ended(socket.generation)
        return false
      }
      await receive(frame, generation: socket.generation)
      return true
    } catch {
      ended(socket.generation)
      return false
    }
  }

  // MARK: Opening

  // The handshake under the account's token. A socket opened for a seat that changed while the handshake was on its way
  // closes at once; one still wanted follows what the replica subscribes. A 401 is an open that fails, so every scope is
  // wanted, pulled once the account re-authenticates; it pauses only while that token is still the account's.
  func open(_ meta: ReplicaMeta, account: String) async -> LiveStep {
    guard let token = core.tokens.token(for: account) else {
      return (try? core.pauseAuth(meta.replica, sentUnder: nil)) == true ? .paused : .again
    }
    switch await transport.openLive(token: token) {
    case .answered(.ok(let connection)):
      guard wanted(for: meta) else {
        connection.close()
        return .again
      }
      generation += 1
      socket = Socket(
        connection: connection, replica: meta.replica, account: account, token: token, generation: generation, openedAt: now(),
        heardAt: now())
      if core.config.drivesLoops { read(connection, generation: generation) }
      return await keep(meta)
    case .answered(.failed(let failure)) where failure.status == 401:
      core.pullWants.all()
      puller.wake.kick()
      return (try? core.pauseAuth(meta.replica, sentUnder: token)) == true ? .paused : .again
    case .answered(.failed(let failure)) where failure.status == 426:
      core.requireUpgrade()
      return .stopped
    case .answered(.failed), .unreachable:
      return reopenLater()
    }
  }

  // A socket is still wanted for the seat it was opened for: the same bound, unpaused replica, online, in the
  // foreground, with no upgrade required.
  func wanted(for opened: ReplicaMeta) -> Bool {
    guard let meta = try? core.seat() else { return false }
    return meta.replica.utf8.elementsEqual(opened.replica.utf8) && meta.state == .bound && !meta.authPaused && core.isForeground
      && core.connectivity.isOnline && !core.upgradeRequired
  }

  func read(_ connection: any LiveConnection, generation: Int) {
    reader?.cancel()
    reader = Task { [weak self] in
      while let frame = try? await connection.receive() { await self?.receive(frame, generation: generation) }
      await self?.ended(generation)
    }
  }

  // MARK: An open socket

  // Follows what §7.9 says, then keeps the heartbeat: a ping once LIVE_PING_MS pass with nothing heard, its pong due
  // before it goes, since the reader may take the pong while the ping is being sent, and a reconnect when the pong is
  // LIVE_PONG_MS late. Each send revalidates the socket, which may have ended while it waited.
  func keep(_ meta: ReplicaMeta) async -> LiveStep {
    guard let current = socket else { return .idle }
    let mono = now()
    if let pongDue = current.pongDue, pongDue <= mono { return reopenLater() }
    do {
      guard let subscriptions = try core.store.subscriptions(of: meta.replica, core.subscriptions()) else { return .again }
      let doubtful = core.doubts.withLock { doubts in Set(subscriptions.pulled.filter(doubts.inDoubt)) }
      let dropped = current.following.filter { !subscriptions.set.contains($0) }
      let added = subscriptions.pulled.filter { !current.following.contains($0) && !doubtful.contains($0) }
      if !dropped.isEmpty { try await send(.unsub(dropped), on: current) }
      if !added.isEmpty { try await send(.sub(added), on: current) }
      let following = current.following.filter(subscriptions.set.contains) + added
      socket?.following = following
      core.doubts.withLock { $0.follow(Set(following), at: mono) }
      if current.pongDue == nil, mono - current.heardAt >= Constants.livePingMs {
        socket?.pongDue = mono + Constants.livePongMs
        try await send(.ping, on: current)
      }
    } catch {
      guard socket?.generation == current.generation else { return .again }
      return reopenLater()
    }
    guard let socket else { return .again }
    return .open(ms: max(0, (socket.pongDue ?? socket.heardAt + Constants.livePingMs) - mono))
  }

  func send(_ request: LiveRequest, on sending: Socket) async throws {
    try await sending.connection.send(request)
    guard socket?.generation == sending.generation else { throw CancellationError() }
  }

  // MARK: Frames

  func receive(_ frame: LiveFrame, generation: Int) async {
    guard let socket, socket.generation == generation else { return }
    self.socket?.heardAt = now()
    switch frame {
    case .pong:
      self.socket?.pongDue = nil
    case .other:
      break
    case .change:
      guard frame.isServed(to: socket.account) else { return servedAsAnother(socket) }
      await puller.enqueue(frame, for: socket.replica)
    case .gone(let scope, _), .notFound(let scope, _):
      guard frame.isServed(to: socket.account) else { return servedAsAnother(socket) }
      let following = socket.following.filter { $0 != scope }
      self.socket?.following = following
      core.doubts.withLock { $0.follow(Set(following), at: now()) }
      await puller.enqueue(frame, for: socket.replica)
    }
  }

  // A frame served as anyone but the socket's account: the socket closes at once and nothing it sent is applied. The
  // replica pauses while `token` is still the account's; otherwise the next socket opens under the new one.
  func servedAsAnother(_ socket: Socket) {
    close()
    _ = try? core.pauseAuth(socket.replica, sentUnder: socket.token)
    wake.kick()
  }

  // The socket's reader saw it end.
  func ended(_ generation: Int) {
    guard socket?.generation == generation else { return }
    _ = reopenLater()
    wake.kick()
  }

  // MARK: Reopening

  // A failed open, or a socket that ended or failed: a reconnect, so the puller pulls every scope at once, and the next
  // socket opens after a backoff.
  func reopenLater() -> LiveStep {
    close()
    core.pullWants.all()
    puller.wake.kick()
    let ms = nextBackoff()
    reopenAt = now() + ms
    return .backoff(ms: ms)
  }

  func nextBackoff() -> Int64 {
    backoff.next(ceilingMs: Self.reopenCeilingMs, floorMs: 0, random: core.random)
  }

  func now() -> Int64 {
    core.clock.wall.reading().mono
  }
}
