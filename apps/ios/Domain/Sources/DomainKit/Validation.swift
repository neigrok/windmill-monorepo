import SyncCore

// §4.4 where a violation is: dotted text, so `Path("entries") + 1 + "reps"` is `entries.1.reps`.
public struct Path: Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
  public let text: String

  public init(_ text: String) {
    self.text = text
  }

  public init(stringLiteral text: String) {
    self.init(text)
  }

  public static func + (p: Path, k: String) -> Path {
    Path(p.text.isEmpty ? k : "\(p.text).\(k)")
  }

  public static func + (p: Path, i: Int) -> Path {
    p + String(i)
  }

  public var description: String { text }

  public static func == (a: Path, b: Path) -> Bool { a.text.utf8.elementsEqual(b.text.utf8) }
  public func hash(into hasher: inout Hasher) { hasher.combine(Array(text.utf8)) }
}

// D-10 the first LOCAL rule a value breaks. The UI maps `(rule, reason)` to copy.
public struct Violation: Error, Hashable, Sendable {
  public let rule: String
  public let path: Path
  public let reason: Reason

  public enum Reason: Hashable, Sendable {
    case blank, nul, notANumber, notInteger, notOneOf
    case tooShort(min: Int, unit: TextUnit), tooLong(max: Int, unit: TextUnit, measured: Int)
    case below(min: Double), above(max: Double)
    case tooFew(min: Int), tooMany(max: Int)
    case custom(String)
  }

  public init(rule: String, path: Path, reason: Reason) {
    self.rule = rule
    self.path = path
    self.reason = reason
  }
}

// D-21 an instant with a zone, and so a local day. Domain time comes only from a moment (§5.3).
public struct Moment: Sendable {
  public let now: Instant
  public let zone: any Zone

  public init(now: Instant, zone: any Zone) {
    self.now = now
    self.zone = zone
  }

  public var today: LocalDay { LocalDay(now, in: zone) }
}

// D-9 one field's LOCAL rules, which normalise that field, or a rule on the natural key, which reads the id and the
// moment. A check throws only `Violation`.
public struct Check<E>: Sendable {
  public let field: String?
  let apply: @Sendable (inout E, Moment) throws -> Void

  public init(_ field: String, _ apply: @escaping @Sendable (inout E, Moment) throws -> Void) {
    self.field = field
    self.apply = apply
  }

  init(key apply: @escaping @Sendable (E, Moment) throws -> Void) {
    field = nil
    self.apply = { value, moment in try apply(value, moment) }
  }

  public static func key(_ apply: @escaping @Sendable (E, Moment) throws -> Void) -> Check {
    Check(key: apply)
  }
}

// D-11 an entity whose named fields passed their checks. Its initialisers are the only way to make one, so no plan
// writes a value that skipped its checks (INV-5).
public struct Valid<E: Writable>: Sendable {
  public let value: E
  public let checked: [String]

  public init(_ value: E, at moment: Moment) throws(Violation) {
    try self.init(value, fields: Array(value.fields.keys), at: moment)
  }

  // Runs, in `E.checks` order, every key check and the check of every named field on a copy of the value; gives a named
  // `Timestamped` field the moment's now, whatever it held, so inside a run every write of it records the commit's now;
  // then refuses a U+0000 in any named field no check caught, which the engine would refuse in every string it sends.
  public init(_ value: E, fields: [String], at moment: Moment) throws(Violation) {
    let named = fields.uniqueInByteOrder
    var checking = value
    for check in E.checks {
      guard let field = check.field else {
        try Valid.run(check, on: &checking, at: moment)
        continue
      }
      guard named.contains(where: { $0.utf8.elementsEqual(field.utf8) }) else { continue }
      let before = checking.fields
      try Valid.run(check, on: &checking, at: moment)
      let after = checking.fields
      let others = Set(before.keys).union(after.keys).filter { !$0.utf8.elementsEqual(field.utf8) }
      precondition(others.allSatisfy { before[$0] == after[$0] }, "the check of \(E.type).\(field) changed another field")
    }
    if let stamped = (E.self as? any Timestamped.Type)?.timestampField, named.contains(where: { $0.utf8.elementsEqual(stamped.utf8) }) {
      checking = E.decoding(checking.id, checking.fields.merging([stamped: JSON(moment.now.ms)]) { _, now in now })
    }
    let written = checking.fields
    for field in named {
      guard let path = written[field]?.firstNul(at: Path(field)) else { continue }
      throw Violation(rule: "\(E.type).\(field)", path: path, reason: .nul)
    }
    self.value = checking
    checked = named
  }

  static func run(_ check: Check<E>, on value: inout E, at moment: Moment) throws(Violation) {
    do {
      try check.apply(&value, moment)
    } catch let violation as Violation {
      throw violation
    } catch {
      preconditionFailure("a check of \(E.type) threw \(error), and a check throws only Violation")
    }
  }
}

extension Writable {
  // §3.4 step 7: a value takes field values by decoding the record they build, which a `Draftable` always decodes.
  static func decoding(_ id: ID<Self>, _ fields: [String: JSON]) -> Self {
    do {
      return try Self(Fields(type: type, id: id.record, values: fields))
    } catch {
      preconditionFailure("\(type) does not decode the record its own fields build: \(error)")
    }
  }
}

extension Array where Element == String {
  // §8.2 order: UTF-8 bytes, each name once.
  var uniqueInByteOrder: [String] {
    var unique: [String] = []
    for name in sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) })
    where !(unique.last.map { $0.utf8.elementsEqual(name.utf8) } ?? false) {
      unique.append(name)
    }
    return unique
  }
}
