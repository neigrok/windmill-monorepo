// expect: can not be used 'inout' from a Sendable closure
import Foundation
import DomainKit
import ProbeDomain

// INV-14: the app's own @preconcurrency function runs the save on a thread.
@preconcurrency nonisolated func inBackground(_ body: @escaping @Sendable () -> Void) { Thread(block: body).start() }

final class OwnDeclarationModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func paused() { inBackground { _ = self.runner.save(&self.draft, SaveCard.self) } }
}
