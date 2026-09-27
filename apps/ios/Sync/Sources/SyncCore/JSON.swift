// A JSON value as the engine hashes, compares and sends it: byte-exact strings and keys, finite numbers, JCS text.

public enum JSON: Sendable, CustomStringConvertible {
  case null
  case bool(Bool)
  case number(Number)
  case string(String)
  case array([JSON])
  case object(Object)

  public static let maxDepth = 128
}

// MARK: - Numbers

extension JSON {
  public struct Number: Sendable, Hashable, CustomStringConvertible {
    public let value: Double

    public init?(_ value: Double) {
      guard value.isFinite else { return nil }
      self.value = value == 0 ? 0 : value
    }

    public init<Integer: BinaryInteger>(_ value: Integer) {
      self.value = Double(value)
    }

    // ECMAScript Number::toString over Swift's shortest round-trip digits: `digits` × 10^(n − k).
    public var description: String {
      if value == 0 { return "0" }
      let (digits, n) = Number.shortestDigits(of: value.magnitude)
      let k = digits.count
      let sign = value < 0 ? "-" : ""
      if k <= n && n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
      if 0 < n && n <= 21 { return sign + digits.prefix(n) + "." + digits.dropFirst(n) }
      if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + digits }
      let exponent = n - 1 < 0 ? "e-\(1 - n)" : "e+\(n - 1)"
      if k == 1 { return sign + digits + exponent }
      return sign + digits.prefix(1) + "." + digits.dropFirst() + exponent
    }

    // Reads Swift's shortest round-trip digits back as (significant digits, decimal point position).
    static func shortestDigits(of magnitude: Double) -> (digits: String, pointAt: Int) {
      let text = magnitude.description
      let parts = text.split(separator: "e", maxSplits: 1)
      let exponent = parts.count == 2 ? Int(parts[1])! : 0
      let mantissa = parts[0].split(separator: ".", maxSplits: 1)
      let whole = mantissa[0]
      let fraction = mantissa.count == 2 ? mantissa[1] : ""
      let significant = (whole + fraction).drop { $0 == "0" }
      let leadingZeros = whole.count + fraction.count - significant.count
      let trailingZeros = significant.reversed().prefix { $0 == "0" }.count
      return (String(significant.dropLast(trailingZeros)), whole.count + exponent - leadingZeros)
    }
  }
}

// MARK: - Objects

extension JSON {
  // Members sorted by the UTF-16 code units of their keys (the JCS order), keys unique by bytes.
  public struct Object: Sendable {
    public private(set) var members: [(key: String, value: JSON)]

    public init() {
      members = []
    }

    public init(_ pairs: some Sequence<(String, JSON)>) throws(JSONError) {
      members = pairs.map { (key: $0.0, value: $0.1) }
      members.sort { $0.key.utf16.lexicographicallyPrecedes($1.key.utf16) }
      for (earlier, later) in zip(members, members.dropFirst()) where earlier.key.utf8.elementsEqual(later.key.utf8) {
        throw .duplicateKey(later.key)
      }
    }

    public init(uniqueKeysWithValues pairs: some Sequence<(String, JSON)>) {
      do {
        try self.init(pairs)
      } catch {
        preconditionFailure("\(error)")
      }
    }

    public var keys: [String] { members.map(\.key) }
    public var count: Int { members.count }
    public var isEmpty: Bool { members.isEmpty }

    public subscript(key: String) -> JSON? {
      get { members.first { $0.key.utf8.elementsEqual(key.utf8) }?.value }
      set {
        members.removeAll { $0.key.utf8.elementsEqual(key.utf8) }
        guard let newValue else { return }
        let at = members.firstIndex { key.utf16.lexicographicallyPrecedes($0.key.utf16) } ?? members.endIndex
        members.insert((key: key, value: newValue), at: at)
      }
    }

    public func member(_ key: String) throws(JSONError) -> JSON {
      guard let value = self[key] else { throw .shape("missing key \(JSON.string(key).jcsText)") }
      return value
    }

    public func expectKeys(required: [String], optional: [String] = []) throws(JSONError) {
      for key in required where self[key] == nil { throw .shape("missing key \(JSON.string(key).jcsText)") }
      for key in keys where !(required + optional).contains(where: { $0.utf8.elementsEqual(key.utf8) }) {
        throw .shape("unexpected key \(JSON.string(key).jcsText)")
      }
    }
  }
}

// MARK: - Equality: two values are equal iff their JCS bytes are

extension JSON: Hashable {
  public static func == (lhs: JSON, rhs: JSON) -> Bool {
    lhs.jcs == rhs.jcs
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(jcs)
  }
}

extension JSON.Object: Hashable {
  public static func == (lhs: JSON.Object, rhs: JSON.Object) -> Bool {
    JSON.object(lhs) == JSON.object(rhs)
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(JSON.object(self))
  }
}

// MARK: - JCS (RFC 8785)

extension JSON {
  public var jcs: [UInt8] {
    var bytes: [UInt8] = []
    write(into: &bytes)
    return bytes
  }

  public var jcsText: String {
    String(decoding: jcs, as: UTF8.self)
  }

  public var description: String { jcsText }

  public func jcsPrecedes(_ other: JSON) -> Bool {
    jcs.lexicographicallyPrecedes(other.jcs)
  }

  func write(into bytes: inout [UInt8]) {
    switch self {
    case .null: bytes += Array("null".utf8)
    case .bool(let flag): bytes += Array((flag ? "true" : "false").utf8)
    case .number(let number): bytes += Array(number.description.utf8)
    case .string(let text): JSON.writeString(text, into: &bytes)
    case .array(let items):
      bytes.append(UInt8(ascii: "["))
      for (index, item) in items.enumerated() {
        if index > 0 { bytes.append(UInt8(ascii: ",")) }
        item.write(into: &bytes)
      }
      bytes.append(UInt8(ascii: "]"))
    case .object(let object):
      bytes.append(UInt8(ascii: "{"))
      for (index, member) in object.members.enumerated() {
        if index > 0 { bytes.append(UInt8(ascii: ",")) }
        JSON.writeString(member.key, into: &bytes)
        bytes.append(UInt8(ascii: ":"))
        member.value.write(into: &bytes)
      }
      bytes.append(UInt8(ascii: "}"))
    }
  }

  static func writeString(_ text: String, into bytes: inout [UInt8]) {
    let hex = Array("0123456789abcdef".utf8)
    bytes.append(UInt8(ascii: "\""))
    for byte in text.utf8 {
      switch byte {
      case UInt8(ascii: "\""): bytes += [UInt8(ascii: "\\"), UInt8(ascii: "\"")]
      case UInt8(ascii: "\\"): bytes += [UInt8(ascii: "\\"), UInt8(ascii: "\\")]
      case 0x08: bytes += [UInt8(ascii: "\\"), UInt8(ascii: "b")]
      case 0x09: bytes += [UInt8(ascii: "\\"), UInt8(ascii: "t")]
      case 0x0A: bytes += [UInt8(ascii: "\\"), UInt8(ascii: "n")]
      case 0x0C: bytes += [UInt8(ascii: "\\"), UInt8(ascii: "f")]
      case 0x0D: bytes += [UInt8(ascii: "\\"), UInt8(ascii: "r")]
      case 0x00..<0x20: bytes += Array("\\u00".utf8) + [hex[Int(byte >> 4)], hex[Int(byte & 0x0F)]]
      default: bytes.append(byte)
      }
    }
    bytes.append(UInt8(ascii: "\""))
  }
}

// MARK: - Parsing (RFC 8259, strict)

extension JSON {
  public init(parsing text: String) throws(JSONError) {
    try self.init(parsing: Array(text.utf8))
  }

  public init(parsing bytes: [UInt8]) throws(JSONError) {
    var parser = JSONParser(bytes: bytes)
    self = try parser.document()
  }
}

struct JSONParser {
  let bytes: [UInt8]
  var index = 0
  var depth = 0

  init(bytes: [UInt8]) {
    self.bytes = bytes
  }

  mutating func document() throws(JSONError) -> JSON {
    let value = try value()
    skipWhitespace()
    guard index == bytes.count else { throw .syntax("trailing characters", offset: index) }
    return value
  }

  mutating func value() throws(JSONError) -> JSON {
    skipWhitespace()
    guard let byte = peek() else { throw .syntax("a value is missing", offset: index) }
    switch byte {
    case UInt8(ascii: "{"): return try object()
    case UInt8(ascii: "["): return try array()
    case UInt8(ascii: "\""): return .string(try string())
    case UInt8(ascii: "t"): try literal("true"); return .bool(true)
    case UInt8(ascii: "f"): try literal("false"); return .bool(false)
    case UInt8(ascii: "n"): try literal("null"); return .null
    case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return .number(try number())
    default: throw .syntax("unexpected byte \(byte)", offset: index)
    }
  }

  mutating func object() throws(JSONError) -> JSON {
    try enterContainer()
    defer { depth -= 1 }
    var pairs: [(String, JSON)] = []
    skipWhitespace()
    if peek() == UInt8(ascii: "}") {
      index += 1
      return .object(JSON.Object())
    }
    while true {
      skipWhitespace()
      guard peek() == UInt8(ascii: "\"") else { throw .syntax("an object key must be a string", offset: index) }
      let key = try string()
      skipWhitespace()
      try expect(UInt8(ascii: ":"))
      pairs.append((key, try value()))
      skipWhitespace()
      if peek() == UInt8(ascii: ",") {
        index += 1
        continue
      }
      try expect(UInt8(ascii: "}"))
      return .object(try JSON.Object(pairs))
    }
  }

  mutating func array() throws(JSONError) -> JSON {
    try enterContainer()
    defer { depth -= 1 }
    var items: [JSON] = []
    skipWhitespace()
    if peek() == UInt8(ascii: "]") {
      index += 1
      return .array(items)
    }
    while true {
      items.append(try value())
      skipWhitespace()
      if peek() == UInt8(ascii: ",") {
        index += 1
        continue
      }
      try expect(UInt8(ascii: "]"))
      return .array(items)
    }
  }

  mutating func string() throws(JSONError) -> String {
    let start = index
    index += 1
    var text: [UInt8] = []
    while let byte = peek() {
      index += 1
      switch byte {
      case UInt8(ascii: "\""):
        guard let valid = String(validating: text, as: UTF8.self) else { throw .syntax("a string is not UTF-8", offset: start) }
        return valid
      case UInt8(ascii: "\\"):
        UTF8.encode(try escapedScalar()) { text.append($0) }
      case 0x00..<0x20:
        throw .syntax("a control character must be escaped", offset: index - 1)
      default:
        text.append(byte)
      }
    }
    throw .syntax("a string is not terminated", offset: start)
  }

  mutating func escapedScalar() throws(JSONError) -> Unicode.Scalar {
    guard let byte = peek() else { throw .syntax("an escape is cut off", offset: index) }
    index += 1
    switch byte {
    case UInt8(ascii: "\""): return "\""
    case UInt8(ascii: "\\"): return "\\"
    case UInt8(ascii: "/"): return "/"
    case UInt8(ascii: "b"): return "\u{08}"
    case UInt8(ascii: "f"): return "\u{0C}"
    case UInt8(ascii: "n"): return "\n"
    case UInt8(ascii: "r"): return "\r"
    case UInt8(ascii: "t"): return "\t"
    case UInt8(ascii: "u"): break
    default: throw .syntax("unknown escape", offset: index - 1)
    }
    let unit = try hexUnit()
    if (0xDC00...0xDFFF).contains(unit) { throw .syntax("a lone low surrogate", offset: index - 6) }
    guard (0xD800...0xDBFF).contains(unit) else { return Unicode.Scalar(unit)! }
    guard bytes[index...].starts(with: Array("\\u".utf8)) else { throw .syntax("a lone high surrogate", offset: index - 6) }
    index += 2
    let low = try hexUnit()
    guard (0xDC00...0xDFFF).contains(low) else { throw .syntax("a lone high surrogate", offset: index - 12) }
    return Unicode.Scalar(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00))!
  }

  mutating func hexUnit() throws(JSONError) -> UInt32 {
    var unit: UInt32 = 0
    for _ in 0..<4 {
      guard let byte = peek(), let digit = Character(Unicode.Scalar(byte)).hexDigitValue else {
        throw .syntax("\\u needs four hex digits", offset: index)
      }
      unit = unit << 4 | UInt32(digit)
      index += 1
    }
    return unit
  }

  mutating func number() throws(JSONError) -> JSON.Number {
    let start = index
    if peek() == UInt8(ascii: "-") { index += 1 }
    if peek() == UInt8(ascii: "0") {
      index += 1
    } else {
      guard try digits() > 0 else { throw .syntax("a number needs digits", offset: index) }
    }
    if peek() == UInt8(ascii: ".") {
      index += 1
      guard try digits() > 0 else { throw .syntax("a fraction needs digits", offset: index) }
    }
    if peek() == UInt8(ascii: "e") || peek() == UInt8(ascii: "E") {
      index += 1
      if peek() == UInt8(ascii: "+") || peek() == UInt8(ascii: "-") { index += 1 }
      guard try digits() > 0 else { throw .syntax("an exponent needs digits", offset: index) }
    }
    let text = String(decoding: bytes[start..<index], as: UTF8.self)
    guard let value = Double(text), let number = JSON.Number(value) else {
      throw .syntax("the number \(text) is not a finite double", offset: start)
    }
    return number
  }

  mutating func digits() throws(JSONError) -> Int {
    let start = index
    while let byte = peek(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) { index += 1 }
    return index - start
  }

  mutating func literal(_ word: String) throws(JSONError) {
    guard bytes[index...].starts(with: Array(word.utf8)) else { throw .syntax("expected \(word)", offset: index) }
    index += word.utf8.count
  }

  mutating func expect(_ byte: UInt8) throws(JSONError) {
    guard peek() == byte else { throw .syntax("expected \(Character(Unicode.Scalar(byte)))", offset: index) }
    index += 1
  }

  mutating func enterContainer() throws(JSONError) {
    depth += 1
    guard depth <= JSON.maxDepth else { throw .tooDeep(offset: index) }
    index += 1
  }

  mutating func skipWhitespace() {
    while let byte = peek(), [0x20, 0x09, 0x0A, 0x0D].contains(byte) { index += 1 }
  }

  func peek() -> UInt8? {
    index < bytes.count ? bytes[index] : nil
  }
}

// MARK: - Reading values

extension JSON {
  public subscript(key: String) -> JSON? {
    guard case .object(let object) = self else { return nil }
    return object[key]
  }

  public func member(_ key: String) throws(JSONError) -> JSON {
    try asObject().member(key)
  }

  public var isNull: Bool {
    if case .null = self { return true }
    return false
  }

  public func asString() throws(JSONError) -> String {
    guard case .string(let text) = self else { throw mismatch("a string") }
    return text
  }

  public func asBool() throws(JSONError) -> Bool {
    guard case .bool(let flag) = self else { throw mismatch("a boolean") }
    return flag
  }

  public func asDouble() throws(JSONError) -> Double {
    guard case .number(let number) = self else { throw mismatch("a number") }
    return number.value
  }

  // §9.1: every integer on the wire is a safe integer, at most 2^53 − 1 in magnitude.
  public func asInteger() throws(JSONError) -> Int64 {
    guard case .number(let number) = self, number.value.rounded(.towardZero) == number.value,
          number.value.magnitude < 9_007_199_254_740_992 else { throw mismatch("a safe integer") }
    return Int64(number.value)
  }

  public func asInteger(atLeast minimum: Int64) throws(JSONError) -> Int64 {
    let integer = try asInteger()
    guard integer >= minimum else { throw mismatch("an integer of at least \(minimum)") }
    return integer
  }

  public func asDistinctStrings() throws(JSONError) -> [String] {
    var strings: [String] = []
    for item in try asArray() {
      let text = try item.asString()
      guard !strings.contains(where: { $0.utf8.elementsEqual(text.utf8) }) else { throw .shape("\(item) appears twice") }
      strings.append(text)
    }
    return strings
  }

  public func asArray() throws(JSONError) -> [JSON] {
    guard case .array(let items) = self else { throw mismatch("an array") }
    return items
  }

  public func asObject() throws(JSONError) -> Object {
    guard case .object(let object) = self else { throw mismatch("an object") }
    return object
  }

  func mismatch(_ expected: String) -> JSONError {
    let found = jcsText
    return .shape("expected \(expected), found \(found.count > 80 ? String(found.prefix(80)) + "…" : found)")
  }
}

// MARK: - Literals

extension JSON: ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
  ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
  public init<Integer: BinaryInteger>(_ value: Integer) {
    self = .number(Number(value))
  }

  public init(booleanLiteral value: Bool) {
    self = .bool(value)
  }

  public init(integerLiteral value: Int64) {
    self = .number(Number(value))
  }

  public init(floatLiteral value: Double) {
    guard let number = Number(value) else { preconditionFailure("a JSON number is finite") }
    self = .number(number)
  }

  public init(stringLiteral value: String) {
    self = .string(value)
  }

  public init(arrayLiteral elements: JSON...) {
    self = .array(elements)
  }

  public init(dictionaryLiteral elements: (String, JSON)...) {
    self = .object(Object(uniqueKeysWithValues: elements))
  }
}

extension JSON.Object: ExpressibleByDictionaryLiteral {
  public init(dictionaryLiteral elements: (String, JSON)...) {
    self.init(uniqueKeysWithValues: elements)
  }
}

// MARK: - Identifier text

extension StringProtocol {
  // Identifiers are printable ASCII, so canonical equivalence never makes two different ones equal.
  public var isPrintableASCII: Bool {
    utf8.allSatisfy { (0x20...0x7E).contains($0) }
  }
}
