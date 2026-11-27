// expect: can not be used 'inout' from a Sendable closure
import Dispatch
import DomainKit
import ProbeDomain

// INV-14: a model saving on a serial Dispatch queue of its own.
final class SerialQueueModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  let saves = DispatchSerialQueue(label: "saves")
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() { saves.async { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
