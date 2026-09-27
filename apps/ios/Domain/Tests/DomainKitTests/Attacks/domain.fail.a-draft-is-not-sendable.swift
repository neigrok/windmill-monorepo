// expect: type 'Draft<Card>' does not conform to the 'Sendable' protocol
import DomainKit
import ProbeDomain

// INV-14: a draft never crosses an isolation domain.
func share(_ draft: Draft<Card>) -> any Sendable {
  draft
}
