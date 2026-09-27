// expect: type 'Saved' does not conform to the 'Sendable' protocol
import DomainKit
import ProbeDomain
import SyncAPI
import SyncCore

// INV-14: the draft's save wrapped in an action, then run off the main actor while the person types.
nonisolated struct AsAction<E: Draftable, R: ProductRefusal>: Action {
  let save: SaveDraft<E, R>
  var scope: ScopeRef { save.scope }
  func load(_ read: Reader) throws -> SaveDraftLoaded<E> { try save.load(read) }
  func decide(_ loaded: SaveDraftLoaded<E>, ids: IDSource) -> Decision<Saved, R> { save.decision(loaded, ids: ids) }
}
