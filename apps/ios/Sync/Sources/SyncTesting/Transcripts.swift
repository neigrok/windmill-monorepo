import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import Synchronization

// protocol/*.jsonl from the client's side (corpus/README.md "protocol/*.jsonl"), through the real engine. Each device is
// an engine in step mode over an in-memory store holding the header's device, its ids and actors the header's queues
// (engine start takes the first actor), its clock reading each line's `deviceNow` on the wall and monotonic clocks
// alike. A client action goes through the engine's call for it. An exchange is expected by the device's
// `TranscriptTransport` and made by the step that makes it: the hello, a sender step, or a puller step once the line's
// tree and overlay scopes are subscribed. The puller pulls what it wants of its own (a first pull, a new subscription,
// a gap, a stale page); only when it wants nothing does the line's own trigger, which no transcript line shows, want
// its scopes. A frame arrives on the device's live socket, opened by a live step, and a puller step applies it. A
// `load` replaces the store under the running instance, which keeps its actor. The last line is the end: each
// device's store and ended log are checked, the log running across loads. Server lines are the server runner's.

public enum Transcripts {
  // The fork guard each store is given, its copy kept beside it, so no engine start re-identifies. No transcript device
  // carries one, so it is left out of the stores compared.
  static let forkGuard = "fg_00000000000000000000000000000000"

  // Where the engines and the transcript disagree; empty when they agree throughout.
  public static func differences(_ lines: [JSON], registry: Registry) async throws -> [String] {
    guard let header = lines.first else { throw VectorError("a transcript starts with its header") }
    guard lines.count > 1, lines.last?["end"] != nil else { throw VectorError("a transcript ends with its end line") }
    let accounts = try header["server"]?["accounts"]?.asObject().members.map(\.key) ?? []
    let gestures = QueuedIdentities.GestureCount()
    var devices: [String: TranscriptDevice] = [:]
    for (name, json) in try header.member("devices").asObject().members {
      let queues: JSON = ["ids": header["ids"]?[name] ?? [], "actors": header["actors"]?[name] ?? [.string(ClientSteps.actor)]]
      devices[name] = try TranscriptDevice(
        holding: try LoadedDevice(json: json, registry: registry), registry: registry,
        identities: try QueuedIdentities(queues, gestures: gestures),
        tokens: InMemoryTokenStore(Dictionary(uniqueKeysWithValues: accounts.map { ($0, Transcripts.token(for: $0)) })))
    }

    var differences: [String] = []
    for line in lines.dropFirst() {
      let place = "step \(line["step"]?.jcsText ?? "?")"
      if line["end"] != nil {
        for (name, device) in devices.sorted(by: { $0.key < $1.key }) {
          let expected = try device.offsets.augment(line["devices"]?[name])
          differences += expected.differences.map { "\(place): \(name): \($0)" }
          differences += Self.compare(try device.dump(), expected.device, "\(place): \(name)'s store is")
          differences += Self.compare(.array(device.ended.filter(\.isEnded).map(\.json)), line["ended"]?[name],
                                      "\(place): \(name)'s ended log is")
        }
        continue
      }
      if line["server"] != nil { continue }
      let name = try line.member("device").asString()
      guard let device = devices[name] else { throw VectorError("\(place) names \(name), a device the header does not hold") }
      try device.clock(at: try line["deviceNow"]?.asInteger() ?? 0)
      differences += try await device.perform(line, place: place)
    }
    return differences
  }

  // The session token the server issued `account`. Each device keeps its own, and engine start deletes those no sign-in
  // on the device needs.
  static func token(for account: String) -> SessionToken { SessionToken("token-\(account)") }

  static func compare(_ answer: JSON, _ expected: JSON?, _ what: String) -> [String] {
    guard let expected, answer != expected else { return [] }
    return ["\(what) \(answer.jcsText), not \(expected.jcsText)"]
  }
}

// One transcript device: its engine and the store under it, which a `load` replaces, and what they run against.
final class TranscriptDevice {
  // What a device's engine runs against, outliving a `load`: the identity queues, the tokens, the clock, the transport,
  // the fork guard's copy, and the ended log across every engine.
  struct Surroundings: Sendable {
    let registry: Registry
    let identities: QueuedIdentities
    let tokens: InMemoryTokenStore
    let clock = SimClock(wallMs: 0)
    let transport = TranscriptTransport()
    let forkGuard = InMemoryForkGuardStore(Transcripts.forkGuard)
    let ended = EventLog()

    // An engine in step mode over a store holding `device`, given the fork guard whose copy is kept.
    func engine(holding device: LoadedDevice) throws -> (store: Store, engine: SyncEngine) {
      var meta = device.meta
      meta.forkGuard = meta.forkGuard ?? Transcripts.forkGuard
      let store = try Store.inMemory(holding: LoadedDevice(meta: meta, active: device.active, replicas: device.replicas), registry: registry)
      let engine = try SyncEngine(
        config: EngineConfig(appVersion: "1", surface: .ios, drivesLoops: false), bindings: [], store: store, transport: transport,
        tokens: tokens, forkGuard: forkGuard, clock: clock.engineClock, random: NoJitter(), identities: identities,
        connectivity: SwitchedConnectivity(), tap: { [ended] in ended.append($0) })
      return (store, engine)
    }
  }

  // Every backoff draw is 0, so no retry waits across the transcript's lines: 1 is the raw draw a uniform draw below
  // any bound maps to 0 without rejecting it.
  struct NoJitter: RandomSource {
    func next() -> UInt64 { 1 }
  }

  let around: Surroundings
  var store: Store
  var engine: SyncEngine
  var subscribed: [ScopeRef] = []
  var offsets: TranscriptOffsets

  init(holding device: LoadedDevice, registry: Registry, identities: QueuedIdentities, tokens: InMemoryTokenStore) throws {
    let around = Surroundings(registry: registry, identities: identities, tokens: tokens)
    (store, engine) = try around.engine(holding: device)
    self.around = around
    offsets = TranscriptOffsets(device)
  }

  var ended: [EngineEvent] { around.ended.events }

  func clock(at deviceNow: Int64) throws {
    let now = around.clock.nowMs()
    guard deviceNow >= now else { throw VectorError("the device clock goes back from \(now) to \(deviceNow)") }
    around.clock.advance(ms: deviceNow - now)
  }

  // The store as the corpus writes a device down, without the fork guard it was given.
  func dump() throws -> JSON {
    var dumped = try store.read { try $0.device(rows: true).json }.asObject()
    if dumped["meta"] == ["forkGuard": .string(Transcripts.forkGuard)] { dumped["meta"] = nil }
    return .object(dumped)
  }

  // One line: a client action, an exchange, or a frame. Where the engine and the line disagree.
  func perform(_ line: JSON, place: String) async throws -> [String] {
    if let action = try line["do"]?.asString() {
      let differences = try act(action, try line.member("args"), returns: line["returns"], place: place)
      if action == "load" { offsets = try TranscriptOffsets(LoadedDevice(json: line.member("args").member("device"), registry: around.registry)) }
      return differences
    }
    if let call = try line["http"]?.asString() { return try await exchange(call, line, place: place) }
    if let frame = line["frame"] { return try await receive(frame, returns: line["returns"], place: place) }
    return []
  }

  // MARK: Client actions

  // A sign-in keeps the account's token first, as the app's does. A release lets one held entry go before its time, as the
  // release timer lets it go at its time. A reconcile unsubscribes the tree and overlay scopes its set leaves out; product
  // scopes follow the seat.
  func act(_ action: String, _ args: JSON, returns: JSON?, place: String) throws -> [String] {
    switch action {
    case "commit":
      let answer: JSON
      do {
        answer = ClientSteps.json(try engine.commit(try ScopeRef(json: args.member("scope")), try ClientSteps.gesture(args)))
      } catch is CommitFailure {
        answer = ["throws": true]
      }
      return Transcripts.compare(answer, returns, "\(place): commit returned")
    case "signIn":
      let decisions = try JSON.map(args["decisions"]) { json -> LineageAnswer in
        guard let answer = LineageAnswer(rawValue: try json.asString()) else { throw VectorError("not a decision") }
        return answer
      }
      let account = try args.member("account").asString()
      around.tokens.save(Transcripts.token(for: account), for: account)
      let signIn = try engine.write { store, _ in
        try store.signIn(account: account, holdsRecords: try JSON.map(args["holdsRecords"]) { try $0.asBool() }, decisions: decisions,
                         counted: try JSON.map(args["counted"]) { try $0.asArray().map { try $0.asString() } }, identities: engine.identities)
      }
      return Transcripts.compare(ClientSteps.json(signIn), returns, "\(place): signIn returned")
    case "release":
      let released = try engine.write { store, _ in try store.release(try args.member("localId").asString()) }
      return Transcripts.compare(.bool(released), returns, "\(place): release returned")
    case "reconcile":
      let scopes = try args.member("scopes").asArray().map { try ScopeRef(json: $0) }
      for scope in subscribed where !scopes.contains(scope) { try engine.unsubscribe(scope) }
      subscribed = subscribed.filter(scopes.contains)
      return Transcripts.compare(.null, returns, "\(place): reconcile returned")
    case "load":
      around.identities.reissueLastActor()
      (store, engine) = try around.engine(holding: try LoadedDevice(json: args.member("device"), registry: around.registry))
      subscribed = []
      return Transcripts.compare(.null, returns, "\(place): load returned")
    case let other:
      throw VectorError("\(place): the engine runner does not drive \(other)")
    }
  }

  // MARK: Exchanges

  // The step that makes the line's exchange: a pull line's tree and overlay scopes are subscribed first, and its scopes
  // wanted. A pull's page outcomes are checked against the line's `returns`.
  func exchange(_ call: String, _ line: JSON, place: String) async throws -> [String] {
    let request = call == "hello" ? nil : try line.member("request")
    let before = try store.read { try $0.meta(of: $0.activeReplica()) }
    let reading = around.clock.engineClock.wall.reading()
    var readiness: Int64?
    if call == "push" {
      let account = try request!.member("account").asString()
      let time = try line.member("response").member("body").member("serverTime").asInteger()
      let epoch = try line.member("response").member("body").member("epoch").asString()
      readiness = time
      let hello: JSON = ["status": 200, "body": [
        "serverTime": JSON(time), "epoch": .string(epoch),
        "as": .string(account), "schema": JSON(around.registry.version), "minSchema": JSON(around.registry.minVersion),
      ]]
      around.transport.expect(.init(call: "hello", request: nil, response: hello, lost: false,
                                    place: "\(place) readiness", credential: Transcripts.token(for: account)))
    }
    around.transport.expect(TranscriptTransport.Exchange(
      call: call, request: request, response: try line.member("response"), lost: try line["lost"]?.asBool() ?? false, place: place))
    var differences: [String] = []
    switch call {
    case "hello":
      _ = await engine.hello(token: try line["account"]?.nullable { Transcripts.token(for: try $0.asString()) } ?? nil)
    case "push":
      guard line["returns"] == nil else { throw VectorError("\(place): a push's return is the sender's own") }
      _ = await engine.sender.step()
    case "pull":
      let scopes = try request!.member("scopes").asArray().map { try ScopeRef(json: $0.member("scope")) }
      let opening = scopes.filter { $0.tree != nil && !subscribed.contains($0) }
      for scope in opening { try engine.subscribe(scope) }
      subscribed += opening
      var step = await engine.puller.step()
      switch step {
      case .idle, .fallback, .repull:
        engine.puller.wants.add(scopes)
        step = await engine.puller.step()
      default:
        break
      }
      if let expected = line["returns"] {
        guard case .pulled(let reports) = step else { return around.transport.settle() + ["\(place): the puller \(step), not a pull"] }
        let answer = JSON.array(reports.map { ["scope": $0.scope.json, "outcome": .string($0.outcome.rawValue)] })
        differences += Transcripts.compare(answer, expected, "\(place): the pull answer returned")
      }
    case let other:
      throw VectorError("\(place): unknown exchange \(other)")
    }
    let ordinary = try line["lost"]?.asBool() == true ? nil : line["response"]?["body"]?["serverTime"].map { try $0.asInteger() }
    let device = try store.read { try $0.device(rows: true) }
    differences += offsets.record(device, before: before, readiness: readiness, ordinary: ordinary, reading: reading)
      .map { "\(place): \($0)" }
    return around.transport.settle() + differences
  }

  // MARK: Frames

  func receive(_ frame: JSON, returns: JSON?, place: String) async throws -> [String] {
    if await !engine.live.isOpen { _ = await engine.live.step() }
    try around.transport.socket.deliver(frame)
    guard await engine.live.receiveNext() else { return ["\(place): the live socket is closed"] }
    guard case .frame(_, let outcome) = await engine.puller.step() else { return ["\(place): the puller applied no frame"] }
    return Transcripts.compare(.string(outcome?.rawValue ?? "dropped"), returns, "\(place): the frame returned")
  }
}

// The runtime's readiness exchange is additional to the kernel transcript. Both offset histories are modeled in call
// order: every actual sample is checked, and only the modeled readiness samples augment the unchanged end fixture.
struct TranscriptOffsets {
  var kernel: [String: ServerOffset]
  var runtime: [String: ServerOffset]

  init(_ device: LoadedDevice) {
    kernel = Dictionary(uniqueKeysWithValues: device.replicas.map { ($0.id, $0.meta.offset) })
    runtime = kernel
  }

  mutating func record(_ device: LoadedDevice, before: ReplicaMeta?, readiness: Int64?, ordinary: Int64?, reading: ClockReading) -> [String] {
    var differences: [String] = []
    if let before {
      if kernel[before.replica] == nil {
        kernel[before.replica] = ServerOffset(); runtime[before.replica] = ServerOffset()
      }
      if let readiness { runtime[before.replica]!.take(serverTime: readiness, send: reading, recv: reading) }
      if let ordinary {
        kernel[before.replica]!.take(serverTime: ordinary, send: reading, recv: reading)
        runtime[before.replica]!.take(serverTime: ordinary, send: reading, recv: reading)
      }
    }
    for replica in device.replicas {
      if runtime[replica.id] == nil {
        if let before, device.active == replica.id, !device.replicas.contains(where: { $0.id == before.replica }) {
          kernel[replica.id] = kernel[before.replica]; runtime[replica.id] = runtime[before.replica]
        } else {
          kernel[replica.id] = ServerOffset(); runtime[replica.id] = ServerOffset()
        }
      }
      if replica.meta.offset != runtime[replica.id] { differences.append("\(replica.id) offset samples differ from the exact modeled exchanges") }
    }
    return differences
  }

  func augment(_ device: JSON?) throws -> (device: JSON?, differences: [String]) {
    guard let device else { return (nil, []) }
    var value = try device.asObject(), differences: [String] = []
    value["replicas"] = .array(try device.member("replicas").asArray().map { replica in
      var row = try replica.asObject()
      let meta = try ReplicaMeta(json: replica.member("meta"))
      guard let ordinary = kernel[meta.replica], let actual = runtime[meta.replica] else {
        differences.append("\(meta.replica) has no modeled offset history")
        return replica
      }
      if meta.offset != ordinary { differences.append("\(meta.replica) ordinary offset samples differ from the unchanged transcript") }
      var augmented = meta
      augmented.offset = actual
      row["meta"] = augmented.json
      return .object(row)
    })
    return (.object(value), differences)
  }
}
