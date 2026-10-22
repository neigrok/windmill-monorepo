import Testing
import DomainKit
import GymDomain
@testable import Windmill

struct CoachScreensTests {
  // Each typed text, the title and body it stores, and the text it reads back as.
  @Test(arguments: [
    ("Prefer dumbbells at home on weekends.",
     "Prefer dumbbells at home on weekends.", ""),
    ("Training focus\nA stronger squat.\nNo running.",
     "Training focus", "A stronger squat.\nNo running."),
    ("My left shoulder hurts on overhead pressing, so avoid it for now",
     "My left shoulder hurts on overhead pressing, so avoid it…", "My left shoulder hurts on overhead pressing, so avoid it for now"),
    ("My left shoulder hurts on overhead pressing, so avoid it for now\nRows are fine.",
     "My left shoulder hurts on overhead pressing, so avoid it…", "My left shoulder hurts on overhead pressing, so avoid it for now\nRows are fine."),
    ("Squat twice a week, bench twice, deadlift once, rest Sunday!",
     "Squat twice a week, bench twice, deadlift once, rest Sunday!", ""),
    (String(repeating: "a", count: 70),
     String(repeating: "a", count: 59) + "…", String(repeating: "a", count: 70)),
  ])
  func aNotesOneTextStoresATitleTheDomainTakesAndReadsBackAsTyped(typed: String, title: String, body: String) throws {
    var note = Note(id: ID("note"))
    note.text = typed
    #expect([note.title, note.body, note.text] == [title, body, typed])
    var stored = note
    stored.title = try NoteRules.title.apply(note.title, at: "title")
    stored.body = try NoteRules.body.apply(note.body, at: "body")
    #expect([stored.title, stored.body, stored.text] == [title, body, typed])
  }
}
