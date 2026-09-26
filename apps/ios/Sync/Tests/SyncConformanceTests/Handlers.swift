import SyncCore
import SyncTesting
import Testing

// One handler per corpus file: it runs a vector's input and answers in the shape of its `expect`.

enum Handlers {
  static let table: [String: @Sendable (JSON) throws -> JSON] = [
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

struct VectorError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

extension JSON {
  func nullable<Value>(_ decode: (JSON) throws -> Value) rethrows -> Value? {
    isNull ? nil : try decode(self)
  }
}
