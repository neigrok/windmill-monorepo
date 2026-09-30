// expect: risks causing data races
import DomainKit
import ProbeDomain

// INV-14: the pause saves a copy in a detached task.
final class DetachedAutosave {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() {
    guard draft.isDirty else { return }
    let submitted = draft
    Task.detached { [runner] in
      var copy = submitted
      _ = runner.save(&copy, SaveCard.self)
    }
  }
}
