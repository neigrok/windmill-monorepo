// expect: cannot convert value of type 'ID<Mark>' to expected argument type 'ID<Card>'
import DomainKit
import ProbeDomain

// D-5: an id only an entity of its type carries.
func mix(_ read: Reader, _ id: ID<Mark>) throws -> Card? {
  try read.repository(Card.self).find(id, in: .drawn)
}
