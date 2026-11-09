import Foundation

// The locale copy writes its numbers and picks its plural forms in: English, the one language, with digits as Swift
// writes them under any region, 1000 and never 1,000 or 1 000. A message that interpolates an Int resolves in it.
extension Locale {
  nonisolated static let copy = Locale(identifier: "en_US_POSIX")
}
