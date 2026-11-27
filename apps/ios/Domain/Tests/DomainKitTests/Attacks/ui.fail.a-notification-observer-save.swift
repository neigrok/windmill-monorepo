// expect: can not be used 'inout' from a Sendable closure
import Foundation
import DomainKit
import ProbeDomain

// INV-14: an observer with no queue, which runs on the posting thread, saving the draft.
final class ObserverModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func watch() {
    _ = NotificationCenter.default.addObserver(forName: .init("paused"), object: nil, queue: nil) { _ in
      _ = self.runner.save(&self.draft, SaveCard.self)
    }
  }
}
