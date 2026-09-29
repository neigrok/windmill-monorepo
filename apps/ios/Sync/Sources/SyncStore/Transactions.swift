import SyncAPI
import SyncCore
import SyncReplica

// The design's §3.5 table: one Action per transaction, each an ordered load → plan → batch inside one `write`; a commit
// that mints ids its load did not cover loads them all and plans again. The runtime calls these; a crash between any two of
// them loses nothing.

extension Store {
  // MARK: Writing (§7.1, §7.3)

  // §8.2 first launch: a store holding no device row gets an anon replica, active. The active replica's id.
  public func firstLaunch(identities: IdentitySource) throws -> Written<String> {
    try write(.firstLaunch) { tx in
      if let device = try tx.deviceMeta() { return Planned(device.active, ReplicaBatch()) }
      let device = try planners.lifecycle.firstLaunch(identities: identities)
      return Planned(device.active, device.batch)
    }
  }

  // §7.1 read-and-commit: step 1, then `decide` through this transaction, then steps 2–11 over the rows the decided
  // gesture reads and the entries that touch them. The ids the commit mints are read by their keys once drawn: a plan
  // that drew ids its load did not read is planned again over the same draws with those records read, and a gesture id
  // it mints is drawn again while the device carries it. A nil gesture writes nothing and ticks no clock.
  public func commit<T>(in scope: ScopeRef, instance: Instance, identities: IdentitySource,
                        _ decide: (StoreTransaction) throws -> (Gesture?, T)) throws -> Written<(outcome: CommitOutcome?, value: T)> {
    try write(.commit) { tx in
      let active = try tx.activeReplica()
      guard let meta = try tx.meta(of: active) else { throw StoreError.noReplica(active) }
      try planners.commits.checkWritable(meta)
      let (gesture, value) = try decide(tx)
      guard let gesture else { return Planned((nil, value), ReplicaBatch()) }
      let gestureIdTaken = try gesture.gestureId.map(tx.carries(gestureId:)) ?? false
      let identities = UniqueGestureIDs(identities, carries: tx.carries(gestureId:))
      var reads = planners.commits.reads(of: gesture, in: scope)
      var draws: [Draw] = []
      while true {
        var replica = try loaded(active, in: tx, reads: reads, entries: planners.commits.entryReads(of: gesture))
        do {
          let outcome = try planners.commits.commit(
            gesture, in: scope, to: &replica, as: instance, identities: identities, gestureIdTaken: gestureIdTaken, draws: draws)
          return Planned((outcome, value), replica.batch)
        } catch let unread as UnreadDraws {
          reads[scope, default: RowSelection()].keys.formUnion(unread.keys)
          draws = unread.draws
        }
      }
    }
  }

  public func commit(_ gesture: Gesture, in scope: ScopeRef, instance: Instance, identities: IdentitySource) throws -> Written<CommitOutcome> {
    let written = try commit(in: scope, instance: instance, identities: identities) { _ in (gesture, ()) }
    return Written(value: written.value.outcome!, events: written.events, change: written.change)
  }

  // True iff every entry of the gesture was held, and so removed.
  public func undo(_ gestureId: String) throws -> Written<Bool> {
    try onActive(.undo) { replica in try planners.hold.undo(gestureId, in: &replica) }
  }

  public func release(_ localId: String) throws -> Written<Bool> {
    try onActive(.release) { replica in try planners.hold.release(localId, in: &replica) }
  }

  // The release timer: every held entry whose `releaseAt` has come.
  public func releaseDue(at deviceNow: Int64) throws -> Written<Void> {
    try onActive(.release) { replica in try planners.hold.releaseDue(at: deviceNow, in: &replica) }
  }

  // Leaving the app, and sign-out's first step: every held entry released. True iff there was one.
  public func releaseAll(_ tx: TxName = .release) throws -> Written<Bool> {
    try onActive(tx) { replica in try planners.hold.releaseAll(in: &replica) }
  }

  // §7.3 and §7.11 at engine start: holds released, a new actor, and the fork guard checked.
  public func start(backup: BackupCopy, instance: inout Instance, identities: IdentitySource) throws -> Written<EngineStart> {
    try onDevice(.engineStart) { device in
      try planners.lifecycle.start(&device, backup: backup, instance: &instance, identities: identities)
    }
  }

  // D-17: a dismissed notice is hidden, never deleted, since an orphan's refusal may still fold into it. A notice the
  // active replica does not hold throws.
  public func dismissNotice(_ id: String) throws -> Written<Void> {
    try write(.dismissNotice) { tx in
      var replica = try loaded(try tx.activeReplica(), in: tx, notices: true)
      guard replica.dismiss(notice: id) else { throw StoreError.noNotice(id) }
      return Planned((), replica.batch)
    }
  }

  // MARK: Sending (§7.4)

  // Numbering: the request to send, or nil. An entry refused as it is numbered may be an orphan, whose refusal folds
  // into its origin's stored notice, so the notices are loaded.
  public func number(limit: Int? = nil, at deviceNow: Int64) throws -> Written<PushRequest?> {
    try onActive(.number, notices: true) { replica in try planners.pushes.number(&replica, limit: limit, at: deviceNow) }
  }

  // One step of a push answer, for the replica the request was numbered in; a replica gone since drops it. The
  // replica's id after the step, which a re-identify changes.
  public func apply(_ step: PushStep, replica id: String, instance: inout Instance, timing: Timing,
                    identities: IdentitySource) throws -> Written<String?> {
    try write(step.transaction) { tx in
      guard let meta = try tx.meta(of: id),
            var replica = try tx.replica(id, entries: step.entries(of: meta), notices: step.readsNotices) else { return Planned(nil, ReplicaBatch()) }
      try planners.pushes.apply(step, to: &replica, instance: &instance, timing: timing, identities: identities)
      return Planned(replica.id, replica.batch)
    }
  }

  // A hello's offset sample (§10.4).
  public func sample(serverTime: Int64, timing: Timing) throws -> Written<Void> {
    try onActive(.offset) { replica in
      replica.update { $0.sample(serverTime: serverTime, send: timing.send, recv: timing.recv) }
    }
  }

  // MARK: Pulling (§7.5, §7.9)

  // What the scopes asked make of `replica`'s next request; nil when the replica is no longer active.
  public func pullPlan(_ scopes: [ScopeRef], replica id: String) throws -> PullPlan? {
    try read { tx in
      guard try tx.activeReplica().utf8.elementsEqual(id.utf8), let replica = try tx.replica(id) else { return nil }
      return planners.pages.plan(scopes, in: replica)
    }
  }

  // One step of a pull answer, for the replica the request was built in and the account it was built as: a page's
  // outcome, what it leaves to pull, and the replica's id after the step, which an epoch change re-identifies. A replica
  // no longer active, or no longer of that account (a sign-in binds the `anon` replica in place), drops the step and
  // answers nil, since the answer says nothing of the replica as it now stands; a page of a scope that left `subscribed`
  // while the answer was on its way is stale.
  public func apply(_ step: PullStep, replica id: String, account: String?, subscribed: Set<ScopeRef>, instance: inout Instance,
                    timing: Timing, identities: IdentitySource) throws -> Written<(outcome: PageOutcome?, next: PullNext, replica: String)?> {
    try write(step.transaction) { tx in
      guard try tx.activeReplica().utf8.elementsEqual(id.utf8),
            var replica = try tx.replica(id, reads: planners.pages.reads(of: step)),
            replica.meta.account.map({ Array($0.utf8) }) == account.map({ Array($0.utf8) })
      else { return Planned(nil, ReplicaBatch()) }
      if case .page(let page, _) = step, !subscribed.contains(page.scope) { return Planned((.stale, PullNext(), id), ReplicaBatch()) }
      let before = replica
      let outcome = try planners.pages.apply(step, to: &replica, instance: &instance, timing: timing, identities: identities)
      guard case .page(let page, _) = step, let outcome else { return Planned((outcome, PullNext(), replica.id), replica.batch) }
      return Planned((outcome, planners.pages.next(after: page, outcome, from: before, in: replica), replica.id), replica.batch)
    }
  }

  // A live frame received for `replica`: its outcome, and what it leaves to pull. A replica no longer active, or a scope
  // that left `subscribed`, drops the frame and answers nil.
  public func apply(_ frame: LiveFrame, replica id: String, subscribed: Set<ScopeRef>,
                    instance: Instance) throws -> Written<(outcome: FrameOutcome, next: PullNext)?> {
    try write(.liveFrame) { tx in
      guard try tx.activeReplica().utf8.elementsEqual(id.utf8), let scope = frame.scope, subscribed.contains(scope),
            var replica = try tx.replica(id, reads: planners.pages.reads(of: frame)) else { return Planned(nil, ReplicaBatch()) }
      let before = replica
      let outcome = try planners.pages.apply(frame, to: &replica, instance: instance)
      return Planned((outcome, planners.pages.next(after: frame, outcome, from: before, in: replica)), replica.batch)
    }
  }

  // A scope known not found boots again; one known gone stays gone.
  public func subscribe(_ scope: ScopeRef) throws -> Written<SubscribeOutcome> {
    try onActive(.subscriptions) { replica in planners.lifecycle.subscribe(&replica, to: scope) }
  }

  // A scope leaving the subscription set is forgotten, and acked entries outside it resolve; answers those followed.
  public func reconcile(subscribed: Set<ScopeRef>) throws -> Written<Set<ScopeRef>> {
    try onActive(.subscriptions) { replica in try planners.lifecycle.reconcile(&replica, subscribed: subscribed) }
  }

  // MARK: The replica lifecycle (§7.10, §7.11)

  public func reidentify(instance: inout Instance, identities: IdentitySource) throws -> Written<Void> {
    try onActive(.reidentify) { replica in try planners.lifecycle.reidentify(&replica, instance: &instance, identities: identities) }
  }

  public func changeEpoch(to epoch: String, instance: inout Instance, identities: IdentitySource) throws -> Written<Void> {
    try onActive(.epochChange) { replica in
      try planners.lifecycle.changeEpoch(to: epoch, in: &replica, instance: &instance, identities: identities)
    }
  }

  // The bound replica's account signed in again: true iff that cleared the pause a 401 set.
  public func reauthenticate() throws -> Written<Bool> {
    try onActive(.authResume) { replica in try planners.lifecycle.reauthenticate(&replica) }
  }

  public func beginSignIn(account: String) throws -> Written<Void> {
    try onDevice(.signInBegin) { device in try planners.lifecycle.beginSignIn(&device, account: account) }
  }

  // The corpus's sign-in step: complete when every due decision is answered, and each pin in `counted` still holds; else
  // incomplete with nothing more changed.
  public func signIn(account: String, holdsRecords: [String: Bool], decisions: [String: LineageAnswer],
                     counted: [String: [String]], identities: IdentitySource) throws -> Written<SignIn> {
    try onDevice(.signInComplete) { device in
      try planners.lifecycle.signIn(
        &device, account: account, holdsRecords: holdsRecords, decisions: decisions, counted: counted, identities: identities)
    }
  }

  // The pending sign-in as `account`, after its hello, with the answers and the entries each pins; nil when no sign-in as
  // `account` is pending.
  public func continueSignIn(account: String, holdsRecords: [String: Bool], answers: [String: LineageAnswer],
                             counted: [String: [String]], identities: IdentitySource) throws -> Written<SignIn?> {
    try onDevice(.signInComplete) { device in
      try planners.lifecycle.continueSignIn(
        &device, account: account, holdsRecords: holdsRecords, answers: answers, counted: counted, identities: identities)
    }
  }

  // The corpus's sign-out step: the question, and with a choice whose pin holds, the finish.
  public func signOut(choice: SignOutChoice?, counted: [String]?, identities: IdentitySource) throws -> Written<SignOut> {
    try onDevice(choice == nil ? .signOutCount : .signOutFinish) { device in
      try planners.lifecycle.signOut(&device, choice: choice, counted: counted, identities: identities)
    }
  }

  // After the bounded flush: the unsent entries counted; nil when the active replica is not bound to `account`.
  public func countUnsent(signingOut account: String) throws -> Written<SignOut?> {
    try onDevice(.signOutCount) { device in try planners.lifecycle.countUnsent(&device, signingOut: account) }
  }

  // Keep or Discard of `account`'s unsent entries, the confirmation having counted `counted`.
  public func finishSignOut(account: String, choice: SignOutChoice, counted: [String], identities: IdentitySource) throws -> Written<SignOutFinish> {
    try onDevice(.signOutFinish) { device in
      try planners.lifecycle.finishSignOut(&device, account: account, choice: choice, counted: counted, identities: identities)
    }
  }

  // The corpus's discard of a dormant replica by its id.
  public func discardDormant(_ replica: String) throws -> Written<Void> {
    try onDevice(.discardDormant) { device in try planners.lifecycle.discardUnsent(replica, in: &device) }
  }

  // `account`'s dormant replica discarded; false when the device holds none.
  public func discardDormant(account: String) throws -> Written<Bool> {
    try onDevice(.discardDormant) { device in try planners.lifecycle.discardDormant(of: account, in: &device) }
  }

  // MARK: Reading

  // The scopes of `subscribed` that `replica` pulls and follows live (§7.9), in their order: none it knows gone or not
  // found, and none that waits for its governing record's create.
  public func pulledScopes(of replica: String, among subscribed: [ScopeRef]) throws -> [ScopeRef] {
    try read { tx in
      guard let loaded = try tx.replica(replica) else { return [] }
      return subscribed.filter { planners.pages.pulls($0, in: loaded) }
    }
  }

  public func anonCount(of product: String, in replica: String) throws -> [String: Int] {
    try read { tx in planners.lifecycle.anonCount(of: product, in: try loaded(replica, in: tx)) }
  }

  // MARK: The Action shapes

  func loaded(_ id: String, in tx: StoreTransaction, reads: [ScopeRef: RowSelection] = [:], entries: EntrySelection = .every,
              notices: Bool = false) throws -> LoadedReplica {
    guard let replica = try tx.replica(id, reads: reads, entries: entries, notices: notices) else { throw StoreError.noReplica(id) }
    return replica
  }

  // A planner over the active replica, which reads no rows; `notices` loads its notices.
  func onActive<Value>(_ tx: TxName, notices: Bool = false, _ plan: (inout LoadedReplica) throws -> Value) throws -> Written<Value> {
    try write(tx) { transaction in
      var replica = try loaded(try transaction.activeReplica(), in: transaction, notices: notices)
      let value = try plan(&replica)
      return Planned(value, replica.batch)
    }
  }

  // A planner over every replica of the device, which reads no rows.
  func onDevice<Value>(_ tx: TxName, _ plan: (inout LoadedDevice) throws -> Value) throws -> Written<Value> {
    try write(tx) { transaction in
      var device = try transaction.device()
      let value = try plan(&device)
      return Planned(value, device.batch)
    }
  }
}

extension PushStep {
  var transaction: TxName {
    switch self {
    case .sample: .offset
    case .pauseAuth: .authPause
    case .reidentify: .reidentify
    case .halve, .refuseLocally: .localRefusal
    case .result: .result
    case .ack: .ack
    case .epoch: .epochChange
    }
  }
}

extension PullStep {
  var transaction: TxName {
    switch self {
    case .sample: .offset
    case .pauseAuth: .authPause
    case .epoch: .epochChange
    case .page: .pullPage
    }
  }
}
