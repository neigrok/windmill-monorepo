// D-25 fractional keys, byte-identical to web/src/products/roadmap/sync/fractionalIndex.js; lists sort by (key, id).

public struct FractionalKey: Sendable, Hashable, Comparable, CustomStringConvertible {
  let bytes: [UInt8]

  static let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)
  static let smallestInteger = Array("A".utf8) + Array(repeating: UInt8(ascii: "0"), count: 26)

  public init(_ text: String) throws(FractionalKeyError) {
    let bytes = Array(text.utf8)
    guard let head = bytes.first, bytes != FractionalKey.smallestInteger,
          bytes.allSatisfy({ FractionalKey.alphabet.contains($0) }),
          let length = FractionalKey.integerLength(head: head), length <= bytes.count,
          length == bytes.count || bytes.last != UInt8(ascii: "0")
    else { throw .invalid(text) }
    self.bytes = bytes
  }

  init(checked bytes: [UInt8]) {
    self.bytes = bytes
  }

  // A key strictly between `a` and `b`; nil is an open end.
  public init(between a: FractionalKey?, and b: FractionalKey?) throws(FractionalKeyError) {
    switch (a, b) {
    case (nil, nil):
      self.init(checked: Array("a0".utf8))
    case (nil, let b?):
      let integer = b.integerPart
      if integer == FractionalKey.smallestInteger {
        self.init(checked: integer + (try FractionalKey.midpoint([], Array(b.bytes.dropFirst(integer.count)))))
        return
      }
      if integer.count < b.bytes.count {
        self.init(checked: integer)
        return
      }
      guard let lower = FractionalKey.step(integer, by: -1) else { throw .exhausted }
      self.init(checked: lower)
    case (let a?, nil):
      let integer = a.integerPart
      if let higher = FractionalKey.step(integer, by: 1) {
        self.init(checked: higher)
        return
      }
      self.init(checked: integer + (try FractionalKey.midpoint(Array(a.bytes.dropFirst(integer.count)), nil)))
    case (let a?, let b?):
      guard a < b else { throw .notAscending(a.text, b.text) }
      let integerA = a.integerPart
      let fractionA = Array(a.bytes.dropFirst(integerA.count))
      if integerA == b.integerPart {
        self.init(checked: integerA + (try FractionalKey.midpoint(fractionA, Array(b.bytes.dropFirst(integerA.count)))))
        return
      }
      guard let higher = FractionalKey.step(integerA, by: 1) else { throw .exhausted }
      if higher.lexicographicallyPrecedes(b.bytes) {
        self.init(checked: higher)
        return
      }
      self.init(checked: integerA + (try FractionalKey.midpoint(fractionA, nil)))
    }
  }

  // D-25 drop position: after the anchor (looked up in drawn, then stored), before the next greater stored key,
  // the placed member excluded.
  public init(dropping moved: JSON, below above: JSON?, stored: [ListMember], drawn: [ListMember]) throws(FractionalKeyError) {
    let others = stored.filter { $0.id != moved }.sorted()
    guard let above else {
      try self.init(between: nil, and: others.first?.key)
      return
    }
    guard let anchor = drawn.first(where: { $0.id == above }) ?? others.first(where: { $0.id == above }) else {
      throw .anchorMissing(above.jcsText)
    }
    try self.init(between: anchor.key, and: others.first { $0.key > anchor.key }?.key)
  }

  public var text: String { String(decoding: bytes, as: UTF8.self) }
  public var description: String { text }

  public static func < (lhs: FractionalKey, rhs: FractionalKey) -> Bool {
    lhs.bytes.lexicographicallyPrecedes(rhs.bytes)
  }

  var integerPart: [UInt8] {
    Array(bytes.prefix(FractionalKey.integerLength(head: bytes[0])!))
  }

  static func integerLength(head: UInt8) -> Int? {
    switch head {
    case UInt8(ascii: "a")...UInt8(ascii: "z"): Int(head - UInt8(ascii: "a")) + 2
    case UInt8(ascii: "A")...UInt8(ascii: "Z"): Int(UInt8(ascii: "Z") - head) + 2
    default: nil
    }
  }

  static func value(of digit: UInt8) -> Int {
    alphabet.firstIndex(of: digit)!
  }

  // One loop pass per step of the reference's recursion, so a key of any length needs no stack.
  static func midpoint(_ a: [UInt8], _ b: [UInt8]?) throws(FractionalKeyError) -> [UInt8] {
    let zero = UInt8(ascii: "0")
    var a = a[...]
    var b = b?[...]
    var built: [UInt8] = []
    while true {
      if let b, !a.lexicographicallyPrecedes(b) {
        throw .notAscending(String(decoding: a, as: UTF8.self), String(decoding: b, as: UTF8.self))
      }
      if a.last == zero || b?.last == zero { throw .invalid("a fraction ending in 0") }
      if let upper = b {
        var shared = 0
        while (a.dropFirst(shared).first ?? zero) == upper.dropFirst(shared).first { shared += 1 }
        if shared > 0 {
          built += upper.prefix(shared)
          a = a.dropFirst(shared)
          b = upper.dropFirst(shared)
          continue
        }
      }
      let digitA = a.first.map(value(of:)) ?? 0
      let digitB = b.map { value(of: $0.first!) } ?? alphabet.count
      if digitB - digitA > 1 { return built + [alphabet[(digitA + digitB + 1) / 2]] }
      if let b, b.count > 1 { return built + [b.first!] }
      built.append(alphabet[digitA])
      a = a.dropFirst()
      b = nil
    }
  }

  // The next integer part up or down, its length moving with its head; nil past either end.
  static func step(_ integer: [UInt8], by direction: Int) -> [UInt8]? {
    let head = integer[0]
    var digits = Array(integer.dropFirst())
    for index in digits.indices.reversed() {
      let next = value(of: digits[index]) + direction
      if alphabet.indices.contains(next) {
        digits[index] = alphabet[next]
        return [head] + digits
      }
      digits[index] = direction > 0 ? UInt8(ascii: "0") : UInt8(ascii: "z")
    }
    if direction > 0 {
      if head == UInt8(ascii: "Z") { return Array("a0".utf8) }
      if head == UInt8(ascii: "z") { return nil }
      if head + 1 > UInt8(ascii: "a") { digits.append(UInt8(ascii: "0")) } else { digits.removeLast() }
      return [head + 1] + digits
    }
    if head == UInt8(ascii: "a") { return Array("Zz".utf8) }
    if head == UInt8(ascii: "A") { return nil }
    if head - 1 < UInt8(ascii: "Z") { digits.append(UInt8(ascii: "z")) } else { digits.removeLast() }
    return [head - 1] + digits
  }
}

// A visible member of an ordered list: its record id and its order key.
public struct ListMember: Sendable, Hashable, Comparable {
  public let id: JSON
  public let key: FractionalKey

  public init(id: JSON, key: FractionalKey) {
    self.id = id
    self.key = key
  }

  public static func < (lhs: ListMember, rhs: ListMember) -> Bool {
    if lhs.key != rhs.key { return lhs.key < rhs.key }
    return lhs.id.jcsPrecedes(rhs.id)
  }
}
