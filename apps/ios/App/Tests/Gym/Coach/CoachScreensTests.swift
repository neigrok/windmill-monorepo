import Testing
import DomainKit
import GymDomain
@testable import Windmill

struct CoachScreensTests {
  // Each typed text, the title and body it stores, and the text it reads back as: what was typed, composed and trimmed.
  @Test(arguments: [
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
  ])
  func aNotesOneTextStoresATitleTheDomainTakesAndReadsBackAsTyped(typed: String, title: String, body: String, reads: String) throws {
    var note = Note(id: ID("note"))
    note.text = typed
    #expect([note.title, note.body, note.text] == [title, body, reads])
    var stored = note
    stored.title = try NoteRules.title.apply(note.title, at: "title")
    stored.body = try NoteRules.body.apply(note.body, at: "body")
    #expect([stored.title, stored.body, stored.text] == [title, body, reads])
  }
}
