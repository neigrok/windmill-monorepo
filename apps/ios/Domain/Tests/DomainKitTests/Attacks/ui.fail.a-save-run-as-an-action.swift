// expect: missing argument label 'creating:' in call
import DomainKit
import ProbeDomain

// INV-14: a draft's save run the way every other action runs, so the draft never takes the result.
final class EditorRunsItsSave {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func save() throws -> Bool {
    if case .committed = try runner.run(SaveCard(draft)) { return true }
    return false
  }
}
