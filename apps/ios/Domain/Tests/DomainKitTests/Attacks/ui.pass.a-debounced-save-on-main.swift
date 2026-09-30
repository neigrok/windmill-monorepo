import DomainKit
import ProbeDomain

// §10.1: a debounced save on the main actor compiles, and a failure can only go unshown, never strand the draft.
final class DebouncedCard {
  let runner: ActionRunner
  var draft: Draft<Card>
  var pending: Task<Void, Never>? = nil
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func typed(_ title: String) {
    draft.current.title = title
    pending?.cancel()
    pending = Task { [weak self] in
      try? await Task.sleep(for: .seconds(1))
      guard let self, !Task.isCancelled else { return }
      _ = self.runner.save(&self.draft, SaveCard.self)
    }
  }
}
