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

  // One pull answer step, nil once its replica is not active or not of `account` (§7.12); a page checked against the set (§7.9).
  public func apply(_ step: PullStep, replica id: String, account: String?, subscribed: SubscriptionSet, instance: inout Instance,
                    timing: Timing, identities: IdentitySource)
    throws -> Written<(outcome: PageOutcome?, unsettled: Bool, next: [ScopeRef], replica: String)?> {
    try write(step.transaction) { tx in
      let page: (page: PullPage, chunk: PageChunk)? = if case .page(let page, _, let chunk) = step { (page, chunk) } else { nil }
      let reads = planners.pages.reads(of: step).merging(page == nil ? [:] : planners.lifecycle.reads(of: subscribed)) { $0.union($1) }
      guard try tx.activeReplica().utf8.elementsEqual(id.utf8), let meta = try tx.meta(of: id),
            var replica = try tx.replica(id, reads: reads, entries: planners.pages.entries(of: step, in: meta)),
            replica.meta.account.map({ Array($0.utf8) }) == account.map({ Array($0.utf8) })
      else { return Planned(nil, ReplicaBatch()) }
      let set = page == nil ? [] : Set(try planners.lifecycle.subscriptionSet(of: replica, subscribed))
      let before = replica
      let applied = try planners.pages.apply(step, to: &replica, subscribed: set, instance: &instance, timing: timing, identities: identities)
      guard let page else { return Planned((applied.outcome, applied.unsettled, [], replica.id), replica.batch) }
      let next = planners.pages.next(after: page.page, chunk: page.chunk, applied.outcome, from: before, in: replica)
      return Planned((applied.outcome, applied.unsettled, next, replica.id), replica.batch)
    }
  }

  // A live frame for `replica`, checked against the set as read and settling `count` covered entries; nil once it is not active (§7.12).
  public func apply(_ frame: LiveFrame, replica id: String, subscribed: SubscriptionSet, settling count: Int,
                    instance: Instance) throws -> Written<(outcome: FrameOutcome, unsettled: Bool, next: [ScopeRef])?> {
    try write(.liveFrame) { tx in
      let reads = planners.pages.reads(of: frame).merging(planners.lifecycle.reads(of: subscribed)) { $0.union($1) }
      let entries = planners.pages.entries(of: frame, settling: count)
      guard try tx.activeReplica().utf8.elementsEqual(id.utf8), var replica = try tx.replica(id, reads: reads, entries: entries) else {
        return Planned(nil, ReplicaBatch())
      }
      let set = Set(try planners.lifecycle.subscriptionSet(of: replica, subscribed))
      let before = replica
      let applied = try planners.pages.apply(frame, to: &replica, subscribed: set, settling: count, instance: instance)
      let next = planners.pages.next(after: frame, applied.outcome, from: before, in: replica)
      return Planned((applied.outcome, applied.unsettled, next), replica.batch)
    }
  }

  // §7.5 step 2 one settling slice of `scope`: how many covered entries it resolved and whether any are left; nil once `replica` is not active.
  public func settle(_ scope: ScopeRef, replica id: String, count: Int) throws -> Written<(resolved: Int, left: Bool)?> {
    try write(.settle) { tx in
      guard try tx.activeReplica().utf8.elementsEqual(id.utf8), let cursors = try tx.replica(id, entries: EntrySelection()) else {
        return Planned(nil, ReplicaBatch())
      }
      let entries = planners.pages.entries(settling: scope, count: count, in: cursors)
      guard entries.covered != nil, var replica = try tx.replica(id, entries: entries) else { return Planned((0, false), ReplicaBatch()) }
      let settled = try planners.pages.settle(scope, count: count, in: &replica)
      return Planned(settled, replica.batch)
    }
  }

  // A scope known not found boots again; one known gone stays gone.
  public func subscribe(_ scope: ScopeRef) throws -> Written<SubscribeOutcome> {
    try onActive(.subscriptions) { replica in planners.lifecycle.subscribe(&replica, to: scope) }
  }

  // The active replica's subscription set, read in this transaction (§7.9): a scope that left it is forgotten, and acked
  // entries outside it resolve. Answers the set, in the order the puller pulls it.
  public func reconcile(_ subscribed: SubscriptionSet) throws -> Written<[ScopeRef]> {
    try write(.subscriptions) { tx in
      var replica = try loaded(try tx.activeReplica(), in: tx, reads: planners.lifecycle.reads(of: subscribed))
      let set = try planners.lifecycle.subscriptionSet(of: replica, subscribed)
      try planners.lifecycle.reconcile(&replica, subscribed: Set(set))
      return Planned(set, replica.batch)
    }
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

  // `replica`'s subscription set (§7.9), in order, and of it the scopes the replica pulls and follows live: none that
  // waits for its governing record's create. Nil when the store holds no such replica.
  public func subscriptions(of replica: String, _ subscribed: SubscriptionSet) throws -> (set: [ScopeRef], pulled: [ScopeRef])? {
    try read { tx in
      guard let loaded = try tx.replica(replica, reads: planners.lifecycle.reads(of: subscribed)) else { return nil }
      let set = try planners.lifecycle.subscriptionSet(of: loaded, subscribed)
      return (set, set.filter { planners.pages.pulls($0, in: loaded) })
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
    case .results: .results
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
