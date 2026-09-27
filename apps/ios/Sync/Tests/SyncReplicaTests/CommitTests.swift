import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// Properties of §7.1–§7.3 over random gestures on the probe: coalescing never changes what is drawn (§11.2 property 2),
// Undo leaves the store as the commit found it, and a commit over the rows its read set names decides exactly as one
// over every row.

struct CommitTests {
  static let probe = try! Corpus.probeRegistry()
  static let product = ScopeRef.product("probe")
  static let overlay = ScopeRef.overlay("b_00000001")

  // A bound replica holding three cards, a day, and a board whose overlay holds a mark.
  static func replica() throws -> LoadedReplica {
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let card = { (id: String, seq: Int64) in
      Row(key: RecordKey("card", RecordID(id)), lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: [
        "title": Register(.string(id), stamp), "tier": Register("draft", stamp),
      ]), seq: seq, rc: seq, ru: seq)
    }
    let rows = [card("card0001", 1), card("card0002", 2), card("card0003", 3),
                Row(key: RecordKey("day", "2026-09-01"), lattice: Lattice(life: Life(.alive, stamp), fields: ["score": Register(1, stamp)]), seq: 4, rc: 4, ru: 4),
                Row(key: RecordKey("board", "b_00000001"), lattice: Lattice(life: Life(.alive, stamp), born: stamp), seq: 5, rc: 5, ru: 5)]
    let mark = Row(key: RecordKey("mark", "oak"), lattice: Lattice(fields: ["done": Register(false, stamp)]),
                   texts: ["memo": TextState(text: "first", rev: 1, merged: false)], seq: 1, rc: 1, ru: 1)
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.hlc = HLC(ms: 1000)
    return LoadedReplica(meta: meta, confirmed: [product: Rows(rows), overlay: Rows([mark])], wholeScopes: true)
  }

  // Plain writes by one engine instance that never cancel: updates and deletes of confirmed cards, keyed puts, and
  // text and field writes of a mark.
  static func gesture(_ random: inout SeededRandom) -> (scope: ScopeRef, gesture: Gesture) {
    if random.chance(0.25) {
      let change: Change = random.chance(0.5)
        ? .write("mark", "oak", texts: ["memo": TextEdit(text: random.pick(["a", "b c", "first", "d"]))])
        : .write("mark", "oak", ["done": .bool(random.chance(0.5))])
      return (overlay, Gesture(changes: [change]))
    }
    let changes = (0..<Int.random(in: 1...3, using: &random)).map { _ -> Change in
      let card = RecordID(random.pick(["card0001", "card0002", "card0003"]))
      switch Int.random(in: 0..<6, using: &random) {
      case 0: return .delete("card", card)
      case 1: return .put("day", "2026-09-01", present: random.chance(0.5), ["score": JSON(Int.random(in: 0...10, using: &random))])
      case 2: return .update("card", card, ["tier": .string(random.pick(["draft", "review", "done"]))])
      default: return .update("card", card, ["title": .string(random.pick(["One", "Two", "Three"]))])
      }
    }
    var seen: Set<RecordKey> = []
    return (product, Gesture(changes: changes.filter { seen.insert(RecordKey($0.type, $0.id!)).inserted }))
  }

  static func instance(_ deviceNow: Int64) -> Instance {
    Instance(actor: try! Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: deviceNow, appVersion: "1")
  }

  static func visibleDrawn(_ replica: LoadedReplica, _ scope: ScopeRef) throws -> [JSON] {
    let view = try ScopeView(replica, scope, .drawn, registry: probe)
    return view.all.filter(view.isVisible).map(\.json)
  }

  @Test func coalescingNeverChangesWhatIsDrawn() throws {
    var random = SeededRandom.fromEnvironment()
    let planner = CommitPlanner(registry: Self.probe)
    let identities = try QueuedIdentities([:])
    var coalesced = try Self.replica()
    var held = try Self.replica()
    for step in 0..<200 {
      let (scope, gesture) = Self.gesture(&random)
      var holding = gesture
      holding.hold = true
      _ = try planner.commit(gesture, in: scope, to: &coalesced, as: Self.instance(2000 + Int64(step)), identities: identities)
      _ = try planner.commit(holding, in: scope, to: &held, as: Self.instance(2000 + Int64(step)), identities: identities)
      for scope in [Self.product, Self.overlay] {
        #expect(try Self.visibleDrawn(coalesced, scope) == Self.visibleDrawn(held, scope), "seed \(random.seed), step \(step)")
      }
    }
    #expect(coalesced.outbox.count < held.outbox.count, "seed \(random.seed): some writes coalesced")
  }

  @Test func undoLeavesTheStoreAsTheCommitFoundItButForTheClock() throws {
    var random = SeededRandom.fromEnvironment()
    let planner = CommitPlanner(registry: Self.probe)
    let hold = Hold(registry: Self.probe)
    var replica = try Self.replica()
    for step in 0..<100 {
      let (scope, gesture) = Self.gesture(&random)
      var holding = gesture
      holding.hold = true
      holding.gestureId = "held\(step)"
      let before = replica.json
      let outcome = try planner.commit(holding, in: scope, to: &replica, as: Self.instance(3000 + Int64(step)), identities: try QueuedIdentities([:]))
      guard case .committed(let receipt) = outcome, !receipt.localIds.isEmpty else { continue }
      #expect(try hold.undo("held\(step)", in: &replica), "seed \(random.seed), step \(step)")
      var after = try replica.json.asObject()
      var meta = try after.member("meta").asObject()
      let original = try before.member("meta")
      meta["hlc"] = original["hlc"]
      meta["hlcHigh"] = original["hlcHigh"]
      after["meta"] = .object(meta)
      #expect(JSON.object(after) == before, "seed \(random.seed), step \(step)")
      var plain = gesture
      plain.gestureId = "plain\(step)"
      _ = try planner.commit(plain, in: scope, to: &replica, as: Self.instance(3000 + Int64(step)), identities: try QueuedIdentities([:]))
    }
  }

  // The store loads only what `reads(of:)` names; any row it left out would change the decision, or trap.
  @Test func aCommitOverItsReadSetDecidesAsOneOverEveryRow() throws {
    var random = SeededRandom.fromEnvironment()
    let planner = CommitPlanner(registry: Self.probe)
    var whole = try Self.replica()
    for step in 0..<150 {
      var (scope, gesture) = Self.gesture(&random)
      gesture.gestureId = "step\(step)"
      var partial = try Self.partial(whole, reads: planner.reads(of: gesture, in: scope))
      let instance = Self.instance(4000 + Int64(step))
      let wholeOutcome = try planner.commit(gesture, in: scope, to: &whole, as: instance, identities: try QueuedIdentities([:]))
      let partialOutcome = try planner.commit(gesture, in: scope, to: &partial, as: instance, identities: try QueuedIdentities([:]))
      #expect(partialOutcome == wholeOutcome, "seed \(random.seed), step \(step)")
      #expect(partial.writes == Array(whole.writes.suffix(partial.writes.count)), "seed \(random.seed), step \(step)")
    }
  }

  // The same replica as a store would load it: every table whole but the rows, which only `reads` names.
  static func partial(_ replica: LoadedReplica, reads: [ScopeRef: RowSelection]) throws -> LoadedReplica {
    var rows: [ScopeRef: Rows] = [:]
    var spent: [ScopeRef: [RecordKey: SpentID]] = [:]
    for (scope, selection) in reads {
      let every = replica.rows(scope).all
      let named = every.filter { selection.keys.contains($0.key) || selection.types.contains($0.key.type) }
      rows[scope] = Rows(loaded: named, keys: selection.keys, types: selection.types, empty: every.isEmpty)
      spent[scope] = replica.spentIDs(scope)
    }
    return LoadedReplica(
      meta: replica.meta, outbox: replica.outbox, confirmed: rows, spent: spent, cursors: replica.cursors, known: replica.known,
      deviceRows: replica.deviceRows, wholeScopes: false)
  }

  // A put that keeps presence changes a record drawn holds, as an update does; one drawn does not hold throws.
  @Test func aPutKeepingPresenceOfARecordAbsentFromDrawnThrows() throws {
    var replica = try Self.replica()
    #expect(throws: CommitError.self) {
      try CommitPlanner(registry: Self.probe).commit(
        Gesture(changes: [.put("day", "2026-09-27", present: nil, ["score": 7])]), in: Self.product, to: &replica, as: Self.instance(5000),
        identities: try QueuedIdentities([:]))
    }
    #expect(replica.writes == [])
  }
}
