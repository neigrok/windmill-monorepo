// expect: can not be used 'inout' from a Sendable closure
import Foundation
import DomainKit
import ProbeDomain

// INV-14: a model saving on an operation queue.
final class OperationQueueModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  let saves = OperationQueue()
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() { saves.addOperation { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
