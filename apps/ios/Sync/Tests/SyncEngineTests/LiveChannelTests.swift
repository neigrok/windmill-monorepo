import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// §7.5 and §9.5 the live channel over a scripted transport and a fake socket: when a socket is wanted, what it follows,
// the reconnect pull after a failed open and a socket that ends and none after a close the client makes, the heartbeat,
// the frames it hands the puller, and how it reopens, pauses and stops.

struct LiveChannelTests {
  static let tree = ScopeRef.tree("b_00000001")
  static let overlay = ScopeRef.overlay("b_00000001")

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

  // On open it follows every subscribed scope, and pulls nothing: an open is no pull trigger (§7.5).
  @Test func anOpenSocketFollowsTheSubscriptionsAndPullsNothing() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    let socket = FakeLiveConnection()
    rig.transport.willOpenLive(socket)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope])])
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    #expect(rig.transport.pulls.count == 1)
  }

  // A close the client makes pulls nothing, going offline or leaving, and nor does the open after it; the foreground is
  // a pull trigger of its own. Nothing to pull in the foreground waits for the fallback pull; in the background, for a
  // trigger.
  @Test func aCloseTheClientMakesPullsNothing() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    let first = FakeLiveConnection()
    rig.transport.willOpenLive(first)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    rig.connectivity.set(online: false)
    #expect(await rig.engine.live.step() == .idle)
    #expect(first.isClosed)
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    rig.connectivity.set(online: true)
    let second = FakeLiveConnection()
    rig.transport.willOpenLive(second)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    try rig.engine.leave()
    #expect(await rig.engine.live.step() == .idle)
    #expect(second.isClosed)
    #expect(await rig.engine.puller.step() == .idle)
    #expect(rig.transport.pulls.count == 1)
    rig.engine.foreground()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
  }

  // It follows a new subscription, and stops following a scope the replica learns is gone.
  @Test func itFollowsNewSubscriptionsAndDropsScopesKnownGone() async throws {
    let (rig, socket) = try await Self.open()
    try rig.engine.subscribe(Self.tree)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    await rig.engine.puller.enqueue(.gone(Self.tree, servedAs: "A"), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .gone))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.tree]), .unsub([Self.tree])])
  }

  // §7.9: a tree whose board's create is in the outbox is not followed, nor its overlay, and a not-found frame for the
  // tree is ignored, so nothing is known of it, and the tree is in doubt. The create's result wakes the channel, which
  // then follows the overlay; the tree it follows once a rows page of it has ended the doubt.
  @Test func aTreeWaitingForItsBoardsCreateIsFollowedOnceTheCreateHasItsResultAndItsDoubtEnded() async throws {
    let (rig, socket) = try await Self.open()
    try rig.commit(Gesture(changes: [.create("board", id: .given("b_00000001"))]))
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    #expect(rig.transport.pulls == [PullRequest(scopes: [PullRequest.Pulled(scope: Rig.scope, cursor: nil)])])
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    await rig.engine.puller.enqueue(.notFound(Self.tree, servedAs: "A"), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .ignored))
    #expect(try rig.active().known == [:])
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope])])
    let kicks = rig.engine.live.wake.kicks
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(rig.engine.live.wake.kicks > kicks)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.overlay])])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0), Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([
      PageReport(scope: Self.tree, outcome: .applied), PageReport(scope: Self.overlay, outcome: .applied),
    ]))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.overlay]), .sub([Self.tree])])
  }

  // §6.8, §7.9: the socket subscribed the tree before its board reached the server, which answered not-found and kept no
  // subscription. The frame lands after the board's create is acked, so it is ignored, and the tree is in doubt: no `sub`
  // goes out for it, while the overlay that joined with the board is followed. The next pull brings the tree's rows,
  // which ends the doubt, and the tree is followed again.
  @Test func aTreeWhoseStaleNotFoundFrameIsIgnoredIsSubscribedAgainOnceItsRowsCame() async throws {
    let (rig, socket) = try await Self.open()
    try rig.engine.subscribe(Self.tree)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    try rig.commit(Gesture(changes: [.create("board", id: .given("b_00000001"))], gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    socket.deliver(.notFound(Self.tree, servedAs: "A"))
    #expect(await rig.engine.live.receiveNext())
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .ignored))
    #expect(try rig.active().known == [:])
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.tree]), .sub([Self.overlay])])
    rig.transport.willAnswerPull(200, Rig.pulled([
      Rig.rows([try PullerTests.board(seq: 1)], seq: 1), Rig.rows(in: Self.tree, seq: 0), Rig.rows(in: Self.overlay, seq: 0),
    ]))
    #expect(await rig.engine.puller.step() == .pulled([
      PageReport(scope: Rig.scope, outcome: .applied), PageReport(scope: Self.tree, outcome: .applied),
      PageReport(scope: Self.overlay, outcome: .applied),
    ]))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [
      PullRequest.Pulled(scope: Rig.scope, cursor: nil), PullRequest.Pulled(scope: Self.tree, cursor: nil),
      PullRequest.Pulled(scope: Self.overlay, cursor: nil),
    ]))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.tree]), .sub([Self.overlay]), .sub([Self.tree])])
  }

  // §6.8, §7.9: an ignored end frame drops its scope from what the socket follows and puts it in doubt: no `sub` goes out
  // for it until a rows page of it is applied, which ends the doubt, and the next keep sends `sub` again.
  @Test(arguments: [KnownKind.gone, .notFound])
  func anIgnoredEndFrameIsSubscribedAgainOnlyOnceARowsPageEndsItsDoubt(_ kind: KnownKind) async throws {
    let (rig, socket) = try await Self.open()
    socket.deliver(kind == .gone ? .gone(Rig.scope, servedAs: "A") : .notFound(Rig.scope, servedAs: "A"))
    #expect(await rig.engine.live.receiveNext())
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .ignored))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope])])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Rig.scope])])
  }

  // An ignored end page leaves the scope followed, if it was, through its doubt, and the socket sends no `sub` for it.
  @Test func anIgnoredEndPageLeavesItsScopeFollowed() async throws {
    let (rig, socket) = try await Self.open()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope])])
    #expect(rig.engine.doubts.inDoubt(Rig.scope))
  }

  // §7.9: a gone or not-found frame ends the scope's followed stretch as it arrives; one of 31 s returns its k to 0, so
  // the doubt the frame starts draws from k = 0 again.
  @Test func aFrameStartedDoubtAfterThirtySecondsFollowedDrawsFromKZero() async throws {
    let (rig, socket) = try await Self.open()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    socket.deliver(.notFound(Rig.scope, servedAs: "A"))
    #expect(await rig.engine.live.receiveNext())
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .ignored))
    #expect(rig.engine.doubts.k(Rig.scope) == 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    rig.engine.puller.wants.add([Rig.scope])
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    #expect(!rig.engine.doubts.inDoubt(Rig.scope))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Rig.scope])])
    rig.clock.advance(ms: 31_000)
    socket.deliver(.notFound(Rig.scope, servedAs: "A"))
    #expect(await rig.engine.live.receiveNext())
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .ignored))
    #expect(rig.engine.doubts.k(Rig.scope) == 1)
  }

  // A close the client makes ends the scope's followed stretch: 10 s followed, then 25 s closed, is no stretch of 30 s,
  // so the next ignored end draws on the scope's k as it stood.
  @Test func aCloseEndsTheFollowedStretch() async throws {
    let (rig, _) = try await Self.open()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    rig.engine.puller.wants.add([Rig.scope])
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    rig.clock.advance(ms: 10_000)
    try rig.engine.leave()
    #expect(await rig.engine.live.step() == .idle)
    rig.clock.advance(ms: 25_000)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")]))
    rig.engine.puller.wants.add([Rig.scope])
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    #expect(rig.engine.doubts.k(Rig.scope) == 2)
  }

  // §6.8, §7.9: an applied end frame sends no `unsub`; a subscribe sends `sub` again for a tree not found, not one gone.
  @Test(arguments: [KnownKind.gone, .notFound])
  func anAppliedEndFrameIsFollowedNoMoreWithoutAnUnsub(_ kind: KnownKind) async throws {
    let (rig, socket) = try await Self.open()
    try rig.engine.subscribe(Self.tree)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    socket.deliver(kind == .gone ? .gone(Self.tree, servedAs: "A") : .notFound(Self.tree, servedAs: "A"))
    #expect(await rig.engine.live.receiveNext())
    #expect(await rig.engine.puller.step() == .frame(Self.tree, kind == .gone ? .gone : .notFound))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.tree])])
    #expect(try rig.engine.subscribe(Self.tree) == (kind == .gone ? .gone : .subscribed))
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    let resubscribed: [LiveRequest] = kind == .gone ? [] : [.sub([Self.tree])]
    #expect(socket.sent == [.sub([Rig.scope]), .sub([Self.tree])] + resubscribed)
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

  // The leave flush ends by closing the socket while the app is away; in the foreground again by then, it keeps it.
  @Test func theLeaveFlushClosesTheSocketUnlessTheAppCameBack() async throws {
    let (rig, socket) = try await Self.open()
    try rig.engine.leave()
    rig.engine.foreground()
    await rig.engine.flushOnLeave()
    #expect(!socket.isClosed)
    try rig.engine.leave()
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

  // Change, gone and not-found frames go to the puller's queue, which applies nothing of one outside the subscription set;
  // a pong keeps the heartbeat, and other ops are ignored.
  @Test func framesGoToThePullerAndOtherOpsAreIgnored() async throws {
    let (rig, socket) = try await Self.open()
    try socket.deliver(["op": "presence", "scope": "self/probe", "who": "B"])
    socket.deliver(.pong)
    socket.deliver(.notFound(Self.tree, servedAs: "A"))
    for _ in 0..<3 { #expect(await rig.engine.live.receiveNext()) }
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .outside))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
  }

  // §9.1, §7.5: a change, gone or not-found frame served as anyone but the socket's account (anonymous, or another
  // account) closes the socket at once and pauses the replica: nothing it sent is handed to the puller, and no socket
  // opens again until the account re-authenticates.
  @Test(arguments: [nil, "B"] as [String?])
  func aFrameServedAsAnotherPrincipalClosesTheSocketAndPauses(_ served: String?) async throws {
    let (rig, socket) = try await Self.open()
    socket.deliver(.notFound(Rig.scope, servedAs: served))
    socket.deliver(.notFound(Self.tree, servedAs: "A"))
    #expect(await rig.engine.live.receiveNext())
    #expect(socket.isClosed)
    #expect(await rig.engine.live.receiveNext() == false)
    #expect(try rig.meta().authPaused)
    #expect(await rig.engine.puller.step() == .paused)
    #expect(try rig.active().known == [:])
    #expect(await rig.engine.live.step() == .paused)
    #expect(rig.transport.calls.filter { if case .openLive = $0 { true } else { false } }.count == 1)
  }

  // A frame served as another to a socket opened under a token the account has replaced since pauses nothing: the socket
  // closes, and the next opens under the new token.
  @Test func aFrameServedAsAnotherToAReplacedTokenReopensUnderTheNewOne() async throws {
    let (rig, socket) = try await Self.open()
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    socket.deliver(.gone(Rig.scope, servedAs: "B"))
    #expect(await rig.engine.live.receiveNext())
    #expect(socket.isClosed)
    #expect(try !rig.meta().authPaused)
    rig.transport.willOpenLive(FakeLiveConnection())
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(rig.transport.calls.last == .openLive(token: SessionToken("token-2")))
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

  // The ping waits LIVE_PING_MS from the last frame or pong heard, whatever the frame.
  @Test func anyFrameHeardPutsTheNextPingOff() async throws {
    let (rig, socket) = try await Self.open()
    rig.clock.advance(ms: 20_000)
    try socket.deliver(["op": "presence", "scope": "self/probe", "who": "B"])
    #expect(await rig.engine.live.receiveNext())
    rig.clock.advance(ms: 5_000)
    #expect(await rig.engine.live.step() == .open(ms: 20_000))
    rig.clock.advance(ms: 20_000)
    #expect(await rig.engine.live.step() == .open(ms: 10_000))
    #expect(socket.sent == [.sub([Rig.scope]), .ping])
  }

  // A pong the reader receives while the ping is still being sent keeps the socket: the ping's deadline is set before
  // the send, not after it.
  @Test(.timeLimit(.minutes(1))) func aPongReceivedWhileItsPingIsSentKeepsTheSocket() async throws {
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

  // An open that fails, and a socket that ends, count as a reconnect: the puller pulls every scope at once. The open
  // between them pulls nothing.
  @Test func aFailedOpenAndAnEndedSocketPullEveryScopeAtOnce() async throws {
    let rig = try Rig(account: "A")
    let pulled = PullerStep.pulled([PageReport(scope: Rig.scope, outcome: .applied)])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == pulled)
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    rig.random.queue(raw: .max, count: 2)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == pulled)
    rig.clock.advance(ms: 1_000)
    let socket = FakeLiveConnection()
    rig.transport.willOpenLive(socket)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs - 1_000))
    socket.end()
    #expect(await rig.engine.live.receiveNext() == false)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == pulled)
    #expect(rig.transport.pulls.count == 3)
  }

  // Reopening backs off with the channel's own k up to its own 30 s ceiling, whatever the sender's; k resets once a
  // socket has stayed open 30 s, so only then does the next reopen wait from 1 s again.
  @Test func theReopenBackoffStopsAtThirtySecondsAndResetsOnceASocketStaysOpenThirtySeconds() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 9)
    var waits: [Int64] = []
    for _ in 0..<7 {
      guard case .backoff(let ms) = await rig.engine.live.step() else { throw RigError("the open did not fail") }
      waits.append(ms)
      rig.clock.advance(ms: ms)
    }
    #expect(waits == [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    let brief = FakeLiveConnection()
    rig.transport.willOpenLive(brief)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    rig.clock.advance(ms: 29_999)
    brief.end()
    #expect(await rig.engine.live.receiveNext() == false)
    #expect(await rig.engine.live.step() == .backoff(ms: 30_000))
    rig.clock.advance(ms: 30_000)
    let settled = FakeLiveConnection()
    rig.transport.willOpenLive(settled)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    rig.clock.advance(ms: 30_000)
    settled.end()
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

  // A handshake 401 is an open that fails, a reconnect: every scope is pulled once the account re-authenticates, though
  // the socket that then opens pulls nothing.
  @Test func aHandshake401IsAReconnectWhosePullRunsOnceReauthenticated() async throws {
    let rig = try Rig(account: "A")
    let pulled = PullerStep.pulled([PageReport(scope: Rig.scope, outcome: .applied)])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == pulled)
    rig.transport.willRefuseLive(401)
    #expect(await rig.engine.live.step() == .paused)
    #expect(await rig.engine.puller.step() == .paused)
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    rig.transport.willOpenLive(FakeLiveConnection())
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == pulled)
    #expect(rig.transport.pulls.count == 2)
  }

  // §7.5: a re-authentication that clears the pause opens the socket at once with `k` reset, so the socket's next reopen
  // waits from 1 s, whatever the reopens before the pause had raised `k` to.
  @Test func aReauthenticationReopensTheSocketAtOnceWithItsBackoffReset() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 3)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
    rig.clock.advance(ms: 1_000)
    #expect(await rig.engine.live.step() == .backoff(ms: 2_000))
    rig.clock.advance(ms: 2_000)
    rig.transport.willRefuseLive(401)
    #expect(await rig.engine.live.step() == .paused)
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    let socket = FakeLiveConnection()
    rig.transport.willOpenLive(socket)
    #expect(await rig.engine.live.step() == .open(ms: 25_000))
    socket.end()
    #expect(await rig.engine.live.receiveNext() == false)
    #expect(await rig.engine.live.step() == .backoff(ms: 1_000))
  }

  // A handshake 401 to a token the account replaced meanwhile pauses nothing, and the next step opens under the new one.
  @Test(.timeLimit(.minutes(1))) func aHandshake401ToATokenReplacedMeanwhilePausesNothing() async throws {
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
  @Test(.timeLimit(.minutes(1))) func aSocketOpenedAfterTheAppLeftClosesAtOnce() async throws {
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
