// §3 the merge: registers, lives, borns and a record's lattice part, with the §3.2 joins.

public struct Register: Sendable, Hashable {
  public var value: JSON
  public var stamp: Stamp

  public init(_ value: JSON, _ stamp: Stamp) {
    self.value = value
    self.stamp = stamp
  }

  public init(json: JSON) throws {
    let pair = try json.asArray()
    guard pair.count == 2 else { throw JSONError.shape("a register is [value, stamp]") }
    self.init(pair[0], try Stamp(json: pair[1]))
  }

  public var json: JSON { [value, stamp.json] }
}

public struct Life: Sendable, Hashable {
  public enum State: String, Sendable {
    case alive, dead
  }

  public var state: State
  public var stamp: Stamp

  public init(_ state: State, _ stamp: Stamp) {
    self.state = state
    self.stamp = stamp
  }

  public init(json: JSON) throws {
    let pair = try json.asArray()
    guard pair.count == 2, let state = State(rawValue: try pair[0].asString()) else {
      throw JSONError.shape("a life is [\"alive\"|\"dead\", stamp]")
    }
    self.init(state, try Stamp(json: pair[1]))
  }

  public var isAlive: Bool { state == .alive }
  public var json: JSON { [.string(state.rawValue), stamp.json] }
}

// The lattice part of a record: `{life?, born?, f?}`, `f` holding one register per lattice field.
public struct Lattice: Sendable, Hashable {
  public var life: Life?
  public var born: Stamp?
  public var fields: [String: Register]

  public init(life: Life? = nil, born: Stamp? = nil, fields: [String: Register] = [:]) {
    self.life = life
    self.born = born
    self.fields = fields
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    let registers = try object["f"]?.asObject().members ?? []
    for (name, _) in registers where !name.isPrintableASCII {
      throw JSONError.shape("the field name \(JSON.string(name).jcsText) is not printable ASCII")
    }
    self.init(
      life: try object["life"].map { try Life(json: $0) },
      born: try object["born"].map { try Stamp(json: $0) },
      fields: Dictionary(uniqueKeysWithValues: try registers.map { ($0.key, try Register(json: $0.value)) }))
  }

  // Every stamp the part carries: its life's, its born, and each register's.
  public var stamps: [Stamp] {
    [life?.stamp, born].compactMap { $0 } + fields.values.map(\.stamp)
  }

  public var json: JSON {
    var object = JSON.Object()
    object["life"] = life?.json
    object["born"] = born?.json
    if !fields.isEmpty { object["f"] = .object(JSON.Object(uniqueKeysWithValues: fields.map { ($0.key, $0.value.json) })) }
    return .object(object)
  }

  public static func == (lhs: Lattice, rhs: Lattice) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

public enum Join {
  public static func lww(_ a: Register?, _ b: Register?) -> Register? {
    guard let a else { return b }
    guard let b else { return a }
    if a.stamp != b.stamp { return a.stamp > b.stamp ? a : b }
    return a.value.jcsPrecedes(b.value) ? b : a
  }

  public static func ranked(_ a: Register?, _ b: Register?, rank: Rank) throws(JoinError) -> Register? {
    guard let a else { return b }
    guard let b else { return a }
    guard let rankA = rank.of(a.value) else { throw .unranked(a.value) }
    guard let rankB = rank.of(b.value) else { throw .unranked(b.value) }
    if rankA != rankB { return rankA > rankB ? a : b }
    return lww(a, b)
  }

  public static func fww(_ a: Register?, _ b: Register?) -> Register? {
    guard let a else { return b }
    guard let b else { return a }
    if a.stamp != b.stamp { return a.stamp < b.stamp ? a : b }
    return b.value.jcsPrecedes(a.value) ? b : a
  }

  public static func life(_ a: Life?, _ b: Life?) -> Life? {
    guard let a else { return b }
    guard let b else { return a }
    if a.stamp != b.stamp { return a.stamp > b.stamp ? a : b }
    return a.isAlive ? a : b
  }

  public static func born(_ a: Stamp?, _ b: Stamp?) -> Stamp? {
    guard let a else { return b }
    guard let b else { return a }
    return b < a ? b : a
  }

  // A field the registry does not know is kept as it is, and cannot meet a second register.
  public static func register(
    _ field: FieldDef?, named name: String, _ a: Register?, _ b: Register?
  ) throws(JoinError) -> Register? {
    guard let field else {
      guard a == nil || b == nil else { throw .unknownFieldOnBothSides(name) }
      return a ?? b
    }
    switch field.kind {
    case .lww: return lww(a, b)
    case .ranked(let rank): return try ranked(a, b, rank: rank)
    case .fww, .const, .time: return fww(a, b)
    case .serial, .text: throw .notJoinable(field: name, kind: field.kind.name)
    }
  }

  // `type` is nil for a type the registry does not know.
  public static func record(_ type: TypeDef?, _ a: Lattice, _ b: Lattice) throws(JoinError) -> Lattice {
    var fields: [String: Register] = [:]
    for name in Set(a.fields.keys).union(b.fields.keys) {
      fields[name] = try register(type?.field(name), named: name, a.fields[name], b.fields[name])
    }
    return Lattice(life: life(a.life, b.life), born: born(a.born, b.born), fields: fields)
  }
}
