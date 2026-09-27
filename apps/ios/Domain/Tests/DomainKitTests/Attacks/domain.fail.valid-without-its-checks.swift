// expect: incorrect argument labels in call (have 'value:checked:', expected '_:at:')
import DomainKit
import ProbeDomain

// INV-5: `Valid` has no initialiser but the two that run the checks.
func forge(_ card: Card) -> Valid<Card> {
  Valid(value: card, checked: ["title"])
}
