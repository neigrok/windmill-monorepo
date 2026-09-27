// expect: can not be used 'inout' from a nonisolated context
import DomainKit
import ProbeDomain

// INV-14: the model's own draft saved from a detached task.
final class OffMainInout {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() {
    Task.detached { [runner] in _ = runner.save(&self.draft, SaveCard.self) }
  }
}
