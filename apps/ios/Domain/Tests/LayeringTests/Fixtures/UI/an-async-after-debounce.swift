// expect: 11: dispatch-queue DispatchQueue.global
import Dispatch
import DomainKit

// INV-14: the pre-concurrency debounce: save a second after the last keystroke, off the main thread.
final class AsyncAfterModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  func typed(_ title: String) {
    draft.current.title = title
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { _ = self.runner.save(&self.draft, SaveCard.self) }
  }
}
