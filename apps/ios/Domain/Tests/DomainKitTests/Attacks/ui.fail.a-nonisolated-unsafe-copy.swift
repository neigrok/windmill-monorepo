// expect: risks causing data races
import DomainKit
import ProbeDomain

// INV-14, mode 6 kept: the copy marked nonisolated(unsafe), then saved off the main actor while the person types.
final class OffMainUnsafe {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() {
    nonisolated(unsafe) let copy = draft
    Task.detached { [runner] in
      var mine = copy
      _ = runner.save(&mine, SaveCard.self)
    }
  }
}
