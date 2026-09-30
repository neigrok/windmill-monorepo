import DomainKit
import ProbeDomain

// §16.2 made expressible, not impossible: the forms that drop "not saved" on purpose.
func skipForms(_ runner: ActionRunner, _ draft: inout Draft<Card>, close: () -> Void) {
  _ = runner.save(&draft, SaveCard.self)
  if case .saved = runner.save(&draft, SaveCard.self) { close() }
  switch runner.save(&draft, SaveCard.self) {
  case .saved: close()
  default: break
  }
}
