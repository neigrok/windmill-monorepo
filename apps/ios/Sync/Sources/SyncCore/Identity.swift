// How ids are made: a CSPRNG id by its type's mint and a seeded id (D-8), and a derived id from a label (D-26).

extension Mint {
  public func id(using generator: inout some RandomNumberGenerator) -> String {
    let symbols = Array(alphabet.unicodeScalars)
    return prefix + String(String.UnicodeScalarView((0..<length).map { _ in symbols.randomElement(using: &generator)! }))
  }
}

public enum DerivedID {
  public static let baseLimit = 40

  // `taken` is compared by bytes; every label byte outside [A-Za-z0-9] separates words.
  public static func from(label: String, fallback: String, taken: some Sequence<String>) -> String {
    let takenBytes = Set(taken.map { Array($0.utf8) })
    var base: [UInt8] = []
    for byte in label.utf8 {
      if base.count == baseLimit { break }
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "a")...UInt8(ascii: "z"): base.append(byte)
      case UInt8(ascii: "A")...UInt8(ascii: "Z"): base.append(byte + 0x20)
      default: if let last = base.last, last != UInt8(ascii: "-") { base.append(UInt8(ascii: "-")) }
      }
    }
    while base.last == UInt8(ascii: "-") { base.removeLast() }
    let stem = base.isEmpty ? fallback : String(decoding: base, as: UTF8.self)
    var id = stem
    var suffix = 2
    while takenBytes.contains(Array(id.utf8)) {
      id = "\(stem)-\(suffix)"
      suffix += 1
    }
    return id
  }
}

public struct SeededID: Sendable, Hashable {
  public let seed: String
  public let ordinal: Int

  public init(seed: String, ordinal: Int, for type: TypeDef) throws(IdentityError) {
    guard let bounds = type.seeded, let pattern = type.idPattern else { throw IdentityError("\(type.name) does not seed ids") }
    guard seed.unicodeScalars.count <= bounds.seedMax, pattern.matches(seed) else {
      throw IdentityError("the seed \(seed) is not an id of at most \(bounds.seedMax) characters")
    }
    guard (1...bounds.ordinalMax).contains(ordinal) else {
      throw IdentityError("the ordinal \(ordinal) is outside 1...\(bounds.ordinalMax)")
    }
    self.seed = seed
    self.ordinal = ordinal
    guard pattern.matches(id) else { throw IdentityError("\(id) does not match \(pattern.source)") }
  }

  // Split at the last `-`: a non-empty seed, and a decimal ordinal of at least 1 without a leading zero.
  public init?(parsing id: String) {
    guard let cut = id.utf8.lastIndex(of: UInt8(ascii: "-")), cut != id.utf8.startIndex else { return nil }
    let digits = id.utf8[id.utf8.index(after: cut)...]
    guard let first = digits.first, first != UInt8(ascii: "0"),
          digits.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
          let ordinal = Int(String(decoding: digits, as: UTF8.self)) else { return nil }
    self.seed = String(decoding: id.utf8[..<cut], as: UTF8.self)
    self.ordinal = ordinal
  }

  public var id: String { "\(seed)-\(ordinal)" }

  public static func == (lhs: SeededID, rhs: SeededID) -> Bool {
    lhs.seed.utf8.elementsEqual(rhs.seed.utf8) && lhs.ordinal == rhs.ordinal
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(seed.utf8))
    hasher.combine(ordinal)
  }
}

