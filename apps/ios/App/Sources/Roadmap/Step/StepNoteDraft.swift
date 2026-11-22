import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncCore

// The note's draft (Roadmap · iOS 03.10): the kit's one draft of a step's note, opened as the note's screen is pushed
// on what the person's overlay draws, or new where the step has no note, and saved once as the screen leaves, through
// the room's write door. What a note may hold is the domain's; the draft keeps no more of a text than the domain takes.
// The web's room keeps no Undo of a note's save (`ReplicaWorkspace.setNote`), and neither does the band.
@Observable @MainActor
final class StepNoteDraft {
  unowned let room: RoadmapModel
  let step: ID<RoadmapStep>
  private var draft: Draft<StepNote>

  init(of step: ID<RoadmapStep>, in tree: ID<RoadmapEntry>, room: RoadmapModel) {
    self.room = room
    self.step = step
    draft = room.shown?.workspaces[step]?.note.map { Draft(opening: $0, in: tree.overlay) }
      ?? Draft(new: StepNote(id: ID(step.record)), in: tree.overlay)
  }

  var text: String {
    get { draft.current.text }
    set { draft.current.text = RoadmapSpecs.note.holding(newValue) }
  }

  // The phone's copy read the note anew. A draft that holds nothing unsaved opens on it again, so its screen shows what
  // another device wrote; one that does keeps the person's words, which its save merges with theirs.
  func follow() {
    guard !draft.isDirty, let drawn = room.shown?.workspaces[step]?.note, drawn.text != draft.base.text else { return }
    draft = Draft(opening: drawn, in: draft.scope)
  }

  // The draft's one save: nothing where its words stand as they were opened. A save the domain refuses or a commit that
  // fails is the door's to tell.
  func save() {
    guard draft.isDirty, let written = room.write(&draft, as: "note").committed else { return }
    room.forget(written.receipt.gestureId)
    room.telemetry.event("roadmap_board_workspace", properties: ["action": "noteSave"])
  }
}

// A note's text in the dialect the web's page writes and reads (`renderMarkdown`, `formatNote`): a line that starts
// with a dash is a list item, and within a line stand **bold**, *italic* and [a link](its address). Nothing escapes a
// mark, a mark never spans lines, and bold or italic words hold no asterisk. A line is read a code point at a time, as
// the web's patterns read it.
enum NoteText {
  enum Emphasis {
    case bold, italic
  }

  // A stretch of one line: its words, how they are set, and the address they link to as it is written.
  struct Span: Equatable {
    var text: String
    var emphasis: Emphasis?
    var link: String?
  }

  // What the web's patterns take for a blank, and for the end of a line.
  static let blanks: Set<Unicode.Scalar> = {
    let named: [Unicode.Scalar] = ["\t", "\n", "\u{B}", "\u{C}", "\r", " ", "\u{A0}", "\u{1680}", "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}",
                                   "\u{3000}", "\u{FEFF}"]
    let spaces: [Unicode.Scalar] = (0x2000...0x200A).compactMap { (value: UInt32) -> Unicode.Scalar? in Unicode.Scalar(value) }
    return Set(named + spaces)
  }()
  static let lineEnds: Set<Unicode.Scalar> = ["\n", "\r", "\u{2028}", "\u{2029}"]

  // The words of a list item, where the line is one: blanks, a dash, at least one blank, then the item to the line's end.
  static func item(of line: String) -> String? {
    let scalars = Array(line.unicodeScalars)
    let dash = scalars.firstIndex { !blanks.contains($0) } ?? scalars.count
    guard dash < scalars.count, scalars[dash] == "-" else { return nil }
    let words = scalars[(dash + 1)...].firstIndex { !blanks.contains($0) } ?? scalars.count
    guard words > dash + 1, !scalars[words...].contains(where: { lineEnds.contains($0) }) else { return nil }
    return String(String.UnicodeScalarView(scalars[words...]))
  }

  // One line as its stretches (the web's `renderInline`): the first mark from the left is taken, a link before bold
  // before italic where two start together, and the words inside bold or italic are read again for links.
  static func spans(of line: String, emphasis: Emphasis? = nil) -> [Span] {
    let scalars = Array(line.unicodeScalars)
    let text = { (range: Range<Int>) -> String in String(String.UnicodeScalarView(scalars[range])) }
    var spans: [Span] = []
    var rest = 0
    var at = 0
    // No link closes past here, so no bracket before it opens one.
    var linksFrom = 0
    while at < scalars.count {
      var taken: (spans: [Span], end: Int)?
      if scalars[at] == "[", at >= linksFrom {
        let close = scalars[(at + 1)...].firstIndex(of: "]") ?? scalars.count
        let address = close + 2
        let end = address < scalars.count ? scalars[address...].firstIndex { $0 == ")" || blanks.contains($0) } ?? scalars.count : scalars.count
        if close > at + 1, close + 1 < scalars.count, scalars[close + 1] == "(", end > address, end < scalars.count, scalars[end] == ")" {
          taken = ([Span(text: text((at + 1)..<close), emphasis: emphasis, link: text(address..<end))], end + 1)
        } else {
          linksFrom = close == scalars.count ? scalars.count : close
        }
      } else if scalars[at] == "*" {
        let double = at + 1 < scalars.count && scalars[at + 1] == "*"
        let bold = double ? scalars[(at + 2)...].firstIndex(of: "*") ?? scalars.count : scalars.count
        let italic = scalars[(at + 1)...].firstIndex(of: "*") ?? scalars.count
        if double, bold > at + 2, bold + 1 < scalars.count, scalars[bold + 1] == "*" {
          taken = (Self.spans(of: text((at + 2)..<bold), emphasis: .bold), bold + 2)
        } else if italic > at + 1, italic < scalars.count {
          taken = (Self.spans(of: text((at + 1)..<italic), emphasis: .italic), italic + 1)
        }
      }
      guard let taken else {
        at += 1
        continue
      }
      if at > rest { spans.append(Span(text: text(rest..<at), emphasis: emphasis)) }
      spans += taken.spans
      rest = taken.end
      at = taken.end
    }
    if rest < scalars.count { spans.append(Span(text: text(rest..<scalars.count), emphasis: emphasis)) }
    return spans
  }

  // A link the dialect can write: words with no closing bracket, and an address with no blank and no closing parenthesis.
  static func writes(link address: String, on words: String) -> Bool {
    !words.isEmpty && !words.unicodeScalars.contains("]") && !address.isEmpty
      && !address.unicodeScalars.contains { $0 == ")" || blanks.contains($0) }
  }

  // A line's text from its stretches, the marks written back around each run of bold or of italic. Words the dialect
  // cannot mark are written plain: bold or italic words that hold an asterisk, and a link it cannot write.
  static func line(_ spans: [Span]) -> String {
    var line = ""
    var at = 0
    while at < spans.count {
      let emphasis = spans[at].emphasis
      let end = spans[at...].firstIndex { $0.emphasis != emphasis } ?? spans.count
      let words = spans[at..<end].map { (span: Span) -> String in
        guard let address = span.link, writes(link: address, on: span.text) else { return span.text }
        return "[\(span.text)](\(address))"
      }.joined()
      let mark = emphasis == .bold ? "**" : emphasis == .italic ? "*" : ""
      line += words.isEmpty || words.unicodeScalars.contains("*") ? words : mark + words + mark
      at = end
    }
    return line
  }
}
