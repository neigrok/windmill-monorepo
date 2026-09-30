import SyncCore

// §6.11 the server's text merge: tokens, the least shortest edit script, diff3 over its hunks, and the merge of one
// text write onto the stored head. Tokens compare by their Unicode scalars, never by canonical equivalence. An edit
// script takes (base tokens + 1) × (side tokens + 1) cells; past `workCells` diff3 computes none and makes the whole text
// one conflict.

public enum TextMerge {
  public enum Edit: String, Sendable {
    case keep, delete, insert
  }

  // The outcome of steps 1–2 and the `merged` flag of step 4.
  public struct Merged: Sendable, Hashable {
    public let text: String
    public let conflict: Bool
    public let merged: Bool
    public let baseText: String

    public static func == (lhs: Merged, rhs: Merged) -> Bool {
      lhs.text.utf8.elementsEqual(rhs.text.utf8) && lhs.conflict == rhs.conflict && lhs.merged == rhs.merged
        && lhs.baseText.utf8.elementsEqual(rhs.baseText.utf8)
    }

    public func hash(into hasher: inout Hasher) {
      hasher.combine(Array(text.utf8))
      hasher.combine(merged)
    }
  }

  // ECMAScript `\s`, exactly.
  public static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }

  // Maximal runs of whitespace and of non-whitespace.
  public static func tokens(_ text: String) -> [String] {
    var tokens: [String] = []
    var run = String.UnicodeScalarView()
    var runIsWhitespace = false
    for scalar in text.unicodeScalars {
      if !run.isEmpty && isWhitespace(scalar) != runIsWhitespace {
        tokens.append(String(run))
        run = String.UnicodeScalarView()
      }
      runIsWhitespace = isWhitespace(scalar)
      run.append(scalar)
    }
    if !run.isEmpty { tokens.append(String(run)) }
    return tokens
  }

  // The lexicographically least shortest script under keep < delete < insert: keep while equal, else delete if a
  // shortest script goes on with that deletion, else insert.
  public static func script(_ a: [String], _ b: [String]) -> [(Edit, String)] {
    let (x, y) = interned(a, b)
    let n = x.count
    let m = y.count
    var distance = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
    for i in (0...n).reversed() {
      for j in (0...m).reversed() {
        if i == n || j == m {
          distance[i][j] = (n - i) + (m - j)
        } else if x[i] == y[j] {
          distance[i][j] = distance[i + 1][j + 1]
        } else {
          distance[i][j] = 1 + min(distance[i + 1][j], distance[i][j + 1])
        }
      }
    }
    var edits: [(Edit, String)] = []
    var i = 0
    var j = 0
    while i < n || j < m {
      if i < n, j < m, x[i] == y[j] {
        edits.append((.keep, a[i]))
        i += 1
        j += 1
      } else if i < n, distance[i + 1][j] + 1 == distance[i][j] {
        edits.append((.delete, a[i]))
        i += 1
      } else {
        edits.append((.insert, b[j]))
        j += 1
      }
    }
    return edits
  }

  // Tokens as integers, equal exactly when their UTF-8 bytes are.
  static func interned(_ a: [String], _ b: [String]) -> ([Int], [Int]) {
    var ids: [[UInt8]: Int] = [:]
    let intern = { (token: String) -> Int in
      let bytes = Array(token.utf8)
      if let id = ids[bytes] { return id }
      ids[bytes] = ids.count
      return ids.count - 1
    }
    return (a.map(intern), b.map(intern))
  }

  // One side's maximal run of edits: a base range and the tokens that replace it.
  struct Hunk {
    let start: Int
    let end: Int
    let inserted: [String]
    let deleted: [String]
    let isHead: Bool

    var isWhitespaceOnly: Bool {
      (inserted + deleted).allSatisfy { $0.unicodeScalars.allSatisfy(TextMerge.isWhitespace) }
    }
  }

  static func hunks(from base: [String], to side: [String], isHead: Bool) -> [Hunk] {
    var hunks: [Hunk] = []
    var index = 0
    var start: Int?
    var inserted: [String] = []
    var deleted: [String] = []
    let close = {
      if let open = start { hunks.append(Hunk(start: open, end: index, inserted: inserted, deleted: deleted, isHead: isHead)) }
      start = nil
      inserted = []
      deleted = []
    }
    for (edit, token) in script(base, side) {
      switch edit {
      case .keep:
        close()
        index += 1
      case .delete:
        if start == nil { start = index }
        deleted.append(token)
        index += 1
      case .insert:
        if start == nil { start = index }
        inserted.append(token)
      }
    }
    close()
    return hunks
  }

  public static func diff3(base: String, head: String, mine: String, workCells: Int) -> (text: String, conflict: Bool) {
    let baseTokens = tokens(base)
    let headTokens = tokens(head)
    let mineTokens = tokens(mine)
    let cells = { (side: [String]) in (baseTokens.count + 1) * (side.count + 1) }
    if cells(headTokens) > workCells || cells(mineTokens) > workCells { return (conflict(head, mine), true) }
    let all = (hunks(from: baseTokens, to: headTokens, isHead: true) + hunks(from: baseTokens, to: mineTokens, isHead: false))
      .sorted { ($0.start, $0.end, $0.isHead ? 0 : 1) < ($1.start, $1.end, $1.isHead ? 0 : 1) }
    var regions: [(start: Int, end: Int, hunks: [Hunk])] = []
    for hunk in all {
      if let last = regions.last, hunk.start <= last.end {
        regions[regions.count - 1] = (last.start, max(last.end, hunk.end), last.hunks + [hunk])
      } else {
        regions.append((hunk.start, hunk.end, [hunk]))
      }
    }
    var text = ""
    var conflict = false
    var position = 0
    for region in regions {
      text += baseTokens[position..<region.start].joined()
      let emitted = emit(region.hunks, over: region.start..<region.end, of: baseTokens)
      text += emitted.text
      conflict = conflict || emitted.conflict
      position = region.end
    }
    text += baseTokens[position...].joined()
    return (text, conflict)
  }

  // A region emits by the first rule of §6.11 that applies.
  static func emit(_ hunks: [Hunk], over range: Range<Int>, of base: [String]) -> (text: String, conflict: Bool) {
    let headHunks = hunks.filter(\.isHead)
    let mineHunks = hunks.filter { !$0.isHead }
    let head = side(headHunks, over: range, of: base)
    let mine = side(mineHunks, over: range, of: base)
    if mineHunks.isEmpty { return (head, false) }
    if headHunks.isEmpty { return (mine, false) }
    if head.utf8.elementsEqual(mine.utf8) { return (head, false) }
    let headWhitespaceOnly = headHunks.allSatisfy(\.isWhitespaceOnly)
    let mineWhitespaceOnly = mineHunks.allSatisfy(\.isWhitespaceOnly)
    if headWhitespaceOnly && mineWhitespaceOnly { return (head, false) }
    if headWhitespaceOnly { return (mine, false) }
    if mineWhitespaceOnly { return (head, false) }
    if head.isEmpty { return (mine, false) }
    if mine.isEmpty { return (head, false) }
    return (conflict(head, mine), true)
  }

  // A conflict emits both sides: head without its trailing whitespace, a blank line, and mine without its leading.
  static func conflict(_ head: String, _ mine: String) -> String {
    trimmed(head, leading: false) + "\n\n" + trimmed(mine, leading: true)
  }

  // One side's text over a region's base range, its hunks applied.
  static func side(_ hunks: [Hunk], over range: Range<Int>, of base: [String]) -> String {
    var text = ""
    var position = range.lowerBound
    for hunk in hunks {
      text += base[position..<hunk.start].joined() + hunk.inserted.joined()
      position = hunk.end
    }
    return text + base[position..<range.upperBound].joined()
  }

  static func trimmed(_ text: String, leading: Bool) -> String {
    var scalars = Array(text.unicodeScalars)
    if leading {
      scalars = Array(scalars.drop(while: isWhitespace))
    } else {
      while let last = scalars.last, isWhitespace(last) { scalars.removeLast() }
    }
    return String(String.UnicodeScalarView(scalars))
  }

  // Steps 1–2 of §6.11 and step 4's `merged`; `revision` answers a superseded head by its rev.
  public static func merge(
    head: TextState, base: TextBase, mine: String, workCells: Int, revision: (Int64) -> String?
  ) throws(Refusal) -> Merged {
    let baseText = try resolve(base, head: head, mine: mine, revision: revision)
    let (text, conflict) = merged(base: baseText, head: head.text, mine: mine, workCells: workCells)
    let isMerged = conflict || (head.merged && !baseText.utf8.elementsEqual(head.text.utf8))
    return Merged(text: text, conflict: conflict, merged: isMerged, baseText: baseText)
  }

  static func resolve(_ base: TextBase, head: TextState, mine: String, revision: (Int64) -> String?) throws(Refusal) -> String {
    switch base {
    case .rev(let rev):
      if rev == head.rev { return head.text }
      guard let text = revision(rev) else { throw Refusal(.baseUnknown) }
      return text
    case .text(let text) where text.isEmpty:
      if extends(mine, head.text) { return head.text }
      if extends(head.text, mine) { return mine }
      return text
    case .text(let text):
      return text
    }
  }

  // `x` extends `y` when `y`'s tokens are a prefix of `x`'s.
  static func extends(_ x: String, _ y: String) -> Bool {
    let (longer, prefix) = interned(tokens(x), tokens(y))
    return longer.starts(with: prefix)
  }

  static func merged(base: String, head: String, mine: String, workCells: Int) -> (String, Bool) {
    if mine.utf8.elementsEqual(head.utf8) { return (head, false) }
    if base.utf8.elementsEqual(head.utf8) { return (mine, false) }
    if base.utf8.elementsEqual(mine.utf8) { return (head, false) }
    return diff3(base: base, head: head, mine: mine, workCells: workCells)
  }
}
