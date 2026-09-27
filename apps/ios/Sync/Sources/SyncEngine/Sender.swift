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
  let tokens: any TokenStore
  let random: any RandomSource
  let bindings: [any ProductBinding]
  let answers: PushPlanner
  package nonisolated let wake = Wake()
  var wait = SenderWait()
  var batchLimit: Int?
  var kicksSeen: UInt64 = 0
  var conflicts = 0
  var turn: Int?
  var nextTurn = 0
  var waitingTurns: [(turn: Int, continuation: CheckedContinuation<Void, Never>)] = []

  init(core: EngineCore, transport: any SyncTransport, tokens: any TokenStore, random: any RandomSource,
       bindings: [any ProductBinding]) {
    self.core = core
    self.transport = transport
    self.tokens = tokens
    self.random = random
    self.bindings = bindings
    answers = PushPlanner(registry: core.registry)
  }

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

  // MARK: One round at a time

  package func step(leaving: Bool = false) async -> SenderStep {
    guard let turn = await takeTurn() else { return .idle }
    defer { passTurn(from: turn) }
    return await round(leaving: leaving)
  }

  // Waits for the round in flight to end; nil when the caller is cancelled first.
  func takeTurn() async -> Int? {
    nextTurn += 1
    let mine = nextTurn
    guard turn != nil else {
      turn = mine
      return mine
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        if Task.isCancelled { continuation.resume() } else { waitingTurns.append((mine, continuation)) }
      }
    } onCancel: {
      Task { await self.abandonTurn(mine) }
    }
    return turn == mine ? mine : nil
  }

  func passTurn(from ending: Int) {
    guard turn == ending else { return }
    guard !waitingTurns.isEmpty else {
      turn = nil
      return
    }
    let next = waitingTurns.removeFirst()
    turn = next.turn
    next.continuation.resume()
  }

  func abandonTurn(_ abandoned: Int) {
    guard let index = waitingTurns.firstIndex(where: { $0.turn == abandoned }) else { return }
    waitingTurns.remove(at: index).continuation.resume()
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
      guard let token = tokens.token(for: account) else {
        try core.pauseAuth(seat.replica)
        return .paused
      }
      guard let request = try core.write({ store, _ in try store.number(limit: batchLimit) }) else { return .idle }
      guard request.replica.utf8.elementsEqual(seat.replica.utf8) else { return .again }
      let send = core.clock.wall.reading()
      let reply = await transport.push(request, token: token)
      return try record(reply, to: request, timing: Timing(send: send, recv: core.clock.wall.reading()))
    } catch {
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
  }

  // The answer's transactions in order: the offset sample first, then the results, the ack and the epoch, or the
  // failure's own move. A replica gone since the request (re-identified, signed out) drops the rest of the answer,
  // which then says nothing about the replica now active: the next round looks again.
  func record(_ reply: Reply<PushResponse>, to request: PushRequest, timing: Timing) throws -> SenderStep {
    guard case .answered(let answer) = reply else {
      conflicts = 0
      return .backoff(ms: nextBackoff(floorMs: 0))
    }
    var replica: String? = request.replica
    for step in answers.steps(for: answer, to: request) {
      guard let id = replica else { break }
      if case .halve(let limit, _) = step { batchLimit = limit }
      replica = try core.write { store, instance in
        try store.apply(step, replica: id, instance: &instance, timing: timing, identities: core.identities)
      }
    }
    guard replica != nil else { return .again }
    switch answer {
    case .ok(let response): return next(after: response, to: request)
    case .failed(let failure): return next(after: failure)
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

  // Design §6.3's rows: a 401 pauses; a 400 or 413 was halved or refused, so the next push differs; a conflict
  // re-identified, and a second one in a row backs off; a 426 stops; a 503 sleeps the longer of its `retryAfterMs`, a
  // pause no kick cuts short, and a backoff.
  func next(after failure: HTTPFailure) -> SenderStep {
    conflicts = failure.status == 409 ? conflicts + 1 : 0
    switch failure.status {
    case 401: return .paused
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

  // The ceiling is 30 s while any product's live hint holds, else 300 s; a hint that cannot be read does not hold.
  func nextBackoff(floorMs: Int64) -> Int64 {
    let physNow = try? core.physNow()
    let live = physNow.map { physNow in
      bindings.contains { binding in
        (try? core.read(.product(binding.product)) { try binding.liveHint($0, physNow: physNow) }) == true
      }
    } ?? false
    return wait.backoff(ceilingMs: live ? Constants.backoffLiveCeilingMs : Constants.backoffCeilingMs, floorMs: floorMs, random: random)
  }
}

// §7.4 the sender's wait between pushes. A backoff sleeps `max(floor, random(0, min(ceiling, 1 s · 2^k)))`, then k grows
// by one. Two waits hold every push until they end on the monotonic clock: the time the server asked for (a `retry`, a
// 503), and the backoff after a clock-skew recovery, which only a leave's push goes through. A kick resets k, except
// during the backoff after a clock-skew recovery, which it neither cuts short nor resets.
package struct SenderWait: Sendable {
  package private(set) var k = 0
  var serverAskEnd: Int64?
  var skewBackoffEnd: Int64?

  package init() {}

  package mutating func backoff(ceilingMs: Int64, floorMs: Int64, random: any RandomSource) -> Int64 {
    var bound = Constants.backoffBaseMs
    for _ in 0..<k where bound < ceilingMs { bound *= 2 }
    var draws = Draws(source: random)
    let sleep = Int64.random(in: 0...min(ceilingMs, bound), using: &draws)
    k += 1
    return max(floorMs, sleep)
  }

  package mutating func reset() {
    k = 0
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
    k = earlier.k
    skewBackoffEnd = earlier.skewBackoffEnd
  }

  package mutating func kick(at mono: Int64) {
    if let skewBackoffEnd, mono < skewBackoffEnd { return }
    k = 0
  }

  // The ms left before a round may push at `mono`, nil when it may push now.
  package func pauseLeft(at mono: Int64, leaving: Bool) -> Int64? {
    let ends = [serverAskEnd, leaving ? nil : skewBackoffEnd].compactMap { $0 }.filter { $0 > mono }
    return ends.max().map { $0 - mono }
  }
}
