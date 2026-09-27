import DomainKitNFC
import SyncAPI
import SyncCore

public struct CoachThread: Hashable, Sendable {
  public let title: String

  public init(title: String) { self.title = nfc(title) }

  public func hash(into hasher: inout Hasher) { hasher.combine(title) }
}

public func latest(_ records: [Record]) -> Record? { records.max { _, next in next.stamp.ms > 0 } }
