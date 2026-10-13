import Foundation

// The one place a count's noun agrees with its number (docs/design/ios/ios-redesign.md §3).
nonisolated enum GymCount {
  static func of(_ count: Int, _ singular: String, plural: String? = nil) -> String {
    "\(count) \(count == 1 ? singular : plural ?? singular + "s")"
  }
}
