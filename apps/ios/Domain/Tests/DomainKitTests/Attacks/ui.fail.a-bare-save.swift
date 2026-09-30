// expect: result of call to 'save' is unused
import DomainKit
import ProbeDomain

// §16.2: a bare call that drops "not saved" does not compile where warnings are errors.
func bareCall(_ runner: ActionRunner, _ draft: inout Draft<Card>) {
  runner.save(&draft, SaveCard.self)
}
