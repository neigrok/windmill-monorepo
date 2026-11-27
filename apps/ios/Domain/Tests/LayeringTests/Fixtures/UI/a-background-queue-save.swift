// expect: 9: dispatch-queue DispatchQueue.global
import Dispatch
import DomainKit

// INV-14: a model saving from a background queue, which Swift 6.4 only warns about.
final class QueueModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  func paused() { DispatchQueue.global().async { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
