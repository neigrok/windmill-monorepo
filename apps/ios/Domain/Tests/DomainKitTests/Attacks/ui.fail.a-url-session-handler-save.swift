// expect: can not be used 'inout' from a Sendable closure
import Foundation
import DomainKit
import ProbeDomain

// INV-14: a session's completion handler, on the session's queue, editing and saving the draft.
final class SessionModel {
  let runner: ActionRunner
  var draft: Draft<Card>
  init(runner: ActionRunner, draft: Draft<Card>) { self.runner = runner; self.draft = draft }
  func fetched(_ url: URL) {
    URLSession.shared.dataTask(with: url) { data, _, _ in
      self.draft.current.title = String(decoding: data ?? Data(), as: UTF8.self)
      _ = self.runner.save(&self.draft, SaveCard.self)
    }.resume()
  }
}
