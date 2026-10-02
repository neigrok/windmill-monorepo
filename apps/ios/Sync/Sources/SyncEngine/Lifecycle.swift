import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// The replica lifecycle as the app drives it (§7.10, §7.11, design §5.4): engine start with the fork guard, sign-in by
// the lineage rule with its signed-out decisions, sign-out with the bounded flush and Keep or Discard, the replicas left
// dormant, and re-authentication. Each state change is one store transaction; the session token and the fork guard's
// copy change beside them, in an order a death between the two survives.

// MARK: - Engine start

extension EngineCore {
  // Before the first frame (§7.3, §7.11, design §5.1): the store first launched; every held entry released, with no Undo
  // shown; a fresh actor; the fork guard checked against its backup-excluded copy, a copy that differs or is missing
  // re-identifying every replica, and the copy written once the store has committed, so a death between the two costs
  // one more re-identify at the next start and loses nothing. Then every token no sign-in needs is deleted, and a bound
  // replica left with no token is paused.
  func launch(forkGuard: any ForkGuardStore) throws {
    _ = try write { store, _ in try store.firstLaunch(identities: identities) }
    let copy = forkGuard.load()
    let started = try write { store, instance in
      try store.start(backup: copy.map(BackupCopy.held) ?? .missing, instance: &instance, identities: identities)
    }
    if let kept = started.forkGuard, kept != copy { try forkGuard.save(kept) }
    let seat = try seat()
    let needed = [seat?.state == .bound ? seat?.account : nil, started.pendingSignIn].compactMap { $0 }
    for account in tokens.accounts() where !needed.contains(where: { $0.utf8.elementsEqual(account.utf8) }) {
      try? tokens.delete(for: account)
    }
    if let seat, seat.state == .bound, let account = seat.account, tokens.token(for: account) == nil {
      try pauseAuth(seat.replica, sentUnder: nil)
    }
  }
}

extension SyncEngine {
  // MARK: Sign-in (§7.10)

  // Signs in as `account` with its session token, by the lineage rule: every held entry is released first, and a hello
  // as the account says in which products it holds records. The session holds the signed-out decisions due, or is
  // complete when none is, work made signed out having joined the account without asking. Until it completes the
  // sign-in stays pending, nothing is sent, and it resumes at the next engine start. A sign-in pending for another account
  // is replaced, and that account's token deleted. Signing in as the account already signed in re-authenticates it; as
  // another, it throws `signedIn`, and that account signs out first.
  public func signIn(account: String, token: SessionToken) async throws -> SignInSession {
    if let seat = try core.seat(), seat.state == .bound, let current = seat.account {
      guard current.utf8.elementsEqual(account.utf8) else { throw EngineError.signedIn(account: current) }
      try reauthenticate(token: token)
      return SignInSession(engine: self, account: account, holdsRecords: [:], decisions: nil)
    }
    let replaced = try core.store.read { try $0.deviceMeta()?.meta.pendingSignIn }
    try core.tokens.save(token, for: account)
    try core.write { store, _ in try store.beginSignIn(account: account) }
    if let replaced, !replaced.utf8.elementsEqual(account.utf8) { try? core.tokens.delete(for: replaced) }
    return try await continueSignIn(as: account)
  }

  // The pending sign-in, with a new hello and every decision still due; nil when no sign-in is pending.
  public func resumeSignIn() async throws -> SignInSession? {
    guard let account = try core.store.read({ try $0.deviceMeta()?.meta.pendingSignIn }) else { return nil }
    return try await continueSignIn(as: account)
  }

  // The hello as `account`, then the lineage rule before any answer: complete when no decision is due.
  func continueSignIn(as account: String) async throws -> SignInSession {
    let holdsRecords = try await holdsRecords(of: account)
    await seatWillChange()
    let signIn = try core.write { store, _ in
      try store.continueSignIn(account: account, holdsRecords: holdsRecords, answers: [:], counted: [:], identities: core.identities)
    }
    guard let signIn else { throw EngineError.signInEnded }
    if signIn.complete { core.wakes.kickAll() }
    return SignInSession(engine: self, account: account, holdsRecords: holdsRecords, decisions: signIn.complete ? nil : signIn.due)
  }

  // Before each transaction that may change the replica the products write to (Coach D-10).
  func seatWillChange() async {
    for binding in core.bindings { await binding.seatWillChange() }
  }

  // §9.2 a hello as `account`: the products in which it holds records. Sign-in runs only after a hello served as the
  // account (§7.10): one served as anonymous carries no `holdsRecords`, which would read as "holds nothing" and add
  // the signed-out work silently, and one served as another account says nothing of this one. Either refuses the
  // sign-in as a 401 does.
  func holdsRecords(of account: String) async throws -> [String: Bool] {
    guard let token = core.tokens.token(for: account) else { throw EngineError.unauthenticated }
    switch await hello(token: token) {
    case .answered(.ok(let hello)):
      guard !core.upgradeRequired else { throw EngineError.upgradeRequired }
      guard hello.isServed(to: account), let holdsRecords = hello.holdsRecords else { throw EngineError.unauthenticated }
      return holdsRecords
    case .answered(.failed(let failure)) where failure.status == 401: throw EngineError.unauthenticated
    case .answered(.failed(let failure)) where failure.status == 426: throw EngineError.upgradeRequired
    case .answered(.failed), .unreachable: throw EngineError.unreachable
    }
  }

  // §8.2: the account's new token clears the pause a 401 set, and sending, pulling and following live resume. A clearing
  // pulls every subscribed scope and opens the live socket at once, its backoff's `k` reset (§7.5).
  public func reauthenticate(token: SessionToken) throws {
    guard let seat = try core.seat(), seat.state == .bound, let account = seat.account else { throw EngineError.notSignedIn }
    try core.tokens.save(token, for: account)
    if try core.write({ store, _ in try store.reauthenticate() }) {
      core.pullWants.all()
      core.liveReopensAtOnce.store(true, ordering: .releasing)
    }
    core.wakes.kickAll()
  }

  // MARK: Sign-out (§7.10)

  // Signs the account out as far as the person's answer: every held entry is released, the sender flushes what is
  // unsent for at most SIGNOUT_FLUSH_MS and then holds the replica. The session counts what is still unsent, ready or
  // sent (a sent entry may already have landed), plus pending product device work, for the confirmation; the person keeps it,
  // discards it, or cancels and stays signed in. A later sign-out replaces this one.
  public func signOut() async throws -> SignOutSession {
    guard let seat = try core.seat(), seat.state == .bound, let account = seat.account else { throw EngineError.notSignedIn }
    await seatWillChange()
    if try core.write({ store, _ in try store.releaseAll(.signOutRelease) }) { core.wakes.sender.kick() }
    await flush(atMostMs: Constants.signoutFlushMs)
    let hold = await sender.hold(signingOut: account)
    do {
      guard let counted = try core.write({ store, _ in try store.countUnsent(signingOut: account) }) else {
        throw EngineError.notSignedIn
      }
      return SignOutSession(engine: self, account: account, hold: hold, counted: counted)
    } catch {
      await sender.endHold(hold)
      throw error
    }
  }

  // One drain of the outbox, joined with the sender's loop, for at most `ms` on the engine's sleeper; a push still in
  // flight when the time is up is cancelled, and not waited for.
  func flush(atMostMs ms: Int64) async {
    let flushed = Wake()
    let seen = flushed.kicks
    let flush = Task { [sender] in
      await sender.flushOnce()
      flushed.kick()
    }
    await flushed.wait(past: seen, atMost: .milliseconds(ms), clock: core.clock.sleeper)
    flush.cancel()
  }

  // MARK: Dormant replicas

  // What accounts left on this device at sign-out with Keep, each with its unsent entries and pending device work.
  public func dormantReplicas() throws -> [DormantReplica] {
    try core.store.read { try $0.device() }.replicas.compactMap { replica in
      guard replica.meta.state == .dormant, let account = replica.meta.account else { return nil }
      return DormantReplica(
        account: account, ready: replica.outbox.filter { $0.state == .ready }.count,
        sent: replica.outbox.filter { $0.state == .sent }.count, pending: core.store.pendingWork(in: replica).count)
    }
  }

  // §7.10 "Discard unsent": the entries `account` left on this device end discarded. False when it left none.
  @discardableResult
  public func discardDormant(account: String) throws -> Bool {
    try core.write { store, _ in try store.discardDormant(account: account) }
  }
}

// MARK: - Sessions

// A sign-in as `account` (§7.10) waiting for the person's answer to each signed-out decision due, or complete. The
// decisions are values: how they are asked is product canon.
public final class SignInSession: Sendable {
  enum State {
    case open, complete, cancelled
  }

  public let account: String
  // One per product in which the account holds records and work made signed out waits, with that work counted by type:
  // add it to the account or discard it, with no default and no "later". Each answer covers the entries its decision
  // counted.
  public let decisions: [SignedOutDecision]
  let holdsRecords: [String: Bool]
  let engine: SyncEngine
  let state: Mutex<State>

  // Nil decisions: the sign-in is complete.
  init(engine: SyncEngine, account: String, holdsRecords: [String: Bool], decisions: [SignedOutDecision]?) {
    self.engine = engine
    self.account = account
    self.holdsRecords = holdsRecords
    self.decisions = decisions ?? []
    state = Mutex(decisions == nil ? .complete : .open)
  }

  public var isComplete: Bool { state.withLock { $0 == .complete } }

  // Every answer in one transaction: the discards, the bind and the add; then the replica now bound sends, boots its
  // scopes and follows live. Throws `decisionMissing` for a due decision with no answer, `signInChanged` when the entries
  // a decision counted changed since the question was asked (nothing changes: ask again from `resumeSignIn()`), and
  // `signInEnded` once the sign-in was cancelled or another replaced it. Completing a complete sign-in does nothing.
  public func complete(_ answers: [String: LineageAnswer]) async throws {
    switch state.withLock({ $0 }) {
    case .complete: return
    case .cancelled: throw EngineError.signInEnded
    case .open: break
    }
    if let missing = decisions.first(where: { answers[$0.product] == nil }) { throw EngineError.decisionMissing(product: missing.product) }
    await engine.seatWillChange()
    let core = engine.core
    let signIn = try core.write { store, _ in
      try store.continueSignIn(
        account: account, holdsRecords: holdsRecords, answers: answers,
        counted: Dictionary(uniqueKeysWithValues: decisions.map { ($0.product, $0.counted) }), identities: core.identities)
    }
    guard let signIn else { throw EngineError.signInEnded }
    guard signIn.complete else { throw EngineError.signInChanged }
    state.withLock { $0 = .complete }
    core.wakes.kickAll()
  }

  // Leaves the sign-in pending as it stands: nothing more changes, and it resumes at the next engine start.
  public func cancel() {
    state.withLock { if $0 == .open { $0 = .cancelled } }
  }
}

// A sign-out of `account` (§7.10) waiting for the person's finish or Cancel, even with nothing unsent: its unsent entries
// counted after the flush and held from the sender, so the count the confirmation states stays true. It is answered once.
public final class SignOutSession: Sendable {
  enum State {
    case open, finishing, ended
  }

  public let account: String
  public let ready: Int
  // Sent with no answer yet: each may already be in the account.
  public let sent: Int
  public let pending: Int
  // The work identifiers and device-row value digests the confirmation pins for Discard.
  package let counted: [String]
  package let hold: Int
  let engine: SyncEngine
  let state = Mutex(State.open)

  init(engine: SyncEngine, account: String, hold: Int, counted: SignOut) {
    self.engine = engine
    self.account = account
    self.hold = hold
    ready = counted.ready
    sent = counted.sent
    pending = counted.pending
    self.counted = counted.counted
  }

  public var unsent: Int { ready + sent + pending }

  // The finish. Keep, the plain confirm when nothing is unsent, leaves every unsent entry on this device, counted or not,
  // with its durable product device rows dormant until the account signs in here again; Discard deletes the replica and work the confirmation
  // counted, and cannot recall an entry the server already received. Either way acked entries resolve, the account's
  // server caches leave the device, its token is deleted, and the signed-out replica becomes active. Throws `signOutChanged` when
  // unsent entries or pending device values differ from those a Discard counted (nothing changes: ask again from `signOut()`), and
  // `signOutEnded` once this sign-out finished, was cancelled or was replaced. A token that cannot be deleted now is
  // deleted at the next engine start. Answers what the finish covered: the unsent entries as it counted them.
  @discardableResult
  public func finish(_ choice: SignOutChoice) async throws -> SignOut {
    guard state.withLock({ state in
      guard state == .open else { return false }
      state = .finishing
      return true
    }) else { throw EngineError.signOutEnded }
    guard await engine.sender.isHolding(hold) else {
      state.withLock { $0 = .ended }
      throw EngineError.signOutEnded
    }
    await engine.seatWillChange()
    let core = engine.core
    let finished: SignOutFinish
    do {
      finished = try core.write { store, _ in
        try store.finishSignOut(account: account, choice: choice, counted: counted, identities: core.identities)
      }
    } catch {
      state.withLock { $0 = .open }
      throw error
    }
    if case .changed(let counted) = finished {
      state.withLock { $0 = .open }
      throw EngineError.signOutChanged(ready: counted.ready, sent: counted.sent, pending: counted.pending)
    }
    state.withLock { $0 = .ended }
    await engine.sender.endHold(hold)
    guard case .finished(let signedOut) = finished else { throw EngineError.notSignedIn }
    try? core.tokens.delete(for: account)
    core.wakes.kickAll()
    return signedOut
  }

  // The person stays signed in: the sender goes on sending. Does nothing once the sign-out is answered.
  public func cancel() async {
    guard state.withLock({ state in
      guard state == .open else { return false }
      state = .ended
      return true
    }) else { return }
    await engine.sender.endHold(hold)
    engine.core.wakes.sender.kick()
  }
}
