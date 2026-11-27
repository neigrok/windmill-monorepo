// expect: can not be used 'inout' from a Sendable closure
@preconcurrency import Foundation
import DomainKit
import ProbeDomain

// INV-14: @preconcurrency import Foundation, then the draft and a copy of it saved on threads.
final class ImportFoundationModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() { Thread { _ = self.runner.save(&self.draft, SaveCard.self) }.start() }
  func copied() {
    let copy = draft
    Thread { var mine = copy; _ = self.runner.save(&mine, SaveCard.self) }.start()
  }
}
