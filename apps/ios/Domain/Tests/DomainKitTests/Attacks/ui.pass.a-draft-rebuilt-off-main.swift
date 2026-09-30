import DomainKit
import ProbeDomain

// §10.1 the copy case, expressible: a draft is not Sendable, but its entities are; one rebuilt in a task is a copy.
final class OffMainRebuilt {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() {
    let (base, current) = (draft.base, draft.current)
    Task.detached { [runner] in
      var copy = Draft(opening: base)
      copy.current = current
      if case .failed = runner.save(&copy, SaveCard.self) { return }
    }
  }
}
