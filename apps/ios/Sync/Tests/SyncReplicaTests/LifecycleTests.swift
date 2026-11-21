import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// Lifecycle decisions over identifiers that differ only by Unicode canonical equivalence: accounts, epochs and record
// ids are the same only byte for byte (§9.1, INV-7).

struct LifecycleTests {
  static let probe = try! Corpus.probeRegistry()

  static func bytes(_ text: String?) -> [UInt8]? { text.map { Array($0.utf8) } }

  @Test func adoptionPreservesEachQueuedEntryAndItsCommitOrder() throws {
    let entries = try [30, 10, 20].map { order in
      OutboxEntry(localId: "g\(order)/0", gestureId: "g\(order)", lineage: "anon", scope: .tree("b_00000001"), state: .ready,
        commitOrder: Int64(order), releaseAt: 0, stamp: try Stamp("1000:\(order):r_aaaaaaaaaaaa"),
        intent: Intent(scope: .tree("b_00000001"), deltas: [Delta(key: RecordKey("tag", RecordID("step\(order)")))]))
    }
    var device = LoadedDevice(meta: DeviceMeta(), active: "rp_anon", replicas: [
      LoadedReplica(meta: ReplicaMeta(replica: "rp_anon", state: .anon), outbox: entries, wholeScopes: true),
    ])
    let result = try ReplicaLifecycle(registry: Self.probe).signIn(&device, account: "A", holdsRecords: [:],
      decisions: [:], counted: [:], identities: try QueuedIdentities(["ids": []]))
    let expected = entries.sorted { $0.commitOrder < $1.commitOrder }.map { entry in
      var adopted = entry; adopted.lineage = "A"; return adopted
    }
    #expect(result == SignIn(complete: true, due: []))
    #expect(device.active == "rp_anon")
    #expect(device.activeReplica.outbox == expected)
    #expect(device.batch.writes.compactMap { write -> OutboxEntry? in
      if case .replica(_, .putEntry(let entry)) = write { return entry }
      return nil
    } == expected)
  }

  @Test func openedTreesPairOnlyTheBoundAccountsOwnOverlayAndReopenBothScopes() throws {
    let lifecycle = ReplicaLifecycle(registry: Self.probe)
    let tree = ScopeRef.tree("b_00000001")
    let overlay = ScopeRef.overlay("b_00000001")
    let set = SubscriptionSet.own(Subscriptions(products: ["probe"], opened: [tree]))
    var device = LoadedDevice(meta: DeviceMeta(), active: "rp_reader", replicas: [
      .fresh(ReplicaMeta(replica: "rp_reader", state: .anon)),
    ])
    #expect(try lifecycle.subscriptionSet(of: device.activeReplica, set) == [tree])
    _ = try lifecycle.signIn(&device, account: "B", holdsRecords: [:], decisions: [:], counted: [:], identities: try QueuedIdentities(["ids": ["rp_bound"]]))
    #expect(try lifecycle.subscriptionSet(of: device.activeReplica, set) == [.product("probe"), tree, overlay])
    var replica = device.activeReplica
    replica.apply(.putKnown(tree, .notFound))
    replica.apply(.putKnown(overlay, .notFound))
    #expect(try lifecycle.subscriptionSet(of: replica, set) == [.product("probe")])
    #expect(lifecycle.subscribe(&replica, to: tree) == .subscribed)
    #expect(replica.known == [:])
    #expect(try lifecycle.subscriptionSet(of: replica, set) == [.product("probe"), tree, overlay])
    replica.apply(.putKnown(tree, .gone))
    replica.apply(.putKnown(overlay, .notFound))
    #expect(lifecycle.subscribe(&replica, to: tree) == .gone)
    #expect(replica.known == [tree: .gone, overlay: .notFound])
  }

  // A dormant replica of "caf\u{E9}" is another account's: signing in as "cafe\u{301}" binds a replica of its own.
  @Test func aLookAlikeAccountSignsIntoAReplicaOfItsOwn() throws {
    var device = LoadedDevice(meta: DeviceMeta(), active: "rp_anon", replicas: [
      .fresh(ReplicaMeta(replica: "rp_anon", state: .anon)),
      .fresh(ReplicaMeta(replica: "rp_cafe", state: .dormant, account: "caf\u{E9}")),
    ])
    let signIn = try ReplicaLifecycle(registry: Self.probe).signIn(
      &device, account: "cafe\u{301}", holdsRecords: [:], decisions: [:], counted: [:], identities: try QueuedIdentities(["ids": ["rp_new"]]))
    #expect(signIn.complete)
    #expect(Self.bytes(device.active) == Self.bytes("rp_new"))
    #expect(device.replicas.map { "\($0.id) \($0.meta.state)" } == ["rp_anon anon", "rp_cafe dormant", "rp_new bound"])
    #expect(device.replicas.map { Self.bytes($0.meta.account) } == [nil, Self.bytes("caf\u{E9}"), Self.bytes("cafe\u{301}")])
  }

  // An answer under "ep-e\u{301}" to a replica in "ep-\u{E9}" is an epoch change: the acked entry returns to ready and the
  // replica re-identifies.
  @Test func anEpochThatOnlyLooksLikeTheCurrentOneIsAnEpochChange() throws {
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-\u{E9}"
    var acked = OutboxEntry(
      localId: "g1/0", gestureId: "g1", lineage: "A", scope: .product("probe"), state: .acked, commitOrder: 1, releaseAt: 0,
      stamp: try Stamp("10:0:r_aaaaaaaaaaaa"), intent: Intent(n: 1, scope: .product("probe"), deltas: [Delta(key: RecordKey("board", "b_00000001"))]))
    acked.resultSeq = 1
    acked.resultEpoch = "ep-\u{E9}"
    var replica = LoadedReplica(meta: meta, outbox: [acked], wholeScopes: true)
    var instance = Instance(actor: try Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: 1_000, appVersion: "1")
    try ReplicaLifecycle(registry: Self.probe).checkEpoch(
      "ep-e\u{301}", in: &replica, instance: &instance, identities: try QueuedIdentities(["ids": ["rp_2"], "actors": ["r_bbbbbbbbbbbb"]]))
    #expect(Self.bytes(replica.meta.serverEpoch) == Self.bytes("ep-e\u{301}"))
    #expect(replica.meta.replica == "rp_2")
    #expect(replica.outbox.map { "\($0.localId) \($0.state)" } == ["g1/0 ready"])
  }

  // Two records whose ids differ only by canonical equivalence are two records to count.
  @Test func anonCountCountsLookAlikeIdsApart() throws {
    let entry = { (order: Int64, id: String) throws -> OutboxEntry in
      OutboxEntry(
        localId: "g\(order)/0", gestureId: "g\(order)", lineage: "anon", scope: .product("probe"), state: .ready, commitOrder: order,
        releaseAt: 0, stamp: try Stamp("10:\(order):r_aaaaaaaaaaaa"),
        intent: Intent(scope: .product("probe"), deltas: [Delta(key: RecordKey("day", RecordID(id)))]))
    }
    let replica = LoadedReplica(
      meta: ReplicaMeta(replica: "rp_1", state: .anon), outbox: [try entry(1, "\u{E9}"), try entry(2, "e\u{301}")], wholeScopes: true)
    #expect(ReplicaLifecycle(registry: Self.probe).anonCount(of: "probe", in: replica) == ["day": 2])
  }
}
