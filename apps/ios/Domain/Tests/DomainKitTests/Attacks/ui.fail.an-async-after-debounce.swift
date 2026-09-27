// expect: can not be used 'inout' from a Sendable closure
import Dispatch
import DomainKit
import ProbeDomain

// INV-14: the pre-concurrency debounce: save a second after the last keystroke, off the main thread.
final class AsyncAfterModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func typed(_ title: String) {
    draft.current.title = title
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { _ = self.runner.save(&self.draft, SaveCard.self) }
  }
}
