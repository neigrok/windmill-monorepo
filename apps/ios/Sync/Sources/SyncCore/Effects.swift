public struct ScopedDeltas: Sendable, Hashable {
  public var scope: ScopeRef
  public var deltas: [Delta]
  public init(scope: ScopeRef, deltas: [Delta]) { self.scope = scope; self.deltas = deltas }
  public init(json: JSON) throws {
    self.init(scope: try ScopeRef(json: json.member("scope")), deltas: try json.member("d").asArray().map { try Delta(json: $0) })
  }
  public var json: JSON { ["scope": scope.json, "d": .array(deltas.map(\.json))] }
}

public struct Projection: Sendable, Hashable {
  public var scope: ScopeRef
  public var deltas: [Delta]
  public var resultSeq: Int64?
  public var covered: Bool
  public init(scope: ScopeRef, deltas: [Delta], resultSeq: Int64? = nil, covered: Bool = false) {
    self.scope = scope; self.deltas = deltas; self.resultSeq = resultSeq; self.covered = covered
  }
  public init(json: JSON) throws {
    self.init(scope: try ScopeRef(json: json.member("scope")), deltas: try json.member("d").asArray().map { try Delta(json: $0) },
              resultSeq: try json["resultSeq"]?.asInteger(), covered: try json["covered"]?.asBool() ?? false)
  }
  public var json: JSON {
    var object: JSON.Object = ["scope": scope.json, "d": .array(deltas.map(\.json))]
    object["resultSeq"] = resultSeq.map { JSON($0) }
    object["covered"] = covered ? true : nil
    return .object(object)
  }
}

public enum EffectReceipts {
  public static func orderedScopes(origin: ScopeRef, scopes: [ScopeRef]) -> [ScopeRef] {
    [origin] + Set(scopes).filter { $0 != origin }.sorted()
  }

  public static func row(before: Row?, after: Row) -> JSON {
    var slots: [JSON] = []
    func stamp(_ kind: String, _ value: Stamp, name: String? = nil) {
      var slot: JSON.Object = ["kind": .string(kind)]
      slot["name"] = name.map { .string($0) }
      slots.append(["slot": .object(slot), "version": ["kind": "stamp", "stamp": value.json]])
    }
    if let born = after.lattice.born, born != before?.lattice.born { stamp("born", born) }
    if let life = after.lattice.life, life != before?.lattice.life { stamp("life", life.stamp) }
    for name in after.lattice.fields.keys.sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) {
      if let value = after.lattice.fields[name], value != before?.lattice.fields[name] { stamp("field", value.stamp, name: name) }
    }
    for name in after.texts.keys.sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) {
      if let value = after.texts[name], value != before?.texts[name] {
        slots.append(["slot": ["kind": "text", "name": .string(name)], "version": ["kind": "text", "revision": JSON(value.rev)]])
      }
    }
    return ["t": .string(after.key.type), "id": after.key.id.json, "beforeRowSeq": before.map { JSON($0.seq) } ?? .null,
            "rowSeq": JSON(after.seq), "slots": .array(slots)]
  }

  public static func validate(registry: Registry, origin: ScopeRef, expected: [ScopeRef], resultSeq: Int64, detail: JSON?) throws -> [JSON] {
    func fail() -> JSONError { .shape("invalid scoped receipt") }
    func sequence(_ value: JSON) throws -> Int64? { value.isNull ? nil : try value.asInteger(atLeast: 0) }
    guard let detail else { throw fail() }
    try detail.asObject().expectKeys(required: ["windmillKit"], optional: ["command"])
    let kit = try detail.member("windmillKit")
    try kit.asObject().expectKeys(required: ["v", "effects"])
    guard try kit.member("v").asInteger() == 1, !kit.holdsNul, kit.jcs.count <= Constants.receiptMaxBytes else { throw fail() }
    let effects = try kit.member("effects").asArray()
    var scopes: [ScopeRef] = []
    for effect in effects {
      try effect.asObject().expectKeys(required: ["scope", "beforeSeq", "seq", "rows"])
      let scope = try ScopeRef(json: effect.member("scope"))
      guard registry.scopeKind(of: scope) != nil, registry.isScopeID(scope), !scopes.contains(scope) else { throw fail() }
      scopes.append(scope)
      let before = try sequence(effect.member("beforeSeq")), seq = try sequence(effect.member("seq"))
      if let before { guard let seq, seq >= before else { throw fail() } }
      let rows = try effect.member("rows").asArray()
      guard seq != nil || rows.isEmpty else { throw fail() }
      var prior: RecordKey?
      for row in rows {
        try row.asObject().expectKeys(required: ["t", "id", "beforeRowSeq", "rowSeq", "slots"])
        let key = RecordKey(try row.member("t").asString(), try RecordID(json: row.member("id")))
        guard let type = registry.type(key.type), registry.lives(key.type, in: scope), registry.isID(key.id.json, of: type),
              prior.map({ $0 < key }) ?? true else { throw fail() }
        prior = key
        let rowSeq = try row.member("rowSeq").asInteger(atLeast: 1), oldSeq = try sequence(row.member("beforeRowSeq"))
        guard rowSeq == seq, before != seq else { throw fail() }
        if let oldSeq { guard let before, oldSeq < rowSeq && oldSeq <= before else { throw fail() } }
        let slots = try row.member("slots").asArray()
        var previous = ""
        var kinds: Set<String> = []
        for item in slots {
          try item.asObject().expectKeys(required: ["slot", "version"])
          let slot = try item.member("slot"), version = try item.member("version"), kind = try slot.member("kind").asString()
          let order: String
          switch kind {
          case "born", "life":
            try slot.asObject().expectKeys(required: ["kind"])
            guard kind == "born" ? type.hasBorn : type.life else { throw fail() }
            order = kind == "born" ? "0" : "1"
          default:
            try slot.asObject().expectKeys(required: ["kind", "name"])
            let name = try slot.member("name").asString()
            guard kind == "field" ? type.field(name)?.kind.isLattice == true : kind == "text" && type.field(name)?.kind == .text else { throw fail() }
            order = (kind == "field" ? "2" : "3") + name
          }
          guard previous.utf8.lexicographicallyPrecedes(order.utf8) else { throw fail() }
          previous = order; kinds.insert(kind)
          if kind == "text" {
            try version.asObject().expectKeys(required: ["kind", "revision"])
            guard try version.member("kind").asString() == "text", try version.member("revision").asInteger(atLeast: 1) <= rowSeq else { throw fail() }
          } else {
            try version.asObject().expectKeys(required: ["kind", "stamp"])
            guard try version.member("kind").asString() == "stamp", try Stamp(json: version.member("stamp")) != .unset else { throw fail() }
          }
        }
        if oldSeq == nil, (type.hasBorn && !kinds.contains("born") || type.life && !kinds.contains("life")) { throw fail() }
      }
    }
    guard scopes == orderedScopes(origin: origin, scopes: scopes), expected.allSatisfy(scopes.contains), let first = effects.first,
          try !first.member("beforeSeq").isNull, try first.member("seq").asInteger() == resultSeq else { throw fail() }
    return effects
  }
}
