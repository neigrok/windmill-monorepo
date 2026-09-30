// expect: missing argument label 'creating:' in call
import DomainKit
import ProbeDomain
import SyncAPI
import SyncCore

// INV-14: an action with its own result built from the editor's draft, run the way actions run.
nonisolated struct SaveRemembering: Action {
  let save: SaveCard
  var scope: ScopeRef { save.scope }
  func load(_ read: Reader) throws -> SaveDraftLoaded<Card> { try save.load(read) }
  func decide(_ loaded: SaveDraftLoaded<Card>, ids: IDSource) -> Decision<Bool, ProbeRefusal> {
    switch save.decision(loaded, ids: ids) {
    case .write(let plan, _): return .write(plan, true)
    case .unchanged: return .unchanged(false)
    case .refuse(let refusal): return .refuse(refusal)
    }
  }
}

final class EditorRunsAComposer {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func save() throws -> Bool {
    if case .committed = try runner.run(SaveRemembering(save: SaveCard(draft))) { return true }
    return false
  }
}
