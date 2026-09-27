import DomainKit
import ProbeDomain

// Appendix A's editor shape over the probe card: one draft, saved in place, every result handled.
final class CardEditor {
  let runner: ActionRunner
  var draft: Draft<Card>
  var shown: ProbeRefusal? = nil
  var notSaved: (any Error)? = nil
  init(runner: ActionRunner, new id: ID<Card>) {
    self.runner = runner
    draft = Draft(new: Card(id: id), placed: .bottom)
  }
  func save() {
    switch runner.save(&draft, SaveCard.self) {
    case .saved: shown = nil
    case .refused(let refusal): shown = refusal
    case .failed(let error): notSaved = error
    }
  }
  func delete() throws {
    if case .committed(_, let receipt) = try runner.run(DeleteCard(draft.id)) { _ = receipt.releaseAt }
  }
}
