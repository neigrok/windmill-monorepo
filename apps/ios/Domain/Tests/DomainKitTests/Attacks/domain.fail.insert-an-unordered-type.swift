// expect: requires that 'Mark' conform to 'Ordered'
import DomainKit
import ProbeDomain

// §8.1: only an ordered type is inserted at an anchor.
func place(_ mark: Valid<Mark>) {
  var plan = Plan()
  plan.insert(mark, below: nil)
}
