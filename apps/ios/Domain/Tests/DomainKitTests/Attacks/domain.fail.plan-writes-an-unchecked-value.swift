// expect: cannot convert value of type 'Card' to expected argument type 'Valid<E>'
import DomainKit
import ProbeDomain

// INV-5: a plan takes only a value that passed its checks.
func writeUnchecked(_ card: Card) {
  var plan = Plan()
  plan.create(card)
}
