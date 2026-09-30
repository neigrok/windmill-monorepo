// expect: risks causing data races
@preconcurrency import DomainKit
import ProbeDomain

// INV-14: a @preconcurrency import does not let a copy of the draft cross to another thread.
final class PreconcurrencyCopy {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() {
    let copy = draft
    Task.detached { [runner] in
      var mine = copy
      _ = runner.save(&mine, SaveCard.self)
    }
  }
}
