// expect: missing argument for parameter 'in' in call
import DomainKit
import ProbeDomain

// INV-9: every read names its view; `stored` decides and `drawn` draws.
func find(_ read: Reader, _ id: ID<Card>) throws -> Card? {
  try read.repository(Card.self).find(id)
}
