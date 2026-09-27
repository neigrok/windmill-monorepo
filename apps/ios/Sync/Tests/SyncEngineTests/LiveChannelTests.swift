import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// §9.5 the live channel over a scripted transport and a fake socket: when a socket is wanted, what it follows, the
// reconnect pull, the heartbeat, the frames it hands the puller, and how it reopens, pauses and stops.

struct LiveChannelTests {
  static let tree = ScopeRef.tree("b_00000001")

  // A bound device with its socket open, following its product scope.
  static func open() async throws -> (rig: Rig, socket: FakeLiveConnection) {
    let rig = try Rig(account: "A")
    let socket = FakeLiveConnection()
    rig.transport.willOpenLive(socket)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    return (rig, socket)
  }

  // MARK: When a socket is wanted

  @Test func aSignedOutDeviceOpensNoSocket() async throws {
    let rig = try Rig()
    #expect(await rig.engine.live.step() == .idle)
    #expect(rig.transport.calls == [])
  }

  // On open it follows every subscribed scope, then the puller pulls them all.
  @Test func anOpenSocketFollowsTheSubscriptionsThenEverythingIsPulled() async throws {
    let (rig, socket) = try await Self.open()
    #expect(rig.transport.calls == [.openLive(token: SessionToken("token-1"))])
    #expect(socket.sent == [.sub([Rig.scope])])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
  }

  // It follows a new subscription, and stops following a scope the replica learns is gone.
  @Test func itFollowsNewSubscriptionsAndDropsScopesKnownGone() async throws {
    let (rig, socket) = try await Self.open()
    try rig.engine.subscribe([Self.tree])
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    await rig.engine.puller.enqueue(.gone(Self.tree), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .gone))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.tree]), .unsub([Self.tree])])
  }

  // Leaving closes the socket; back in the foreground another opens.
  @Test func leavingClosesTheSocketAndTheForegroundOpensAnother() async throws {
    let (rig, socket) = try await Self.open()
    try rig.engine.leave()
    #expect(await rig.engine.live.step() == .idle)
    #expect(socket.isClosed)
    let next = FakeLiveConnection()
    rig.transport.willOpenLive(next)
    rig.engine.foreground()
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(next.sent == [.sub([Rig.scope])])
  }

  // The leave flush ends by closing the socket.
  @Test func theLeaveFlushClosesTheSocket() async throws {
    let (rig, socket) = try await Self.open()
    await rig.engine.flushOnLeave()
    #expect(socket.isClosed)
    #expect(await rig.engine.live.isOpen == false)
  }

  // Offline, no socket; and one open for a replica no longer active is replaced by one for the replica now active.
  @Test func aSocketFollowsTheNetworkAndTheActiveReplica() async throws {
    let (rig, socket) = try await Self.open()
    rig.connectivity.set(online: false)
    #expect(await rig.engine.live.step() == .idle)
    #expect(socket.isClosed)
    rig.connectivity.set(online: true)
    let second = FakeLiveConnection()
    rig.transport.willOpenLive(second)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    _ = try rig.engine.write { store, instance in try store.reidentify(instance: &instance, identities: rig.engine.identities) }
    let third = FakeLiveConnection()
    rig.transport.willOpenLive(third)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(second.isClosed)
    #expect(third.sent == [.sub([Rig.scope])])
  }

  // MARK: Frames

  // Change, gone and not-found frames go to the puller's queue; a pong keeps the heartbeat, and other ops are ignored.
  @Test func framesGoToThePullerAndOtherOpsAreIgnored() async throws {
    let (rig, socket) = try await Self.open()
    try socket.deliver(["op": "presence", "scope": "self/probe", "who": "B"])
    socket.deliver(.pong)
    socket.deliver(.notFound(Self.tree))
    for _ in 0..<3 { #expect(await rig.engine.live.receiveNext()) }
    #expect(await rig.engine.puller.step() == .frame(Self.tree, nil))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
  }

  // MARK: The heartbeat

  // A ping PING_MS after the socket opened, and PING_MS after its pong; a pong PONG_MS late reopens the socket after a
  // backoff.
  @Test func aPingEveryPingMsAndAMissingPongReopensTheSocket() async throws {
    let (rig, socket) = try await Self.open()
    rig.random.queue(raw: .max, count: 1)
    rig.clock.advance(ms: 25_000)
    #expect(await rig.engine.live.step() == .open(ms: 10_000))
    socket.deliver(.pong)
    #expect(await rig.engine.live.receiveNext())
    rig.clock.advance(ms: 10_000)
    #expect(await rig.engine.live.step() == .open(ms: 15_000))
    rig.clock.advance(ms: 15_000)
    #expect(await rig.engine.live.step() == .open(ms: 10_000))
    rig.clock.advance(ms: 10_000)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
    #expect(socket.sent == [.sub([Rig.scope]), .ping, .ping])
    #expect(socket.isClosed)
    let next = FakeLiveConnection()
    rig.transport.willOpenLive(next)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
    rig.clock.advance(ms: 1_000)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
  }

  // A pong the reader receives while the ping is still being sent keeps the socket: the ping's deadline is set before
  // the send, not after it.
  @Test func aPongReceivedWhileItsPingIsSentKeepsTheSocket() async throws {
    let rig = try Rig(account: "A")
    let socket = FakeLiveConnection()
    let pinging = Gate()
    rig.transport.willOpenLive(GatedPings(socket, gate: pinging))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    rig.clock.advance(ms: 25_000)
    let live = rig.engine.live
    let stepping = Task { await live.step() }
    await pinging.arrival()
    socket.deliver(.pong)
    #expect(await live.receiveNext())
    pinging.open()
    #expect(await stepping.value == .open(ms: 25_000))
    rig.clock.advance(ms: 10_000)
    #expect(await live.step() == .open(ms: 15_000))
    #expect(socket.isClosed == false)
  }

  // The backoff grows with each failed open, and a socket's first pong resets it: the next reopen waits from 1 s again.
  @Test func theBackoffGrowsUntilASocketsFirstPong() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 3)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
    rig.clock.advance(ms: 1_000)
    #expect(await rig.engine.live.step() == .backoff(ms: 2_000))
    rig.clock.advance(ms: 2_000)
    let socket = FakeLiveConnection()
    rig.transport.willOpenLive(socket)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    socket.deliver(.pong)
    #expect(await rig.engine.live.receiveNext())
    socket.end()
    #expect(await rig.engine.live.receiveNext() == false)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
  }

  // MARK: Refused handshakes

  @Test func aHandshake401PausesTheReplica() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willRefuseLive(401)
    #expect(await rig.engine.live.step() == .paused)
    #expect(try rig.meta().authPaused)
    #expect(await rig.engine.live.step() == .paused)
    #expect(rig.transport.calls.count == 1)
  }

  // A handshake 401 to a token the account replaced meanwhile pauses nothing, and the next step opens under the new one.
  @Test func aHandshake401ToATokenReplacedMeanwhilePausesNothing() async throws {
    let rig = try Rig(account: "A")
    let gate = Gate()
    rig.transport.willRefuseLive(401, after: gate)
    let live = rig.engine.live
    let stepping = Task { await live.step() }
    await gate.arrival()
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    gate.open()
    #expect(await stepping.value == .again)
    #expect(try rig.meta().authPaused == false)
    rig.transport.willOpenLive(FakeLiveConnection())
    #expect(await live.step() == .open(ms: 25_000))
    #expect(rig.transport.calls.last == .openLive(token: SessionToken("token-2")))
  }

  // A socket opened for a seat that changed during the handshake (here the app left) closes at once.
  @Test func aSocketOpenedAfterTheAppLeftClosesAtOnce() async throws {
    let rig = try Rig(account: "A")
    let socket = FakeLiveConnection()
    let gate = Gate()
    rig.transport.willOpenLive(socket, after: gate)
    let live = rig.engine.live
    let stepping = Task { await live.step() }
    await gate.arrival()
    try rig.engine.leave()
    gate.open()
    #expect(await stepping.value == .again)
    #expect(socket.isClosed)
    #expect(socket.sent == [])
    #expect(await live.step() == .idle)
  }

  @MainActor @Test func aHandshake426StopsTheChannelForTheProcess() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willRefuseLive(426)
    #expect(await rig.engine.live.step() == .stopped)
    #expect(await rig.engine.live.step() == .stopped)
    #expect(rig.transport.calls.count == 1)
    await rig.engine.settle()
    #expect(rig.engine.status.upgradeRequired)
  }

  // Any other refusal reopens after a backoff.
  @Test func anotherRefusalReopensAfterABackoff() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 1)
    rig.transport.willRefuseLive(503)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
    #expect(rig.transport.calls.count == 1)
  }
}

// A socket whose pings wait at a gate on their way out, so a test can act while one is being sent.
final class GatedPings: LiveConnection {
  let socket: FakeLiveConnection
  let gate: Gate

  init(_ socket: FakeLiveConnection, gate: Gate) {
    self.socket = socket
    self.gate = gate
  }

  func send(_ request: LiveRequest) async throws {
    if request == .ping { await gate.pass() }
    try await socket.send(request)
  }

  func receive() async throws -> LiveFrame? { try await socket.receive() }
  func close() { socket.close() }
}
