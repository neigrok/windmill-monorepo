import SyncAPI
import SyncCore
import SyncReplica
import SyncStore

// §7.5 and §9.5 the live socket: one per device, open while the active replica is bound and not paused, the device
// online and the app in the foreground. On open it follows every subscribed scope the replica does not know gone or not
// found, then has the puller pull them all (the reconnect trigger); while open it keeps what it follows in step with
// the subscriptions, and pings every PING_MS, a pong missing PONG_MS after a ping forcing a reconnect. Change, gone and
// not-found frames go to the puller's queue, a pong keeps the heartbeat, and any other op is ignored. An open that
// fails, and a socket that ends or fails, count as a reconnect too, so the puller pulls every scope at once; the next
// socket opens after the channel's own backoff, with its own `k` and a 30 s ceiling, `k` reset once a socket has
// stayed open 30 s. A 401 at the handshake pauses the replica, and a 426 stops the channel for the process. When the
// loops run, a reader task per socket receives its frames; in step mode the caller receives them.

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
  static let pingMs: Int64 = 25_000
  static let pongMs: Int64 = 10_000
  // Appendix B's live reopen backoff: its ceiling, and how long a socket stays open before `k` resets.
  static let reopenCeilingMs: Int64 = 30_000
  static let settledMs: Int64 = 30_000

  struct Socket {
    let connection: any LiveConnection
    let replica: String
    let generation: Int
    let openedAt: Int64
    var following: [ScopeRef] = []
    var pingedAt: Int64
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

  // The leave flush's end, and every state that wants no socket: the socket closes, and the next one opens at once. A
  // socket that stayed open `settledMs` resets the reopen backoff's `k`.
  package func close() {
    if let socket, now() - socket.openedAt >= Self.settledMs { backoff.reset() }
    socket?.connection.close()
    socket = nil
    reader?.cancel()
    reader = nil
    reopenAt = nil
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
  // closes at once; one still wanted follows what the replica subscribes, then the puller pulls every scope. A 401 pauses
  // only while that token is still the account's.
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
      socket = Socket(connection: connection, replica: meta.replica, generation: generation, openedAt: now(), pingedAt: now())
      if core.config.drivesLoops { read(connection, generation: generation) }
      let kept = await keep(meta)
      core.pullWants.all()
      puller.wake.kick()
      return kept
    case .answered(.failed(let failure)) where failure.status == 401:
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

  // Follows the subscribed scopes the replica does not know gone or not found and no others, then keeps the heartbeat:
  // a ping PING_MS after the last, its pong due before it goes, since the reader may take the pong while the ping is
  // being sent, and a reconnect when the pong is PONG_MS late. Each send revalidates the socket, which may have ended
  // while it waited.
  func keep(_ meta: ReplicaMeta) async -> LiveStep {
    guard let current = socket else { return .idle }
    let mono = now()
    if let pongDue = current.pongDue, pongDue <= mono { return reopenLater() }
    do {
      let known = try core.store.knownScopes(of: meta.replica)
      let wanted = core.subscriptions(of: meta).filter { known[$0] == nil }
      let dropped = current.following.filter { !wanted.contains($0) }
      let added = wanted.filter { !current.following.contains($0) }
      if !dropped.isEmpty { try await send(.unsub(dropped), on: current) }
      if !added.isEmpty { try await send(.sub(added), on: current) }
      socket?.following = wanted
      if current.pongDue == nil, mono - current.pingedAt >= Self.pingMs {
        socket?.pingedAt = mono
        socket?.pongDue = mono + Self.pongMs
        try await send(.ping, on: current)
      }
    } catch {
      guard socket?.generation == current.generation else { return .again }
      return reopenLater()
    }
    guard let socket else { return .again }
    let nextPing = socket.pingedAt + Self.pingMs
    return .open(ms: max(0, min(socket.pongDue ?? nextPing, nextPing) - mono))
  }

  func send(_ request: LiveRequest, on sending: Socket) async throws {
    try await sending.connection.send(request)
    guard socket?.generation == sending.generation else { throw CancellationError() }
  }

  // MARK: Frames

  func receive(_ frame: LiveFrame, generation: Int) async {
    guard let socket, socket.generation == generation else { return }
    switch frame {
    case .pong:
      self.socket?.pongDue = nil
    case .other:
      break
    case .change, .gone, .notFound:
      await puller.enqueue(frame, for: socket.replica)
    }
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
