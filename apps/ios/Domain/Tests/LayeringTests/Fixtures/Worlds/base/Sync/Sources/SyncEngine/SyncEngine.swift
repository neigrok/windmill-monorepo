import Foundation
import Observation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore

public final class SyncEngine: Sendable {
  public let store: Store

  public init(store: Store) { self.store = store }
}
