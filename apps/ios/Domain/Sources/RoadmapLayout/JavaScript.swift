// What the picture takes from JavaScript itself, each as JavaScript defines it (the fixtures' README, "Numbers, order and
// text"): `Math.max` and `Math.min`, text compared by UTF-16 code unit, and white space.

// A NaN argument gives NaN and -0 orders below 0. Swift's `max` and `min` promise neither.
enum Math {
  static func max(_ a: Double, _ b: Double) -> Double {
    if a != a || b != b { return .nan }
    if a == 0 && b == 0 { return a.sign == .minus ? b : a }
    return a > b ? a : b
  }

  static func min(_ a: Double, _ b: Double) -> Double {
    if a != a || b != b { return .nan }
    if a == 0 && b == 0 { return a.sign == .minus ? a : b }
    return a < b ? a : b
  }

  static func max(_ a: Double, _ b: Double, _ c: Double) -> Double { max(max(a, b), c) }

  // `Math.max(...values)` and `Math.min(...values)`: of nothing, they are -∞ and ∞.
  static func max(of values: [Double]) -> Double { values.reduce(-.infinity) { max($0, $1) } }

  static func min(of values: [Double]) -> Double { values.reduce(.infinity) { min($0, $1) } }
}

// A text as JavaScript holds it, by its UTF-16 code units: an id, an order key, a stamp's actor, a hue. Two of them are
// equal, ordered and keyed unit by unit, where Swift's String takes two spellings of one character for the same text
// and orders by scalar: `é` is not `e` with U+0301, and U+1F600 sorts before U+FF21.
public struct UTF16Text: Hashable, Comparable, Sendable {
  public let units: [UInt16]

  public init(_ text: String) {
    units = Array(text.utf16)
  }

  public var text: String { String(decoding: units, as: UTF16.self) }

  public static func < (a: UTF16Text, b: UTF16Text) -> Bool {
    a.units.lexicographicallyPrecedes(b.units)
  }
}

extension Unicode.Scalar {
  // What `\s` matches and `trim` strips. U+0085 and U+200B are not white space; U+FEFF is.
  var isJavaScriptWhiteSpace: Bool {
    switch value {
    case 0x9...0xD, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }
}
