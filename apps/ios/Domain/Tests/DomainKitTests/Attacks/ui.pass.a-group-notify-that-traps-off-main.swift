import Dispatch
import DomainKit
import ProbeDomain

// §10.1: a group's notify on a global queue compiles, and traps when it runs off the main thread.
final class GroupNotifyModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  let group = DispatchGroup()
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func typed(_ title: String) {
    draft.current.title = title
    group.notify(queue: .global()) { _ = self.runner.save(&self.draft, SaveCard.self) }
  }
}
