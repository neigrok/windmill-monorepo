// Where a roadmap and its steps open on the site, as what follows its origin (`roadmap-addresses.json`, which the web
// and the backend also run): one of the person's own at `/#/app/<tree>`, a step of it with `?step=<step>` in the hash,
// and one shared with them at `/t/<tree>`, a step of it with `#?step=<step>`. A tree id is `t_` and sixteen lowercase hex
// and is written as it is; a step id is encoded as the web's `encodeURIComponent` encodes it.
public struct RoadmapAddress: Equatable, Sendable {
  public let tree: String
  // The step the address names; none for the roadmap's own address.
  public let step: String?

  public init?(tree: String, step: String? = nil) {
    guard Self.names(tree) else { return nil }
    self.tree = tree
    self.step = step
  }

  // The roadmap an address names, from its path and its fragment as they stand in it, still percent-encoded, read as
  // the web's router reads them: a fragment that is an app route wins over the path, and a share's fragment holds only
  // the step. The fragment's query is what stands between its first `?` and the next, as the web splits it. Nil where the
  // address names no roadmap: another page of the site, or an id that is no tree's.
  public init?(path: String, fragment: String?) {
    let hash = (fragment ?? "").split(separator: "?", omittingEmptySubsequences: false)
    let step = hash.count > 1 ? Self.step(in: hash[1]) : nil
    if hash[0].hasPrefix("/") {
      guard hash[0].hasPrefix("/app/") else { return nil }
      self.init(tree: String(hash[0].dropFirst("/app/".count)), step: step)
      return
    }
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 3 || (parts.count == 4 && parts[3].isEmpty), parts[0].isEmpty, parts[1] == "t" else { return nil }
    self.init(tree: Self.decoded(parts[2], plusIsSpace: false), step: step)
  }

  // The address a roadmap shared with the reader opens at, the share's: `/t/<tree>`, with its step.
  public var shared: String { "/t/\(tree)" + (step.map { "#?step=\(Self.encoded($0))" } ?? "") }

  // The address one of the person's own roadmaps opens at in the app: `/#/app/<tree>`, with its step.
  public var own: String { "/#/app/\(tree)" + (step.map { "?step=\(Self.encoded($0))" } ?? "") }

  // A tree id: `t_` and sixteen lowercase hex.
  static func names(_ tree: String) -> Bool {
    let bytes = Array(tree.utf8)
    return bytes.count == 18 && bytes.starts(with: Array("t_".utf8)) && bytes.dropFirst(2).allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }

  // The value of the first `step` a query holds, as the browser's `URLSearchParams` reads it.
  static func step(in query: Substring) -> String? {
    for pair in query.split(separator: "&") {
      let named = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      if decoded(named[0], plusIsSpace: true) == "step" { return named.count > 1 ? decoded(named[1], plusIsSpace: true) : "" }
    }
    return nil
  }

  // Percent-decoded as the browser decodes a query or a path: an escape of two hex digits is its byte, anything else stands
  // as it is, and the bytes are read as UTF-8, any that are not standing for the replacement character.
  static func decoded(_ text: Substring, plusIsSpace: Bool) -> String {
    let bytes = Array(text.utf8)
    var out: [UInt8] = []
    var at = 0
    while at < bytes.count {
      if bytes[at] == 0x25, at + 2 < bytes.count, let high = hex(bytes[at + 1]), let low = hex(bytes[at + 2]) {
        out.append(high << 4 | low)
        at += 3
        continue
      }
      out.append(plusIsSpace && bytes[at] == 0x2B ? 0x20 : bytes[at])
      at += 1
    }
    return String(decoding: out, as: UTF8.self)
  }

  // Percent-encoded as `encodeURIComponent` encodes: letters, digits and `-_.!~*'()` stand as they are, every other byte
  // of the UTF-8 is escaped in capital hex.
  static func encoded(_ text: String) -> String {
    let kept = Set("-_.!~*'()".utf8)
    let digits = Array("0123456789ABCDEF".utf8)
    var out: [UInt8] = []
    for byte in text.utf8 {
      let letterOrDigit = (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte)
      if letterOrDigit || kept.contains(byte) { out.append(byte) }
      else { out += [0x25, digits[Int(byte >> 4)], digits[Int(byte & 0x0F)]] }
    }
    return String(decoding: out, as: UTF8.self)
  }

  static func hex(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 0x30...0x39: byte - 0x30
    case 0x41...0x46: byte - 0x41 + 10
    case 0x61...0x66: byte - 0x61 + 10
    default: nil
    }
  }
}
