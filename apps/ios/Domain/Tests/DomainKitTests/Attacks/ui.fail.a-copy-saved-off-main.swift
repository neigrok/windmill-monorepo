// expect: risks causing data races
import DomainKit
import ProbeDomain

// INV-14: a copy of the shown draft saved on another thread while the person keeps typing into the original.
final class OffMainCopy {
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
