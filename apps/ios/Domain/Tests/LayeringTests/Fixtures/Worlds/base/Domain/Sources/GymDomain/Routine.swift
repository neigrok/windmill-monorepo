import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct Routine: Sendable {
  public let name: String
  public let thread: CoachThread
}
