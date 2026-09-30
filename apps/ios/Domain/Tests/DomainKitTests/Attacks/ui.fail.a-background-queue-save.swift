// expect: can not be used 'inout' from a Sendable closure
import Dispatch
import DomainKit
import ProbeDomain

// INV-14: a model saving from a background queue.
final class QueueModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() { DispatchQueue.global().async { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
