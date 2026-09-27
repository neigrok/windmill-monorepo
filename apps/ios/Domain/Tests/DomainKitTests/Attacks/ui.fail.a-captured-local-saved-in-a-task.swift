// expect: risks causing data races
import DomainKit
import ProbeDomain

// INV-14: a local draft saved in a detached task while this function keeps editing it.
func typeDuringASave(runner: ActionRunner, card: Card) {
  var draft = Draft(opening: card)
  Task.detached { _ = runner.save(&draft, SaveCard.self) }
  draft.current.title = "typed during the save"
}
