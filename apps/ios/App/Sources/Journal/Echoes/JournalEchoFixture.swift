import Foundation
import SwiftUI
import DomainKit
import JournalDomain
import SyncSchema

enum JournalEchoFixture {
  static var appearance: ColorScheme? {
    #if DEBUG && targetEnvironment(simulator)
    switch ProcessInfo.processInfo.environment["WM_IOS_ECHO_APPEARANCE"] {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
    #else
    return nil
    #endif
  }
  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("journal-echoes") else { return false }
    guard let runtime = model.runtime, let server = runtime.auth.fake else { return true }
    do {
      try await model.signIn(server.identity(email: "echo-fixture@example.com"))
      guard model.account != nil, !model.editorReadOnly else { throw JournalEchoFailure.unavailable }
      model.preferences.set(true, forKey: "inkShown")
      model.openJournal()
      model.keepDismissed = true
      let today = model.journal.today
      let first = today.adding(days: -120), second = today.adding(days: -240)
      let unicode = board.contains("unicode"), decomposedEdit = board.contains("decomposed")
      let unicodeQuote = "I remembered the café by the river."
      let spoken = unicode ? (decomposedEdit ? unicodeQuote : unicodeQuote.decomposedStringWithCanonicalMapping)
        : "The long walk home helped me notice the evening."
      let copied = "Pay attention to the walk, not the destination."
      let longSource = (1...14).map { step in
        "I took a different street on the way home, passing the small gardens and the corner shop. I remembered one ordinary detail from the day: the quiet pause at stop \(step)."
      }.joined(separator: "\n\n") + "\n\n\(spoken)\n\nI made tea when I got back. The kitchen window was still open, and the room had cooled down.\n\nI put my shoes by the door and left the rest of the evening unplanned."
      let empty = board.contains("empty")
      if !empty {
        for offset in Array(1...18) + [120, 240] {
          let zone = FixedZone(offsetSeconds: DeviceZone().offsetSeconds(at: Instant(ms: BoardClock().nowMs())) - offset * 86_400)
          let runner = ActionRunner(replica: runtime.engine, registry: SyncSchema.registry, zone: zone)
          let body = offset == 120 ? longSource
            : offset == 240 ? "I copied this into today's page:\n\(copied)"
            : "A quiet evening, a short walk, and a page before bed."
          let document = PageDocument(body: body, source: offset == 120 ? "spoken" : "typed")
          let result = try runner.run(SavePage(day: today.adding(days: -offset), document: document, retiring: ["placeholder", "scales"]))
          guard result.refusal == nil else { throw JournalEchoFailure.unavailable }
        }
        model.refresh()
        model.journal.type("The rain cleared before my walk. I took the long way home and left my phone in my pocket.")
        guard model.journal.save() else { throw JournalEchoFailure.unavailable }
        model.journal.done()
        model.journal.dismissScales()
      }
      let response = JournalEchoResponse(pages: empty ? [] : [JournalEchoPage(day: today.text, matches: [
        JournalEchoMatch(day: first.text, text: spoken, isSelf: true, source: "spoken", useful: false, occurrenceHint: 0),
        JournalEchoMatch(day: second.text, text: copied, isSelf: false, source: "typed", useful: false, occurrenceHint: 0),
      ])], pagesWritten: empty ? 0 : 21, floorWaived: false)
      let service = JournalEchoFixtureService(response: response, offline: board.contains("offline"))
      if unicode {
        service.onUseful = { [weak model] day in
          let zone = FixedZone(offsetSeconds: DeviceZone().offsetSeconds(at: Instant(ms: BoardClock().nowMs())) - 120 * 86_400)
          let runner = ActionRunner(replica: runtime.engine, registry: SyncSchema.registry, zone: zone)
          let body = day == first.text
            ? (decomposedEdit ? longSource.decomposedStringWithCanonicalMapping : longSource.precomposedStringWithCanonicalMapping)
            : longSource.replacingOccurrences(of: spoken, with: "The river path is closed.")
          let result = try runner.run(SavePage(day: first, document: PageDocument(body: body, source: "spoken")))
          guard result.refusal == nil else { throw JournalEchoFailure.unavailable }
          model?.refresh()
        }
      }
      model.journal.echoes = JournalEchoes(service: service,
        preferences: model.preferences, telemetry: model.telemetry)
      model.refresh()
    } catch {
      model.journal.error = "Couldn't prepare the echo fixture."
    }
    return true
    #else
    return false
    #endif
  }
}

#if DEBUG && targetEnvironment(simulator)
@MainActor final class JournalEchoFixtureService: JournalEchoServing {
  var response: JournalEchoResponse
  let offline: Bool
  var onUseful: ((String?) throws -> Void)?

  init(response: JournalEchoResponse, offline: Bool) {
    self.response = response; self.offline = offline
  }

  func list(through day: String) async throws -> JournalEchoResponse {
    if offline { throw URLError(.notConnectedToInternet) }
    return response
  }

  func signal(_ signal: JournalEchoSignal, triggerDay: String, matchDay: String?) async throws {
    if offline { throw URLError(.notConnectedToInternet) }
    guard signal != .opened else { return }
    if signal == .useful { try onUseful?(matchDay) }
    response.pages = response.pages.compactMap { page in
      guard page.day == triggerDay else { return page }
      if signal == .dismiss && matchDay == nil { return nil }
      var updated = page
      updated.matches = page.matches.compactMap { match in
        guard match.day == matchDay else { return match }
        if signal == .dismiss { return nil }
        var useful = match; useful.useful = true; return useful
      }
      return updated.matches.isEmpty ? nil : updated
    }
  }
}
#endif
