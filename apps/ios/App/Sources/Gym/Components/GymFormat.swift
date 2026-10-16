import SwiftUI
import DomainKit

// The one place a count's noun agrees with its number (docs/design/ios/ios-redesign.md §3).
nonisolated enum GymCount {
  static func of(_ count: Int, _ singular: String, plural: String? = nil) -> String {
    "\(count) \(count == 1 ? singular : plural ?? singular + "s")"
  }
}

// The log's instants meet Foundation's dates here, for formatting and for date pickers, to the millisecond.
extension Instant {
  nonisolated init(_ date: Date) { self.init(ms: Int64((date.timeIntervalSince1970 * 1_000).rounded())) }
  nonisolated var date: Date { Date(timeIntervalSince1970: Double(ms) / 1_000) }
}

extension Binding where Value == Instant {
  var date: Binding<Date> { Binding<Date>(get: { wrappedValue.date }, set: { wrappedValue = Instant($0) }) }
}
