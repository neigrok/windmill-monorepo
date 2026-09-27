import DomainKit
import ProbeDomain
import SyncAPI
import SyncCore

// §9.3: what stays open to product code: an executor's own new record through SaveDraft(creating:), its own result.
struct CreateCard: Action {
  let save: SaveCard
  var scope: ScopeRef { save.scope }
  func load(_ read: Reader) throws -> SaveDraftLoaded<Card> { try save.load(read) }
  func decide(_ loaded: SaveDraftLoaded<Card>, ids: IDSource) throws(Violation) -> Decision<Bool, ProbeRefusal> {
    switch try save.decide(loaded, ids: ids) {
    case .write(let plan, _): return .write(plan, true)
    case .unchanged: return .unchanged(false)
    case .refuse(let refusal): return .refuse(refusal)
    }
  }
}

func createCard(_ runner: ActionRunner, _ card: Card) throws -> Bool {
  if case .committed = try runner.run(CreateCard(save: SaveCard(creating: card, placed: .bottom))) { return true }
  return false
}
