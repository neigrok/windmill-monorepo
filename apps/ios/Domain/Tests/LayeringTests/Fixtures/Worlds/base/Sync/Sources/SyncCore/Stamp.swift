public struct Stamp: Hashable, Sendable {
  public let ms: Int64
  public let actor: String

  public func hash(into hasher: inout Hasher) {
    hasher.combine(ms)
    hasher.combine(actor)
  }
}
