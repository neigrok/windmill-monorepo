// expect: requires that 'Mark' conform to 'Removable'
import DomainKit
import ProbeDomain

// §3.1: only a type whose binding lets a client delete it is removed.
func remove(_ id: ID<Mark>) {
  var plan = Plan()
  plan.remove(id)
}
