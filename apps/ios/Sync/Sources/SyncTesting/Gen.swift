import Foundation
import SyncAPI
import SyncCore

// Seeded generators for property tests and simulation gestures: SYNC_SEED fixes the seed, and every failure message
// names it.

public struct SeededRandom: RandomNumberGenerator, Sendable {
  public let seed: UInt64
  var state: (UInt64, UInt64, UInt64, UInt64)

  public init(seed: UInt64) {
    self.seed = seed
    var mix = seed
    func splitMix() -> UInt64 {
      mix &+= 0x9E37_79B9_7F4A_7C15
      var z = mix
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
    state = (splitMix(), splitMix(), splitMix(), splitMix())
  }

  public static func fromEnvironment() -> SeededRandom {
    let chosen = ProcessInfo.processInfo.environment["SYNC_SEED"].flatMap { UInt64($0) }
    return SeededRandom(seed: chosen ?? UInt64.random(in: 0...UInt64.max))
  }

  // xoshiro256**
  public mutating func next() -> UInt64 {
    let result = ((state.1 &* 5) << 7 | (state.1 &* 5) >> 57) &* 9
    let shifted = state.1 << 17
    state.2 ^= state.0
    state.3 ^= state.1
    state.1 ^= state.2
    state.0 ^= state.3
    state.2 ^= shifted
    state.3 = state.3 << 45 | state.3 >> 19
    return result
  }

  public mutating func pick<Element>(_ options: [Element]) -> Element {
    options[Int.random(in: options.indices, using: &self)]
  }

  public mutating func chance(_ probability: Double) -> Bool {
    Double.random(in: 0..<1, using: &self) < probability
  }

  // A whole number in `0..<bound`.
  public mutating func below(_ bound: Int) -> Int {
    Int.random(in: 0..<bound, using: &self)
  }

  // A small pool, so equal stamps, equal pairs with different actors and the unset stamp all recur.
  public mutating func stamp() -> Stamp {
    if chance(0.05) { return .unset }
    return try! Stamp("\(Int.random(in: 1...3, using: &self)):\(Int.random(in: 0...2, using: &self)):\(pick(["a", "b", "r_x"]))")
  }

  // Strings that trip Swift: canonical equivalents, the Kelvin sign, astral characters, controls and escapes.
  public mutating func text() -> String {
    pick(["", "a", "b", "é", "e\u{301}", "K", "\u{212A}", "\u{FB33}", "😀", "\u{7F}", "\u{2028}", "\"", "\\", "\u{0}", "\t",
          "ab", "a b", "10", "9"])
  }

  public mutating func number() -> Double {
    pick([0, -0.0, 1, -1, 9, 10, 0.1, 1e21, 1e-7, .leastNonzeroMagnitude, .greatestFiniteMagnitude, 9_007_199_254_740_991,
          333_333_333.33333325, Double.random(in: -1e6...1e6, using: &self)])
  }

  public mutating func json(depth: Int = 3) -> JSON {
    let leaf = depth == 0 || chance(0.5)
    switch Int.random(in: leaf ? 0...3 : 0...5, using: &self) {
    case 0: return .null
    case 1: return .bool(chance(0.5))
    case 2: return .number(JSON.Number(number())!)
    case 3: return .string(text())
    case 4: return .array((0..<Int.random(in: 0...3, using: &self)).map { _ in json(depth: depth - 1) })
    default:
      var object = JSON.Object()
      for _ in 0..<Int.random(in: 0...3, using: &self) { object[text()] = json(depth: depth - 1) }
      return .object(object)
    }
  }
}

// MARK: - Simulation gestures

// What a person sees of the probe product on one device before a gesture (corpus README "The probe product"): the
// visible records of its views, the held gestures that only remove one record, which a later gesture may retire, the
// trees of its boards, read when a gesture goes into one, and the trees still open on a screen though the phone knows
// them gone or not found.
struct ProbeView {
  // One board's tree and overlay: its visible tags, tags seen before that are dead now, and each tag's memo.
  struct Tree {
    var tags: [Record] = []
    var deadTags: [RecordID] = []
    var memos: [RecordID: String] = [:]
  }

  var now: Int64
  var bound: Bool
  var cards: [Record]
  var storedCards: [Record]
  var runs: [Record]
  var boards: [Record]
  var facts: [Record]
  var heldRemovals: [RecordKey]
  var deadTrees: [RecordID]
}

// One gesture a person makes: its scope, what it commits, the tree and overlay scopes the product holds open for it,
// and a label for the log and the coverage tally.
struct PlannedGesture {
  let scope: ScopeRef
  let gesture: Gesture
  let opens: [ScopeRef]
  let label: String

  init(_ label: String, in scope: ScopeRef, opens: [ScopeRef] = [], _ gesture: Gesture) {
    self.label = label
    self.scope = scope
    self.gesture = gesture
    self.opens = opens
  }
}

extension SeededRandom {
  static let words = ["oak", "ash", "elm", "fir", "yew", "bay", "box", "ivy"]
  static let tiers = ["draft", "review", "done", "dropped"]

  mutating func word() -> JSON { .string(pick(Self.words)) }

  // An id of `length` symbols of the alphabet a type's mint draws from, after `prefix`.
  mutating func id(_ prefix: String, _ length: Int, from alphabet: String) -> RecordID {
    let symbols = Array(alphabet)
    return RecordID(prefix + String((0..<length).map { _ in symbols[below(symbols.count)] }))
  }

  mutating func boardID() -> RecordID { id("b_", 8, from: "0123456789abcdef") }
  mutating func recordID() -> RecordID { id("", 16, from: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") }

  // A gesture over every kind the probe registry has (design §9.3): creates anchored in order, edits with exact guards
  // and retire, reorders, held deletes, keyed puts, whole saves, atomic gestures across types, commands with their
  // predictions, text edits, device rows, and gestures in a board's tree and overlay. `tree` reads a board's tree when
  // one is needed. Nil when the draw finds nothing to act on.
  mutating func probeGesture(on view: ProbeView, tree: (RecordID) -> ProbeView.Tree) -> PlannedGesture? {
    let product = ScopeRef.product("probe")
    let ordered = (view.cards + view.storedCards).filter { $0.values["ord"] != nil }.map(\.id)
    let retirable = { (type: String) in view.heldRemovals.filter { $0.type == type }.map(\.id) }
    if !retirable("fact").isEmpty && chance(0.25) {
      let day = pick(retirable("fact"))
      let value = JSON.number(JSON.Number(Double(below(5_000)) / 10.3)!)
      return PlannedGesture("fact save retiring its delete", in: product, Gesture(
        changes: [.put("fact", day, present: true, ["value": value, "at": JSON(view.now)])], retire: [RecordRef(type: "fact", id: day)]))
    }
    switch below(19) {
    case 0:
      let below = !ordered.isEmpty && chance(0.8) ? pick(ordered) : nil
      let id: NewID = chance(0.5) ? .given(recordID()) : .minted
      return PlannedGesture("card create", in: product, Gesture(changes: [
        .create("card", id: id, ["title": word(), "tier": "draft"], anchor: OrderAnchor(field: "ord", below: below)),
      ]))
    case 1 where !view.cards.isEmpty:
      let retiring = retirable("card").filter { id in view.storedCards.contains { $0.id == id } }
      let id = !retiring.isEmpty && chance(0.7) ? pick(retiring) : pick(view.cards).id
      var values: [String: JSON] = [:]
      if chance(0.5) { values["title"] = word() }
      if chance(0.4) { values["size"] = .number(JSON.Number(Double(below(20_000) - 10_000) / 997)!) }
      if chance(0.4) { values["tier"] = .string(pick(Self.tiers)) }
      if chance(0.3) { values["claim"] = word() }
      if values.isEmpty { values["body"] = .string("note \(below(1_000))") }
      var gesture = Gesture(changes: [.update("card", id, values)])
      if chance(0.3) {
        let fields = values.keys.filter { $0 != "body" }.sorted() + (chance(0.3) ? ["tier"] : [])
        gesture.guards = Array(Set(fields)).sorted().map { RegisterRef(type: "card", id: id, field: $0) }
      }
      if retiring.contains(id) { gesture.retire = [RecordRef(type: "card", id: id)] }
      if chance(0.2) { gesture.local = [DeviceWrite(key: "rack", value: ["last": id.json])] }
      return PlannedGesture(gesture.retire.isEmpty ? "card update" : "card update retiring its delete", in: product, gesture)
    case 2 where ordered.count > 1:
      let movable = view.cards.filter { $0.values["ord"] != nil }.map(\.id)
      guard !movable.isEmpty else { return nil }
      let moved = pick(movable)
      let anchors = ordered.filter { $0 != moved }
      let below = chance(0.3) || anchors.isEmpty ? nil : pick(anchors)
      return PlannedGesture("card move", in: product, Gesture(changes: [.move("card", moved, to: OrderAnchor(field: "ord", below: below))]))
    case 3 where !view.cards.isEmpty:
      return PlannedGesture("card delete held", in: product, Gesture(changes: [.delete("card", pick(view.cards).id)], hold: true))
    case 4:
      let id = recordID()
      let label = word()
      return PlannedGesture("probe.start", in: product, Gesture(
        changes: [],
        command: Command(name: "probe.start", args: ["id": id.json, "label": label, "startedAt": JSON(view.now), "join": true]),
        predict: [.create("run", id: .given(id), ["startedAt": JSON(view.now), "label": label])]))
    case 5 where !view.runs.isEmpty:
      let run = pick(view.runs)
      let endedAt = max((try? run.values["startedAt"]?.asInteger()) ?? 0, view.now)
      return PlannedGesture("probe.end", in: product, Gesture(
        changes: [], command: Command(name: "probe.end", args: ["runId": run.id.json, "endedAt": JSON(endedAt)]),
        predict: [.update("run", run.id, ["endedAt": JSON(endedAt)])]))
    case 6 where !view.runs.isEmpty:
      let run = pick(view.runs)
      let id: NewID = chance(0.3) ? .seeded(seed: run.id.string ?? "", ordinal: below(99_999)) : .minted
      return PlannedGesture("lap create", in: product, Gesture(changes: [
        .create("lap", id: id, ["runId": run.id.json, "weight": .number(JSON.Number(Double(below(4_000) - 2_000) / 7)!)]),
      ]))
    case 7 where !view.runs.isEmpty:
      let run = pick(view.runs)
      if chance(0.5) { return PlannedGesture("run update", in: product, Gesture(changes: [.update("run", run.id, ["label": word()])])) }
      return PlannedGesture("run delete held", in: product, Gesture(changes: [.delete("run", run.id)], hold: true))
    case 8:
      if !view.boards.isEmpty && chance(0.3) {
        return PlannedGesture("board delete held", in: product, Gesture(changes: [.delete("board", pick(view.boards).id)], hold: true))
      }
      return PlannedGesture("board create", in: product, Gesture(changes: [.create("board", id: .given(boardID()))], atomic: true))
    case 12 where !view.runs.isEmpty:
      let run = pick(view.runs)
      return PlannedGesture("atomic card and lap", in: product, Gesture(changes: [
        .create("card", ["title": word(), "tier": "draft"]),
        .create("lap", ["runId": run.id.json, "weight": JSON(below(100))]),
      ], atomic: true))
    case 14:
      let retiring = retirable("day")
      let day = !retiring.isEmpty && chance(0.6) ? pick(retiring) : RecordID("2026-09-0\(1 + below(5))")
      let present = chance(0.75)
      let values: [String: JSON] = chance(0.7) ? ["score": JSON(below(11))] : [:]
      var gesture = Gesture(changes: [.put("day", day, present: present, values)], hold: !present && chance(0.6))
      if present, retiring.contains(day), chance(0.8) { gesture.retire = [RecordRef(type: "day", id: day)] }
      return PlannedGesture(gesture.retire.isEmpty ? "day put" : "day put retiring its removal", in: product, gesture)
    case 15 where !view.boards.isEmpty:
      let dst = boardID()
      return PlannedGesture("probe.copy", in: product, Gesture(
        changes: [], command: Command(name: "probe.copy", args: ["src": pick(view.boards).id.json, "dst": dst.json]),
        predict: [.create("board", id: .given(dst))]))
    case 16:
      return PlannedGesture("device row", in: product, Gesture(changes: [], local: [DeviceWrite(key: "rack", value: chance(0.8) ? word() : nil)]))
    case 18:
      let retiring = retirable("fact")
      if !view.facts.isEmpty && retiring.isEmpty && chance(0.3) {
        return PlannedGesture("fact delete", in: product, Gesture(changes: [.delete("fact", pick(view.facts).id)], hold: chance(0.8)))
      }
      let day = !retiring.isEmpty && chance(0.7) ? pick(retiring) : RecordID("2026-09-0\(1 + below(5))")
      let value = JSON.number(JSON.Number(Double(below(5_000)) / 10.3)!)
      var gesture = Gesture(changes: [.put("fact", day, present: true, ["value": value, "at": JSON(view.now)])])
      if retiring.contains(day), chance(0.8) { gesture.retire = [RecordRef(type: "fact", id: day)] }
      return PlannedGesture(gesture.retire.isEmpty ? "fact save" : "fact save retiring its delete", in: product, gesture)
    case 9, 10, 11, 13, 17:
      if !view.deadTrees.isEmpty && chance(0.15) {
        let board = pick(view.deadTrees)
        return treeGesture(in: board, tree(board), bound: view.bound)
      }
      guard !view.boards.isEmpty else { return nil }
      let board = pick(view.boards).id
      return treeGesture(in: board, tree(board), bound: view.bound)
    default:
      return nil
    }
  }

  // A gesture in the tree board `board` governs, or in the person's overlay of it.
  mutating func treeGesture(in board: RecordID, _ view: ProbeView.Tree, bound: Bool) -> PlannedGesture? {
    guard let tree = board.string else { return nil }
    let scope = ScopeRef.tree(tree)
    let overlay = ScopeRef.overlay(tree)
    let opens = bound ? [scope, overlay] : [scope]
    let tags = view.tags.map(\.id)
    if !view.deadTags.isEmpty && chance(0.25) {
      return PlannedGesture("tag revive", in: scope, opens: opens, Gesture(changes: [.revive("tag", pick(view.deadTags))]))
    }
    switch below(6) {
    case 0 where !view.deadTags.isEmpty && chance(0.5):
      return PlannedGesture("tag revive", in: scope, opens: opens, Gesture(changes: [.revive("tag", pick(view.deadTags))]))
    case 0 where !tags.isEmpty:
      return PlannedGesture("tag delete held", in: scope, opens: opens, Gesture(changes: [.delete("tag", pick(tags))], hold: true))
    case 1 where !tags.isEmpty:
      return PlannedGesture("tag update", in: scope, opens: opens, Gesture(changes: [.update("tag", pick(tags), ["label": word()])]))
    case 2 where tags.count >= 2:
      let values: [String: JSON] = chance(0.5) ? ["strength": JSON(below(10))] : [:]
      let link = RecordID(tuple: [pick(tags), pick(tags)].compactMap(\.string))
      return PlannedGesture("link put", in: scope, opens: opens, Gesture(changes: [.put("link", link, present: chance(0.7), values)]))
    case 3 where !tags.isEmpty:
      let tag = id("", 12, from: "0123456789abcdefghijklmnopqrstuvwxyz")
      guard let new = tag.string, let other = pick(tags).string else { return nil }
      return PlannedGesture("atomic tag and link", in: scope, opens: opens, Gesture(changes: [
        .create("tag", id: .given(tag), ["label": word()]),
        .put("link", .pair(new, other), present: true, ["strength": JSON(below(10))]),
      ], atomic: true))
    case 4 where !tags.isEmpty && bound:
      let tag = pick(tags)
      var words = (view.memos[tag] ?? "").split(separator: " ").map(String.init)
      if !words.isEmpty && chance(0.4) {
        words[below(words.count)] = pick(Self.words)
      } else {
        words.append(pick(Self.words))
      }
      let memo = String(words.joined(separator: " ").suffix(38))
      let values: [String: JSON] = chance(0.5) ? ["done": .bool(chance(0.5))] : [:]
      return PlannedGesture("mark memo edit", in: overlay, opens: opens, Gesture(changes: [
        .write("mark", tag, values, texts: ["memo": TextEdit(text: memo)]),
      ]))
    case 5:
      return PlannedGesture("meta title", in: scope, opens: opens, Gesture(changes: [.write("meta", "meta", ["title": word()])]))
    default:
      let label = "\(pick(Self.words)) \(pick(Self.words))"
      return PlannedGesture("tag create", in: scope, opens: opens, Gesture(changes: [.create("tag", id: .derived(label: label), ["label": word()])]))
    }
  }

  // Property 3's gestures (§11.2): each changes one record, with no guard, no command and no hold.
  mutating func plainGesture(on view: ProbeView, tree: (RecordID) -> ProbeView.Tree) -> PlannedGesture? {
    let product = ScopeRef.product("probe")
    switch below(7) {
    case 0 where view.storedCards.count < 3:
      return PlannedGesture("card create", in: product, Gesture(changes: [
        .create("card", ["title": word(), "size": .number(JSON.Number(Double(below(10_000)) / 777)!)]),
      ]))
    case 1 where !view.cards.isEmpty:
      return PlannedGesture("card update", in: product, Gesture(changes: [
        .update("card", pick(view.cards).id, ["title": word(), "tier": .string(pick(Self.tiers)), "claim": word()]),
      ]))
    case 2 where !view.cards.isEmpty:
      return PlannedGesture("card delete", in: product, Gesture(changes: [.delete("card", pick(view.cards).id)]))
    case 3 where view.boards.isEmpty:
      return PlannedGesture("board create", in: product, Gesture(changes: [.create("board", id: .given(boardID()))]))
    default:
      guard !view.boards.isEmpty else { return nil }
      let board = pick(view.boards).id
      guard let id = board.string else { return nil }
      let (scope, overlay) = (ScopeRef.tree(id), ScopeRef.overlay(id))
      let tree = tree(board)
      let tags = tree.tags.map(\.id)
      switch below(5) {
      case 0 where tags.count > 1:
        let link = RecordID(tuple: [pick(tags), pick(tags)].compactMap(\.string))
        return PlannedGesture("link put", in: scope, opens: [scope, overlay], Gesture(changes: [.put("link", link, present: chance(0.7))]))
      case 1 where !tags.isEmpty:
        let tag = pick(tags)
        let memo = String("\(tree.memos[tag] ?? "") \(pick(Self.words))".trimmingCharacters(in: .whitespaces).suffix(36))
        return PlannedGesture("mark memo edit", in: overlay, opens: [scope, overlay], Gesture(changes: [
          .write("mark", tag, texts: ["memo": TextEdit(text: memo)]),
        ]))
      case 2 where tags.count > 1:
        return PlannedGesture("tag delete", in: scope, opens: [scope, overlay], Gesture(changes: [.delete("tag", pick(tags))]))
      case 3:
        return PlannedGesture("meta title", in: scope, opens: [scope, overlay], Gesture(changes: [.write("meta", "meta", ["title": word()])]))
      default:
        let label = "\(pick(Self.words)) \(below(1_000))"
        return PlannedGesture("tag create", in: scope, opens: [scope, overlay], Gesture(changes: [
          .create("tag", id: .derived(label: label), ["label": word()]),
        ]))
      }
    }
  }
}
