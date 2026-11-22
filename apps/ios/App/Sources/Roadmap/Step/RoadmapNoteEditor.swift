import SwiftUI
import RoadmapDomain

// A step's note on its own screen (Roadmap · iOS 03.10), pushed over the step's page: one field over the note's draft,
// with the keyboard up as it opens. Done returns to the step, and so does Back; either way the draft is saved as the
// screen leaves. On iOS 26 a selection's Format menu sets words bold or italic, which the field shows and the note keeps
// as the web writes them; before it the field edits the note's text as it is written.
struct RoadmapNoteEditor: View {
  // The draft the screen opened on, which it goes on showing while it leaves the stack.
  final class Opened {
    var draft: StepNoteDraft?
  }

  let roadmap: RoadmapModel
  @State private var opened = Opened()
  @FocusState private var writing: Bool
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    if let draft = roadmap.note { opened.draft = draft }
    return opened.draft.map { draft in
      field(draft).focused($writing).scrollContentBackground(.hidden).foregroundStyle(RoadmapPalette.ink)
        .padding(.horizontal, 15).accessibilityLabel("Note").accessibilityIdentifier("roadmap-note-field")
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .tint(RoadmapPalette.accent)
        .navigationTitle("Note").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Done") { dismiss() }.fontWeight(.semibold).accessibilityIdentifier("roadmap-note-done")
          }
        }.roomBar(.roadmap)
        .onAppear { writing = true }
    }
  }

  @ViewBuilder func field(_ draft: StepNoteDraft) -> some View {
    if #available(iOS 26.0, *) { FormattedNote(draft: draft) }
    else { TextEditor(text: Binding(get: { draft.text }, set: { draft.text = $0 })) }
  }
}

// The note as the system's editor formats it: its words with their bold, italic and links, read from the note's text as
// the field opens and written back to it with every change. What the dialect cannot hold, the field does not keep:
// only a font and a link are taken, and words past the domain's limit are not.
@available(iOS 26.0, *)
struct FormattedNote: View {
  // What the field keeps of a format: bold and italic, which are fonts, and a link.
  nonisolated struct Marks: AttributeScope {
    let font: AttributeScopes.SwiftUIAttributes.FontAttribute
    let link: AttributeScopes.FoundationAttributes.LinkAttribute
  }

  let draft: StepNoteDraft
  @State private var words: AttributedString
  @Environment(\.fontResolutionContext) private var fonts

  init(draft: StepNoteDraft) {
    self.draft = draft
    _words = State(initialValue: NoteText.edited(draft.text))
  }

  var body: some View {
    TextEditor(text: $words).attributedTextFormattingDefinition(Marks.self)
      .onChange(of: words) { before, typed in
        guard typed != NoteText.edited(draft.text) else { return }
        let text = NoteText.text(of: typed, in: fonts)
        guard RoadmapSpecs.note.holding(text) == text else {
          words = before
          return
        }
        draft.text = text
      }
      // The draft opened again on what another device wrote.
      .onChange(of: draft.text) { _, held in
        if NoteText.text(of: words, in: fonts) != held { words = NoteText.edited(held) }
      }
  }
}

// The note's dialect as text the phone draws.
extension NoteText {
  // A note's lines, split where the web splits them.
  static func lines(of text: String) -> [String] {
    text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
  }

  // The address a link's words open in the field: one a page opens, written as the phone writes it back. The words of
  // any other link stand in the field as they are written, marks and all, so the note keeps them.
  static func opens(_ address: String) -> URL? {
    guard let held = LinkAddress(address), held.url.absoluteString == address else { return nil }
    return held.url
  }

  // A line's stretches as words on a page, or in the field, where bold and italic are the fonts the system's Format
  // menu sets.
  static func words(_ spans: [Span], inField: Bool) -> AttributedString {
    var words = AttributedString()
    for span in spans {
      let address = span.link.flatMap { inField ? opens($0) : LinkAddress($0)?.url }
      var part = AttributedString(inField && span.link != nil && address == nil ? line([Span(text: span.text, link: span.link)]) : span.text)
      part.link = address
      switch (span.emphasis, inField) {
      case (.bold, true): part.font = .body.bold()
      case (.italic, true): part.font = .body.italic()
      case (.bold, false): part.inlinePresentationIntent = .stronglyEmphasized
      case (.italic, false): part.inlinePresentationIntent = .emphasized
      case (nil, _): break
      }
      words.append(part)
    }
    return words
  }

  // A note as its page reads it (the web's `renderMarkdown`): paragraphs a blank line apart, each list item on its own
  // line under a bullet, and a link the page does not open as its words alone.
  static func read(_ text: String) -> AttributedString {
    var blocks: [[AttributedString]] = []
    var listed = false
    var open = false
    for line in lines(of: text) {
      let item = item(of: line)
      let blank = line.unicodeScalars.allSatisfy { blanks.contains($0) }
      if blank && item == nil {
        open = false
        continue
      }
      if !open || listed != (item != nil) { blocks.append([]) }
      open = true
      listed = item != nil
      blocks[blocks.count - 1].append(item.map { AttributedString("•\u{A0}") + words(spans(of: $0), inField: false) } ?? words(spans(of: line), inField: false))
    }
    var read = AttributedString()
    for (place, block) in blocks.enumerated() {
      if place > 0 { read.append(AttributedString("\n\n")) }
      for (row, line) in block.enumerated() {
        if row > 0 { read.append(AttributedString("\n")) }
        read.append(line)
      }
    }
    return read
  }

  // A note as the field opens on it: every line as it is written, its marks become the fonts and links they stand for.
  static func edited(_ text: String) -> AttributedString {
    var edited = AttributedString()
    for (place, line) in lines(of: text).enumerated() {
      if place > 0 { edited.append(AttributedString("\n")) }
      edited.append(words(spans(of: line), inField: true))
    }
    return edited
  }

  // The note's text from what the field holds: each run of one font and one link a stretch of its line, bold where its
  // font is bold, else italic where it is italic.
  @available(iOS 26.0, *)
  static func text(of words: AttributedString, in fonts: Font.Context) -> String {
    var lines: [[Span]] = [[]]
    for run in words.runs {
      let font = run.font?.resolve(in: fonts)
      let emphasis: Emphasis? = font?.isBold == true ? .bold : font?.isItalic == true ? .italic : nil
      for (place, piece) in self.lines(of: String(words[run.range].characters)).enumerated() {
        if place > 0 { lines.append([]) }
        if !piece.isEmpty { lines[lines.count - 1].append(Span(text: piece, emphasis: emphasis, link: run.link?.absoluteString)) }
      }
    }
    return lines.map { line($0) }.joined(separator: "\n")
  }
}
