// expect: 10: dispatch-queue DispatchQueue.global
// expect: 11: dispatch-queue DispatchQueue
import Dispatch
import DomainKit

// INV-14: @unchecked Sendable, then a save off the main thread, on a global queue and on a queue of its own.
final class UncheckedModel: @unchecked Sendable {
  let runner: ActionRunner
  var draft: Draft<Card>
  func paused() { DispatchQueue.global().async { _ = self.runner.save(&self.draft, SaveCard.self) } }
  let queue = DispatchQueue(label: "saves")
}
