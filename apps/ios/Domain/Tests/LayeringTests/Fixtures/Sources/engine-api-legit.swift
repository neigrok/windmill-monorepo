// module: SyncCore
// expect: pass
public struct Stamp: Hashable { public let ms: Int64; public let actor: String
  public func hash(into hasher: inout Hasher) { hasher.combine(ms); hasher.combine(actor) } }
func mint(_ symbols: [Character], _ generator: inout some RandomNumberGenerator) -> Character { symbols.randomElement(using: &generator)! }
