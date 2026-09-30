import Foundation
import SyncAPI
import SyncCore

public struct Outbox: Sendable {
  public var records: [Record] = []

  public init() {}
}
