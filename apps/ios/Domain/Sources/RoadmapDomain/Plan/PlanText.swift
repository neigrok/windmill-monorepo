// The text rules every part of the plan grammar reads and writes by (packages/api-contract/roadmap/plan/README.md, Text):
// a text is its Unicode scalars, compared one by one and never normalized, so no rule here leans on Swift's characters,
// its canonical equality or its idea of a newline.
enum PlanText {
  // The domain's bounds, in its unit: characters, each a Unicode scalar value.
  static let titleBound = 200
  static let labelBound = 200
  static let kindLabelBound = 24
  static let descriptionBound = 16_000
  static let linkBound = 2_048
  static let linksBound = 32
  static let idBound = 40

  // The domain kit's whitespace (§4.3).
  static let whitespace: Set<UInt32> = [
    0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
    0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
  ]
  // The two separators no line of a text holds, though no line ends at them.
  static let separators: Set<UInt32> = [0x2028, 0x2029]
  // The characters a file writes as entities and a read takes back: `&`, `<`, `>`, `-`, `[` and the whitespace.
  static let entities: Set<UInt32> = whitespace.union([0x26, 0x3C, 0x3E, 0x2D, 0x5B])
  static let hues = ["terracotta", "olive", "gold", "brick", "sky", "plum"]

  static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool { whitespace.contains(scalar.value) }

  static func trimmed(_ text: [Unicode.Scalar]) -> [Unicode.Scalar] {
    guard let first = text.firstIndex(where: { !isWhitespace($0) }), let last = text.lastIndex(where: { !isWhitespace($0) }) else { return [] }
    return Array(text[first...last])
  }

  static func trimmed(_ text: String) -> String { string(trimmed(Array(text.unicodeScalars))) }

  static func string(_ scalars: some Sequence<Unicode.Scalar>) -> String {
    var text = String.UnicodeScalarView()
    text.append(contentsOf: scalars)
    return String(text)
  }

  // At most `bound` characters.
  static func clipped(_ text: String, to bound: Int) -> String {
    text.unicodeScalars.count <= bound ? text : string(text.unicodeScalars.prefix(bound))
  }

  static func count(_ text: String) -> Int { text.unicodeScalars.count }

  // Two texts are equal when their scalars are, one by one.
  static func key(_ text: String) -> [UInt8] { Array(text.utf8) }

  // A text cut at each CRLF, CR or LF: a CRLF is one cut, and nothing else ends a line.
  static func lines(of text: String) -> [[Unicode.Scalar]] {
    var lines: [[Unicode.Scalar]] = [[]]
    var previousCR = false
    for scalar in text.unicodeScalars {
      if scalar == "\n" && previousCR {
        previousCR = false
        continue
      }
      previousCR = scalar == "\r"
      if scalar == "\r" || scalar == "\n" { lines.append([]) } else { lines[lines.count - 1].append(scalar) }
    }
    return lines
  }

  // ECMAScript's `toLowerCase`: each scalar's full lowercase mapping, with no locale, and a capital sigma that ends a word
  // the final sigma (Unicode's Final_Sigma).
  static func lowercased(_ text: String) -> String {
    let scalars = Array(text.unicodeScalars)
    var lowered = String.UnicodeScalarView()
    for (index, scalar) in scalars.enumerated() {
      guard scalar.value == 0x3A3 else {
        lowered.append(contentsOf: scalar.properties.lowercaseMapping.unicodeScalars)
        continue
      }
      let before = scalars[..<index].reversed().first { !$0.properties.isCaseIgnorable }
      let after = scalars[(index + 1)...].first { !$0.properties.isCaseIgnorable }
      let final = (before?.properties.isCased ?? false) && !(after?.properties.isCased ?? false)
      lowered.append(final ? "\u{3C2}" : "\u{3C3}")
    }
    return String(lowered)
  }

  // A label's id form: lowercased, each run of characters other than a to z and 0 to 9 one `-`, a `-` at either end
  // dropped, clipped at 40, and a `-` at its end dropped again.
  static func idForm(_ label: String) -> String {
    var form: [Unicode.Scalar] = []
    for scalar in lowercased(label).unicodeScalars {
      let kept = ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
      if kept { form.append(scalar) } else if form.last != "-" { form.append("-") }
    }
    let inner = form.drop { $0 == "-" }.reversed().drop { $0 == "-" }.reversed()
    return string(Array(inner.prefix(idBound)).reversed().drop { $0 == "-" }.reversed())
  }

  // The entities of a text read back, left to right: `&#`, a decimal with no leading zero naming one of `entities`, `;`.
  static func readingEntities(_ text: String) -> String {
    let scalars = Array(text.unicodeScalars)
    var read = String.UnicodeScalarView()
    var at = 0
    while at < scalars.count {
      if scalars[at] == "&", at + 2 < scalars.count, scalars[at + 1] == "#",
         let end = scalars[(at + 2)...].firstIndex(where: { !("0"..."9").contains($0) }), end > at + 2, scalars[end] == ";",
         scalars[at + 2] != "0", end - at - 2 <= 6,
         let code = UInt32(string(scalars[(at + 2)..<end])), entities.contains(code), let entity = Unicode.Scalar(code) {
        read.append(entity)
        at = end + 1
        continue
      }
      read.append(scalars[at])
      at += 1
    }
    return String(read)
  }

  static func entity(_ scalar: Unicode.Scalar) -> String { "&#\(scalar.value);" }
}
