// expect: value of type 'SaveResult<ProbeRefusal>' has no member 'refusal'
import DomainKit
import ProbeDomain

// §16.2: a save read through "no refusal", which would take a failed save for a saved one.
func refusalNilShape(_ runner: ActionRunner, _ draft: inout Draft<Card>, close: () -> Void, show: (ProbeRefusal) -> Void) {
  switch runner.save(&draft, SaveCard.self).refusal {
  case nil: close()
  case let refusal?: show(refusal)
  }
}
