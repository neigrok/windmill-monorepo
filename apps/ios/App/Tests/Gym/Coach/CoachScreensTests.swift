import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@MainActor struct CoachScreensTests {
  // Notes and the Connected log are the account's: signed out, or while an account changes, Notes asks for a sign-in and
  // the Connected log's one primary is Sign in first.
  @Test func notesAndTheConnectedLogNeedTheAccount() {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let gym = GymModel(runner: harness.runner)
    let doors = { "\(gym.coachAccountAvailable ? "notes" : "sign in") | \(ConnectedLogScreen(gym: gym).connectTitle)" }
    #expect(doors() == "sign in | Sign in first")
    gym.account = "account"
    #expect(doors() == "sign in | Sign in first")
    gym.isAnonymous = false
    #expect(doors() == "notes | Connect a tool")
    gym.accountChanging = true
    #expect(doors() == "sign in | Sign in first")
  }

  // Each typed text, the title and body it stores, and the text it reads back as: what was typed, composed and trimmed.
  @Test func aNotesOneTextStoresATitleTheDomainTakesAndReadsBackAsTyped() throws {
    let cases: [(typed: String, title: String, body: String, reads: String)] = [
    ("Prefer dumbbells at home on weekends.",
     "Prefer dumbbells at home on weekends.", "", "Prefer dumbbells at home on weekends."),
    ("Training focus\nA stronger squat.\nNo running.",
     "Training focus", "A stronger squat.\nNo running.", "Training focus\nA stronger squat.\nNo running."),
    ("My left shoulder hurts on overhead pressing, so avoid it for now",
     "My left shoulder hurts on overhead pressing, so avoid it…", "My left shoulder hurts on overhead pressing, so avoid it for now",
     "My left shoulder hurts on overhead pressing, so avoid it for now"),
    ("My left shoulder hurts on overhead pressing, so avoid it for now\nRows are fine.",
     "My left shoulder hurts on overhead pressing, so avoid it…", "My left shoulder hurts on overhead pressing, so avoid it for now\nRows are fine.",
     "My left shoulder hurts on overhead pressing, so avoid it for now\nRows are fine."),
    ("Squat twice a week, bench twice, deadlift once, rest Sunday!",
     "Squat twice a week, bench twice, deadlift once, rest Sunday!", "", "Squat twice a week, bench twice, deadlift once, rest Sunday!"),
    (String(repeating: "a", count: 70),
     String(repeating: "a", count: 59) + "…", String(repeating: "a", count: 70), String(repeating: "a", count: 70)),
    (String(repeating: "Cafe\u{301} ", count: 10) + "ok\nSecond line",
     String(repeating: "Café ", count: 10) + "ok", "Second line", String(repeating: "Café ", count: 10) + "ok\nSecond line"),
    ("\n  \nRows are fine.\n",
     "Rows are fine.", "", "Rows are fine."),
    ]
    for (typed, title, body, reads) in cases {
      var note = Note(id: ID("note"))
      note.text = typed
      #expect([note.title, note.body, note.text] == [title, body, reads])
      var stored = note
      stored.title = try NoteRules.title.apply(note.title, at: "title")
      stored.body = try NoteRules.body.apply(note.body, at: "body")
      #expect([stored.title, stored.body, stored.text] == [title, body, reads])
    }
  }
}
