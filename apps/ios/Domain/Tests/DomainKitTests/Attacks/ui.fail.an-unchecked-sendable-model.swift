// expect: can not be used 'inout' from a Sendable closure
import Dispatch
import DomainKit
import ProbeDomain

// INV-14: the usual answer to a mode-6 error in UI code, @unchecked Sendable, then a save off the main thread.
final class UncheckedModel: @unchecked Sendable {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() { DispatchQueue.global().async { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
