import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// The server-role corpus files (corpus/README.md "Server files") run against ModelServer and the probe's rules, and
// the server half of every protocol transcript.

enum ServerHandlers {
  static let probe = try! Corpus.probeRegistry()

  static let table: [String: @Sendable (JSON) throws -> JSON] = files.merging(admitFiles) { $1 }

  static let files: [String: @Sendable (JSON) throws -> JSON] = [
    "identity/table.json": { try identityTable($0) },
    "machine/scope.json": { try scopeMachine($0) },
    "text/tokens.json": { input in ["tokens": .array(TextMerge.tokens(try input.member("text").asString()).map(JSON.string))] },
    "text/script.json": { input in
      let script = TextMerge.script(
        TextMerge.tokens(try input.member("a").asString()), TextMerge.tokens(try input.member("b").asString()))
      return ["script": .array(script.map { [.string($0.0.rawValue), .string($0.1)] })]
    },
    "text/diff3.json": { input in
      let merged = TextMerge.diff3(
        base: try input.member("base").asString(), head: try input.member("head").asString(),
        mine: try input.member("mine").asString(), workCells: Constants.mergeWorkCells)
      return ["text": .string(merged.text), "conflict": .bool(merged.conflict)]
    },
    "text/merge.json": { try textMerge($0) },
    "admit/requests.json": { try requests($0) },
    "push/serve.json": { try push($0) },
    "pull/serve.json": { try pull($0) },
    "live/death.json": { input in
      let server = try makeServer(input)
      return ["frame": server.deathFrame(of: try ScopeRef(json: input.member("scope")), for: try account(input)) ?? .null]
    },
    "pull/hello.json": { input in
      var server = try makeServer(input)
      return ["response": server.hello(account: try account(input), at: try input.member("serverTime").asInteger()).json]
    },
  ]

  // Every admit/*.json but requests.json is one intent through §6.1.
  static let admitFiles: [String: @Sendable (JSON) throws -> JSON] = Dictionary(uniqueKeysWithValues: try! Corpus.paths()
    .filter { $0.hasPrefix("admit/") && $0 != "admit/requests.json" }.map { file in
      let run: @Sendable (JSON) throws -> JSON = { try admit($0) }
      return (file, run)
    })

  static func makeServer(_ input: JSON) throws -> ModelServer {
    ModelServer(
      registry: probe, rules: ProbeServerRules(), state: try ServerState(json: input.member("state")),
      limits: try ServerLimits(json: input["limits"]))
  }

  static func account(_ input: JSON) throws -> String? {
    let account = try input.member("account")
    return account.isNull ? nil : try account.asString()
  }

  // `{type, delta: {life?, born?}, idState: {state, born?}}` answers the §4.1 op and the §4.3 verdict.
  static func identityTable(_ input: JSON) throws -> JSON {
    guard let type = probe.type(try input.member("type").asString()) else { throw ServerVectorError("not a probe type") }
    let delta = try input.member("delta")
    let life = try delta["life"].map { json in try Life(json: json) }.map { PlannedLife($0.state, .given($0.stamp)) }
    let born = try delta["born"].map { StampSlot.given(try Stamp(json: $0)) }
    guard let op = IdentityRules.op(of: type, life: life, born: born) else {
      return ["op": "invalid", "verdict": "refuse", "code": "invalid"]
    }
    let idState = try input.member("idState")
    let row = Row(key: RecordKey(type.name, "x"), lattice: Lattice(born: try idState["born"].map { try Stamp(json: $0) }), seq: 0)
    let state: IdState = switch try idState.member("state").asString() {
    case "alive": .alive(row)
    case "dead": .dead(row)
    case "foreign": .foreign
    default: .none
    }
    switch IdentityRules.verdict(op, on: state, born: born, revivable: type.revivable == true) {
    case .apply: return ["op": .string(op.rawValue), "verdict": "apply"]
    case .ok: return ["op": .string(op.rawValue), "verdict": "ok"]
    case .refuse(let code): return ["op": .string(op.rawValue), "verdict": "refuse", "code": code.json]
    }
  }

  // `{from, event, to?}`: the §8.3 target, or the named one iff the table allows it.
  static func scopeMachine(_ input: JSON) throws -> JSON {
    guard let from = ScopeLife(rawValue: try input.member("from").asString()),
          let event = ScopeLife.Event(rawValue: try input.member("event").asString()) else { throw ServerVectorError("not a scope transition") }
    guard let to = from.after(event) else { throw ServerVectorError("no \(event) from \(from)") }
    if let named = try input["to"]?.asString(), named != to.rawValue { throw ServerVectorError("\(event) from \(from) goes to \(to)") }
    return ["to": .string(to.rawValue)]
  }

  static func textMerge(_ input: JSON) throws -> JSON {
    let stored = try TextState(json: input.member("stored"))
    let base = try TextBase(json: input.member("base"))
    let mine = try input.member("mine").asString()
    let revisions = try input.member("revisions").asArray().map { (try $0.member("rev").asInteger(), try $0.member("text").asString()) }
    do throws(Refusal) {
      let merged = try TextMerge.merge(head: stored, base: base, mine: mine, workCells: Constants.mergeWorkCells) { rev in
        revisions.first { $0.0 == rev }?.1
      }
      return ["text": .string(merged.text), "conflict": .bool(merged.conflict), "merged": .bool(merged.merged), "baseText": .string(merged.baseText)]
    } catch let refusal {
      return ["refuse": refusal.code.json]
    }
  }

  // `{state, origin, intent, serverNow, limits?}`: §6.1 for one intent, no push bookkeeping.
  static func admit(_ input: JSON) throws -> JSON {
    var state = try ServerState(json: input.member("state"))
    let origin = try input.member("origin")
    let account = try origin.member("account").asString()
    let from: IntentOrigin = try origin.member("kind").asString() == "replica"
      ? .replica(account: account, replica: try origin.member("replica").asString(), n: try origin.member("n").asInteger())
      : .server(account: account, requestId: nil)
    let admission = Admission(registry: probe, rules: ProbeServerRules(), limits: try ServerLimits(json: input["limits"]))
    let admitted = try admission.admit(input.member("intent"), from: from, at: try input.member("serverNow").asInteger(), in: &state)
    return ["result": admitted.result.json, "state": state.json]
  }

  // `{state, calls}`: §6.3 for each call in order; a call ended by `crashAfter` or `transientAt` answers null, and
  // `faultAt` faults that admit.
  static func requests(_ input: JSON) throws -> JSON {
    var server = try makeServer(input)
    var results: [JSON] = []
    for call in try input.member("calls").asArray() {
      let serverCall = ServerCall(
        account: try call.member("account").asString(), requestId: try call["requestId"]?.asString(),
        tool: try call.member("tool").asString(), args: try call.member("args"), intents: try call.member("intents").asArray())
      let faults = CallFaults(
        crashAfter: try call["crashAfter"].map { Int(try $0.asInteger()) },
        transientAt: try call["transientAt"].map { Int(try $0.asInteger()) },
        faultAt: try call["faultAt"].map { Int(try $0.asInteger()) })
      results.append(server.call(serverCall, at: try call.member("serverNow").asInteger(), faults: faults) ?? .null)
    }
    return ["results": .array(results), "state": server.state.json]
  }

  static func push(_ input: JSON) throws -> JSON {
    var server = try makeServer(input)
    let faults = try input["faults"]?.asArray().map { fault throws -> (Int64, PushFaults.Kind) in
      guard let kind = PushFaults.Kind(rawValue: try fault.member("kind").asString()) else { throw ServerVectorError("not a fault") }
      return (try fault.member("n").asInteger(), kind)
    } ?? []
    let reply = server.push(
      try input.member("request"), account: try account(input), at: try input.member("serverNow").asInteger(),
      faults: PushFaults(budget: try input["budget"].map { Int(try $0.asInteger()) }, byN: Dictionary(uniqueKeysWithValues: faults)))
    return ["response": reply.json, "state": server.state.json, "frames": .array(reply.events.map(\.json))]
  }

  // `state` and `live` appear when a `beforePull` admission changed the tables.
  static func pull(_ input: JSON) throws -> JSON {
    var server = try makeServer(input)
    let before = server.state
    let reply = server.pull(try input.member("request"), account: try account(input), at: try input.member("serverNow").asInteger())
    var answer: JSON.Object = ["response": reply.json]
    if server.state != before {
      answer["state"] = server.state.json
      answer["live"] = .array(reply.events.map(\.json))
    }
    return .object(answer)
  }

  // protocol/*.jsonl from the server's side: every exchange replayed with its principal, time and injected faults
  // and its response checked, loads applied, every frame a device receives one the server published, and the end
  // state checked.
  static func transcriptDifferences(_ lines: [JSON]) throws -> [String] {
    guard let header = lines.first else { throw ServerVectorError("a transcript starts with its header") }
    var server = ModelServer(registry: probe, rules: ProbeServerRules(), state: try ServerState(json: header.member("server")))
    var published: [LiveEvent] = []
    var accounts: [String: String] = [:]
    var differences: [String] = []
    for line in lines.dropFirst() {
      let place = "step \(line["step"]?.jcsText ?? "?")"
      if line["end"] != nil {
        if server.state.json != line["server"] { differences.append("\(place): the server ends as \(server.state.json.jcsText)") }
      } else if line["server"] == "load" {
        server.restore(try ServerState(json: line.member("state")))
      } else if let http = try line["http"]?.asString() {
        let account = try self.account(line)
        let serverNow = try line.member("serverNow").asInteger()
        let inject = line["inject"]
        let reply: Reply
        switch http {
        case "push":
          let faults = try inject?["fault"]?.asArray().map { (try $0.asInteger(), PushFaults.Kind.fault) } ?? []
          reply = server.push(
            try line.member("request"), account: account, at: serverNow,
            faults: PushFaults(budget: try inject?["budget"].map { Int(try $0.asInteger()) }, byN: Dictionary(uniqueKeysWithValues: faults)))
        case "pull": reply = server.pull(try line.member("request"), account: account, at: serverNow)
        case "hello": reply = server.hello(account: account, at: serverNow)
        case let other: throw ServerVectorError("unknown exchange \(other)")
        }
        if reply.json != line["response"] { differences.append("\(place): \(http) answered \(reply.json.jcsText)") }
        published += reply.events
        if let device = try line["device"]?.asString(), let account { accounts[device] = account }
      } else if let frame = line["frame"] {
        let device = try line.member("device").asString()
        if !isPublished(frame, to: accounts[device], among: published, by: server) {
          differences.append("\(place): the server never sent \(frame.jcsText)")
        }
      }
    }
    return differences
  }

  static func isPublished(_ frame: JSON, to account: String?, among events: [LiveEvent], by server: ModelServer) -> Bool {
    events.contains { event in
      switch event {
      case .change(_, let sent): sent == frame
      case .death(let key): ScopeKey(key.ref, account: account) == key && server.deathFrame(of: key.ref, for: account) == frame
      }
    }
  }
}

struct ServerVectorError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}
