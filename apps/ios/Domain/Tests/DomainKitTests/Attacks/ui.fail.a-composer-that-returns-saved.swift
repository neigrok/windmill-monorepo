// expect: type 'Saved' does not conform to the 'Sendable' protocol
import DomainKit
import ProbeDomain
import SyncAPI
import SyncCore

// INV-14: a composing action whose result is the draft save's `Saved`, run outside `runner.save`.
nonisolated struct RelaySave: Action {
  let save: SaveCard
  var scope: ScopeRef { save.scope }
  func load(_ read: Reader) throws -> SaveDraftLoaded<Card> { try save.load(read) }
  func decide(_ loaded: SaveDraftLoaded<Card>, ids: IDSource) throws(Violation) -> Decision<Saved, ProbeRefusal> {
    try save.decide(loaded, ids: ids)
  }
}
