import Foundation

// English, with digits as Swift writes them under any region, 1000 never 1,000: a String(localized:) counting an Int resolves in it.
extension Locale {
  nonisolated static let copy = Locale(identifier: "en_US_POSIX")
}
