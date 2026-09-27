import SyncAPI
import SyncCore
import SyncReplica

// The design's §3.5 table: one Action per transaction, each an ordered load → plan → batch inside one `write`. The
// runtime calls these; a crash between any two of them loses nothing.

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
  // gesture reads. A nil gesture writes nothing and ticks no clock.
  public func commit<T>(in scope: ScopeRef, instance: Instance, identities: IdentitySource,
                        _ decide: (StoreTransaction) throws -> (Gesture?, T)) throws -> Written<(outcome: CommitOutcome?, value: T)> {
    try write(.commit) { tx in
      let active = try tx.activeReplica()
      guard let meta = try tx.meta(of: active) else { throw StoreError.noReplica(active) }
      try planners.commits.checkWritable(meta)
      let (gesture, value) = try decide(tx)
      guard let gesture else { return Planned((nil, value), ReplicaBatch()) }
      var replica = try loaded(active, in: tx, reads: planners.commits.reads(of: gesture, in: scope))
      let outcome = try planners.commits.commit(gesture, in: scope, to: &replica, as: instance, identities: identities)
      return Planned((outcome, value), replica.batch)
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

  // Leaving the app, and sign-out's first step: every held entry released.
  public func releaseAll() throws -> Written<Void> {
    try onActive(.release) { replica in try planners.hold.releaseAll(in: &replica) }
  }

  // §7.3 and §7.11 at engine start: holds released, a new actor, and the fork guard checked.
  public func start(backup: BackupCopy, instance: inout Instance, identities: IdentitySource) throws -> Written<EngineStart> {
    try onDevice(.engineStart) { device in
      try planners.lifecycle.start(&device, backup: backup, instance: &instance, identities: identities)
    }
  }

  public func dismissNotice(_ id: String) throws -> Written<Void> {
    try write(.dismissNotice) { tx in
      var replica = try loaded(try tx.activeReplica(), in: tx, notices: true)
      replica.apply(.deleteNotice(id))
      return Planned((), replica.batch)
    }
  }

  // MARK: Sending (§7.4)

  // Numbering: the request to send, or nil.
  public func number(limit: Int? = nil) throws -> Written<PushRequest?> {
    try onActive(.number) { replica in try planners.pushes.number(&replica, limit: limit) }
  }

  // One step of a push answer, for the replica the request was numbered in; a replica gone since drops it. The
  // replica's id after the step, which a re-identify changes.
  public func apply(_ step: PushStep, replica id: String, instance: inout Instance, timing: Timing,
                    identities: IdentitySource) throws -> Written<String?> {
    try write(step.transaction) { tx in
      guard var replica = try tx.replica(id) else { return Planned(nil, ReplicaBatch()) }
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

  public func pullRequest(_ scopes: [ScopeRef]) throws -> PullRequest {
    try read { tx in planners.pages.request(scopes, in: try loaded(try tx.activeReplica(), in: tx)) }
  }

  // One step of a pull answer, for the replica the request was built in: a page's outcome, and the replica's id after
  // the step, which an epoch change re-identifies. A replica gone since drops the step.
  public func apply(_ step: PullStep, replica id: String, instance: inout Instance, timing: Timing,
                    identities: IdentitySource) throws -> Written<(outcome: PageOutcome?, replica: String?)> {
    try write(step.transaction) { tx in
      guard var replica = try tx.replica(id, reads: planners.pages.reads(of: step)) else { return Planned((nil, nil), ReplicaBatch()) }
      let outcome = try planners.pages.apply(step, to: &replica, instance: &instance, timing: timing, identities: identities)
      return Planned((outcome, replica.id), replica.batch)
    }
  }

  public func apply(_ frame: LiveFrame, instance: Instance) throws -> Written<FrameOutcome> {
    try write(.liveFrame) { tx in
      var replica = try loaded(try tx.activeReplica(), in: tx, reads: planners.pages.reads(of: frame))
      let outcome = try planners.pages.apply(frame, to: &replica, instance: instance)
      return Planned(outcome, replica.batch)
    }
  }

  // A scope leaving the subscription set is forgotten, and acked entries outside the set resolve.
  public func reconcile(subscribed: Set<ScopeRef>) throws -> Written<Void> {
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

  // A 401 paused the bound replica; its account signed in again.
  public func reauthenticate() throws -> Written<Void> {
    try onActive(.authResume) { replica in try planners.lifecycle.reauthenticate(&replica) }
  }

  public func beginSignIn(account: String) throws -> Written<Void> {
    try onDevice(.signInBegin) { device in try planners.lifecycle.beginSignIn(&device, account: account) }
  }

  // After the hello: complete when every due decision is answered, else incomplete with nothing more changed.
  public func signIn(account: String, holdsRecords: [String: Bool], decisions: [String: LineageAnswer],
                     identities: IdentitySource) throws -> Written<SignIn> {
    try onDevice(.signInComplete) { device in
      try planners.lifecycle.signIn(&device, account: account, holdsRecords: holdsRecords, decisions: decisions, identities: identities)
    }
  }

  // Without a choice, the count of unsent entries; with one, or none unsent, the sign-out itself.
  public func signOut(choice: SignOutChoice?, identities: IdentitySource) throws -> Written<SignOut> {
    try onDevice(choice == nil ? .signOutCount : .signOutFinish) { device in
      try planners.lifecycle.signOut(&device, choice: choice, identities: identities)
    }
  }

  public func discardDormant(_ replica: String) throws -> Written<Void> {
    try onDevice(.discardDormant) { device in try planners.lifecycle.discardUnsent(replica, in: &device) }
  }

  // MARK: Reading

  public func anonCount(of product: String, in replica: String) throws -> [String: Int] {
    try read { tx in planners.lifecycle.anonCount(of: product, in: try loaded(replica, in: tx)) }
  }

  // MARK: The Action shapes

  func loaded(_ id: String, in tx: StoreTransaction, reads: [ScopeRef: RowSelection] = [:], notices: Bool = false) throws -> LoadedReplica {
    guard let replica = try tx.replica(id, reads: reads, notices: notices) else { throw StoreError.noReplica(id) }
    return replica
  }

  // A planner over the active replica, which reads no rows.
  func onActive<Value>(_ tx: TxName, _ plan: (inout LoadedReplica) throws -> Value) throws -> Written<Value> {
    try write(tx) { transaction in
      var replica = try loaded(try transaction.activeReplica(), in: transaction)
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
