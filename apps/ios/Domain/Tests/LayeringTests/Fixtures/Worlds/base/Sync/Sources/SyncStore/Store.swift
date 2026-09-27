import GRDB
import SyncAPI
import SyncCore
import SyncReplica

public final class Store: Sendable {
  public let path: String

  public init(path: String) { self.path = path }
}
