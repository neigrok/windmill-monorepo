import CryptoKit

// §6.12 the scope digest: Σ sha256(jcs(row)) mod 2^256 over alive rows; one row's hash is a one-row digest.

public struct ScopeDigest: Sendable, Hashable, CustomStringConvertible {
  let words: [UInt64]

  public static let zero = ScopeDigest(words: [0, 0, 0, 0])

  init(words: [UInt64]) {
    self.words = words
  }

  // A row whose life is dead is outside the digest, and so is an absent one.
  public init(row: JSON?) {
    guard let row else {
      self = .zero
      return
    }
    if let life = row["life"], (try? life.asArray().first) != "alive" {
      self = .zero
      return
    }
    let hash = Array(SHA256.hash(data: row.jcs))
    words = stride(from: 0, to: 32, by: 8).map { start in hash[start..<start + 8].reduce(0) { $0 << 8 | UInt64($1) } }
  }

  public init(rows: some Sequence<JSON>) {
    self = rows.reduce(.zero) { $0 + ScopeDigest(row: $1) }
  }

  public init(hex: String) throws(DigestError) {
    let digits = Array(hex.utf8)
    guard digits.count == 64, digits.allSatisfy({ Array("0123456789abcdef".utf8).contains($0) }) else {
      throw DigestError(hex: hex)
    }
    words = stride(from: 0, to: 64, by: 16).map { UInt64(String(decoding: digits[$0..<$0 + 16], as: UTF8.self), radix: 16)! }
  }

  // 32 big-endian bytes, as the store keeps it (§6.12).
  public init(bytes: [UInt8]) throws(DigestError) {
    guard bytes.count == 32 else { throw DigestError(hex: "\(bytes.count) bytes") }
    words = stride(from: 0, to: 32, by: 8).map { start in bytes[start..<start + 8].reduce(0) { $0 << 8 | UInt64($1) } }
  }

  public var bytes: [UInt8] {
    words.flatMap { word in stride(from: 56, through: 0, by: -8).map { UInt8(truncatingIfNeeded: word >> UInt64($0)) } }
  }

  public var hex: String {
    words.map { word in
      let digits = String(word, radix: 16)
      return String(repeating: "0", count: 16 - digits.count) + digits
    }.joined()
  }

  public var description: String { hex }

  // One row change: `digest − h(before) + h(after)`, absent rows hashing to zero.
  public func replacing(_ before: JSON?, with after: JSON?) -> ScopeDigest {
    self - ScopeDigest(row: before) + ScopeDigest(row: after)
  }

  public static func + (lhs: ScopeDigest, rhs: ScopeDigest) -> ScopeDigest {
    var words = [UInt64](repeating: 0, count: 4)
    var carry = false
    for index in (0..<4).reversed() {
      let (partial, overflowA) = lhs.words[index].addingReportingOverflow(rhs.words[index])
      let (sum, overflowB) = partial.addingReportingOverflow(carry ? 1 : 0)
      words[index] = sum
      carry = overflowA || overflowB
    }
    return ScopeDigest(words: words)
  }

  public static func - (lhs: ScopeDigest, rhs: ScopeDigest) -> ScopeDigest {
    var words = [UInt64](repeating: 0, count: 4)
    var borrow = false
    for index in (0..<4).reversed() {
      let (partial, overflowA) = lhs.words[index].subtractingReportingOverflow(rhs.words[index])
      let (difference, overflowB) = partial.subtractingReportingOverflow(borrow ? 1 : 0)
      words[index] = difference
      borrow = overflowA || overflowB
    }
    return ScopeDigest(words: words)
  }
}

// sha256 of some bytes as 64 lowercase hex characters: the §6.2 intent digest.
public enum SHA256Hex {
  public static func of(_ bytes: [UInt8]) -> String {
    SHA256.hash(data: bytes).map { byte in
      let digits = String(byte, radix: 16)
      return digits.count == 1 ? "0" + digits : digits
    }.joined()
  }
}
