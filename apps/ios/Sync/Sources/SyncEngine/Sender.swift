import SyncAPI
import SyncCore
import SyncReplica
import SyncStore

// §7.4 the sender: one per device, for the active replica while it is bound, not paused and online. Each round numbers
// ready entries into a push, sends it with the account's token, and records the answer as its ordered transactions
// (design §6.3), each revalidating the entries it names by replica and `n`; the round's outcome says what comes next.
// Rounds are single-flight whoever runs them (the loop, the leave flush, the simulator). No round pushes before the time
// the server last asked it to wait, and none but a leave's first pushes inside the backoff after a clock-skew recovery.

package enum SenderStep: Sendable, Hashable {
  // Push again now.
  case again
  // Nothing to send, offline, no bound replica, or the caller was cancelled before its turn: wait for a kick.
  case idle
  // 401, or no token for the account: wait for re-authentication's kick.
  case paused
  // 426: nothing more is sent by this process.
  case stopped
  // A failure: wait for a kick or `ms`, whichever comes first.
  case backoff(ms: Int64)
  // A pause no kick cuts short, which the server asked for (a `retry` answer, a 503) or which follows a clock-skew
  // recovery: a round before it ends pushes nothing.
  case wait(ms: Int64)
}

package actor Sender {
  let core: EngineCore
  let transport: any SyncTransport
  let answers: PushPlanner
  let turns = Turns()
  var wait = SenderWait()
  var batchLimit: Int?
  var kicksSeen: UInt64 = 0
  var conflicts = 0

  init(core: EngineCore, transport: any SyncTransport) {
    self.core = core
    self.transport = transport
    answers = PushPlanner(registry: core.registry)
  }

  package nonisolated var wake: Wake { core.wakes.sender }

  // The production driver: a kick ends any sleep early, and a round inside a pause answers the rest of it.
  func run() async {
    while !Task.isCancelled {
      let seen = wake.kicks
      switch await step() {
      case .again: continue
      case .idle, .paused, .stopped: await wake.wait(past: seen)
      case .backoff(let ms), .wait(let ms): await wake.wait(past: seen, atMost: .milliseconds(ms), clock: core.clock.sleeper)
      }
    }
  }

  // The leave flush (§7.3): rounds until nothing is left to send or the first that does not push again, with no
  // sleeping. The first pushes whatever backoff is running, and leaves k and the backoff as they were. Cancelling it (the
  // background time running out) ends it at its next turn, or its push with the network.
  func flushOnce() async {
    var leaving = true
    while !Task.isCancelled, await step(leaving: leaving) == .again { leaving = false }
  }

  // One round, once the round in flight has ended.
  package func step(leaving: Bool = false) async -> SenderStep {
    guard await turns.take() else { return .idle }
    defer { turns.pass() }
    return await round(leaving: leaving)
  }

  // MARK: One round

  func round(leaving: Bool) async -> SenderStep {
    let mono = core.clock.wall.reading().mono
    if wake.kicks != kicksSeen {
      kicksSeen = wake.kicks
      wait.kick(at: mono)
    }
    guard !core.upgradeRequired else { return .stopped }
    if let left = wait.pauseLeft(at: mono, leaving: leaving) { return .wait(ms: left) }
    let before = wait
    defer { if leaving { wait.restoreBackoff(from: before) } }
    guard core.connectivity.isOnline else { return .idle }
    do {
      guard let seat = try core.seat(), seat.state == .bound, !seat.authPaused, let account = seat.account else { return .idle }
      guard let token = core.tokens.token(for: account) else { return try core.pauseAuth(seat.replica, sentUnder: nil) ? .paused : .again }
      guard let request = try core.write({ store, _ in try store.number(limit: batchLimit) }) else { return .idle }
      guard request.replica.utf8.elementsEqual(seat.replica.utf8) else { return .again }
      let send = core.clock.wall.reading()
      let reply = await transport.push(request, token: token)
      return try record(reply, to: request, under: token, timing: Timing(send: send, recv: core.clock.wall.reading()))
    } catch {
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  // The answer's transactions in order: the offset sample first, then the results, the ack and the epoch, or the
  // failure's own move; a 401 pauses only while `token` is still the account's. A replica gone since the request
  // (re-identified, signed out) drops the rest of the answer, which then says nothing about the replica now active: the
  // next round looks again. An entry acked at a seq its scope's rows already hold (its own frame came first) has the
  // puller pull the scope, whose page resolves it.
  func record(_ reply: Reply<PushResponse>, to request: PushRequest, under token: SessionToken, timing: Timing) throws -> SenderStep {
    guard case .answered(let answer) = reply else {
      conflicts = 0
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
    var replica: String? = request.replica
    var paused = false
    for step in answers.steps(for: answer, to: request) {
      guard let id = replica else { break }
      if case .halve(let limit, _) = step { batchLimit = limit }
      if step == .pauseAuth {
        paused = try core.pauseAuth(id, sentUnder: token)
        continue
      }
      replica = try core.write { store, instance in
        try store.apply(step, replica: id, instance: &instance, timing: timing, identities: core.identities)
      }
    }
    guard let replica else { return .again }
    switch answer {
    case .ok(let response):
      let resolvable = try core.store.resolvableScopes(of: replica)
      if !resolvable.isEmpty {
        core.pullWants.add(resolvable)
        core.wakes.puller.kick()
      }
      return next(after: response, to: request)
    case .failed(let failure):
      return next(after: failure, paused: paused)
    }
  }

  // A 200 that answers an intent of the request resets the halved batch, and resets `k` unless a result is
  // `clock-skew`. After a clock-skew recovery the sender pauses for a backoff, longer each time in a row, which no kick
  // cuts short, and a `retry` beside it waits no less than it asks. A `retry` alone waits as asked. An answer that
  // answers nothing and asks nothing would bring the same request straight back, so it backs off too.
  func next(after response: PushResponse, to request: PushRequest) -> SenderStep {
    conflicts = 0
    let answered = response.results.filter { result in request.intents.contains { $0.n == result.n } }
    let skewed = answered.contains { $0.verdict == .refused(.clockSkew) }
    if !answered.isEmpty {
      batchLimit = nil
      if !skewed { wait.reset() }
    }
    let mono = core.clock.wall.reading().mono
    let asked = response.retry?.retryAfterMs
    if let asked { wait.serverAsks(until: mono + asked) }
    if skewed {
      let backoff = nextBackoff(floorMs: 0)
      wait.backsOffAfterSkew(until: mono + backoff)
      return .wait(ms: max(backoff, asked ?? 0))
    }
    if let asked { return .wait(ms: asked) }
    return answered.isEmpty ? .backoff(ms: nextBackoff(floorMs: 0)) : .again
  }

  // Design §6.3's rows: a 401 paused, unless the token changed while the push was in flight, and the push goes again
  // under the new one; a 400 or 413 was halved or refused, so the next push differs; a conflict re-identified, and a
  // second one in a row backs off; a 426 stops; a 503 sleeps the longer of its `retryAfterMs`, a pause no kick cuts
  // short, and a backoff.
  func next(after failure: HTTPFailure, paused: Bool) -> SenderStep {
    conflicts = failure.status == 409 ? conflicts + 1 : 0
    switch failure.status {
    case 401: return paused ? .paused : .again
    case 400, 413: return .again
    case 409: return conflicts == 1 ? .again : .backoff(ms: nextBackoff(floorMs: 0))
    case 426:
      core.requireUpgrade()
      return .stopped
    case 503:
      let asked = failure.retryAfterMs ?? 0
      wait.serverAsks(until: core.clock.wall.reading().mono + asked)
      let ms = nextBackoff(floorMs: asked)
      return ms > asked ? .backoff(ms: ms) : .wait(ms: asked)
    default: return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  func nextBackoff(floorMs: Int64) -> Int64 {
    wait.backoff.next(ceilingMs: core.backoffCeilingMs(), floorMs: floorMs, random: core.random)
  }
}

// §7.4 the sender's wait between pushes: its backoff, and two waits that hold every push until they end on the monotonic
// clock: the time the server asked for (a `retry`, a 503), and the backoff after a clock-skew recovery, which only a
// leave's push goes through. A kick resets k, except during the backoff after a clock-skew recovery, which it neither
// cuts short nor resets.
package struct SenderWait: Sendable {
  package var backoff = Backoff()
  var serverAskEnd: Int64?
  var skewBackoffEnd: Int64?

  package init() {}

  package mutating func reset() {
    backoff.reset()
  }

  package mutating func serverAsks(until end: Int64) {
    serverAskEnd = end
  }

  package mutating func backsOffAfterSkew(until end: Int64) {
    skewBackoffEnd = end
  }

  // A leave's push (§7.3) leaves k and the backoff after a clock-skew recovery as they were; a pause the server asked
  // for stays.
  package mutating func restoreBackoff(from earlier: SenderWait) {
    backoff = earlier.backoff
    skewBackoffEnd = earlier.skewBackoffEnd
  }

  package mutating func kick(at mono: Int64) {
    if let skewBackoffEnd, mono < skewBackoffEnd { return }
    backoff.reset()
  }

  // The ms left before a round may push at `mono`, nil when it may push now.
  package func pauseLeft(at mono: Int64, leaving: Bool) -> Int64? {
    let ends = [serverAskEnd, leaving ? nil : skewBackoffEnd].compactMap { $0 }.filter { $0 > mono }
    return ends.max().map { $0 - mono }
  }
}
