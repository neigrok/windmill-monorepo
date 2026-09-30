import DomainKitNFC
import SyncCore

// §4.1 a product value with no identity, held inside one of an entity's fields.
public protocol ValueObject: Sendable {
  init(_ f: Fields) throws(DecodeError)
  var json: JSON { get }
  // A normalised copy, or the first LOCAL rule it breaks.
  func validated(at path: Path) throws(Violation) -> Self
}

extension JSON {
  public static func object(omittingNil pairs: [String: JSON?]) -> JSON {
    .object(JSON.Object(uniqueKeysWithValues: pairs.compactMap { key, value in value.map { (key, $0) } }))
  }

  public static func of(_ x: Int?) -> JSON {
    x.map { JSON($0) } ?? .null
  }

  // A value no JSON number holds (a draft's NaN) stays apart from null, so it counts as touched and its check refuses it.
  public static func of(_ x: Double?) -> JSON {
    guard let x else { return .null }
    guard let number = JSON.Number(x) else { return .string("\(x)") }
    return .number(number)
  }

  public static func of(_ s: String?) -> JSON {
    s.map { .string($0) } ?? .null
  }

  public static func of(_ t: Instant?) -> JSON {
    t.map { JSON($0.ms) } ?? .null
  }

  var isString: Bool {
    if case .string = self { return true }
    return false
  }

  // The engine refuses U+0000 in every string it sends (engine §7.1 step 7): the path of the first such string, members
  // in key order, items in order.
  func firstNul(at path: Path) -> Path? {
    switch self {
    case .string(let text): return text.unicodeScalars.contains("\u{0}") ? path : nil
    case .array(let items): return items.enumerated().lazy.compactMap { $0.element.firstNul(at: path + $0.offset) }.first
    case .object(let members): return members.members.lazy.compactMap { $0.value.firstNul(at: path + $0.key) }.first
    default: return nil
    }
  }
}

// MARK: - Value specs

// §4.2 a LOCAL rule on one value, declared as data. Its path is the registry path of the value it constrains, and its
// rule name.
public protocol ValueSpec: Sendable {
  var path: String { get }
  var json: JSON { get }
}

public enum TextUnit: String, Sendable {
  case chars, bytes

  // ER-11: the engine's own measures, Unicode scalars or UTF-8 bytes, never grapheme clusters.
  func length(of text: String) -> Int {
    switch self {
    case .chars: MeasureUnit.chars.length(of: text)
    case .bytes: MeasureUnit.bytes.length(of: text)
    }
  }
}

public struct TextSpec: ValueSpec {
  public let path: String
  let unit: TextUnit
  let min: Int
  let max: Int
  let trim: Bool
  let nfc: Bool

  public init(_ path: String, unit: TextUnit, min: Int, max: Int, trim: Bool, nfc: Bool) {
    self.path = path
    self.unit = unit
    self.min = min
    self.max = max
    self.trim = trim
    self.nfc = nfc
  }

  public var json: JSON {
    ["path": .string(path), "kind": "text", "unit": .string(unit.rawValue), "min": JSON(min), "max": JSON(max),
     "trim": .bool(trim), "nfc": .bool(nfc)]
  }

  // §4.3 text: NFC, trim, U+0000, measure, then the bounds.
  public func apply(_ s: String, at path: Path) throws(Violation) -> String {
    let text = normalised(s)
    if text.unicodeScalars.contains("\u{0}") { throw violation(.nul, at: path) }
    let measured = unit.length(of: text)
    if measured == 0 && min >= 1 { throw violation(.blank, at: path) }
    if measured < min { throw violation(.tooShort(min: min, unit: unit), at: path) }
    if measured > max { throw violation(.tooLong(max: max, unit: unit, measured: measured), at: path) }
    return text
  }

  public func apply(_ s: String?, at path: Path) throws(Violation) -> String? {
    guard let s else { return nil }
    return try apply(s, at: path) as String
  }

  public func measure(_ s: String) -> Int {
    unit.length(of: normalised(s))
  }

  public static func isBlank(_ s: String) -> Bool {
    s.unicodeScalars.allSatisfy(isWhitespace)
  }

  // §4.3 step 2: ECMAScript `\s`, the set the engine's text merge tokenises on. No platform predicate.
  static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }

  func normalised(_ s: String) -> String {
    let composed = nfc ? DomainKitNFC.nfc(s) : s
    guard trim else { return composed }
    let scalars = composed.unicodeScalars
    guard let first = scalars.firstIndex(where: { !TextSpec.isWhitespace($0) }),
          let last = scalars.lastIndex(where: { !TextSpec.isWhitespace($0) }) else { return "" }
    return String(scalars[first...last])
  }

  func violation(_ reason: Violation.Reason, at path: Path) -> Violation {
    Violation(rule: self.path, path: path, reason: reason)
  }
}

public struct NumberSpec: ValueSpec {
  public let path: String
  let min: Double
  let max: Double
  let integer: Bool
  let quantum: Quantum?

  public init(_ path: String, min: Double, max: Double, integer: Bool = false, quantum: Double? = nil) {
    precondition(!(integer && quantum != nil), "the number spec \(path) is integer or has a quantum, never both")
    self.path = path
    self.min = min
    self.max = max
    self.integer = integer
    self.quantum = quantum.map { step in
      guard let quantum = Quantum(step) else { preconditionFailure("the number spec \(path) has a quantum that is no integer or 1/k") }
      return quantum
    }
  }

  public var json: JSON {
    var object: JSON.Object = ["path": .string(path), "kind": "number", "min": .of(min), "max": .of(max), "integer": .bool(integer)]
    object["quantum"] = quantum.map { .of($0.step) }
    return .object(object)
  }

  // §4.3 number: finite, integral when integer, rounded to the quantum (engine §7.1 step 4), then the bounds.
  public func apply(_ x: Double, at path: Path) throws(Violation) -> Double {
    guard x.isFinite else { throw violation(.notANumber, at: path) }
    if integer && x.rounded(.towardZero) != x { throw violation(.notInteger, at: path) }
    let rounded = quantum.map { $0.rounded(x) } ?? x
    if rounded < min { throw violation(.below(min: min), at: path) }
    if rounded > max { throw violation(.above(max: max), at: path) }
    return rounded
  }

  public func apply(_ x: Double?, at path: Path) throws(Violation) -> Double? {
    guard let x else { return nil }
    return try apply(x, at: path) as Double
  }

  public func apply(_ x: Int, at path: Path) throws(Violation) -> Int {
    Int(try apply(Double(x), at: path) as Double)
  }

  public func apply(_ x: Int?, at path: Path) throws(Violation) -> Int? {
    guard let x else { return nil }
    return try apply(x, at: path) as Int
  }

  func violation(_ reason: Violation.Reason, at path: Path) -> Violation {
    Violation(rule: self.path, path: path, reason: reason)
  }
}

public struct ChoiceSpec: ValueSpec {
  public let path: String
  let values: [String]

  public init(_ path: String, values: [String]) {
    self.path = path
    self.values = values
  }

  public var json: JSON {
    ["path": .string(path), "kind": "choice", "values": .array(values.map { .string($0) })]
  }

  // Compared by UTF-8 bytes, so a canonically equivalent spelling is another value.
  public func apply(_ s: String, at path: Path) throws(Violation) -> String {
    guard values.contains(where: { $0.utf8.elementsEqual(s.utf8) }) else {
      throw Violation(rule: self.path, path: path, reason: .notOneOf)
    }
    return s
  }

  public func apply(_ s: String?, at path: Path) throws(Violation) -> String? {
    guard let s else { return nil }
    return try apply(s, at: path) as String
  }
}

public struct CountSpec: ValueSpec {
  public let path: String
  let min: Int
  let max: Int

  public init(_ path: String, min: Int, max: Int) {
    self.path = path
    self.min = min
    self.max = max
  }

  public var json: JSON {
    ["path": .string(path), "kind": "count", "min": JSON(min), "max": JSON(max)]
  }

  // §4.3 count: the count first, then each item in order at its index.
  public func apply<V: ValueObject>(_ items: [V], at path: Path) throws(Violation) -> [V] {
    if items.count < min { throw Violation(rule: self.path, path: path, reason: .tooFew(min: min)) }
    if items.count > max { throw Violation(rule: self.path, path: path, reason: .tooMany(max: max)) }
    var validated: [V] = []
    for (index, item) in items.enumerated() {
      validated.append(try item.validated(at: path + index))
    }
    return validated
  }

  public func apply<V: ValueObject>(_ items: [V]?, at path: Path) throws(Violation) -> [V]? {
    guard let items else { return nil }
    return try apply(items, at: path) as [V]
  }
}
