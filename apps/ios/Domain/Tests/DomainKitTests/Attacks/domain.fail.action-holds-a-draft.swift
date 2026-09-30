// expect: stored property 'draft' of 'Sendable'-conforming struct 'SaveStamped' has non-Sendable type 'Draft<Card>'
import DomainKit
import ProbeDomain
import SyncAPI
import SyncCore

// INV-14: an action holding the editor's draft, to stamp it and save it as one gesture; an action is Sendable and a
// draft is not.
struct SaveStamped: Action {
  let draft: Draft<Card>
  var scope: ScopeRef { Card.scope }
  func load(_ read: Reader) throws -> Moment { read.moment }
  func decide(_ moment: Moment, ids: IDSource) throws(Violation) -> Decision<Bool, ProbeRefusal> { .unchanged(false) }
}
