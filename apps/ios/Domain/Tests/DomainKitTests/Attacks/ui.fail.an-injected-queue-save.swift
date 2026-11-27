// expect: can not be used 'inout' from a Sendable closure
import Foundation
import DomainKit
import ProbeDomain

// INV-14: a save on the Dispatch queue under an operation queue the model is handed.
final class InjectedQueueModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  let saves: OperationQueue
  init(runner: ActionRunner, draft: Draft<Card>, saves: OperationQueue) { self.runner = runner; self.draft = draft; self.saves = saves }
  func paused() { saves.underlyingQueue?.async { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
