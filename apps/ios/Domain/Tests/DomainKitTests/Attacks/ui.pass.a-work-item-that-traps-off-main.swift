import Dispatch
import DomainKit
import ProbeDomain

// §10.1: a Dispatch work item the SDK leaves unannotated compiles, and traps when it runs off the main thread.
final class WorkItemModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  var pending: DispatchWorkItem? = nil
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func typed(_ title: String) {
    draft.current.title = title
    pending?.cancel()
    let item = DispatchWorkItem { _ = self.runner.save(&self.draft, SaveCard.self) }
    pending = item
    DispatchQueue.global().async(execute: item)
  }
}
