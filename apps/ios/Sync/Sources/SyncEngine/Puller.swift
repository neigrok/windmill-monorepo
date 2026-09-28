import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// §7.5 the puller: one per device, for the active replica. Each step applies one live frame from its queue, or pulls
// the scopes wanted in one request and records the answer as its ordered transactions (the offset sample, the epoch,
// then one per page), each revalidating the replica it was asked for and the scope's subscription. Each trigger wants
// its own scopes: engine start, foreground, a live reconnect and the fallback timer want every subscribed scope; a new
// subscription, and a frame that is not admitted (a live gap), want their own; a page that stops short of the head
// wants its scope again. A new seat wants every scope again. Steps are single-flight whoever runs them, so a frame and
// a page never race on a cursor.

package enum PullerStep: Sendable, Hashable {
  // A queued frame: its scope, and its outcome, nil when it was dropped (its replica or subscription gone).
  case frame(ScopeRef, FrameOutcome?)
  // One request answered: each page's scope and outcome, in the answer's order.
  case pulled([PageReport])
  // Look again now: the replica changed while the request was being built or answered, or a 401 answered a token the
  // account has replaced since.
  case again
  // Nothing to pull (nothing wanted, no replica that pulls, offline) and no fallback pull ahead, or the caller was
  // cancelled before its turn: wait for a trigger.
  case idle
  // Nothing to pull now, in the foreground: wait for a trigger, or `ms` until the fallback pull.
  case fallback(ms: Int64)
  // 401, or no token for the account: wait for re-authentication's kick.
  case paused
  // 426: nothing more is pulled by this process.
  case stopped
  // A failure, or the pause a 503 asked for: wait for a kick or `ms`.
  case backoff(ms: Int64)
}

package struct PageReport: Sendable, Hashable {
  package let scope: ScopeRef
  package let outcome: PageOutcome

  package init(scope: ScopeRef, outcome: PageOutcome) {
    self.scope = scope
    self.outcome = outcome
  }
}

// The scopes the puller is asked to pull next, which any thread adds to: every subscribed scope, or some. Beside them, the
// tree and overlay scopes that wait for their governing record's create (§7.9), or that a round is reading and may find
// waiting: while any is marked, an outbox change wakes the puller, which pulls each once it waits no more. A round marks
// its scopes before it reads the outbox, so a create's result landing while it reads is never missed.
package final class PullWants: Sendable {
  struct State {
    var all = false
    var scopes: Set<ScopeRef> = []
    var waiting: Set<ScopeRef> = []
  }

  let state = Mutex(State())

  package func all() {
    state.withLock { $0.all = true }
  }

  package func add(_ scopes: some Sequence<ScopeRef>) {
    state.withLock { $0.scopes.formUnion(scopes) }
  }

  package var isWaiting: Bool { state.withLock { !$0.waiting.isEmpty } }

  // Takes every want: whether every subscribed scope is wanted, and the scopes wanted, the waiting ones among them. The
  // waiting stay marked until the round has read them.
  package func take() -> (all: Bool, scopes: Set<ScopeRef>) {
    state.withLock { state in
      defer {
        state.all = false
        state.scopes = []
      }
      return (state.all, state.scopes.union(state.waiting))
    }
  }

  // A round's tree and overlay scopes, marked before it reads whether they wait.
  package func reading(_ scopes: some Sequence<ScopeRef>) {
    state.withLock { $0.waiting.formUnion(scopes.filter { $0.tree != nil }) }
  }

  // The round has read `scopes`: those in `waiting` stay marked, the rest are marked no more.
  package func read(_ scopes: some Sequence<ScopeRef>, waiting: some Sequence<ScopeRef>) {
    state.withLock { state in
      state.waiting.subtract(scopes)
      state.waiting.formUnion(waiting)
    }
  }
}

package actor Puller {
  // The seat a round pulls for. Another replica (a re-identify, whether an epoch change's or a 409's, or a sign-in or
  // out) or another account wants every scope again.
  struct Seat: Equatable {
    let replica: [UInt8]
    let state: ReplicaMeta.State
    let account: [UInt8]?

    init(_ meta: ReplicaMeta) {
      replica = Array(meta.replica.utf8)
      state = meta.state
      account = meta.account.map { Array($0.utf8) }
    }
  }

  let core: EngineCore
  let transport: any SyncTransport
  let pages: PageApplier
  package nonisolated let turns = Turns()
  var frames: [(frame: LiveFrame, replica: String)] = []
  var backoff = Backoff()
  var kicksSeen: UInt64 = 0
  var serverAskEnd: Int64?
  var fallbackDue: Int64?
  var seat: Seat?

  init(core: EngineCore, transport: any SyncTransport) {
    self.core = core
    self.transport = transport
    pages = PageApplier(registry: core.registry)
  }

  package nonisolated var wake: Wake { core.wakes.puller }
  package nonisolated var wants: PullWants { core.pullWants }

  // The production driver: a kick ends any sleep early.
  func run() async {
    while !Task.isCancelled {
      let seen = wake.kicks
      switch await step() {
      case .frame, .pulled, .again: continue
      case .idle, .paused, .stopped: await wake.wait(past: seen)
      case .fallback(let ms), .backoff(let ms): await wake.wait(past: seen, atMost: .milliseconds(ms), clock: core.clock.sleeper)
      }
    }
  }

  // A live frame received for `replica`, applied by a later step in the order frames came.
  package func enqueue(_ frame: LiveFrame, for replica: String) {
    frames.append((frame, replica))
    wake.kick()
  }

  // One frame or one request, once the step in flight has ended. A round with nothing to pull in the foreground waits for
  // the fallback pull, which a later round takes when it is due, whether it pulls or not.
  package func step() async -> PullerStep {
    guard await turns.take() else { return .idle }
    defer { turns.pass() }
    guard frames.isEmpty else { return apply(frames.removeFirst()) }
    let pulled = await round()
    guard pulled == .idle, core.isForeground, let fallbackDue else { return pulled }
    return .fallback(ms: max(0, fallbackDue - core.clock.wall.reading().mono))
  }

  // MARK: Frames

  // §7.5 step 3 in one transaction; a frame that is not admitted, or whose digest check reset the cursor, wants its scope
  // pulled. One that forgot its scope, or a not-found ignored while its scope waits (§7.9), has the live channel look
  // again at what it follows, so it stops following the scope, and follows a waiting one anew once it is pulled.
  func apply(_ queued: (frame: LiveFrame, replica: String)) -> PullerStep {
    guard let scope = queued.frame.scope else { return .again }
    do {
      let applied = try core.write { store, instance in
        let subscribed = try core.seat().map { core.subscriptions(of: $0) } ?? []
        return try store.apply(queued.frame, replica: queued.replica, subscribed: Set(subscribed), instance: instance)
      }
      guard let applied else { return .frame(scope, nil) }
      if applied.pullsAgain { wants.add([scope]) }
      if [.gone, .notFound, .ignored].contains(applied.outcome) { core.wakes.live.kick() }
      return .frame(scope, applied.outcome)
    } catch {
      wants.add([scope])
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  // MARK: One request

  // One request: its scopes, the wanted subscribed ones in subscription order, less those that wait for their governing
  // record's create, which stay wanted and marked; a round left with none sends nothing. The subscriptions are reconciled
  // first, so an entry acked in a scope no longer followed resolves (§7.9). The wants are taken before the subscriptions
  // are read, since a subscribe opens its scope before it wants it: a scope wanted is subscribed, and a subscribe that
  // lands later leaves its want for the next round.
  func round() async -> PullerStep {
    let mono = core.clock.wall.reading().mono
    if wake.kicks != kicksSeen {
      kicksSeen = wake.kicks
      backoff.reset()
    }
    guard !core.upgradeRequired else { return .stopped }
    if core.isForeground, let fallbackDue, mono >= fallbackDue {
      self.fallbackDue = nil
      wants.all()
    }
    if let serverAskEnd, serverAskEnd > mono { return .backoff(ms: serverAskEnd - mono) }
    guard core.connectivity.isOnline else { return .idle }
    var taken: [ScopeRef] = []
    do {
      guard let meta = try core.seat() else { return .idle }
      var token: SessionToken?
      if meta.state == .bound {
        guard !meta.authPaused, let account = meta.account else { return .paused }
        guard let found = core.tokens.token(for: account) else { return try core.pauseAuth(meta.replica, sentUnder: nil) ? .paused : .again }
        token = found
      }
      if Seat(meta) != seat {
        seat = Seat(meta)
        wants.all()
      }
      try core.reconcileSubscriptions()
      let wanted = wants.take()
      let subscribed = core.subscriptions(of: meta)
      taken = wanted.all ? subscribed : subscribed.filter(wanted.scopes.contains)
      if wanted.all { fallbackDue = subscribed.isEmpty ? nil : mono + Constants.pullFallbackMs }
      wants.reading(taken)
      guard let planned = try core.store.pullPlan(taken, replica: meta.replica) else {
        wants.add(taken)
        return .again
      }
      wants.add(planned.later)
      wants.read(wanted.scopes.union(taken), waiting: planned.waiting)
      guard let request = planned.request else { return .idle }
      let send = core.clock.wall.reading()
      let reply = await transport.pull(request, token: token)
      return try record(reply, to: request, for: meta, under: token, timing: Timing(send: send, recv: core.clock.wall.reading()))
    } catch {
      wants.add(taken)
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  // The answer's transactions in order (§7.5 steps 1–2): the offset sample, the epoch, then one per page; or a failure's
  // sample, and for a 401 a pause while `token` is still the account's. A page of the account's own product answered as
  // no one's pauses the same way, since the server did not take the token, and the rest of that answer, which says
  // nothing of the account's scopes, is dropped and asked again. A page that leaves its scope short of the head
  // wants it again; an epoch change re-identified the replica and nulled every cursor, so every scope is wanted; a
  // replica no longer active drops the rest, which says nothing of the replica now active. The live channel then looks
  // again at what it follows.
  func record(_ reply: Reply<PullResponse>, to request: PullRequest, for meta: ReplicaMeta, under token: SessionToken?,
              timing: Timing) throws -> PullerStep {
    let scopes = request.scopes.map(\.scope)
    guard case .answered(let answer) = reply else {
      wants.add(scopes)
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
    defer { core.wakes.live.kick() }
    var replica = meta.replica
    var reports: [PageReport] = []
    var paused = false
    for step in pages.steps(for: answer, to: request) {
      if step == .pauseAuth {
        paused = try core.pauseAuth(replica, sentUnder: token)
        continue
      }
      let asked = replica
      let applied = try core.write { store, instance in
        try store.apply(step, replica: asked, subscribed: Set(core.subscriptions(of: meta)), instance: &instance, timing: timing,
                        identities: core.identities)
      }
      guard let applied else { return .again }
      if !applied.replica.utf8.elementsEqual(asked.utf8) {
        replica = applied.replica
        wants.all()
      }
      guard case .page(let page, _) = step, let outcome = applied.outcome else { continue }
      reports.append(PageReport(scope: page.scope, outcome: outcome))
      if applied.pullsAgain { wants.add([page.scope]) }
      if outcome == .unauthenticated, token != nil {
        paused = try core.pauseAuth(replica, sentUnder: token)
        wants.add(scopes)
        break
      }
    }
    switch answer {
    case .ok:
      backoff.reset()
      return .pulled(reports)
    case .failed(let failure):
      wants.add(scopes)
      return next(after: failure, paused: paused, signedOut: token == nil)
    }
  }

  // Design §6.3's puller column: a 401 paused the replica, unless the token changed while the pull was in flight, and
  // the pull goes again under the new one; one to a signed-out pull, which pauses nothing, backs off; a 426 stops; a 503
  // pauses every pull for its `retryAfterMs`, a pause no kick cuts short, and backs off no less; anything else backs off.
  func next(after failure: HTTPFailure, paused: Bool, signedOut: Bool) -> PullerStep {
    switch failure.status {
    case 401 where signedOut:
      return .backoff(ms: nextBackoff(floorMs: 0))
    case 401:
      return paused ? .paused : .again
    case 426:
      core.requireUpgrade()
      return .stopped
    case 503:
      let asked = failure.retryAfterMs ?? 0
      serverAskEnd = core.clock.wall.reading().mono + asked
      return .backoff(ms: nextBackoff(floorMs: asked))
    default:
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  func nextBackoff(floorMs: Int64) -> Int64 {
    backoff.next(ceilingMs: core.backoffCeilingMs(), floorMs: floorMs, random: core.random)
  }
}
