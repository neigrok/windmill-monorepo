// expect: capture of 'copy' with non-Sendable type 'Draft<Card>'
import Foundation
import DomainKit
import ProbeDomain

// INV-14's copy case: a copy of the shown draft saved on a thread while the person keeps typing into the original.
final class ThreadCopyModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() {
    let copy = draft
    let runner = runner
    Thread { var mine = copy; _ = runner.save(&mine, SaveCard.self) }.start()
  }
}
