import Foundation

// A status the settings screen can show: whether a push is in flight, and the last error.
// Combine's ObservableObject and @Published, with only Foundation imported.
public final class SyncStatus: ObservableObject {
  @Published public private(set) var pushing = false
  @Published public private(set) var lastError: String?
  public init() {}
}
