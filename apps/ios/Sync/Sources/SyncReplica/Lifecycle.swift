import SyncAPI
import SyncCore

// The replica lifecycle: re-identify and the fork guard (§7.11), the epoch change (§7.5 step 1), engine start (§7.3), a
// hello's answer (§9.2), sign-in by the lineage rule, sign-out and discard (§7.10), and subscriptions (§7.9).

// The fork guard's backup-excluded copy at engine start: web keeps none; a native store's copy may be missing.
public enum BackupCopy: Sendable, Hashable {
  case notKept
  case missing
  case held(String)
}

// What engine start leaves: the instance's actor, whether the fork guard re-identified every replica, the guard the
// store now keeps (its backup-excluded copy is written from it once the start has committed), and a pending sign-in.
public struct EngineStart: Sendable, Hashable {
  public let actor: Stamp.Actor
  public let reidentified: Bool
  public let forkGuard: String?
  public let pendingSignIn: String?
}

public enum LineageAnswer: String, Sendable, Hashable {
  case add, discard
}

// A signed-out decision due at sign-in: the product; anonCount, the distinct records its entries touch by type; and
// `counted`, the local ids of those entries in commit order, which an answer pins.
public struct SignedOutDecision: Sendable, Hashable {
  public let product: String
  public let counts: [String: Int]
  public let counted: [String]

  public init(product: String, counts: [String: Int], counted: [String]) {
    self.product = product
    self.counts = counts
    self.counted = counted
  }
}

// A sign-in after its hello: complete, or waiting for an answer to each decision due.
public struct SignIn: Sendable, Hashable {
  public let complete: Bool
  public let due: [SignedOutDecision]

  public init(complete: Bool, due: [SignedOutDecision]) {
    self.complete = complete
    self.due = due
  }
}

public enum SignOutChoice: String, Sendable, Hashable {
  case keep, discard
}

// A sign-out's question, or its finish: the ready and the sent entries (a sent entry may already have landed), and
// `counted`, their local ids in commit order, which a Discard pins. Acked entries are not unsent.
public struct SignOut: Sendable, Hashable {
  public let complete: Bool
  public let ready: Int
  public let sent: Int
  public let counted: [String]

  public init(complete: Bool, ready: Int, sent: Int, counted: [String]) {
    self.complete = complete
    self.ready = ready
    self.sent = sent
    self.counted = counted
  }

  public var unsent: Int { ready + sent }
}

// The answer to one account's sign-out: finished; the active replica is no longer bound to the account; or a Discard
// whose counted entries differ from the unsent entries now, so nothing is signed out and the question is asked again.
public enum SignOutFinish: Sendable, Hashable {
  case finished(SignOut)
  case notSignedIn
  case changed(SignOut)
}

// Pinned local ids are the ones counted now, byte for byte.
func sameCounted(_ pinned: [String], _ counted: [String]) -> Bool {
  pinned.map { Array($0.utf8) } == counted.map { Array($0.utf8) }
}

// A subscribe (§7.9): the scope is pulled and followed, or the replica knows it gone, and nothing is pulled.
public enum SubscribeOutcome: String, Sendable, Hashable {
  case subscribed, gone
}

public struct ReplicaLifecycle: Sendable {
  public let registry: Registry
  let hold: Hold

  public init(registry: Registry) {
    self.registry = registry
    hold = Hold(registry: registry)
  }

  // MARK: Re-identify and epochs

  // §7.11 a new replica id, `nextN := 1`, `ackThrough := 0`, and every sent entry back to ready. The instance's new
  // actor is its caller's to take.
  public func reidentify(_ replica: inout LoadedReplica, identities: IdentitySource) throws {
    _ = try Machines.replica.transition(from: replica.meta.node, .reidentify, to: replica.meta.node)
    replica.apply(.rename(to: try identities.replicaID()))
    replica.update { meta in
      meta.nextN = 1
      meta.ackThrough = 0
    }
    for entry in replica.outbox where entry.state == .sent { try replica.move(entry.localId, .reidentify) }
  }

  // A 409 or an explicit re-identify: the instance takes a new actor too (D-2).
  public func reidentify(_ replica: inout LoadedReplica, instance: inout Instance, identities: IdentitySource) throws {
    try reidentify(&replica, identities: identities)
    instance.actor = try identities.actor()
  }

  // §7.5 step 1: a null serverEpoch takes the response's; another one is an epoch change.
  public func checkEpoch(_ epoch: String, in replica: inout LoadedReplica, instance: inout Instance, identities: IdentitySource) throws {
    guard let current = replica.meta.serverEpoch else {
      replica.update { $0.serverEpoch = epoch }
      return
    }
    if !current.utf8.elementsEqual(epoch.utf8) { try changeEpoch(to: epoch, in: &replica, instance: &instance, identities: identities) }
  }

  // Every cursor null and every staging dropped; acked entries of another epoch back to ready; then re-identify.
  public func changeEpoch(to epoch: String, in replica: inout LoadedReplica, instance: inout Instance, identities: IdentitySource) throws {
    replica.update { $0.serverEpoch = epoch }
    for (scope, record) in replica.cursors.sorted(by: { $0.key < $1.key }) where record.cursor != nil {
      var reset = record
      reset.cursor = nil
      replica.apply(.putCursor(scope, reset))
    }
    for scope in replica.staging.keys.sorted() { replica.apply(.dropStaging(scope)) }
    for entry in replica.outbox where entry.state == .acked && entry.resultEpoch?.utf8.elementsEqual(epoch.utf8) != true {
      try replica.move(entry.localId, .epoch)
    }
    try reidentify(&replica, instance: &instance, identities: identities)
  }

  // MARK: First launch and engine start

  // §8.2 a store holding no replica: an anon one, active.
  public func firstLaunch(identities: IdentitySource) throws -> LoadedDevice {
    _ = try Machines.replica.transition(from: nil, .firstLaunch, to: .anon)
    let id = try identities.replicaID()
    var device = LoadedDevice(meta: DeviceMeta(), active: "", replicas: [])
    device.add(ReplicaMeta(replica: id, state: .anon))
    device.setMeta(DeviceMeta(), active: id)
    return device
  }

  // §7.3 and §7.11: every held entry released, a fresh actor; a native store whose forkGuard differs from its copy, or
  // whose copy is missing, re-identifies every replica under a new forkGuard. A store without one mints its first.
  public func start(_ device: inout LoadedDevice, backup: BackupCopy, instance: inout Instance,
                    identities: IdentitySource) throws -> EngineStart {
    for replica in device.replicas { try device.modify(replica.id) { try hold.releaseAll(in: &$0) } }
    instance.actor = try identities.actor()
    var reidentified = false
    if backup != .notKept {
      if let forkGuard = device.meta.forkGuard, backup != .held(forkGuard) {
        for replica in device.replicas { try device.modify(replica.id) { try reidentify(&$0, identities: identities) } }
        reidentified = true
      }
      if device.meta.forkGuard == nil || reidentified {
        var meta = device.meta
        meta.forkGuard = try identities.forkGuard()
        device.setMeta(meta, active: device.active)
      }
    }
    return EngineStart(
      actor: instance.actor, reidentified: reidentified, forkGuard: device.meta.forkGuard, pendingSignIn: device.meta.pendingSignIn)
  }

  // MARK: Sign-in

  // Before the hello: Undo does not survive sign-in, and the incomplete sign-in is recorded, to resume at the next
  // engine start. A sign-in pending for another account is replaced.
  public func beginSignIn(_ device: inout LoadedDevice, account: String) throws {
    try requireSignedOut(device)
    if let anon = device.anon { try device.modify(anon.id) { try hold.releaseAll(in: &$0) } }
    device.setMeta(DeviceMeta(forkGuard: device.meta.forkGuard, pendingSignIn: account), active: device.active)
  }

  // §7.10 after a hello as `account`: holds are released; a signed-out decision is due for each product in which the
  // account holds records and the anon replica has entries. Each answer covers the entries its decision counted:
  // `counted[product]` pins their local ids, and a decision whose entries differ now (a commit or an undo in between) is
  // due again with the new count; an answer with no pin covers the decision as it stands. Until every due decision is
  // answered nothing else changes; then the discards, the bind, the add and the lineage, in this transaction.
  public func signIn(_ device: inout LoadedDevice, account: String, holdsRecords: [String: Bool],
                     decisions: [String: LineageAnswer], counted: [String: [String]], identities: IdentitySource) throws -> SignIn {
    try requireSignedOut(device)
    if let anon = device.anon { try device.modify(anon.id) { try hold.releaseAll(in: &$0) } }
    let due = self.due(in: device, holdsRecords: holdsRecords)
    let answered = { (decision: SignedOutDecision) in
      decisions[decision.product] != nil && counted[decision.product].map { sameCounted($0, decision.counted) } ?? true
    }
    guard due.allSatisfy(answered) else {
      device.setMeta(DeviceMeta(forkGuard: device.meta.forkGuard, pendingSignIn: account), active: device.active)
      return SignIn(complete: false, due: due)
    }

    for decision in due where decisions[decision.product] == .discard {
      guard let anon = device.anon else { continue }
      try device.modify(anon.id) { anon in
        for entry in entries(of: decision.product, in: anon) { try anon.move(entry.localId, .discard) }
        anon.apply(.deleteDeviceRows(product: decision.product))
      }
    }

    let target = try bind(account, in: &device, identities: identities)
    if let anon = device.anon, !anon.id.utf8.elementsEqual(target.utf8), !anon.outbox.isEmpty {
      device.modify(anon.id) { anon in
        for entry in anon.outbox { anon.apply(.deleteEntry(entry.localId)) }
      }
      device.modify(target) { target in
        for entry in anon.outbox {
          var moved = entry
          moved.commitOrder = target.nextCommitOrder
          target.apply(.putEntry(moved))
        }
        for (product, rows) in anon.deviceRows.sorted(by: { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) }) {
          for (key, value) in rows.members where target.deviceRows[product]?[key] == nil {
            target.apply(.putDeviceRow(product: product, key: key, value))
          }
        }
        for notice in anon.notices { target.apply(.moveNotice(notice)) }
      }
      _ = try Machines.replica.transition(from: .anon, .signIn, to: .deleted)
      device.remove(anon.id)
    }
    device.modify(target) { target in
      for entry in target.outbox { target.update(entry: entry.localId) { $0.lineage = account } }
      let stamps = target.outbox.flatMap { [$0.stamp] + $0.drawnDeltas.flatMap(\.lattice.stamps) }
      target.update { meta in
        meta.observe(stamps)
        meta.authPaused = false
      }
    }
    device.setMeta(DeviceMeta(forkGuard: device.meta.forkGuard), active: target)
    return SignIn(complete: true, due: due)
  }

  // The sign-in the device records as pending, after its hello, with the person's answers and the entries each pins.
  // Nil when the device records no pending sign-in as `account`, since another sign-in replaced it or it completed.
  public func continueSignIn(_ device: inout LoadedDevice, account: String, holdsRecords: [String: Bool],
                             answers: [String: LineageAnswer], counted: [String: [String]],
                             identities: IdentitySource) throws -> SignIn? {
    guard device.meta.pendingSignIn?.utf8.elementsEqual(account.utf8) == true else { return nil }
    return try signIn(&device, account: account, holdsRecords: holdsRecords, decisions: answers, counted: counted, identities: identities)
  }

  // Sign-in starts signed out: a bound replica, paused or not, re-authenticates or signs out first (§7.10, §8.2).
  func requireSignedOut(_ device: LoadedDevice) throws {
    guard !device.replicas.contains(where: { $0.meta.state == .bound }) else {
      _ = try Machines.replica.transition(from: .bound, .signIn)
      return
    }
  }

  // §9.2 a hello's answer to the replica: its offset sample (§10.4), then the pause of an answer handled as a 401, a hello
  // served as anyone but the replica's account among them (§9.1).
  public func receive(_ hello: Answer<HelloResponse>, in replica: inout LoadedReplica, timing: Timing) {
    if let serverTime = hello.serverTime { replica.update { $0.sample(serverTime: serverTime, send: timing.send, recv: timing.recv) } }
    if hello.isUnauthenticated(for: replica.meta.account) { replica.update { $0.authPaused = true } }
  }

  // §8.2: a bound replica a 401 paused resumes when its account re-authenticates. True iff it was paused.
  public func reauthenticate(_ replica: inout LoadedReplica) throws -> Bool {
    guard replica.meta.state == .bound else { throw TransitionError(description: "only a bound replica re-authenticates") }
    let paused = replica.meta.authPaused
    replica.update { $0.authPaused = false }
    return paused
  }

  // Step 2: a dormant replica of the account is rebound with every cursor null; otherwise the anon replica, when
  // entries are left in it, forgetting what was not found to the signed-out principal, since the account may read it
  // (§6.7); a scope known gone stays gone. Otherwise a new bound replica. The bound replica's id.
  func bind(_ account: String, in device: inout LoadedDevice, identities: IdentitySource) throws -> String {
    if let dormant = device.dormant(of: account) {
      _ = try Machines.replica.transition(from: .dormant, .signIn, to: .bound)
      device.modify(dormant.id) { replica in
        replica.update { $0.state = .bound }
        for scope in replica.cursors.keys.sorted() { replica.apply(.forgetScope(scope)) }
        for scope in replica.staging.keys.sorted() { replica.apply(.dropStaging(scope)) }
      }
      return dormant.id
    }
    if let anon = device.anon, !anon.outbox.isEmpty {
      _ = try Machines.replica.transition(from: .anon, .signIn, to: .bound)
      device.modify(anon.id) { replica in
        replica.update { meta in
          meta.state = .bound
          meta.account = account
        }
        for (scope, kind) in replica.known.sorted(by: { $0.key < $1.key }) where kind == .notFound {
          replica.apply(.deleteKnown(scope))
        }
      }
      return anon.id
    }
    _ = try Machines.replica.transition(from: nil, .signIn, to: .bound)
    let id = try identities.replicaID()
    device.add(ReplicaMeta(replica: id, state: .bound, account: account))
    return id
  }

  // The signed-out decisions due: one for each product, in product order, in which the account holds records and the
  // anon replica has entries.
  func due(in device: LoadedDevice, holdsRecords: [String: Bool]) -> [SignedOutDecision] {
    guard let anon = device.anon else { return [] }
    return registry.products.map(\.name).sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.compactMap { product in
      let entries = entries(of: product, in: anon)
      guard holdsRecords[product] == true, !entries.isEmpty else { return nil }
      return SignedOutDecision(product: product, counts: anonCount(of: product, in: anon), counted: entries.map(\.localId))
    }
  }

  // An entry's product is its scope's; a tree or overlay scope's is its governing type's.
  func entries(of product: String, in replica: LoadedReplica) -> [OutboxEntry] {
    replica.outbox.filter { registry.product(of: $0.scope)?.utf8.elementsEqual(product.utf8) == true }
  }

  // The count, by type, of the distinct records (scope, type, id) a product's entries create or change.
  public func anonCount(of product: String, in replica: LoadedReplica) -> [String: Int] {
    var records: Set<ScopedKey> = []
    var counts: [String: Int] = [:]
    for entry in entries(of: product, in: replica) {
      for delta in entry.drawnDeltas where records.insert(ScopedKey(scope: entry.scope, key: delta.key)).inserted {
        counts[delta.key.type, default: 0] += 1
      }
    }
    return counts
  }

  // MARK: Sign-out and discard

  // §7.10 in one step, as the corpus runs it: the question, and with a choice the finish. A sign-out without a choice
  // never finishes, even with nothing unsent, where Keep is the plain confirm. Keep covers every entry, counted or not; a
  // Discard whose pinned `counted` differs from the unsent entries now is asked again. A Discard with no pin covers the
  // question as it stands.
  public func signOut(_ device: inout LoadedDevice, choice: SignOutChoice?, counted: [String]?,
                      identities: IdentitySource) throws -> SignOut {
    let question = try countUnsent(&device)
    guard let choice, choice == .keep || counted.map({ sameCounted($0, question.counted) }) ?? true else { return question }
    try finishSignOut(&device, keeping: choice == .keep, identities: identities)
    return SignOut(complete: true, ready: question.ready, sent: question.sent, counted: question.counted)
  }

  // Step 2, after the caller's bounded flush, for `account`'s sign-out: nil when the active replica is not bound to it.
  public func countUnsent(_ device: inout LoadedDevice, signingOut account: String) throws -> SignOut? {
    guard isSignedIn(account, device) else { return nil }
    return try countUnsent(&device)
  }

  // Steps 3 and 4 for `account`, whose confirmation counted the unsent entries `counted`: Keep, which covers every
  // entry, counted or not; or Discard, which covers exactly the entries counted, and is asked again when they differ.
  public func finishSignOut(_ device: inout LoadedDevice, account: String, choice: SignOutChoice, counted: [String],
                            identities: IdentitySource) throws -> SignOutFinish {
    guard isSignedIn(account, device) else { return .notSignedIn }
    let question = try countUnsent(&device)
    if choice == .discard && !sameCounted(counted, question.counted) { return .changed(question) }
    try finishSignOut(&device, keeping: choice == .keep, identities: identities)
    return .finished(SignOut(complete: true, ready: question.ready, sent: question.sent, counted: question.counted))
  }

  // The active replica, which is bound: holds released, and the ready and the sent entries counted. Acked entries stay
  // until the sign-out finishes, since one cancelled leaves them to resolve by the pull that brings their rows.
  func countUnsent(_ device: inout LoadedDevice) throws -> SignOut {
    try device.modify(device.active) { replica -> SignOut in
      try hold.releaseAll(in: &replica)
      let unsent = replica.outbox.filter { $0.state == .ready || $0.state == .sent }
      return SignOut(
        complete: false, ready: unsent.filter { $0.state == .ready }.count, sent: unsent.filter { $0.state == .sent }.count,
        counted: unsent.map(\.localId))
    }
  }

  // The finish: acked entries resolve, since the server holds them; then Keep purges the caches and leaves the unsent
  // entries dormant, and Discard deletes the replica. The anon replica, created if absent, becomes active.
  func finishSignOut(_ device: inout LoadedDevice, keeping: Bool, identities: IdentitySource) throws {
    let bound = device.active
    try device.modify(bound) { replica in
      for entry in replica.outbox where entry.state == .acked { try replica.move(entry.localId, .resolve) }
    }
    if keeping {
      try device.modify(bound) { replica in
        _ = try Machines.replica.transition(from: replica.meta.node, .signOutKeep, to: .dormant)
        replica.update { $0.state = .dormant }
        replica.apply(.purgeCaches)
      }
    } else {
      try device.modify(bound) { replica in
        _ = try Machines.replica.transition(from: replica.meta.node, .signOutDiscard, to: .deleted)
        for entry in replica.outbox { try replica.move(entry.localId, .discard) }
      }
      device.remove(bound)
    }
    let anon: String
    if let existing = device.anon {
      anon = existing.id
    } else {
      anon = try identities.replicaID()
      device.add(ReplicaMeta(replica: anon, state: .anon))
    }
    device.setMeta(device.meta, active: anon)
  }

  // The active replica is bound to `account`.
  func isSignedIn(_ account: String, _ device: LoadedDevice) -> Bool {
    let meta = device.activeReplica.meta
    return meta.state == .bound && meta.account?.utf8.elementsEqual(account.utf8) == true
  }

  // An explicit discard of a dormant replica: deleted, its entries discarded.
  public func discardUnsent(_ id: String, in device: inout LoadedDevice) throws {
    try device.modify(id) { replica in
      _ = try Machines.replica.transition(from: replica.meta.node, .discard, to: .deleted)
      for entry in replica.outbox { try replica.move(entry.localId, .discard) }
    }
    device.remove(id)
  }

  // The same for `account`'s dormant replica: false when the device holds none.
  public func discardDormant(of account: String, in device: inout LoadedDevice) throws -> Bool {
    guard let dormant = device.dormant(of: account) else { return false }
    try discardUnsent(dormant.id, in: &device)
    return true
  }

  // MARK: Subscriptions (§7.9)

  // A scope the replica knows not found is known no more, so its first pull boots it; one it knows gone stays gone, since
  // a scope's death is final (INV-13).
  public func subscribe(_ replica: inout LoadedReplica, to scope: ScopeRef) -> SubscribeOutcome {
    switch replica.known[scope] {
    case .gone?: return .gone
    case .notFound?:
      replica.apply(.deleteKnown(scope))
      return .subscribed
    case nil: return .subscribed
    }
  }

  // A scope outside `subscribed` is forgotten, and every acked entry outside it resolves, pulled or not. A scope the
  // replica knows gone or not found is outside it, whoever holds it open: it was unsubscribed when its page came
  // (§7.5), and no pull brings its rows until a subscribe clears a not-found. Answers the scopes still followed.
  @discardableResult
  public func reconcile(_ replica: inout LoadedReplica, subscribed: Set<ScopeRef>) throws -> Set<ScopeRef> {
    let followed = subscribed.filter { replica.known[$0] == nil }
    for scope in replica.cursors.keys.sorted() where !followed.contains(scope) {
      replica.apply(.forgetScope(scope))
      for entry in replica.entries(in: scope) where entry.state == .acked { try replica.move(entry.localId, .resolve) }
    }
    for entry in replica.outbox where entry.state == .acked && !followed.contains(entry.scope) {
      try replica.move(entry.localId, .resolve)
    }
    return followed
  }

  // The scope's first pull is complete, or the replica does not pull it.
  public func firstPullComplete(_ scope: ScopeRef, in replica: LoadedReplica, subscribed: Set<ScopeRef>) -> Bool {
    !subscribed.contains(scope) || replica.cursors[scope]?.booted == true
  }
}
