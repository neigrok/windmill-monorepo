// expect: 3: import-modifier DomainKit
@preconcurrency import ActivityKit
@preconcurrency import DomainKit

// INV-14: a @preconcurrency import of the kit, which lets a copy of the draft cross to another thread with only a warning.
final class PreconcurrencyCopy {
  let runner: ActionRunner
  var draft: Draft<Card>
  func paused() {
    let copy = draft
    Task.detached { [runner] in
      var mine = copy
      _ = runner.save(&mine, SaveCard.self)
    }
  }
}
