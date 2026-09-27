import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct Page: Sendable {
  public let day: String
  public let thread: CoachThread
}
