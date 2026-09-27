// expect: switch must be exhaustive
import DomainKit
import ProbeDomain

// §16.2: a switch over the save that leaves out `.failed`.
func saveWithoutFailed(_ runner: ActionRunner, _ draft: inout Draft<Card>) -> Bool {
  switch runner.save(&draft, SaveCard.self) {
  case .saved: return true
  case .refused: return false
  }
}
