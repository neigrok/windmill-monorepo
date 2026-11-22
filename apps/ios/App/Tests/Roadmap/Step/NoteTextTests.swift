import Foundation
import SwiftUI
import Testing
@testable import Windmill

@Suite @MainActor struct NoteTextTests {
  // A line's stretches as one line of text: bold in angle brackets, italic in slashes, a link as its words and address.
  func read(_ line: String) -> String {
    NoteText.spans(of: line).map { (span: NoteText.Span) -> String in
      let words = span.link.map { "{\(span.text)→\($0)}" } ?? span.text
      return span.emphasis == .bold ? "<\(words)>" : span.emphasis == .italic ? "/\(words)/" : words
    }.joined(separator: "|")
  }

  // The web's `renderInline`: the first mark from the left wins, a link before bold before italic where two start
  // together; bold and italic words hold no asterisk, so neither nests in the other, and a link stands inside either.
  @Test func aLineIsReadIntoItsBoldItalicAndLinkedStretchesAsTheWebReadsIt() {
    #expect(read("Gusts show as **dark patches** on the water.") == "Gusts show as |<dark patches>| on the water.")
    #expect(read("*look* upwind, then **go**") == "/look/| upwind, then |<go>")
    #expect(read("See [the guide](https://rya.org.uk/telltales) first") == "See |{the guide→https://rya.org.uk/telltales}| first")
    #expect(read("**read [this](https://a.b/c) now**") == "<read >|<{this→https://a.b/c}>|< now>")
    #expect(read("*a***b**") == "/a/|<b>")
    #expect(read("**a***b*") == "<a>|/b/")
    #expect(read("***a***") == "*|<a>|*")
    #expect(read("2 * 3 * 4") == "2 |/ 3 /| 4")
    #expect(read("**a*") == "*|/a/")
    #expect(read("a ** b") == "a ** b")
    #expect(read("[**t**](https://a.b)") == "{**t**→https://a.b}")
    #expect(read("[a[b](https://a.b)") == "{a[b→https://a.b}")
    #expect(read("[] (x) [a] (b) [a](b c) [a]()") == "[] (x) [a] (b) [a](b c) [a]()")
    #expect(read("[x](javascript:alert(1))") == "{x→javascript:alert(1}|)")
    #expect(read("no marks at all") == "no marks at all")
    #expect(read("") == "")
    #expect(read(String(repeating: "[", count: 4_000) + String(repeating: "*", count: 4_001)) ==
            String(repeating: "[", count: 4_000) + String(repeating: "*", count: 4_001))
  }

  // The web's list pattern: blanks, a dash, at least one blank, then the item to the end of the line.
  @Test func aLineThatStartsWithADashAndABlankIsAListItem() {
    let items = ["- reef early", "  -   reef early", "-reef early", "- ", "-", "reef - early", "-\treef", "- reef\r", "\u{A0}- reef"].map {
      NoteText.item(of: $0) ?? "nil"
    }
    #expect(items == ["reef early", "reef early", "nil", "", "nil", "nil", "reef", "nil", "reef"])
  }

  // A line is written back from its stretches with the web's marks, so a note opened and saved untouched is the same
  // text, and one read again says the same.
  @Test func aLineIsWrittenBackWithItsMarksAndReadsTheSameAgain() {
    let lines = ["Gusts show as **dark patches** on the water.", "*look* upwind, then **go**", "See [the guide](https://rya.org.uk/telltales) first",
                 "**read [this](https://a.b/c) now**", "*a***b**", "**a***b*", "***a***", "2 * 3 * 4", "**a*", "a ** b", "[**t**](https://a.b)",
                 "- a list item with *words*", "[] (x) [a] (b) [a](b c) [a]()", "[x](javascript:alert(1))", "", "  spaced  "]
    #expect(lines.map { NoteText.line(NoteText.spans(of: $0)) } == lines)
    // Two bold runs side by side are one run, which reads the same.
    #expect(NoteText.line(NoteText.spans(of: "**a****b**")) == "**ab**")
    #expect(read("**ab**") == "<ab>")

    // What the dialect cannot mark is written plain: bold or italic words that hold an asterisk, and a link whose words
    // or address would end it early.
    let span = { (text: String, emphasis: NoteText.Emphasis?, link: String?) -> NoteText.Span in NoteText.Span(text: text, emphasis: emphasis, link: link) }
    #expect(NoteText.line([span("5 * 4", .bold, nil), span(" is ", nil, nil), span("twenty", .italic, nil)]) == "5 * 4 is *twenty*")
    #expect(NoteText.line([span("a]b", nil, "https://a.b"), span(" ", nil, nil), span("c", nil, "https://a.b/(d)"), span("e", nil, "https://a.b/f g")]) == "a]b ce")
    #expect(NoteText.line([span("bold ", .bold, nil), span("link", .bold, "https://a.b"), span(" italic", .italic, nil)]) == "**bold [link](https://a.b)*** italic*")
    #expect(read("**bold [link](https://a.b)*** italic*") == "<bold >|<{link→https://a.b}>|/ italic/")
  }

  // The page reads a note as the web's page does: paragraphs a blank line apart, list items under bullets, bold and
  // italic as such, and a link the page opens as a link; one it does not open is its words alone.
  @Test func thePageReadsANoteInParagraphsAndBullets() {
    let note = "Gusts show as **dark patches** on the water.\nLook *upwind*.\n\n\n- reef early\n-  see [the guide](https://rya.org.uk/telltales)\nThen [go](javascript:1)."
    let read = NoteText.read(note)
    #expect(String(read.characters) == "Gusts show as dark patches on the water.\nLook upwind.\n\n•\u{A0}reef early\n•\u{A0}see the guide\n\nThen go.")
    let marked = read.runs.compactMap { (run: AttributedString.Runs.Run) -> String? in
      let words = String(read[run.range].characters)
      if run.inlinePresentationIntent == .stronglyEmphasized { return "bold \(words)" }
      if run.inlinePresentationIntent == .emphasized { return "italic \(words)" }
      return run.link.map { "link \(words) \($0.absoluteString)" }
    }
    #expect(marked == ["bold dark patches", "italic upwind", "link the guide https://rya.org.uk/telltales"])
    #expect(String(NoteText.read("").characters) == "" && String(NoteText.read("one line").characters) == "one line")
  }

  // The note's field shows bold and italic as the fonts the system's Format menu sets, and a link the phone opens as a
  // link; what it holds is written back as the note's text, the same where nothing was touched. Words made bold in the
  // field are written between the web's marks.
  @Test func theFieldOpensOnANotesFormatsAndWritesThemBackAsItsText() throws {
    guard #available(iOS 26.0, *) else { return }
    let fonts = EnvironmentValues().fontResolutionContext
    let notes = ["Gusts show as **dark patches** on the water.\n\nAsk which way the *harbour flag* points.", "- reef early\n- see [the guide](https://rya.org.uk/telltales)",
                 "Then [go](javascript:1) or [here](https://a.b/ü).\r\nA second line", "", "\n\nends open\n", "**bold [link](https://a.b) inside**"]
    #expect(notes.map { NoteText.text(of: NoteText.edited($0), in: fonts) } == notes)

    let field = NoteText.edited(notes[0])
    #expect(String(field.characters) == "Gusts show as dark patches on the water.\n\nAsk which way the harbour flag points.")
    // A link the phone would write back otherwise stands as it is written.
    #expect(String(NoteText.edited(notes[2]).characters) == "Then [go](javascript:1) or [here](https://a.b/ü).\r\nA second line")
    #expect(String(NoteText.edited(notes[1]).characters) == "- reef early\n- see the guide")

    var words = AttributedString("Look upwind before leaving")
    let upwind = try #require(words.range(of: "upwind"))
    words[upwind].font = .body.bold()
    let leaving = try #require(words.range(of: "before leaving"))
    words[leaving].font = .body.italic()
    #expect(NoteText.text(of: words, in: fonts) == "Look **upwind** *before leaving*")
    // Bold and italic at once is written bold, and a format across a line break is written on each line.
    var both = AttributedString("reef\nearly")
    both.font = .body.bold().italic()
    #expect(NoteText.text(of: both, in: fonts) == "**reef**\n**early**")
  }
}
