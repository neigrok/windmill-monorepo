import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// The corpus's client-step language (corpus/README.md "Client steps"): a device, queues of identities, and steps whose
// answers, ended entries and telemetry a vector expects. `ClientDevice` is what the steps drive: the planners over an
// in-memory device here, and the store's transactions in the store's tests.

public protocol ClientDevice {
  // A nil gesture is a read-and-commit that decides none: nothing is written and the outcome is nil.
  mutating func commit(_ gesture: Gesture?, in scope: ScopeRef, instance: Instance, identities: IdentitySource) throws -> CommitOutcome?
  mutating func release(_ localId: String) throws -> Bool
  mutating func releaseAll() throws
  mutating func releaseDue(at deviceNow: Int64) throws
  mutating func undo(_ gestureId: String) throws -> Bool
  // D-17: the active replica's notice takes `dismissed`; a notice the replica does not hold throws.
  mutating func dismiss(_ noticeId: String) throws
  mutating func push(limit: Int?, at deviceNow: Int64) throws -> PushRequest?
  mutating func receive(_ answer: Answer<PushResponse>, to request: PushRequest, instance: inout Instance, timing: Timing,
                        identities: IdentitySource) throws -> Int?
  mutating func hello(serverTime: Int64?, timing: Timing) throws
  mutating func start(backup: BackupCopy, instance: inout Instance, identities: IdentitySource) throws -> EngineStart
  mutating func pullRequest(_ scopes: [ScopeRef]) throws -> PullRequest
  mutating func receive(_ answer: Answer<PullResponse>, to request: PullRequest, instance: inout Instance, timing: Timing,
                        identities: IdentitySource) throws -> [(scope: ScopeRef, outcome: PageOutcome)]
  mutating func apply(_ frame: LiveFrame, instance: Instance) throws -> FrameOutcome
  mutating func subscribe(_ scope: ScopeRef) throws -> SubscribeOutcome
  mutating func reconcile(_ scopes: Set<ScopeRef>) throws
  mutating func signIn(account: String, holdsRecords: [String: Bool], decisions: [String: LineageAnswer],
                       counted: [String: [String]], identities: IdentitySource) throws -> SignIn
  mutating func signOut(choice: SignOutChoice?, counted: [String]?, identities: IdentitySource) throws -> SignOut
  mutating func discardUnsent(_ replica: String) throws
  mutating func reidentify(instance: inout Instance, identities: IdentitySource) throws
  mutating func changeEpoch(to epoch: String, instance: inout Instance, identities: IdentitySource) throws
  func anonCount(of product: String, in replica: String) throws -> [String: Int]
  // The active replica with every row loaded, which a `view` step folds.
  func activeReplica() throws -> LoadedReplica
  // The whole store in the corpus's device form, and every event since the device was built.
  func dump() throws -> JSON
  var events: [EngineEvent] { get }
}

// The client planners over one in-memory device: each step changes the loaded copy.
public struct PlannedDevice: ClientDevice {
  public private(set) var device: LoadedDevice
  let commits: CommitPlanner
  let hold: Hold
  let pushes: PushPlanner
  let pages: PageApplier
  let lifecycle: ReplicaLifecycle

  public init(_ device: LoadedDevice, registry: Registry, limits: Limits) {
    self.device = device
    commits = CommitPlanner(registry: registry, limits: limits)
    hold = Hold(registry: registry)
    pushes = PushPlanner(registry: registry, limits: limits)
    pages = PageApplier(registry: registry)
    lifecycle = ReplicaLifecycle(registry: registry)
  }

  public var events: [EngineEvent] { device.events }

  public mutating func commit(_ gesture: Gesture?, in scope: ScopeRef, instance: Instance, identities: IdentitySource) throws -> CommitOutcome? {
    let gestureIdTaken = gesture?.gestureId.map(device.carries(gestureId:)) ?? false
    return try device.modify(device.active) { replica in
      guard let gesture else {
        try commits.checkWritable(replica.meta)
        return nil
      }
      return try commits.commit(gesture, in: scope, to: &replica, as: instance, identities: identities, gestureIdTaken: gestureIdTaken)
    }
  }

  public mutating func release(_ localId: String) throws -> Bool {
    try device.modify(device.active) { try hold.release(localId, in: &$0) }
  }

  public mutating func releaseAll() throws {
    try device.modify(device.active) { try hold.releaseAll(in: &$0) }
  }

  public mutating func releaseDue(at deviceNow: Int64) throws {
    try device.modify(device.active) { try hold.releaseDue(at: deviceNow, in: &$0) }
  }

  public mutating func undo(_ gestureId: String) throws -> Bool {
    try device.modify(device.active) { try hold.undo(gestureId, in: &$0) }
  }

  public mutating func dismiss(_ noticeId: String) throws {
    guard device.modify(device.active, { $0.dismiss(notice: noticeId) }) else {
      throw VectorError("\(noticeId) is not a notice of \(device.active)")
    }
  }

  public mutating func push(limit: Int?, at deviceNow: Int64) throws -> PushRequest? {
    try device.modify(device.active) { try pushes.number(&$0, limit: limit, at: deviceNow) }
  }

  public mutating func receive(_ answer: Answer<PushResponse>, to request: PushRequest, instance: inout Instance, timing: Timing,
                               identities: IdentitySource) throws -> Int? {
    try device.modify(device.active) {
      try pushes.receive(answer, to: request, in: &$0, instance: &instance, timing: timing, identities: identities)
    }
  }

  public mutating func hello(serverTime: Int64?, timing: Timing) throws {
    guard let serverTime else { return }
    device.modify(device.active) { $0.update { $0.sample(serverTime: serverTime, send: timing.send, recv: timing.recv) } }
  }

  public mutating func start(backup: BackupCopy, instance: inout Instance, identities: IdentitySource) throws -> EngineStart {
    try lifecycle.start(&device, backup: backup, instance: &instance, identities: identities)
  }

  public mutating func pullRequest(_ scopes: [ScopeRef]) throws -> PullRequest {
    pages.request(scopes, in: device.activeReplica).request
  }

  public mutating func receive(_ answer: Answer<PullResponse>, to request: PullRequest, instance: inout Instance, timing: Timing,
                               identities: IdentitySource) throws -> [(scope: ScopeRef, outcome: PageOutcome)] {
    try device.modify(device.active) {
      try pages.receive(answer, to: request, in: &$0, instance: &instance, timing: timing, identities: identities)
    }
  }

  public mutating func apply(_ frame: LiveFrame, instance: Instance) throws -> FrameOutcome {
    try device.modify(device.active) { try pages.apply(frame, to: &$0, instance: instance) }
  }

  public mutating func subscribe(_ scope: ScopeRef) throws -> SubscribeOutcome {
    device.modify(device.active) { lifecycle.subscribe(&$0, to: scope) }
  }

  public mutating func reconcile(_ scopes: Set<ScopeRef>) throws {
    try device.modify(device.active) { try lifecycle.reconcile(&$0, subscribed: scopes) }
  }

  public mutating func signIn(account: String, holdsRecords: [String: Bool], decisions: [String: LineageAnswer],
                              counted: [String: [String]], identities: IdentitySource) throws -> SignIn {
    try lifecycle.signIn(&device, account: account, holdsRecords: holdsRecords, decisions: decisions, counted: counted, identities: identities)
  }

  public mutating func signOut(choice: SignOutChoice?, counted: [String]?, identities: IdentitySource) throws -> SignOut {
    try lifecycle.signOut(&device, choice: choice, counted: counted, identities: identities)
  }

  public mutating func discardUnsent(_ replica: String) throws {
    try lifecycle.discardUnsent(replica, in: &device)
  }

  public mutating func reidentify(instance: inout Instance, identities: IdentitySource) throws {
    try device.modify(device.active) { try lifecycle.reidentify(&$0, instance: &instance, identities: identities) }
  }

  public mutating func changeEpoch(to epoch: String, instance: inout Instance, identities: IdentitySource) throws {
    try device.modify(device.active) { try lifecycle.changeEpoch(to: epoch, in: &$0, instance: &instance, identities: identities) }
  }

  public func anonCount(of product: String, in replica: String) throws -> [String: Int] {
    guard let replica = device.replica(replica) else { throw VectorError("no replica \(replica)") }
    return lifecycle.anonCount(of: product, in: replica)
  }

  public func activeReplica() throws -> LoadedReplica { device.activeReplica }

  public func dump() throws -> JSON { device.json }
}

// MARK: - The runner

// What one device's steps share: the registry, its identity queues, the actor its instance holds, and the requests
// awaiting answers.
public struct StepContext {
  public let registry: Registry
  public let identities: QueuedIdentities
  public var actor: Stamp.Actor
  var lastPush: PushRequest?
  var lastPull: PullRequest?

  public init(registry: Registry, identities: QueuedIdentities, actor: Stamp.Actor) {
    self.registry = registry
    self.identities = identities
    self.actor = actor
  }
}

public enum ClientSteps {
  public static let actor = "r_aaaaaaaaaaaa"

  // Runs a vector's steps on a device built from its input, answering `{returns, device, ended, telemetry?}`. A step
  // that throws a commit or transition error answers `{throws: true}` and leaves everything as it was.
  public static func run<Device: ClientDevice>(_ input: JSON, registry: Registry,
                                               device makeDevice: (LoadedDevice, Limits) throws -> Device) throws -> JSON {
    let limits = Limits(pushMaxBytes: Int(try input["limits"]?["PUSH_MAX_BYTES"]?.asInteger() ?? Int64(Constants.pushMaxBytes)))
    var device = try makeDevice(try LoadedDevice(json: input.member("device"), registry: registry), limits)
    var context = StepContext(
      registry: registry, identities: try QueuedIdentities(input), actor: try Stamp.Actor(input["actor"]?.asString() ?? ClientSteps.actor))
    var returns: [JSON] = []
    for step in try input.member("steps").asArray() {
      let before = (device: device, identities: context.identities.snapshot(), context: context)
      do {
        returns.append(try perform(step, on: &device, context: &context))
      } catch let error where error is CommitFailure || error is TransitionError {
        device = before.device
        context = before.context
        context.identities.restore(before.identities)
        returns.append(["throws": true])
      }
    }
    var expect: JSON.Object = [
      "returns": .array(returns), "device": try device.dump(),
      "ended": .array(device.events.filter { !$0.isTelemetry }.map(\.json)),
    ]
    let telemetry = device.events.filter(\.isTelemetry)
    if !telemetry.isEmpty { expect["telemetry"] = .array(telemetry.map(\.json)) }
    return .object(expect)
  }

  // One step `{op, deviceNow?, actor?, appVersion?, …}` on the device, answering its return value. A renewed actor
  // stays with the context; a step's own `actor` holds for that step only.
  public static func perform<Device: ClientDevice>(_ step: JSON, on device: inout Device, context: inout StepContext) throws -> JSON {
    let identities = context.identities
    let stepActor = try step["actor"].map { try Stamp.Actor($0.asString()) } ?? context.actor
    let deviceNow = try step["deviceNow"]?.asInteger() ?? 0
    var instance = Instance(actor: stepActor, deviceNow: deviceNow, appVersion: try step["appVersion"]?.asString() ?? "1")
    let timing = try timing(of: step, deviceNow: deviceNow)
    defer { if instance.actor != stepActor { context.actor = instance.actor } }
    switch try step.member("op").asString() {
    case "commit":
      let decided = step["changes"]?.isNull == true ? nil : try gesture(step)
      let outcome = try device.commit(decided, in: try ScopeRef(json: step.member("scope")), instance: instance, identities: identities)
      return outcome.map(json) ?? .null
    case "release": return .bool(try device.release(step.member("localId").asString()))
    case "releaseAll":
      try device.releaseAll()
      return .null
    case "releaseDue":
      try device.releaseDue(at: deviceNow)
      return .null
    case "undo": return .bool(try device.undo(step.member("gestureId").asString()))
    case "dismiss":
      try device.dismiss(step.member("id").asString())
      return .null
    case "push":
      context.lastPush = try device.push(limit: try step["limit"].map { Int(try $0.asInteger()) }, at: deviceNow)
      return context.lastPush?.json ?? .null
    case "pushResponse":
      guard let request = context.lastPush else { throw VectorError("pushResponse without a push") }
      let limit = try device.receive(try answer(step, PushResponse.init(json:)), to: request, instance: &instance, timing: timing, identities: identities)
      return limit.map { ["limit": JSON($0)] } ?? .null
    case "hello":
      try device.hello(serverTime: try step.member("response")["body"]?["serverTime"]?.asInteger(), timing: timing)
      return .null
    case "engineStart":
      let backup: BackupCopy = try step["backupGuard"].map { $0.isNull ? .missing : .held(try $0.asString()) } ?? .notKept
      return json(try device.start(backup: backup, instance: &instance, identities: identities))
    case "pull":
      let request = try device.pullRequest(try step.member("scopes").asArray().map { try ScopeRef(json: $0) })
      context.lastPull = request
      return request.json
    case "pullResponse":
      guard let request = context.lastPull else { throw VectorError("pullResponse without a pull") }
      let outcomes = try device.receive(try answer(step, PullResponse.init(json:)), to: request, instance: &instance, timing: timing, identities: identities)
      return .array(outcomes.map { ["scope": $0.scope.json, "outcome": .string($0.outcome.rawValue)] })
    case "frame": return .string(try device.apply(try LiveFrame(json: step.member("frame")), instance: instance).rawValue)
    case "subscribe":
      let outcome = try device.subscribe(try ScopeRef(json: step.member("scope")))
      return outcome == .gone ? .string(outcome.rawValue) : .null
    case "reconcile":
      try device.reconcile(Set(try step.member("scopes").asArray().map { try ScopeRef(json: $0) }))
      return .null
    case "signIn":
      let decisions = try JSON.map(step["decisions"]) { json -> LineageAnswer in
        guard let answer = LineageAnswer(rawValue: try json.asString()) else { throw VectorError("not a decision") }
        return answer
      }
      let signIn = try device.signIn(
        account: try step.member("account").asString(), holdsRecords: try JSON.map(step["holdsRecords"]) { try $0.asBool() },
        decisions: decisions, counted: try JSON.map(step["counted"]) { try $0.asArray().map { try $0.asString() } },
        identities: identities)
      return json(signIn)
    case "signOut":
      let choice = try step["choice"].map { json -> SignOutChoice in
        guard let choice = SignOutChoice(rawValue: try json.asString()) else { throw VectorError("not a choice") }
        return choice
      }
      let counted = try step["counted"].map { try $0.asArray().map { try $0.asString() } }
      return json(try device.signOut(choice: choice, counted: counted, identities: identities))
    case "discardUnsent":
      try device.discardUnsent(try step.member("replica").asString())
      return .null
    case "reidentify":
      try device.reidentify(instance: &instance, identities: identities)
      return .null
    case "epochChange":
      try device.changeEpoch(to: try step.member("epoch").asString(), instance: &instance, identities: identities)
      return .null
    case "anonCount":
      let counts = try device.anonCount(of: try step.member("product").asString(), in: try step.member("replica").asString())
      return JSON.object(from: counts) { JSON($0) } ?? [:]
    case "view":
      let scope = try ScopeRef(json: step.member("scope"))
      let replica = try device.activeReplica()
      let view = try ScopeView(replica, scope, try step.member("withHeld").asBool() ? .drawn : .stored, registry: context.registry)
      let stored = try ScopeView(replica, scope, .stored, registry: context.registry)
      let capped = context.registry.types.filter { $0.cap != nil && $0.scope == context.registry.scopeKind(of: scope) }
      return [
        "records": .array(view.all.map(\.json)),
        "capCount": .object(JSON.Object(uniqueKeysWithValues: capped.map { ($0.name, JSON(stored.visibleCount($0.name))) })),
      ]
    case let op:
      throw VectorError("unknown step \(op)")
    }
  }

  // MARK: The step language

  static func timing(of step: JSON, deviceNow: Int64) throws -> Timing {
    if let send = step["send"], let recv = step["recv"] { return Timing(send: try ClockReading(json: send), recv: try ClockReading(json: recv)) }
    return .steady(send: try step["tSend"]?.asInteger() ?? deviceNow, recv: try step["tRecv"]?.asInteger() ?? deviceNow)
  }

  static func answer<Body>(_ step: JSON, _ decode: (JSON) throws -> Body) throws -> Answer<Body> {
    let response = try step.member("response")
    let status = Int(try response.member("status").asInteger())
    guard status == 200 else { return .failed(try HTTPFailure(status: status, body: response["body"])) }
    return .ok(try decode(response.member("body")))
  }

  public static func gesture(_ step: JSON) throws -> Gesture {
    let opts = step["opts"] ?? [:]
    return Gesture(
      changes: try step["changes"]?.asArray().map(change) ?? [],
      atomic: try opts["atomic"]?.asBool() ?? false,
      hold: try opts["hold"]?.asBool() ?? false,
      guards: try opts["guard"]?.asArray().map { register in
        RegisterRef(type: try register.member("t").asString(), id: try RecordID(json: register.member("id")), field: try register.member("field").asString())
      } ?? [],
      retire: try opts["retire"]?.asArray().map { RecordRef(type: try $0.member("t").asString(), id: try RecordID(json: $0.member("id"))) } ?? [],
      command: try opts["cmd"].map { try Command(json: $0) },
      predict: try opts["predict"]?.asArray().map(change) ?? [],
      local: try (opts["local"]?.asObject().members ?? []).map { DeviceWrite(key: $0.key, value: $0.value.isNull ? nil : $0.value) },
      gestureId: try opts["gestureId"]?.asString())
  }

  static func change(_ json: JSON) throws -> Change {
    let type = try json.member("t").asString()
    let id = try json["id"].map { try RecordID(json: $0) }
    let values = try JSON.map(json["f"]) { $0 }
    let texts = try JSON.map(json["x"]) { edit -> TextEdit in
      if case .string(let text) = edit { return TextEdit(text: text) }
      return TextEdit(text: try edit.member("text").asString(), editedFrom: try edit["from"]?.asString())
    }
    let anchor = try json["anchor"].map { anchor in
      OrderAnchor(field: try anchor.member("field").asString(), below: try anchor.member("below").nullable { try RecordID(json: $0) })
    }
    let required = { () throws -> RecordID in
      guard let id else { throw VectorError("a \(type) change names its id") }
      return id
    }
    switch try json.member("op").asString() {
    case "create":
      let newID: NewID = if let id { .given(id) } else if let label = try json["label"]?.asString() { .derived(label: label) } else { .minted }
      return Change(type: type, operation: .create(newID), values: values, texts: texts, anchor: anchor)
    case "update": return Change(type: type, operation: .update(try required()), values: values, texts: texts)
    case "delete": return Change(type: type, operation: .delete(try required()))
    case "revive": return Change(type: type, operation: .revive(try required()), values: values)
    case "put": return Change(type: type, operation: .put(try required(), present: try json["present"]?.asBool() ?? true), values: values, texts: texts)
    case "write": return Change(type: type, operation: .write(try required()), values: values, texts: texts)
    case "move": return Change(type: type, operation: .move(try required()), anchor: anchor)
    case let op: throw VectorError("unknown change \(op)")
    }
  }

  // MARK: Answers in the corpus's form

  public static func json(_ outcome: CommitOutcome) -> JSON {
    switch outcome {
    case .committed(let receipt):
      return ["localIds": .array(receipt.localIds.map { .string($0) }), "retired": .array(receipt.retired.map { .string($0) }), "stamp": receipt.stamp.json]
    case .refused(let code, let detail):
      var object: JSON.Object = ["refused": code.json]
      object["detail"] = detail
      return .object(object)
    }
  }

  static func json(_ start: EngineStart) -> JSON {
    var object: JSON.Object = ["actor": .string(start.actor.text), "reidentified": .bool(start.reidentified)]
    object["pendingSignIn"] = start.pendingSignIn.map { ["account": .string($0)] }
    return .object(object)
  }

  public static func json(_ signIn: SignIn) -> JSON {
    [
      "complete": .bool(signIn.complete),
      "due": .array(signIn.due.map { decision in
        [
          "kind": "signed-out", "product": .string(decision.product), "count": JSON.object(from: decision.counts) { JSON($0) } ?? [:],
          "counted": .array(decision.counted.map { .string($0) }),
        ]
      }),
    ]
  }

  public static func json(_ signOut: SignOut) -> JSON {
    [
      "complete": .bool(signOut.complete), "unsent": JSON(signOut.unsent), "ready": JSON(signOut.ready), "sent": JSON(signOut.sent),
      "counted": .array(signOut.counted.map { .string($0) }),
    ]
  }
}

// MARK: - Identity queues

// The vector's queues, each consumed in order: replica ids, actors, fork guards and CSPRNG draws; gesture ids count
// g1, g2, … within the vector.
public final class QueuedIdentities: IdentitySource, Sendable {
  public struct Snapshot: Sendable {
    let queues: Queues
    let gestures: Int
  }

  // The g1, g2, … count, which a transcript's devices share.
  public final class GestureCount: Sendable {
    let value = Mutex(0)

    public init() {}
  }

  struct Queues: Sendable {
    var ids: [String]
    var actors: [String]
    var forkGuards: [String]
    var draws: [Int]
    var lastActor: String?
  }

  let queues: Mutex<Queues>
  let gestures: GestureCount

  // `input`'s queues `ids`, `actors`, `forkGuards` and `draws`, each optional.
  public init(_ input: JSON, gestures: GestureCount = GestureCount()) throws {
    queues = Mutex(Queues(
      ids: try input["ids"]?.asArray().map { try $0.asString() } ?? [],
      actors: try input["actors"]?.asArray().map { try $0.asString() } ?? [],
      forkGuards: try input["forkGuards"]?.asArray().map { try $0.asString() } ?? [],
      draws: try input["draws"]?.asArray().map { Int(try $0.asInteger()) } ?? []))
    self.gestures = gestures
  }

  public func snapshot() -> Snapshot {
    Snapshot(queues: queues.withLock { $0 }, gestures: gestures.value.withLock { $0 })
  }

  public func restore(_ snapshot: Snapshot) {
    queues.withLock { $0 = snapshot.queues }
    gestures.value.withLock { $0 = snapshot.gestures }
  }

  // The actor handed out last is handed out again next: a store loaded under a running instance keeps its actor.
  public func reissueLastActor() {
    queues.withLock { queues in
      if let last = queues.lastActor { queues.actors.insert(last, at: 0) }
    }
  }

  public func draw(below bound: Int) throws -> Int {
    let index = try take(\.draws, "draws")
    guard index < bound else { throw VectorError("draw \(index) is not below \(bound)") }
    return index
  }

  public func gestureID() throws -> String {
    gestures.value.withLock { value in
      value += 1
      return "g\(value)"
    }
  }

  public func replicaID() throws -> String { try take(\.ids, "ids") }
  public func forkGuard() throws -> String { try take(\.forkGuards, "forkGuards") }

  public func actor() throws -> Stamp.Actor {
    let actor = try take(\.actors, "actors")
    queues.withLock { $0.lastActor = actor }
    return try Stamp.Actor(actor)
  }

  func take<Value: Sendable>(_ queue: WritableKeyPath<Queues, [Value]>, _ name: String) throws -> Value {
    try queues.withLock { queues in
      guard !queues[keyPath: queue].isEmpty else { throw VectorError("the vector uses more \(name) than it lists") }
      return queues[keyPath: queue].removeFirst()
    }
  }
}

// MARK: - A store holding a device

extension ReplicaBatch {
  // The writes that put `device` whole into an empty store, replicas in their order, as the corpus writes a device down.
  public init(building device: LoadedDevice) {
    let writes = device.replicas.flatMap { replica -> [StoreWrite] in
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
    }
    self.init(writes: writes + [.device(device.meta, active: device.active)])
  }
}

extension Store {
  // An in-memory store holding `device` whole: a device restored from a backup, or one another was cloned into.
  public static func inMemory(holding device: LoadedDevice, registry: Registry, limits: Limits = Limits(),
                              crashPoints: CrashPoints = .none) throws -> Store {
    let store = try Store.inMemory(registry: registry, limits: limits, crashPoints: crashPoints)
    _ = try store.write(.firstLaunch) { _ in Planned((), ReplicaBatch(building: device)) }
    return store
  }
}

public struct VectorError: Error, CustomStringConvertible {
  public let description: String

  public init(_ description: String) {
    self.description = description
  }
}

extension JSON {
  public func nullable<Value>(_ decode: (JSON) throws -> Value) rethrows -> Value? {
    isNull ? nil : try decode(self)
  }
}
