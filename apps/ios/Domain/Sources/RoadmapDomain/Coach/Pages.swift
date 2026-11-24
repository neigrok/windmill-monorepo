import SyncCore

// Roadmap Coach §5.2: a read's answer in pages of at most 16,384 bytes of canonical text, an object too long for one sent
// in parts, and the cursor that carries a reader from one page to the next.

// A read's answer as pages. `lists` are the lists every page carries, each with the entries that fall on it; an entry
// under any other key is get_tree's header, under `tree`. `read` is what the pages stand on, which each cursor's digest
// holds (rule 4), and `first` what the first page alone carries. Each object is made the first time a page reads it.
final class ReadPages {
  // An object of the sequence, from 0, and the part of it, from 1.
  struct Position {
    let index: Int
    let part: Int
  }

  // An object of the sequence: the key it falls under on a page, and how the read answers it.
  struct Entry {
    let under: String
    let make: () -> JSON.Object
  }

  // An object, or a part of one, as a page carries it, with its canonical bytes.
  struct Placed {
    let under: String
    let value: JSON.Object
    let bytes: Int

    init(under: String, value: JSON.Object) {
      self.under = under
      self.value = value
      bytes = JSON.object(value).jcs.count
    }
  }

  // The catalog's `result.maxBytes` of every read.
  static let maxBytes = 16384
  // The fields whose text or list can pass a page, filled in key order (rule 3).
  static let long = ["description", "frontier", "guide", "links", "prerequisites", "subtasks"]
  // The cuts an object's parts may take for the number they name to hold: past them the pager is at fault, not the object.
  static let recuts = 8

  let lists: [String]
  let entries: [Entry]
  let read: JSON
  let first: JSON.Object
  // What each object came to once a page read it: whole, in parts, and the digest of each position inside it.
  var placedAt: [Int: Placed] = [:]
  var partsAt: [Int: [JSON.Object]] = [:]
  var digestAt: [Int: String] = [:]

  init(lists: [String], entries: [Entry], read: JSON, first: JSON.Object = [:]) {
    self.lists = lists
    self.entries = entries
    self.read = read
    self.first = first
  }

  // The page a call reads: the first, or the one `cursor` names, checked in rule 5's order; else the refusal of the call,
  // naming the roadmap it reads.
  func answer(at cursor: String?, naming id: String?) throws(CoachRefusal) -> AbilityResponse {
    guard let cursor else { return .result(.object(page(from: Position(index: 0, part: 1)))) }
    guard let form = cursor.wholeMatch(of: /(0|[1-9][0-9]{0,8})\.([1-9][0-9]{0,8})\.([0-9a-f]{16})/), let index = Int(form.1),
          let part = Int(form.2) else { throw CoachRefusal(.invalidInput, id) }
    let position = Position(index: index, part: part)
    guard form.3.utf8.elementsEqual(digest(position).utf8) else { throw CoachRefusal(.roadmapChanged, id) }
    guard index < entries.count, part <= parts(index).count else { throw CoachRefusal(.invalidInput, id) }
    return .result(.object(page(from: position)))
  }

  // Rule 4: the first 16 hexadecimal digits of the SHA-256 of what the pages stand on, with the object the position is
  // inside where it starts past that object's first part. Every part of one object shares its digest.
  func digest(_ position: Position) -> String {
    let inside = position.part > 1 && position.index < entries.count ? position.index : -1
    if let known = digestAt[inside] { return known }
    let stands: JSON = ["read": read, "continues": inside < 0 ? .null : .object(placed(inside).value)]
    let digest = String(SHA256Hex.of(stands.jcs).prefix(16))
    digestAt[inside] = digest
    return digest
  }

  // The page that starts at `start`. A part before its object's last takes the page alone (rule 2); otherwise whole objects
  // follow while the page stays within the cap (rule 1), and one that would not fit a page alone ends the page before it
  // or, first on its page, is sent in parts.
  func page(from start: Position) -> JSON.Object {
    var taken: [Placed] = []
    var index = start.index
    if start.part > 1 {
      let parts = parts(index)
      let piece = Placed(under: entries[index].under, value: parts[start.part - 1])
      if start.part < parts.count { return page(taking: [piece], from: start, next: Position(index: index, part: start.part + 1)) }
      taken.append(piece)
      index += 1
    }
    while index < entries.count {
      let entry = placed(index)
      if bytes([entry], from: Position(index: index, part: 1), next: after(index)) > Self.maxBytes {
        if !taken.isEmpty { return page(taking: taken, from: start, next: Position(index: index, part: 1)) }
        return page(taking: [Placed(under: entry.under, value: parts(index)[0])], from: start, next: Position(index: index, part: 2))
      }
      if bytes(taken + [entry], from: start, next: after(index)) > Self.maxBytes {
        return page(taking: taken, from: start, next: Position(index: index, part: 1))
      }
      taken.append(entry)
      index += 1
    }
    return page(taking: taken, from: start, next: nil)
  }

  // Rules 2 and 3: the parts of the object at `index`, or the object alone where it fits a page. Every part names their
  // number, which changes how much each carries, so they are cut again until the number they name is the number they
  // come to.
  func parts(_ index: Int) -> [JSON.Object] {
    if let known = partsAt[index] { return known }
    var parts = [placed(index).value]
    if bytes([placed(index)], from: Position(index: index, part: 1), next: after(index)) > Self.maxBytes {
      var count = 2
      for cuts in 0... {
        precondition(cuts < Self.recuts, "the parts of sequence object \(index) do not settle")
        parts = cut(index, into: count)
        if parts.count == count { break }
        count = parts.count
      }
    }
    partsAt[index] = parts
    return parts
  }

  // The object at `index` cut into parts that each name `count`. Each part but the last fills its page as far as whole
  // Unicode scalars of text and whole elements of a list allow, its long fields in key order; part 1 carries every field of
  // the object, a long one empty where none of it fits, and a later part its `id` and the rest of each long field that goes
  // on there. A part is measured as its frame, each long field empty, and the bytes of the pieces it carries, so cutting it
  // costs what it holds.
  func cut(_ index: Int, into count: Int) -> [JSON.Object] {
    let value = placed(index).value
    let under = entries[index].under
    let fields = Self.long.compactMap { LongField($0, value[$0]) }
    // How many pieces of each field the parts before have carried.
    var sent = [Int](repeating: 0, count: fields.count)
    var parts: [JSON.Object] = []
    for part in 1... {
      let start = Position(index: index, part: part)
      var base: JSON.Object = part == 1 ? value : value["id"].map { (id: JSON) -> JSON.Object in ["id": id] } ?? [:]
      if part == 1 { for field in fields { base[field.key] = nil } }
      base["part"] = JSON(part)
      base["parts"] = JSON(count)
      let frame = { (carrying: [Int], next: Position?) -> Int in
        var framed = base
        for field in carrying { framed[fields[field].key] = fields[field].empty }
        return self.bytes([Placed(under: under, value: framed)], from: start, next: next)
      }
      let going = fields.indices.filter { part == 1 || sent[$0] < fields[$0].length }
      let rest = going.reduce(0) { $0 + fields[$1].bytes(from: sent[$1], to: fields[$1].length) }
      if frame(going, after(index)) + rest <= Self.maxBytes {
        var last = base
        for field in going { last[fields[field].key] = fields[field].piece(from: sent[field], to: fields[field].length) }
        return parts + [last]
      }
      var carried: [(field: Int, from: Int, to: Int)] = []
      var used = 0
      for field in fields.indices where sent[field] < fields[field].length {
        let from = sent[field]
        let room = Self.maxBytes - used - frame(part == 1 ? Array(fields.indices) : carried.map { $0.field } + [field], Position(index: index, part: part + 1))
        let to = fields[field].fit(from: from, room: room)
        if to > from {
          carried.append((field, from, to))
          used += fields[field].bytes(from: from, to: to)
          sent[field] = to
        }
        if to < fields[field].length { break }
      }
      precondition(!carried.isEmpty, "sequence object \(index) has a part that carries nothing")
      var made = base
      if part == 1 { for field in fields { made[field.key] = field.empty } }
      for run in carried { made[fields[run.field].key] = fields[run.field].piece(from: run.from, to: run.to) }
      parts.append(made)
    }
    preconditionFailure("a cut ends at its last part")
  }

  func placed(_ index: Int) -> Placed {
    if let known = placedAt[index] { return known }
    let made = Placed(under: entries[index].under, value: entries[index].make())
    placedAt[index] = made
    return made
  }

  // Where the sequence goes on after the object at `index` taken whole, or none where it ends there.
  func after(_ index: Int) -> Position? {
    index + 1 < entries.count ? Position(index: index + 1, part: 1) : nil
  }

  // The page as it is sent: every list of the read with the entries that fall on it, the header under `tree`, the cursor of
  // `next`, and on the first page what it alone carries.
  func page(taking taken: [Placed], from start: Position, next: Position?) -> JSON.Object {
    var page = frame(taken, from: start)
    for list in lists { page[list] = .array(taken.filter { $0.under == list }.map { .object($0.value) }) }
    if let next { page["nextCursor"] = .string("\(next.index).\(next.part).\(digest(next))") }
    return page
  }

  // The canonical bytes of the page: its frame, with every list empty and a cursor as long as `next`'s, and each list
  // entry's own bytes, since a list's text is its entries' texts joined by commas between its brackets.
  func bytes(_ taken: [Placed], from start: Position, next: Position?) -> Int {
    var frame = self.frame(taken, from: start)
    for list in lists { frame[list] = .array([]) }
    if let next { frame["nextCursor"] = .string("\(next.index).\(next.part).\(String(repeating: "0", count: 16))") }
    var bytes = JSON.object(frame).jcs.count
    for list in lists {
      let values = taken.filter { $0.under == list }
      bytes += values.reduce(max(0, values.count - 1)) { $0 + $1.bytes }
    }
    return bytes
  }

  // What a page carries beside its lists: the header, and on the first page what it alone carries.
  func frame(_ taken: [Placed], from start: Position) -> JSON.Object {
    var frame = start.index == 0 && start.part == 1 ? first : [:]
    for entry in taken where !lists.contains(entry.under) { frame[entry.under] = .object(entry.value) }
    return frame
  }
}

// A long field of an object cut into parts: its pieces, whole Unicode scalars of a text or whole elements of a list, and
// the canonical bytes of every run of them, which a text's quotes and a list's brackets and commas frame.
struct LongField {
  enum Pieces {
    case text([Unicode.Scalar])
    case list([JSON])
  }

  let key: String
  let pieces: Pieces
  // The bytes of the first n pieces, by n: a scalar's own, its quotes left out, or an element's.
  let sums: [Int]

  // None for a field that is neither a text nor a list.
  init?(_ key: String, _ value: JSON?) {
    let bytes: [Int]
    switch value {
    case .string(let text)?:
      pieces = .text(Array(text.unicodeScalars))
      bytes = text.unicodeScalars.map { JSON.string(String($0)).jcs.count - 2 }
    case .array(let items)?:
      pieces = .list(items)
      bytes = items.map(\.jcs.count)
    default: return nil
    }
    self.key = key
    var sums = [0]
    for size in bytes { sums.append(sums[sums.count - 1] + size) }
    self.sums = sums
  }

  var length: Int { sums.count - 1 }

  var empty: JSON {
    guard case .list = pieces else { return .string("") }
    return .array([])
  }

  // The bytes the pieces `from` to `to` add to the field held empty: their own, and a comma between two elements.
  func bytes(from: Int, to: Int) -> Int {
    guard to > from else { return 0 }
    guard case .list = pieces else { return sums[to] - sums[from] }
    return sums[to] - sums[from] + to - from - 1
  }

  // How far from `from` the pieces go within `room` bytes: the end of the longest run that fits.
  func fit(from: Int, room: Int) -> Int {
    var (to, high) = (from, length)
    while to < high {
      let middle = (to + high + 1) / 2
      if bytes(from: from, to: middle) <= room { to = middle } else { high = middle - 1 }
    }
    return to
  }

  func piece(from: Int, to: Int) -> JSON {
    switch pieces {
    case .text(let scalars):
      var run = String.UnicodeScalarView()
      run.append(contentsOf: scalars[from..<to])
      return .string(String(run))
    case .list(let items): return .array(Array(items[from..<to]))
    }
  }
}
