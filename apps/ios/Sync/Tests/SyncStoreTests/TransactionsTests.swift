import Foundation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The store's Actions under the golden corpus: every client-step vector runs through SQLite, each step as the store's
// transactions over partial loads, and the dumped store must equal the vector's device exactly.

struct TransactionsTests {
  static let probe = try! Corpus.probeRegistry()

  static let vectors = try! Corpus.files().filter { Corpus.clientStepFiles.contains($0.path) }.flatMap { try Corpus.vectors(in: $0) }

  @Test(arguments: vectors)
  func everyClientStepVectorHoldsThroughTheStore(_ vector: CorpusVector) throws {
    let answer = try ClientSteps.run(vector.input, registry: Self.probe) { device, limits in
      try StoredDevice(seeding: device, registry: Self.probe, limits: limits)
    }
    #expect(answer == vector.expect, "\(vector)")
  }

  static let transcripts = try! Corpus.files().filter { $0.path.hasPrefix("protocol/") }.flatMap { try Corpus.vectors(in: $0) }

  // The client half of every protocol transcript, each device a store.
  @Test(arguments: transcripts)
  func everyTranscriptsClientHalfHoldsThroughTheStore(_ transcript: CorpusVector) throws {
    let differences = try Transcripts.clientDifferences(transcript.input.asArray(), registry: Self.probe) {
      try StoredDevice(seeding: $0, registry: Self.probe, limits: Limits())
    }
    #expect(differences == [], "\(transcript.file)")
  }

  // Steps beyond the corpus, each run through the planners and through the store: the two must agree exactly, and
  // `returns` names what the steps must answer.
  static let beyond: [(name: String, steps: String, returns: [String])] = [
    ("after a re-identify, numbering starts at 1 beside an acked entry that keeps its number", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "a"}}], "deviceNow": 1000},
      {"op": "push", "deviceNow": 1000},
      {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 1000, "epoch": "ep-1", "lastN": 1, "results": [{"n": 1, "s": "ok", "seq": 1}]}}, "deviceNow": 1001},
      {"op": "reidentify", "deviceNow": 1002},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0002", "f": {"title": "b"}}], "deviceNow": 1003},
      {"op": "push", "deviceNow": 1004}
      """, ["intents.0.n=1"]),
    ("an epoch change in a push answer re-identifies, and numbering starts again at 1", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "a"}}], "deviceNow": 1000},
      {"op": "push", "deviceNow": 1000},
      {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 1000, "epoch": "ep-2", "lastN": 1, "results": [{"n": 1, "s": "ok", "seq": 1}]}}, "deviceNow": 1001},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0002", "f": {"title": "b"}}], "deviceNow": 1003},
      {"op": "push", "deviceNow": 1004}
      """, ["intents.0.n=1"]),
    ("a sign-in while the bound replica is paused throws: it re-authenticates or signs out first", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "a"}}], "deviceNow": 1000},
      {"op": "push", "deviceNow": 1000},
      {"op": "pushResponse", "response": {"status": 401, "body": {"serverTime": 1000, "epoch": "ep-1", "error": "unauthenticated"}}, "deviceNow": 1001},
      {"op": "signIn", "account": "A", "holdsRecords": {"probe": true}, "deviceNow": 1002}
      """, ["throws"]),
    ("a gesture id already in the outbox throws, and the entry holding it stays", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0001", "f": {"title": "first"}}], "opts": {"gestureId": "x", "hold": true}, "deviceNow": 1000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0002", "f": {"title": "second"}}], "opts": {"gestureId": "x"}, "deviceNow": 1001}
      """, ["committed", "throws"]),
    ("an atomic gesture changing one record twice throws: one intent holds one delta per record", """
      {"op": "commit", "scope": "self/overlay/b_00000001", "changes": [{"op": "write", "t": "mark", "id": "tag1", "x": {"memo": "one"}},
        {"op": "write", "t": "mark", "id": "tag1", "x": {"memo": "two"}}], "opts": {"atomic": true}, "deviceNow": 1000}
      """, ["throws"]),
    ("an orphan's refusal folds its held-back dependent into its origin's notice, which keeps its place before a later one", """
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0009", "f": {"title": "Thirteen char"}}], "deviceNow": 5000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0011", "f": {"title": "Thirteen chaR"}}], "deviceNow": 5000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0009", "f": {"title": "Fixed"}},
        {"op": "create", "t": "card", "id": "card0010", "f": {"title": "Fourth"}}], "opts": {"atomic": true}, "deviceNow": 5001},
      {"op": "push", "deviceNow": 5002},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0010", "f": {"title": "Edited"}}], "deviceNow": 5003},
      {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 5004, "epoch": "ep-1", "lastN": 3, "results": [
        {"n": 1, "s": "refused", "code": "invalid"}, {"n": 2, "s": "refused", "code": "invalid"}, {"n": 3, "s": "refused", "code": "unknown-record"}]}},
       "deviceNow": 5004}
      """, []),
    ("a device row outside the product's declared rows throws", """
      {"op": "commit", "scope": "self/probe", "changes": [], "opts": {"local": {"café": 1}}, "deviceNow": 1000}
      """, ["throws"]),
  ]

  // D-17: dismissing hides a notice and keeps it, since an orphan still names it; the orphan's refusal then folds its
  // held-back dependent into that notice, which shows again.
  @Test func aDismissedNoticeAnOrphanNamesStaysAndShowsAgainWhenTheOrphanIsRefused() throws {
    let seeded = try LoadedDevice(json: try JSON(parsing: """
      {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
        "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
        "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}}]}
      """), registry: Self.probe)
    var device = try StoredDevice(seeding: seeded, registry: Self.probe, limits: Limits())
    var context = StepContext(registry: Self.probe, identities: try QueuedIdentities([:]), actor: try Stamp.Actor(ClientSteps.actor))
    let perform = { (device: inout StoredDevice, context: inout StepContext, step: String) in
      _ = try ClientSteps.perform(try JSON(parsing: step), on: &device, context: &context)
    }
    let notices = { (device: StoredDevice) in try device.dump().member("replicas").asArray()[0]["notices"] }
    for step in [
      #"{"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0009", "f": {"title": "Nine"}}], "deviceNow": 5000}"#,
      #"{"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0009", "f": {"title": "Fixed"}}, {"op": "create", "t": "card", "id": "card0010", "f": {"title": "Ten"}}], "opts": {"atomic": true}, "deviceNow": 5001}"#,
      #"{"op": "push", "deviceNow": 5002}"#,
      #"{"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0010", "f": {"title": "Edited"}}], "deviceNow": 5003}"#,
      #"{"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 5004, "epoch": "ep-1", "lastN": 1, "results": [{"n": 1, "s": "refused", "code": "invalid"}]}}, "deviceNow": 5004}"#,
    ] { try perform(&device, &context, step) }
    _ = try device.store.dismissNotice("notice:g1/0")
    let nine: JSON = ["t": "card", "id": "card0009", "born": "5000:0:r_aaaaaaaaaaaa", "life": ["alive", "5000:0:r_aaaaaaaaaaaa"],
                      "f": ["title": ["Nine", "5000:0:r_aaaaaaaaaaaa"]]]
    let orphan: JSON = ["d": [
      ["t": "card", "id": "card0009", "born": "5000:0:r_aaaaaaaaaaaa", "f": ["title": ["Fixed", "5001:0:r_aaaaaaaaaaaa"]]],
      ["t": "card", "id": "card0010", "born": "5001:0:r_aaaaaaaaaaaa", "life": ["alive", "5001:0:r_aaaaaaaaaaaa"],
       "f": ["title": ["Ten", "5001:0:r_aaaaaaaaaaaa"]]],
    ]]
    #expect(try notices(device) == [
      ["id": "notice:g1/0", "scope": "self/probe", "code": "invalid", "at": 5004, "dismissed": true, "content": ["d": [nine], "dependents": [orphan]]],
    ])
    try perform(&device, &context, #"{"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 5005, "epoch": "ep-1", "lastN": 2, "results": [{"n": 2, "s": "refused", "code": "unknown-record"}]}}, "deviceNow": 5005}"#)
    let edited: JSON = ["d": [["t": "card", "id": "card0010", "born": "5001:0:r_aaaaaaaaaaaa", "f": ["title": ["Edited", "5003:0:r_aaaaaaaaaaaa"]]]]]
    #expect(try notices(device) == [
      ["id": "notice:g1/0", "scope": "self/probe", "code": "invalid", "at": 5004, "content": ["d": [nine], "dependents": [orphan, edited]]],
    ])
  }

  // §2.5 and §7.1: gesture ids are unique on the device, so a given gesture id that a dormant replica's notice or outbox
  // entry carries is malformed on the bound replica too, in the planners and in the store alike, and nothing is written.
  @Test(arguments: [
    #""notices": [{"id": "notice:g/0", "scope": "self/probe", "code": "invalid", "content": {"d": []}, "at": 950}]"#,
    #"""
      "outbox": [{"localId": "g/0", "gestureId": "g", "lineage": "A", "scope": "self/probe", "state": "ready", "commitOrder": 1,
        "releaseAt": 0, "stamp": "900:0:r_aaaaaaaaaaaa", "intent": {"scope": "self/probe", "gestureId": "g", "d": [{"t": "card",
        "id": "card0009", "born": "900:0:r_aaaaaaaaaaaa", "life": ["alive", "900:0:r_aaaaaaaaaaaa"]}]}}]
      """#,
  ])
  func aGestureIdAnotherReplicaCarriesIsMalformed(_ dormantHolds: String) throws {
    let meta = { (replica: String, state: String, account: String) in
      """
      {"replica": "\(replica)", "state": "\(state)", "account": "\(account)", "nextN": 1, "hlc": {"ms": 0, "counter": 0},
       "hlcHigh": "0:0:", "admittedHigh": "0:0:", "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1",
       "ackThrough": 0, "authPaused": false}
      """
    }
    let seeded = try LoadedDevice(json: try JSON(parsing: """
      {"active": "rp_00000000000000000000000000000002", "replicas": [
        {"meta": \(meta("rp_00000000000000000000000000000001", "dormant", "A")), \(dormantHolds)},
        {"meta": \(meta("rp_00000000000000000000000000000002", "bound", "B"))}]}
      """), registry: Self.probe)
    let commit = try JSON(parsing: #"""
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0010", "f": {"title": "Ten"}}],
       "opts": {"gestureId": "g"}, "deviceNow": 1000}
      """#)
    var planned = PlannedDevice(seeded, registry: Self.probe, limits: Limits())
    var stored = try StoredDevice(seeding: seeded, registry: Self.probe, limits: Limits())
    #expect(try [Self.failure(of: commit, on: &planned), Self.failure(of: commit, on: &stored)] == [.malformed, .malformed])
    #expect(try stored.dump() == seeded.json)
    #expect(try planned.dump() == seeded.json)
  }

  // The kind of `CommitFailure` a step throws, nil when it throws none.
  static func failure<Device: ClientDevice>(of step: JSON, on device: inout Device) throws -> CommitFailure.Kind? {
    var context = StepContext(registry: probe, identities: try QueuedIdentities([:]), actor: try Stamp.Actor(ClientSteps.actor))
    do {
      _ = try ClientSteps.perform(step, on: &device, context: &context)
      return nil
    } catch let failure as CommitFailure {
      return failure.kind
    }
  }

  @Test(arguments: beyond.indices)
  func beyondTheCorpusThePlannersAndTheStoreAgree(_ index: Int) throws {
    let (name, steps, returns) = Self.beyond[index]
    let input = try JSON(parsing: """
      {"ids": ["rp_00000000000000000000000000000002"], "actors": ["r_bbbbbbbbbbbb"],
       "device": {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
         "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
         "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}}]},
       "steps": [\(steps)]}
      """)
    let planned = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
    let stored = try ClientSteps.run(input, registry: Self.probe) { try StoredDevice(seeding: $0, registry: Self.probe, limits: $1) }
    #expect(stored == planned, "\(name)")
    let answers = try planned.member("returns").asArray()
    for (position, expected) in returns.enumerated() {
      let answer = answers[answers.count - returns.count + position]
      switch expected {
      case "throws": #expect(answer == ["throws": true], "\(name)")
      case "committed": #expect(answer["localIds"] != nil, "\(name)")
      default: #expect(try answer["intents"]?.asArray().first?["n"] == 1, "\(name)")
      }
    }
  }
}

// A corpus device held in an in-memory SQLite store, every step one or more of the store's transactions.
struct StoredDevice: ClientDevice {
  let store: Store
  var events: [EngineEvent] = []

  init(seeding device: LoadedDevice, registry: Registry, limits: Limits) throws {
    store = try Store.inMemory(registry: registry, limits: limits)
    _ = try store.write(.firstLaunch) { _ in Planned((), ReplicaBatch(writes: Seed.writes(of: device))) }
  }

  mutating func take<Value>(_ written: Written<Value>) -> Value {
    events += written.events
    return written.value
  }

  func active() throws -> String { try store.read { try $0.activeReplica() } }

  func activeReplica() throws -> LoadedReplica { try store.read { try $0.device(rows: true) }.activeReplica }

  mutating func commit(_ gesture: Gesture?, in scope: ScopeRef, instance: Instance, identities: IdentitySource) throws -> CommitOutcome? {
    take(try store.commit(in: scope, instance: instance, identities: identities) { _ in (gesture, ()) }).outcome
  }

  mutating func release(_ localId: String) throws -> Bool { take(try store.release(localId)) }
  mutating func releaseAll() throws { _ = take(try store.releaseAll()) }
  mutating func releaseDue(at deviceNow: Int64) throws { take(try store.releaseDue(at: deviceNow)) }
  mutating func undo(_ gestureId: String) throws -> Bool { take(try store.undo(gestureId)) }
  mutating func push(limit: Int?) throws -> PushRequest? { take(try store.number(limit: limit)) }

  // Each step of the answer in its own transaction, as the sender runs them.
  mutating func receive(_ answer: Answer<PushResponse>, to request: PushRequest, instance: inout Instance, timing: Timing,
                        identities: IdentitySource) throws -> Int? {
    var replica: String? = try active()
    var limit: Int?
    for step in PushPlanner(registry: store.registry, limits: store.limits).steps(for: answer, to: request) {
      if case .halve(let half, _) = step { limit = half }
      guard let current = replica else { break }
      replica = take(try store.apply(step, replica: current, instance: &instance, timing: timing, identities: identities))
    }
    return limit
  }

  mutating func hello(serverTime: Int64?, timing: Timing) throws {
    guard let serverTime else { return }
    take(try store.sample(serverTime: serverTime, timing: timing))
  }

  mutating func start(backup: BackupCopy, instance: inout Instance, identities: IdentitySource) throws -> EngineStart {
    take(try store.start(backup: backup, instance: &instance, identities: identities))
  }

  mutating func pullRequest(_ scopes: [ScopeRef]) throws -> PullRequest { try store.pullRequest(scopes) }

  // Each step of the answer in its own transaction, following the replica through an epoch change's re-identify.
  mutating func receive(_ answer: Answer<PullResponse>, to request: PullRequest, instance: inout Instance, timing: Timing,
                        identities: IdentitySource) throws -> [(scope: ScopeRef, outcome: PageOutcome)] {
    var replica: String? = try active()
    var outcomes: [(scope: ScopeRef, outcome: PageOutcome)] = []
    for step in PageApplier(registry: store.registry).steps(for: answer, to: request) {
      guard let current = replica else { break }
      let applied = take(try store.apply(step, replica: current, instance: &instance, timing: timing, identities: identities))
      replica = applied.replica
      if case .page(let page, _) = step, let outcome = applied.outcome { outcomes.append((page.scope, outcome)) }
    }
    return outcomes
  }

  mutating func apply(_ frame: LiveFrame, instance: Instance) throws -> FrameOutcome { take(try store.apply(frame, instance: instance)) }
  mutating func reconcile(_ scopes: Set<ScopeRef>) throws { take(try store.reconcile(subscribed: scopes)) }

  mutating func signIn(account: String, holdsRecords: [String: Bool], decisions: [String: LineageAnswer],
                       identities: IdentitySource) throws -> SignIn {
    take(try store.signIn(account: account, holdsRecords: holdsRecords, decisions: decisions, identities: identities))
  }

  mutating func signOut(choice: SignOutChoice?, identities: IdentitySource) throws -> SignOut {
    take(try store.signOut(choice: choice, identities: identities))
  }

  mutating func discardUnsent(_ replica: String) throws { take(try store.discardDormant(replica)) }

  mutating func reidentify(instance: inout Instance, identities: IdentitySource) throws {
    take(try store.reidentify(instance: &instance, identities: identities))
  }

  mutating func changeEpoch(to epoch: String, instance: inout Instance, identities: IdentitySource) throws {
    take(try store.changeEpoch(to: epoch, instance: &instance, identities: identities))
  }

  func anonCount(of product: String, in replica: String) throws -> [String: Int] { try store.anonCount(of: product, in: replica) }
  func dump() throws -> JSON { try store.read { try $0.device(rows: true).json } }
}

// The writes that build a whole device in an empty store, replicas in their order.
enum Seed {
  static func writes(of device: LoadedDevice) -> [StoreWrite] {
    device.replicas.flatMap { replica -> [StoreWrite] in
      var writes: [ReplicaWrite] = replica.outbox.map { .putEntry($0) }
      for (scope, rows) in replica.confirmed { writes += rows.all.map { .putRow(scope, $0) } }
      for (scope, record) in replica.cursors { writes.append(.putCursor(scope, record)) }
      for (scope, staging) in replica.staging {
        writes += [.beginStaging(scope)] + staging.rows.all.map { .putStagedRow(scope, $0) } + [.stagingDigest(scope, staging.digest)]
      }
      for (scope, ids) in replica.spent { writes += ids.values.map { .putSpent(scope, $0) } }
      for (scope, kind) in replica.known { writes.append(.putKnown(scope, kind)) }
      writes += replica.notices.map { .putNotice($0) }
      for (product, rows) in replica.deviceRows { writes += rows.members.map { .putDeviceRow(product: product, key: $0.key, $0.value) } }
      return [.createReplica(replica.meta)] + writes.map { .replica(replica.id, $0) }
    } + [.device(device.meta, active: device.active)]
  }
}
