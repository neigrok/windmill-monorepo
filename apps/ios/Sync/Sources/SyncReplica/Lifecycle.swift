import SyncAPI
import SyncCore

// The replica lifecycle: re-identify and the fork guard (§7.11), the epoch change (§7.5 step 1), engine start (§7.3),
// sign-in by the lineage rule, sign-out and discard (§7.10), and subscriptions (§7.9).

// The fork guard's backup-excluded copy at engine start: web keeps none; a native store's copy may be missing.
public enum BackupCopy: Sendable, Hashable {
  case notKept
  case missing
  case held(String)
}

public struct EngineStart: Sendable, Hashable {
  public let actor: Stamp.Actor
  public let reidentified: Bool
  public let pendingSignIn: String?
}

public enum LineageAnswer: String, Sendable, Hashable {
  case add, discard
}

// A signed-out decision due at sign-in: the product, and anonCount, the distinct records its entries touch by type.
public struct SignedOutDecision: Sendable, Hashable {
  public let product: String
  public let counts: [String: Int]
}

public struct SignIn: Sendable, Hashable {
  public let complete: Bool
  public let due: [SignedOutDecision]
}

public enum SignOutChoice: String, Sendable, Hashable {
  case keep, discard
}

// A sign-out: complete, or waiting for Keep or Discard of the unsent entries. A sent entry may already have landed.
public struct SignOut: Sendable, Hashable {
  public let complete: Bool
  public let ready: Int
  public let sent: Int

  public var unsent: Int { ready + sent }
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
    return EngineStart(actor: instance.actor, reidentified: reidentified, pendingSignIn: device.meta.pendingSignIn)
  }

  // MARK: Sign-in

  // Before the hello: Undo does not survive sign-in, and the incomplete sign-in is recorded, to resume at the next
  // engine start.
  public func beginSignIn(_ device: inout LoadedDevice, account: String) throws {
    try requireSignedOut(device)
    if let anon = device.anon { try device.modify(anon.id) { try hold.releaseAll(in: &$0) } }
    device.setMeta(DeviceMeta(forkGuard: device.meta.forkGuard, pendingSignIn: account), active: device.active)
  }

  // §7.10 after a hello as `account`: holds are released; a signed-out decision is due for each product in which the
  // account holds records and the anon replica has entries. Until each is answered nothing else changes; then the
  // discards, the bind, the add and the lineage, in this transaction.
  public func signIn(_ device: inout LoadedDevice, account: String, holdsRecords: [String: Bool],
                     decisions: [String: LineageAnswer], identities: IdentitySource) throws -> SignIn {
    try requireSignedOut(device)
    if let anon = device.anon { try device.modify(anon.id) { try hold.releaseAll(in: &$0) } }
    let due = registry.products.map(\.name).sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.compactMap { product -> SignedOutDecision? in
      guard holdsRecords[product] == true, let anon = device.anon, !entries(of: product, in: anon).isEmpty else { return nil }
      return SignedOutDecision(product: product, counts: anonCount(of: product, in: anon))
    }
    guard due.allSatisfy({ decisions[$0.product] != nil }) else {
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
        for notice in anon.notices { anon.apply(.deleteNotice(notice.id)) }
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
        for notice in anon.notices { target.apply(.putNotice(notice)) }
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

  // Sign-in starts signed out: a bound replica, paused or not, re-authenticates or signs out first (§7.10, §8.2).
  func requireSignedOut(_ device: LoadedDevice) throws {
    guard !device.replicas.contains(where: { $0.meta.state == .bound }) else {
      _ = try Machines.replica.transition(from: .bound, .signIn)
      return
    }
  }

  // §8.2: a bound replica a 401 paused resumes when its account re-authenticates.
  public func reauthenticate(_ replica: inout LoadedReplica) throws {
    guard replica.meta.state == .bound else { throw TransitionError(description: "only a bound replica re-authenticates") }
    replica.update { $0.authPaused = false }
  }

  // Step 2: a dormant replica of the account is rebound with every cursor null; otherwise the anon replica, when
  // entries are left in it; otherwise a new bound replica. The bound replica's id.
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
      }
      return anon.id
    }
    _ = try Machines.replica.transition(from: nil, .signIn, to: .bound)
    let id = try identities.replicaID()
    device.add(ReplicaMeta(replica: id, state: .bound, account: account))
    return id
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

  // §7.10 after the caller's bounded flush: holds released, acked entries resolved (the server holds them). With
  // entries left and no choice, it answers their count; Keep purges the caches and leaves them dormant; Discard
  // deletes the replica. The anon replica, created if absent, becomes active.
  public func signOut(_ device: inout LoadedDevice, choice: SignOutChoice?, identities: IdentitySource) throws -> SignOut {
    let bound = device.active
    let counts = try device.modify(bound) { replica -> SignOut in
      try hold.releaseAll(in: &replica)
      for entry in replica.outbox where entry.state == .acked { try replica.move(entry.localId, .resolve) }
      return SignOut(
        complete: false, ready: replica.outbox.filter { $0.state == .ready }.count,
        sent: replica.outbox.filter { $0.state == .sent }.count)
    }
    let unsent = device.activeReplica.outbox.count
    if unsent > 0 && choice == nil { return counts }
    if unsent == 0 || choice == .keep {
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
    return SignOut(complete: true, ready: counts.ready, sent: counts.sent)
  }

  // An explicit discard of a dormant replica: deleted, its entries discarded.
  public func discardUnsent(_ id: String, in device: inout LoadedDevice) throws {
    try device.modify(id) { replica in
      _ = try Machines.replica.transition(from: replica.meta.node, .discard, to: .deleted)
      for entry in replica.outbox { try replica.move(entry.localId, .discard) }
    }
    device.remove(id)
  }

  // MARK: Subscriptions (§7.9)

  // A scope outside `subscribed` is forgotten, and every acked entry outside it resolves, pulled or not.
  public func reconcile(_ replica: inout LoadedReplica, subscribed: Set<ScopeRef>) throws {
    for scope in replica.cursors.keys.sorted() where !subscribed.contains(scope) {
      replica.apply(.forgetScope(scope))
      for entry in replica.entries(in: scope) where entry.state == .acked { try replica.move(entry.localId, .resolve) }
    }
    for entry in replica.outbox where entry.state == .acked && !subscribed.contains(entry.scope) {
      try replica.move(entry.localId, .resolve)
    }
  }

  // The scope's first pull is complete, or the replica does not pull it.
  public func firstPullComplete(_ scope: ScopeRef, in replica: LoadedReplica, subscribed: Set<ScopeRef>) -> Bool {
    !subscribed.contains(scope) || replica.cursors[scope]?.booted == true
  }
}
