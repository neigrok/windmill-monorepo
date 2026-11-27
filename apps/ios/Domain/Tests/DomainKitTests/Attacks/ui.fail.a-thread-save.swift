// expect: can not be used 'inout' from a Sendable closure
import Foundation
import DomainKit
import ProbeDomain

// INV-14: a model saving on a thread of its own.
final class ThreadModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() { Thread { _ = self.runner.save(&self.draft, SaveCard.self) }.start() }
  func later() { Thread.detachNewThread { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
