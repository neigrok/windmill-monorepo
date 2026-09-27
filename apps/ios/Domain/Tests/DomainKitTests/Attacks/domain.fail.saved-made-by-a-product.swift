// expect: 'Saved' initializer is inaccessible due to 'internal' protection level
import DomainKit

// INV-14: only SaveDraft makes a `Saved`, so no action returns one.
func claimSaved() -> Saved {
  Saved(values: [:], exists: true)
}
