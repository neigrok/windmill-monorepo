import SyncCore

// The server half of the sync engine over in-memory tables: hello (§9.2), push (§6.2) with faults and poison (§6.6),
// server-origin calls (§6.3), pull (§6.7) with `beforePull`, the live channel (§6.8), and epoch and restore. A value:
// a copy is a snapshot, and whoever shares one guards it. One value is one server process: every entry point takes the
// wall clock and reads its `physNow()` once (§10.2).

public struct ModelServer: Sendable {
  public static let transientRetryAfterMs: Int64 = 1_000

  public let registry: Registry
  public private(set) var state: ServerState
  let admission: Admission
  var live = LiveChannel()
  var scripted: [Refusal] = []
  var greatestNow = Int64.min

  public init(registry: Registry, rules: any ServerRules, state: ServerState, limits: ServerLimits = ServerLimits()) {
    self.registry = registry
    self.state = state
    admission = Admission(registry: registry, rules: rules, limits: limits)
  }

  var limits: ServerLimits { admission.limits }
  var feed: Feed { Feed(registry: registry, limits: limits) }

  // A restore from a backup: the tables as they were, under the new epoch the snapshot carries. The process, and so its
  // clock, runs on.
  public mutating func restore(_ snapshot: ServerState) {
    state = snapshot
  }

  // §10.2 the server's physNow(): the wall clock, never below a value it returned in this process, so `serverNow` never
  // steps back.
  mutating func physNow(wall: Int64) -> Int64 {
    greatestNow = max(greatestNow, wall)
    return greatestNow
  }

  // The next `count` replica intents are refused with `code`, stored as step R stores a refusal.
  public mutating func refuse(next count: Int = 1, code: RefusalCode, detail: JSON? = nil) {
    scripted += Array(repeating: Refusal(code, detail: detail), count: count)
  }

  // MARK: - Hello

  public mutating func hello(account: String?, at wall: Int64) -> Reply {
    let serverNow = physNow(wall: wall)
    var body: JSON.Object = [
      "serverTime": JSON(serverNow), "epoch": .string(state.epoch),
      "schema": JSON(registry.version), "minSchema": JSON(registry.minVersion),
    ]
    body["holdsRecords"] = account.map { feed.holdsRecords($0, in: state) }
    return Reply(status: 200, body: .object(body))
  }

  // MARK: - Push

  public mutating func push(_ body: JSON, account: String?, at wall: Int64, faults: PushFaults = PushFaults()) -> Reply {
    let serverNow = physNow(wall: wall)
    guard let account else { return failure(401, "unauthenticated", at: serverNow) }
    guard let request = PushBody(body) else { return failure(400, "malformed", at: serverNow) }
    guard request.intents.count <= limits.pushMaxIntents, body.jcs.count <= limits.pushMaxBytes else {
      return failure(413, "request-too-large", at: serverNow)
    }
    if let binding = state.replicas[request.replica], !binding.account.isSameID(as: account) {
      return failure(409, "replica-foreign", at: serverNow)
    }
    let bound = state.replicas[request.replica] == nil
    if bound { state.replicas[request.replica] = ReplicaBinding(account: account, lastN: 0) }
    var answer = PushAnswer()
    for (n, intent) in request.intents {
      guard take(n, intent, of: request.replica, account: account, at: serverNow, faults: faults, into: &answer) else { break }
    }
    let lastN = state.replicas[request.replica]!.lastN
    if let conflict = answer.conflict {
      if bound && lastN == 0 && state.results[request.replica] == nil { state.replicas[request.replica] = nil }
      return Reply(status: 409, body: failure(409, conflict, at: serverNow).body, events: answer.events)
    }
    let pruned = state.results[request.replica]?.filter { $0.key > min(request.ackThrough, lastN) }
    state.results[request.replica] = pruned?.isEmpty == false ? pruned : nil
    var reply: JSON.Object = [
      "serverTime": JSON(serverNow), "epoch": .string(state.epoch), "lastN": JSON(lastN), "results": .array(answer.results),
    ]
    reply["retry"] = answer.retry
    return Reply(status: 200, body: .object(reply), events: answer.events)
  }

  // §6.2 step 4 for one intent: answered from `sync_results`, admitted, or the request stops (false) at a 409 or a
  // retry.
  mutating func take(_ n: Int64, _ intent: JSON, of replica: String, account: String, at serverNow: Int64, faults: PushFaults,
                     into answer: inout PushAnswer) -> Bool {
    let lastN = state.replicas[replica]!.lastN
    let digest = SHA256Hex.of(intent.jcs)
    if n <= lastN {
      guard let stored = state.results[replica]?[n], stored.digest == digest, let result = stored.result else {
        return answer.stop(conflict: "replica-forked")
      }
      answer.append(result, n: n)
      return true
    }
    guard n == lastN + 1 else { return answer.stop(conflict: "gap") }
    if let budget = faults.budget, answer.admissions >= budget { return answer.stop(retryAt: n, after: 0) }
    answer.admissions += 1
    if faults.byN[n] == .transient { return answer.stop(retryAt: n, after: Self.transientRetryAfterMs) }
    do {
      guard faults.byN[n] == nil else { throw AdmissionFault(description: "injected at \(n)") }
      let admitted = try admitNumbered(intent, n: n, digest: digest, replica: replica, account: account, at: serverNow)
      publish(admitted.events)
      answer.events += admitted.events
      answer.append(admitted.result.json, n: n)
      return true
    } catch {
      guard countFault(n: n, digest: digest, replica: replica) else { return answer.stop(retryAt: n, after: 0) }
      answer.append(state.results[replica]![n]!.result!, n: n)
      return true
    }
  }

  // One intent at `n = last_n + 1` (§6.1 steps 3 and 16, step R), its result and `last_n` in one transaction.
  mutating func admitNumbered(_ intent: JSON, n: Int64, digest: String, replica: String, account: String,
                              at serverNow: Int64) throws(AdmissionFault) -> Admitted {
    let admitted: Admitted
    if scripted.isEmpty {
      admitted = try admission.admit(intent, from: .replica(account: account, replica: replica, n: n), at: serverNow, in: &state)
    } else {
      admitted = Admitted(result: .refused(scripted.removeFirst()), events: [])
    }
    let faults = state.results[replica]?[n].map { $0.digest == digest ? $0.faults : 0 } ?? 0
    state.results[replica, default: [:]][n] = StoredResult(digest: digest, result: admitted.result.json, faults: faults)
    state.replicas[replica]!.lastN = n
    return admitted
  }

  // §6.6 a deterministic fault, counted per `(replica, n, digest)` in its own transaction; at K_POISON it ends the
  // intent `internal` and `last_n` moves on. True when it did.
  mutating func countFault(n: Int64, digest: String, replica: String) -> Bool {
    let stored = state.results[replica]?[n]
    let faults = (stored?.digest == digest ? stored!.faults : 0) + 1
    let poisoned = faults >= Constants.kPoison
    let result = poisoned ? AdmitResult.refused(Refusal(.internal)).json : nil
    state.results[replica, default: [:]][n] = StoredResult(digest: digest, result: result, faults: faults)
    if poisoned { state.replicas[replica]!.lastN = n }
    return poisoned
  }

  func failure(_ status: Int, _ error: String, at serverNow: Int64) -> Reply {
    Reply(status: status, body: ["serverTime": JSON(serverNow), "epoch": .string(state.epoch), "error": .string(error)])
  }

  // MARK: - Server-origin calls

  // §6.3: a tool call's admits in order, stopping at the first refusal. With a `requestId` the call is deduplicated
  // by `sha256(jcs({tool, args}))`: each admit stores its result as part k, a resumed call answers its stored parts, and
  // the call's result then ends its row `done`. The lookup, and a lease takeover, belong to the first admit the call
  // runs, and roll back with it. Nil when the call ended unanswered.
  public mutating func call(_ call: ServerCall, at wall: Int64, faults: CallFaults = CallFaults()) -> JSON? {
    let serverNow = physNow(wall: wall)
    guard let requestId = call.requestId else {
      var last: AdmitResult?
      for (index, intent) in call.intents.enumerated() {
        let result = admitFromServer(intent, call: call, faulting: faults.faultAt == index + 1, at: serverNow)
        last = result
        if result.isRefused { break }
      }
      return last?.json
    }
    guard !requestId.isEmpty, !requestId.utf8.contains(where: { $0 == UInt8(ascii: "#") || $0 == 0 }) else {
      return AdmitResult.refused(Refusal(.invalid)).json
    }
    let key = RequestKey(account: call.account, requestId: requestId)
    let digest = SHA256Hex.of(JSON.object(["tool": .string(call.tool), "args": call.args]).jcs)
    let before = state
    if let row = state.requests[key] {
      guard row.digest == digest else { return AdmitResult.refused(Refusal(.requestConflict)).json }
      if row.state == .done { return row.result }
      guard serverNow - row.startedAt >= Constants.requestLeaseMs else { return AdmitResult.refused(Refusal(.requestRunning)).json }
    }
    var row = state.requests[key] ?? RequestRecord(digest: digest, state: .running, startedAt: serverNow)
    row.startedAt = serverNow
    state.requests[key] = row
    let first = row.parts.count + 1
    var result: JSON?
    for (index, intent) in call.intents.enumerated() {
      let k = index + 1
      if let part = state.requests[key]!.parts[k] {
        result = part
      } else {
        if faults.transientAt == k {
          if k == first { state = before }
          return nil
        }
        var tagged = (try? intent.asObject()) ?? JSON.Object()
        tagged["gestureId"] = .string(requestId)
        let admitted = admitFromServer(.object(tagged), call: call, faulting: faults.faultAt == k, at: serverNow).json
        state.requests[key]!.parts[k] = admitted
        state.requests[key]!.startedAt = serverNow
        if faults.crashAfter == k { return nil }
        result = admitted
      }
      if result?["s"] == "refused" { break }
    }
    state.requests[key]!.state = .done
    state.requests[key]!.result = result
    return result
  }

  // One admit of a call. A fault answers the caller `internal` at once (§6.6): it holds no queue to retry it.
  mutating func admitFromServer(_ intent: JSON, call: ServerCall, faulting: Bool, at serverNow: Int64) -> AdmitResult {
    do {
      guard !faulting else { throw AdmissionFault(description: "injected") }
      let admitted = try admission.admit(intent, from: .server(account: call.account, requestId: call.requestId), at: serverNow, in: &state)
      publish(admitted.events)
      return admitted.result
    } catch {
      return .refused(Refusal(.internal))
    }
  }

  // MARK: - Pull

  // §6.7: each requested scope runs its `beforePull` commands, then answers one page from the tables as they stand.
  public mutating func pull(_ body: JSON, account: String?, at wall: Int64) -> Reply {
    let serverNow = physNow(wall: wall)
    guard case .object(let object) = body, (try? object.expectKeys(required: ["scopes"])) != nil,
          case .array(let requested)? = object["scopes"],
          requested.count <= limits.pullMaxScopes else { return failure(400, "malformed", at: serverNow) }
    var scopes: [(scope: String, cursor: String?)] = []
    for entry in requested {
      guard case .object(let pulled) = entry, (try? pulled.expectKeys(required: ["cursor", "scope"])) != nil,
            case .string(let scope)? = pulled["scope"], let cursor = pulled["cursor"] else { return failure(400, "malformed", at: serverNow) }
      switch cursor {
      case .null: scopes.append((scope, nil))
      case .string(let text): scopes.append((scope, text))
      default: return failure(400, "malformed", at: serverNow)
      }
    }
    var events: [LiveEvent] = []
    var pages: [JSON] = []
    for (scope, cursor) in scopes {
      events += runBeforePull(scope, account: account, at: serverNow)
      pages.append(feed.page(scope, cursor: cursor, account: account, in: state))
    }
    return Reply(
      status: 200, body: ["serverTime": JSON(serverNow), "epoch": .string(state.epoch), "pages": .array(pages)], events: events)
  }

  // Each `beforePull` command of the scope's kind, in its own admission as the scope owner's server origin, when
  // the scope exists and the principal may read it.
  mutating func runBeforePull(_ requested: String, account: String?, at serverNow: Int64) -> [LiveEvent] {
    guard let ref = try? ScopeRef(requested), let kind = registry.scopeKind(of: ref), let key = ScopeKey(ref, account: account),
          let owner = state.scopes[key]?.owner, state.scopes[key]?.state == .alive,
          state.canRead(key, as: account, registry: registry) else { return [] }
    var events: [LiveEvent] = []
    for command in registry.commands where command.beforePull && command.scope == kind {
      let intent: JSON = ["scope": key.ref.json, "cmd": ["name": .string(command.name), "args": [:]]]
      guard let admitted = try? admission.admit(intent, from: .server(account: owner, requestId: nil), at: serverNow, in: &state)
      else { continue }
      publish(admitted.events)
      events += admitted.events
    }
    return events
  }

  // MARK: - Live

  public mutating func connect(account: String?) -> LiveSocket {
    LiveSocket(id: live.connect(account: account))
  }

  public mutating func subscribe(_ socket: LiveSocket, to scopes: [ScopeRef]) {
    live.subscribe(socket.id, to: scopes, in: state, registry: registry)
  }

  public mutating func unsubscribe(_ socket: LiveSocket, from scopes: [ScopeRef]) {
    live.unsubscribe(socket.id, from: scopes)
  }

  // The frame a socket of `account` subscribed to `scope` receives when the scope dies; nil when it receives none.
  public func deathFrame(of scope: ScopeRef, for account: String?) -> JSON? {
    guard let key = ScopeKey(scope, account: account) else { return nil }
    return LiveChannel.deathFrame(of: key, to: account, in: state, registry: registry)
  }

  // The frames a socket has been sent since it last took them, in the order they left.
  public mutating func frames(for socket: LiveSocket) -> [JSON] {
    live.take(socket.id)
  }

  mutating func publish(_ events: [LiveEvent]) {
    guard !events.isEmpty else { return }
    live.publish(events, in: state, registry: registry)
  }
}

// One HTTP answer, and the live events its admissions published.
public struct Reply: Sendable, Hashable {
  public let status: Int
  public let body: JSON
  public let events: [LiveEvent]

  public init(status: Int, body: JSON, events: [LiveEvent] = []) {
    self.status = status
    self.body = body
    self.events = events
  }

  public var json: JSON { ["status": JSON(status), "body": body] }
}

public struct LiveSocket: Sendable, Hashable {
  public let id: Int
}

// Faults a push meets (§6.6): a budget of admissions standing for PUSH_WORK_MS, and injected faults by `n`.
public struct PushFaults: Sendable, Hashable {
  public enum Kind: String, Sendable {
    case transient, fault
  }

  public var budget: Int?
  public var byN: [Int64: Kind]

  public init(budget: Int? = nil, byN: [Int64: Kind] = [:]) {
    self.budget = budget
    self.byN = byN
  }
}

// A server-origin tool call (§6.3): MCP, REST, tending, each admit one intent.
public struct ServerCall: Sendable, Hashable {
  public let account: String
  public let requestId: String?
  public let tool: String
  public let args: JSON
  public let intents: [JSON]

  public init(account: String, requestId: String?, tool: String, args: JSON, intents: [JSON]) {
    self.account = account
    self.requestId = requestId
    self.tool = tool
    self.args = args
    self.intents = intents
  }

  public static func == (lhs: ServerCall, rhs: ServerCall) -> Bool {
    lhs.account.isSameID(as: rhs.account) && lhs.requestId.map { Array($0.utf8) } == rhs.requestId.map { Array($0.utf8) }
      && lhs.tool.isSameID(as: rhs.tool) && lhs.args == rhs.args && lhs.intents == rhs.intents
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(account.utf8))
    hasher.combine(args)
  }
}

// Faults a call meets: a crash right after admit k commits, admit k failing transiently and rolling back, or admit k
// faulting.
public struct CallFaults: Sendable, Hashable {
  public var crashAfter: Int?
  public var transientAt: Int?
  public var faultAt: Int?

  public init(crashAfter: Int? = nil, transientAt: Int? = nil, faultAt: Int? = nil) {
    self.crashAfter = crashAfter
    self.transientAt = transientAt
    self.faultAt = faultAt
  }
}

// §9.3 a push body, exactly `{replica, ackThrough, intents}`: a replica id of D-3's form, `rp_` and 32 lowercase hex,
// and an integer `n ≥ 1` on every intent, in ascending `n`.
struct PushBody {
  let replica: String
  let ackThrough: Int64
  let intents: [(n: Int64, intent: JSON)]

  init?(_ body: JSON) {
    guard case .object(let object) = body, (try? object.expectKeys(required: ["ackThrough", "intents", "replica"])) != nil,
          case .string(let replica)? = object["replica"], replica.isPrintableASCII,
          replica.wholeMatch(of: #/rp_[0-9a-f]{32}/#) != nil,
          let ackThrough = try? object["ackThrough"]?.asInteger(atLeast: 0),
          case .array(let intents)? = object["intents"] else { return nil }
    var numbered: [(n: Int64, intent: JSON)] = []
    for intent in intents {
      guard case .object = intent, let n = try? intent["n"]?.asInteger(atLeast: 1) else { return nil }
      numbered.append((n, intent))
    }
    self.replica = replica
    self.ackThrough = ackThrough
    self.intents = numbered.sorted { $0.n < $1.n }
  }
}

// What one push answers so far: the results in order, the live events of its admissions, and how it stopped.
struct PushAnswer {
  var results: [JSON] = []
  var events: [LiveEvent] = []
  var admissions = 0
  var retry: JSON?
  var conflict: String?

  mutating func append(_ result: JSON, n: Int64) {
    var numbered = (try? result.asObject()) ?? JSON.Object()
    numbered["n"] = JSON(n)
    results.append(.object(numbered))
  }

  mutating func stop(retryAt n: Int64, after retryAfterMs: Int64) -> Bool {
    retry = ["n": JSON(n), "retryAfterMs": JSON(retryAfterMs)]
    return false
  }

  mutating func stop(conflict error: String) -> Bool {
    conflict = error
    return false
  }
}
