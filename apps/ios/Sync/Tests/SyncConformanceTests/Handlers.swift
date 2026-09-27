import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// One handler per corpus file: it runs a vector's input and answers in the shape of its `expect`.

enum Handlers {
  static let table: [String: @Sendable (JSON) throws -> JSON] = core.merging(clientSteps) { $1 }.merging(transcripts) { $1 }
    .merging(ServerHandlers.table) { $1 }

  static let core: [String: @Sendable (JSON) throws -> JSON] = [
    "constants.json": { _ in
      [
        "HOLD_MS": JSON(Constants.holdMs), "LEAVE_DEBOUNCE_MS": JSON(Constants.leaveDebounceMs),
        "SIGNOUT_FLUSH_MS": JSON(Constants.signoutFlushMs), "CLOCK_JUMP_MS": JSON(Constants.clockJumpMs),
        "PULL_MAX_SCOPES": JSON(Constants.pullMaxScopes),
        "MAX_SKEW_MS": JSON(Constants.maxSkewMs), "K_POISON": JSON(Constants.kPoison),
        "LOCK_TIMEOUT_MS": JSON(Constants.lockTimeoutMs), "PULL_FALLBACK_MS": JSON(Constants.pullFallbackMs),
        "BACKOFF_BASE_MS": JSON(Constants.backoffBaseMs), "BACKOFF_CEILING_MS": JSON(Constants.backoffCeilingMs),
        "BACKOFF_LIVE_CEILING_MS": JSON(Constants.backoffLiveCeilingMs), "OFFSET_SAMPLES": JSON(Constants.offsetSamples),
        "REQUEST_LEASE_MS": JSON(Constants.requestLeaseMs), "SCOPE_HORIZON_DAYS": JSON(Constants.scopeHorizonDays),
        "REPLICA_GC_DAYS": JSON(Constants.replicaGcDays), "REQUEST_RETENTION_DAYS": JSON(Constants.requestRetentionDays),
        "MAX_RECORD_BYTES": JSON(Constants.maxRecordBytes), "PUSH_MAX_INTENTS": JSON(Constants.pushMaxIntents),
        "PUSH_MAX_BYTES": JSON(Constants.pushMaxBytes), "PUSH_WORK_MS": JSON(Constants.pushWorkMs),
        "PULL_PAGE_BYTES": JSON(Constants.pullPageBytes), "LIVE_FRAME_BYTES": JSON(Constants.liveFrameBytes),
        "LIVE_INLINE_BYTES": JSON(Constants.liveInlineBytes), "KEEPALIVE_BYTES": JSON(Constants.keepaliveBytes),
        "MERGE_WORK_CELLS": JSON(Constants.mergeWorkCells),
      ]
    },

    "stamp/order.json": { input in
      let a = try Stamp(json: input.member("a"))
      let b = try Stamp(json: input.member("b"))
      return ["order": a < b ? -1 : a == b ? 0 : 1]
    },
    "stamp/codec.json": { input in
      let text = try input.member("text").asString()
      guard let stamp = try? Stamp(text) else { return ["valid": false] }
      #expect(stamp.text == text, "encoding the parsed parts of \(text) gives it back")
      return ["valid": true, "ms": JSON(stamp.ms), "counter": JSON(stamp.counter), "actor": .string(stamp.actor)]
    },

    "hlc/tick.json": { input in
      let actor = try Stamp.Actor(input.member("actor").asString())
      var clock = try HLC(json: input.member("clock"))
      let stamps = try input.member("physNow").asArray().map { clock.tick(physNow: try $0.asInteger(), actor: actor).json }
      return ["stamps": .array(stamps), "clock": clock.json]
    },
    "hlc/observe.json": { input in
      let actor = try Stamp.Actor(input.member("actor").asString())
      var clock = try HLC(json: input.member("clock"))
      var stamps: [JSON] = []
      for op in try input.member("ops").asArray() {
        if let observed = op["observe"] {
          clock.observe(try Stamp(json: observed))
        } else {
          stamps.append(clock.tick(physNow: try op.member("tick").asInteger(), actor: actor).json)
        }
      }
      return ["stamps": .array(stamps), "clock": clock.json]
    },
    "hlc/offset.json": { input in
      var offset = ServerOffset()
      for response in try input.member("responses").asArray() {
        offset.take(
          serverTime: try response.member("serverTime").asInteger(),
          send: try ClockReading(json: response.member("send")), recv: try ClockReading(json: response.member("recv")))
      }
      return [
        "samples": .array(offset.samples.map(\.json)), "serverOffsetMs": JSON(offset.ms),
        "clockReading": offset.clockReading?.json ?? .null,
      ]
    },

    "hlc/jump.json": { input in
      let before = try ClockReading(json: input.member("before"))
      let after = try ClockReading(json: input.member("after"))
      return ["jumped": .bool(after.jumped(since: before))]
    },

    "jcs/values.json": { input in
      if let bits = input["bits"] {
        guard let pattern = UInt64(try bits.asString(), radix: 16) else { throw VectorError("bits are 16 hex digits") }
        guard let number = JSON.Number(Double(bitPattern: pattern)) else { throw VectorError("a non-finite double is not JSON") }
        return ["jcs": .string(JSON.number(number).jcsText)]
      }
      return ["jcs": .string(try JSON(parsing: input.member("json").asString()).jcsText)]
    },

    "join/lww.json": { input in try commutative(input, Register.init(json:), \.json, Join.lww) },
    "join/fww.json": { input in try commutative(input, Register.init(json:), \.json, Join.fww) },
    "join/life.json": { input in try commutative(input, Life.init(json:), \.json, Join.life) },
    "join/born.json": { input in try commutative(input, Stamp.init(json:), \.json, Join.born) },
    "join/ranked.json": { input in
      let rank = Rank(try input.member("rank").asObject().members.map { (value: $0.key, rank: Int(try $0.value.asInteger())) })
      return try commutative(input, Register.init(json:), \.json) { a, b in try Join.ranked(a, b, rank: rank) }
    },
    "join/record.json": { input in
      let type = try Corpus.probeRegistry().type(input.member("type").asString())
      let a = try Lattice(json: input.member("a"))
      let b = try Lattice(json: input.member("b"))
      let joined = try Join.record(type, a, b)
      #expect(try Join.record(type, b, a) == joined, "joinRecord is commutative")
      return ["join": joined.json]
    },

    "derive/slug.json": { input in
      let taken = try input.member("taken").asArray().map { try $0.asString() }
      let label = try input.member("label").asString()
      let id = DerivedID.from(label: label, fallback: try input.member("fallback").asString(), taken: taken)
      return ["id": .string(id)]
    },
    "identity/seeded.json": { input in
      guard try input.member("op").asString() == "make" else {
        let parsed = SeededID(parsing: try input.member("id").asString())
        return ["parsed": parsed.map { ["seed": .string($0.seed), "n": JSON($0.ordinal)] } ?? .null]
      }
      guard let type = try Corpus.probeRegistry().type(input.member("type").asString()) else {
        throw VectorError("no such probe type")
      }
      let seeded = try SeededID(seed: input.member("seed").asString(), ordinal: Int(input.member("n").asInteger()), for: type)
      return ["id": .string(seeded.id)]
    },

    "fracindex/between.json": { input in
      let a = try input.member("a").nullable { try FractionalKey($0.asString()) }
      let b = try input.member("b").nullable { try FractionalKey($0.asString()) }
      return ["key": .string(try FractionalKey(between: a, and: b).text)]
    },
    "fracindex/drop.json": { input in
      let members = { (list: JSON) in
        try list.asArray().map { ListMember(id: try $0.member("id"), key: try FractionalKey($0.member("key").asString())) }
      }
      let stored = try members(input.member("stored"))
      let drawn = try members(input.member("drawn"))
      let moved = try input.member("moved")
      let key = try FractionalKey(dropping: moved, below: input.member("above").nullable { $0 }, stored: stored, drawn: drawn)
      let order = { (list: [ListMember]) in
        JSON.array(list.map { $0.id == moved ? ListMember(id: moved, key: key) : $0 }.sorted().map(\.id))
      }
      let drawnAfter = drawn.contains { $0.id == moved } ? drawn : drawn + [ListMember(id: moved, key: key)]
      return ["key": .string(key.text), "drawn": order(drawnAfter), "stored": order(stored)]
    },

    "view/drawn.json": { input in try view(input, .drawn) },
    "view/stored.json": { input in try view(input, .stored) },

    "machine/intent.json": { input in
      let from = try input.member("from").nullable { json -> EntryState in
        guard let state = EntryState(rawValue: try json.asString()) else { throw VectorError("no intent leaves an outcome") }
        return state
      }
      guard let event = IntentEvent(rawValue: try input.member("event").asString()) else { throw VectorError("not an intent event") }
      let to = try input["to"].map { json -> IntentNode in
        guard let node = IntentNode(rawValue: try json.asString()) else { throw VectorError("not an intent node") }
        return node
      }
      return ["to": .string(try Machines.intent.transition(from: from, event, to: to).description)]
    },
    "machine/replica.json": { input in
      let node = { (json: JSON) throws -> ReplicaNode in
        guard let node = ReplicaNode(rawValue: try json.asString()) else { throw VectorError("not a replica node") }
        return node
      }
      guard let event = ReplicaEvent(rawValue: try input.member("event").asString()) else { throw VectorError("not a replica event") }
      let to = try input["to"].map(node)
      return ["to": .string(try Machines.replica.transition(from: try input.member("from").nullable(node), event, to: to).rawValue)]
    },

    "digest/row.json": { input in
      ["hash": .string(ScopeDigest(row: try input.member("row")).hex)]
    },
    "digest/scope.json": { input in
      if let rows = input["rows"] { return ["digest": .string(ScopeDigest(rows: try rows.asArray()).hex)] }
      var digest = try ScopeDigest(hex: input.member("start").asString())
      for change in try input.member("changes").asArray() {
        digest = digest.replacing(try change.member("before").nullable { $0 }, with: try change.member("after").nullable { $0 })
      }
      return ["digest": .string(digest.hex)]
    },
  ]

  static let probe = try! Corpus.probeRegistry()

  // corpus/README.md "Client steps": every client step file runs through the planners over an in-memory device.
  static let clientSteps: [String: @Sendable (JSON) throws -> JSON] = Dictionary(uniqueKeysWithValues: Corpus.clientStepFiles.map { file in
    let run: @Sendable (JSON) throws -> JSON = { input in
      try ClientSteps.run(input, registry: probe) { PlannedDevice($0, registry: probe, limits: $1) }
    }
    return (file, run)
  })

  // protocol/*.jsonl: the client half runs through the planners, the server half through ModelServer.
  static let transcripts: [String: @Sendable (JSON) throws -> JSON] = Dictionary(uniqueKeysWithValues: try! Corpus.paths()
    .filter { $0.hasPrefix("protocol/") }.map { file in
      let run: @Sendable (JSON) throws -> JSON = { input in
        let differences = try Transcripts.clientDifferences(input.asArray(), registry: probe) {
          PlannedDevice($0, registry: probe, limits: Limits())
        }
        #expect(differences == [], "\(file): the client half")
        #expect(try ServerHandlers.transcriptDifferences(input.asArray()) == [], "\(file): the server half")
        return .null
      }
      return (file, run)
    })

  // `{replica, scope}`: the view's records in record order, the visible ones, and for stored the cap counts.
  static func view(_ input: JSON, _ mode: ViewMode) throws -> JSON {
    let replica = try LoadedReplica(json: input.member("replica"), registry: probe)
    let scope = try ScopeRef(json: input.member("scope"))
    let view = try ScopeView(replica, scope, mode, registry: probe)
    let records = view.all
    var answer: JSON.Object = [
      "records": .array(records.map(\.json)),
      "visible": .array(records.filter(view.isVisible).map(\.key.json)),
    ]
    if mode == .stored {
      let capped = probe.types.filter { $0.cap != nil && probe.scopeKind(of: scope) == $0.scope }
      answer["capCount"] = .object(JSON.Object(uniqueKeysWithValues: capped.map { ($0.name, JSON(view.visibleCount($0.name))) }))
    }
    return .object(answer)
  }

  // A join vector `{a, b}` answers `{join}`, null being absent, and must answer the same both ways round.
  static func commutative<Value: Equatable>(
    _ input: JSON, _ decode: (JSON) throws -> Value, _ encode: (Value) -> JSON, _ join: (Value?, Value?) throws -> Value?
  ) throws -> JSON {
    let a = try input.member("a").nullable(decode)
    let b = try input.member("b").nullable(decode)
    let joined = try join(a, b)
    #expect(try join(b, a) == joined, "the join is commutative")
    return ["join": joined.map(encode) ?? .null]
  }
}

