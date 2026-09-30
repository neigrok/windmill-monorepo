// D-1 stamps: the text `ms:counter:actor` (§10.1), ordered by (ms, counter), then the actor's bytes (§3.1).

public struct Stamp: Sendable, Hashable, Comparable, CustomStringConvertible {
  public let ms: Int64
  public let counter: UInt32
  public let actor: String

  public static let unset = Stamp(ms: 0, counter: 0, validActor: "")
  public static let msLimit: Int64 = 1 << 53

  init(ms: Int64, counter: UInt32, validActor: String) {
    self.ms = ms
    self.counter = counter
    self.actor = validActor
  }

  public init(_ text: String) throws(StampError) {
    if text.utf8.elementsEqual(Stamp.unset.text.utf8) {
      self = .unset
      return
    }
    let parts = text.utf8.split(separator: UInt8(ascii: ":"), maxSplits: 2, omittingEmptySubsequences: false)
    guard parts.count == 3 else { throw StampError(text: text, reason: "it lacks two colons") }
    guard let ms = Stamp.decimal(parts[0]), ms < Stamp.msLimit else {
      throw StampError(text: text, reason: "ms is not plain decimal below 2^53")
    }
    guard let counter = Stamp.decimal(parts[1]), counter <= Int64(UInt32.max) else {
      throw StampError(text: text, reason: "counter is not plain decimal below 2^32")
    }
    let actor = String(decoding: parts[2], as: UTF8.self)
    guard Actor.isValid(actor) else { throw StampError(text: text, reason: "the actor is not 1-64 printable ASCII bytes") }
    self.init(ms: ms, counter: UInt32(counter), validActor: actor)
  }

  public init(json: JSON) throws {
    try self.init(json.asString())
  }

  public var text: String { "\(ms):\(counter):\(actor)" }
  public var description: String { text }
  public var json: JSON { .string(text) }

  public static func < (lhs: Stamp, rhs: Stamp) -> Bool {
    if lhs.ms != rhs.ms { return lhs.ms < rhs.ms }
    if lhs.counter != rhs.counter { return lhs.counter < rhs.counter }
    return lhs.actor.utf8.lexicographicallyPrecedes(rhs.actor.utf8)
  }

  public static func == (lhs: Stamp, rhs: Stamp) -> Bool {
    lhs.ms == rhs.ms && lhs.counter == rhs.counter && lhs.actor.utf8.elementsEqual(rhs.actor.utf8)
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(ms)
    hasher.combine(counter)
    hasher.combine(Array(actor.utf8))
  }

  // Plain decimal: digits only, no sign, no leading zero except "0" itself.
  static func decimal(_ digits: Substring.UTF8View) -> Int64? {
    guard let first = digits.first, digits.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
          first != UInt8(ascii: "0") || digits.count == 1, digits.count <= 16 else { return nil }
    return Int64(String(decoding: digits, as: UTF8.self))
  }
}

extension Stamp {
  // The actor an engine instance stamps with: 1–64 bytes of printable ASCII (D-1, D-2).
  public struct Actor: Sendable, Hashable, CustomStringConvertible {
    public let text: String

    public init(_ text: String) throws(StampError) {
      guard Actor.isValid(text) else { throw StampError(text: text, reason: "an actor is 1-64 printable ASCII bytes") }
      self.text = text
    }

    public var description: String { text }

    static func isValid(_ text: String) -> Bool {
      (1...64).contains(text.utf8.count) && text.isPrintableASCII
    }
  }
}

