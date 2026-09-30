import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// §7.5 the puller: one per device, for the active replica. Each step applies one live frame from its queue, or pulls
// the scopes wanted in one request and records the answer as its ordered transactions (the offset sample, the epoch,
// then each page, a rows page chunk by chunk), each revalidating the replica it was asked for and the scope's place in
// the subscription set. Each trigger wants its own scopes: engine start, foreground, a live reconnect, the fallback
// timer and a sign-in, a sign-out or a re-identify of the active replica (§7.12) want every subscribed scope; a new
// subscription, and a frame that is not admitted (a live gap), want their own; a page that stops short of the head
// wants its scope again; a scope in doubt is pulled again as its re-pull backoff draws (§7.9). Steps are single-flight
// whoever runs them, so one pull is in flight at a time, a trigger meanwhile only marks its scopes, and a frame and a
// page never race on a cursor.

package enum PullerStep: Sendable, Hashable {
  // A queued frame: its scope, and its outcome, nil when it was dropped (its replica no longer active).
  case frame(ScopeRef, FrameOutcome?)
  // One request answered: each page's scope and outcome, in the answer's order.
  case pulled([PageReport])
  // Look again now: the replica changed while the request was being built or answered, or an answer handled as a 401
  // answered a token the account has replaced since.
  case again
  // Nothing to pull (nothing wanted, no replica that pulls, offline) and no fallback pull ahead, or the caller was
  // cancelled before its turn: wait for a trigger.
  case idle
  // Nothing to pull now, in the foreground: wait for a trigger, or `ms` until the fallback pull.
  case fallback(ms: Int64)
  // Nothing to pull now, in the foreground: wait for a trigger, or `ms` until a re-pull (§7.9) due before the fallback.
  case repull(ms: Int64)
  // An answer handled as a 401 (§9.1), or no token for the account: wait for re-authentication's kick.
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
    // A process starts wanting every subscribed scope.
    var all = true
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
  let core: EngineCore
  let transport: any SyncTransport
  let pages: PageApplier
  package nonisolated let turns = Turns()
  var frames: [(frame: LiveFrame, replica: String)] = []
  var backoff = Backoff()
  // The re-pulls a round took as due whose pull has not ended.
  var repulling: Set<ScopeRef> = []
  // The subscription set as the last round read it: a scope that joins it since is pulled, as a subscribe's is (§7.9).
  var joined: Set<ScopeRef> = []
  var kicksSeen: UInt64 = 0
  var serverAskEnd: Int64?
  var fallbackDue: Int64?

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
      case .fallback(let ms), .repull(let ms), .backoff(let ms):
        await wake.wait(past: seen, atMost: .milliseconds(ms), clock: core.clock.sleeper)
      }
    }
  }

  // A live frame received for `replica`, applied by a later step in the order frames came.
  package func enqueue(_ frame: LiveFrame, for replica: String) {
    frames.append((frame, replica))
    wake.kick()
  }

  // One frame or one request, once the step in flight has ended. A round with nothing to pull in the foreground waits for
  // the fallback pull, or for a re-pull when that is due first; in the background it waits for a trigger, and a round
  // then takes the re-pulls already due (§7.9 Timers).
  package func step() async -> PullerStep {
    guard await turns.take() else { return .idle }
    defer { turns.pass() }
    guard frames.isEmpty else { return apply(frames.removeFirst()) }
    let pulled = await round()
    guard pulled == .idle, core.isForeground else { return pulled }
    let mono = now()
    if let repull = core.doubts.withLock(\.nextDue), repull < fallbackDue ?? .max { return .repull(ms: max(0, repull - mono)) }
    guard let fallbackDue else { return .idle }
    return .fallback(ms: max(0, fallbackDue - mono))
  }

  // MARK: Frames

  // §7.5 step 3 in one transaction; a frame that is not admitted, whose digest check reset the cursor, or a not-found
  // ignored for a tree that waits wants its scope pulled, and one whose alive governing row brought a tree back wants the
  // tree's scopes (§7.9). An ignored end puts its scope in doubt. One that forgot its scope, ended one it ignores, paused
  // the replica, fell outside the set, or brought scopes back has the live channel look again at what it follows.
  func apply(_ queued: (frame: LiveFrame, replica: String)) -> PullerStep {
    guard let scope = queued.frame.scope else { return .again }
    do {
      let applied = try core.write { store, instance in
        try store.apply(queued.frame, replica: queued.replica, subscribed: core.subscriptions(), instance: instance)
      }
      guard let applied else { return .frame(scope, nil) }
      wants.add(applied.next)
      if applied.outcome == .ignored { core.doubts.withLock { $0.end(scope, at: now(), random: core.random) } }
      let brought = applied.next.contains { $0 != scope }
      if brought || [.gone, .notFound, .ignored, .paused, .outside].contains(applied.outcome) { core.wakes.live.kick() }
      return .frame(scope, applied.outcome)
    } catch {
      wants.add([scope])
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  // MARK: One request

  // One request: its scopes, the wanted ones of the subscription set in its order, less those that wait for their
  // governing record's create, which stay wanted and marked; a round left with none sends nothing. The re-pulls due are
  // wanted from then on, and a scope that joined the set since the last round is wanted. The subscription set is
  // reconciled first, so an entry acked in a scope no longer followed resolves (§7.9). The wants are taken after the
  // set is read, and a subscribe opens its scope before it wants it, so a scope wanted is in the set, and a subscribe
  // that lands later leaves its want for the next round.
  func round() async -> PullerStep {
    let mono = now()
    if wake.kicks != kicksSeen {
      kicksSeen = wake.kicks
      backoff.reset()
    }
    guard !core.upgradeRequired else { return .stopped }
    if core.isForeground, let fallbackDue, mono >= fallbackDue {
      self.fallbackDue = nil
      wants.all()
    }
    let due = core.doubts.withLock { $0.due(by: mono) }
    wants.add(due)
    repulling.formUnion(due)
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
      let set = try core.reconcileSubscriptions()
      core.doubts.withLock { $0.keep(Set(set)) }
      repulling.formIntersection(set)
      wants.add(Set(set).subtracting(joined))
      joined = Set(set)
      let wanted = wants.take()
      taken = wanted.all ? set : set.filter(wanted.scopes.contains)
      if wanted.all { fallbackDue = set.isEmpty ? nil : mono + Constants.pullFallbackMs }
      wants.reading(taken)
      guard let planned = try core.store.pullPlan(taken, replica: meta.replica) else {
        wants.add(taken)
        return .again
      }
      wants.add(planned.later)
      wants.read(wanted.scopes.union(taken), waiting: planned.waiting)
      guard let request = planned.request else { return .idle }
      let send = core.clock.wall.reading()
      let reply = await core.answered { [transport, token] in await transport.pull(request, token: token) }
      return try record(reply, to: request, for: meta, under: token, timing: Timing(send: send, recv: core.clock.wall.reading()))
    } catch {
      wants.add(taken)
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  // The answer's transactions in order (§7.5 steps 1–2): the offset sample, the epoch, then each page's chunks; or a
  // failure's sample. An answer handled as a 401 (§9.1: a 401, or a 200 served as anyone but the replica's account)
  // applies nothing past its sample: it pauses while `token` is still the account's, and its scopes are asked again
  // once the account re-authenticates. A chunk that finds its scope stale or outside the set ends its page there. A
  // page wants the scopes it leaves short of the head or brings back; an ignored end puts its scope in doubt, and an
  // applied rows page ends one; the steps after an epoch change's re-identify go to the replica's new id; a replica no
  // longer active, or no longer of the account the request was built as, drops the rest, which says nothing of the
  // replica as it now stands. Each re-pull the request carried has ended, and the live channel looks again.
  func record(_ reply: Reply<PullResponse>, to request: PullRequest, for meta: ReplicaMeta, under token: SessionToken?,
              timing: Timing) throws -> PullerStep {
    let scopes = request.scopes.map(\.scope)
    defer { endRepulls(scopes) }
    guard case .answered(let answer) = reply else {
      wants.add(scopes)
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
    defer { core.wakes.live.kick() }
    var replica = meta.replica
    var reports: [PageReport] = []
    var ended: Set<ScopeRef> = []
    for step in pages.steps(for: answer, to: request, account: meta.account, chunkRows: core.store.limits.chunkRows) {
      if step == .pauseAuth {
        wants.add(scopes)
        return try unauthenticated(replica, under: token)
      }
      if case .page(let page, _, _) = step, ended.contains(page.scope) { continue }
      let asked = replica
      let applied = try core.write { store, instance in
        try store.apply(step, replica: asked, account: meta.account, subscribed: core.subscriptions(), instance: &instance,
                        timing: timing, identities: core.identities)
      }
      guard let applied else { return .again }
      replica = applied.replica
      guard case .page(let page, _, let chunk) = step else { continue }
      wants.add(applied.next)
      guard let outcome = applied.outcome else { continue }
      if !chunk.isLast { ended.insert(page.scope) }
      reports.append(PageReport(scope: page.scope, outcome: outcome))
      doubt(page, outcome)
    }
    switch answer {
    case .ok:
      backoff.reset()
      return .pulled(reports)
    case .failed(let failure):
      wants.add(scopes)
      return next(after: failure)
    }
  }

  // §7.9: an ignored end puts its scope in doubt; an applied rows page ends the doubt.
  func doubt(_ page: PullPage, _ outcome: PageOutcome) {
    switch (outcome, page.body) {
    case (.ignored, _): core.doubts.withLock { $0.end(page.scope, at: now(), random: core.random) }
    case (.applied, .rows): core.doubts.withLock { $0.rows(page.scope) }
    default: break
    }
  }

  // The re-pulls among `scopes` have ended: each scope still in doubt draws its next.
  func endRepulls(_ scopes: [ScopeRef]) {
    let ended = repulling.intersection(scopes)
    repulling.subtract(ended)
    let mono = now()
    core.doubts.withLock { doubts in
      for scope in ended.sorted() { doubts.repulled(scope, at: mono, random: core.random) }
    }
  }

  // Design §6.3's puller column for an answer handled as a 401: it paused the replica, unless the token changed while the
  // pull was in flight, and the pull goes again under the new one. One to a signed-out pull, which pauses nothing, backs
  // off.
  func unauthenticated(_ replica: String, under token: SessionToken?) throws -> PullerStep {
    guard token != nil else { return .backoff(ms: nextBackoff(floorMs: 0)) }
    return try core.pauseAuth(replica, sentUnder: token) ? .paused : .again
  }

  // The puller column's other failures: a 426 stops; a 503 pauses every pull for its `retryAfterMs`, a pause no kick cuts
  // short, and backs off no less; anything else backs off.
  func next(after failure: HTTPFailure) -> PullerStep {
    switch failure.status {
    case 426:
      core.requireUpgrade()
      return .stopped
    case 503:
      let asked = failure.retryAfterMs ?? 0
      serverAskEnd = now() + asked
      return .backoff(ms: nextBackoff(floorMs: asked))
    default:
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  func nextBackoff(floorMs: Int64) -> Int64 {
    backoff.next(ceilingMs: core.backoffCeilingMs(), floorMs: floorMs, random: core.random)
  }

  func now() -> Int64 {
    core.clock.wall.reading().mono
  }
}
