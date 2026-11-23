import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// Properties of §7.1–§7.3 over random gestures on the probe: Undo leaves the store as the commit found it, and a commit
// over the rows its read set names, and what its plans find unread, decides exactly as one over every row.

struct CommitTests {
  static let probe = try! Corpus.probeRegistry()
  static let product = ScopeRef.product("probe")
  static let overlay = ScopeRef.overlay("b_00000001")

  // A bound replica holding three live cards, as many as the probe's cap, and a dead one, a day, and a board whose
  // overlay holds a mark.
  static func replica() throws -> LoadedReplica {
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let card = { (id: String, seq: Int64, life: Life.State) in
      Row(key: RecordKey("card", RecordID(id)), lattice: Lattice(life: Life(life, stamp), born: stamp, fields: [
        "title": Register(.string(id), stamp), "tier": Register("draft", stamp),
      ]), seq: seq, rc: seq, ru: seq)
    }
    let rows = [card("card0001", 1, .alive), card("card0002", 2, .alive), card("card0003", 3, .alive), card("card0004", 6, .dead),
                Row(key: RecordKey("day", "2026-09-01"), lattice: Lattice(life: Life(.alive, stamp), fields: ["score": Register(1, stamp)]), seq: 4, rc: 4, ru: 4),
                Row(key: RecordKey("board", "b_00000001"), lattice: Lattice(life: Life(.alive, stamp), born: stamp), seq: 5, rc: 5, ru: 5)]
    let mark = Row(key: RecordKey("mark", "oak"), lattice: Lattice(fields: ["done": Register(false, stamp)]),
                   texts: ["memo": TextState(text: "first", rev: 1, merged: false)], seq: 1, rc: 1, ru: 1)
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.hlc = HLC(ms: 1000)
    return LoadedReplica(meta: meta, confirmed: [product: Rows(rows), overlay: Rows([mark])], wholeScopes: true)
  }

  // Writes of one record each by one engine instance: updates, deletes and revives of confirmed cards, keyed puts, and
  // text and field writes of a mark.
  static func gesture(_ random: inout SeededRandom) -> (scope: ScopeRef, gesture: Gesture) {
    if random.chance(0.25) {
      let change: Change = random.chance(0.5)
        ? .write("mark", "oak", texts: ["memo": TextEdit(text: random.pick(["a", "b c", "first", "d"]))])
        : .write("mark", "oak", ["done": .bool(random.chance(0.5))])
      return (overlay, Gesture(changes: [change]))
    }
    let changes = (0..<Int.random(in: 1...3, using: &random)).map { _ -> Change in
      let card = RecordID(random.pick(["card0001", "card0002", "card0003", "card0004"]))
      switch Int.random(in: 0..<7, using: &random) {
      case 0: return .delete("card", card)
      case 6: return .revive("card", card)
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

  @Test(arguments: [8, 1])
  func derivedCommitsFitTheirIDDomainOrLeaveTheReplicaUnchanged(_ max: Int) throws {
    let registry = try Registry(json: [
      "registry": "bounded", "version": 1, "minVersion": 1, "products": ["p": [:]], "commands": [],
      "types": [["type": "node", "scope": "product:p", "identity": "derived", "idSpace": "scope",
                 "idDomain": ["type": "string", "unit": "chars", "min": 1, "max": JSON(max)],
                 "derive": ["fallback": .string(String(repeating: "a", count: max))],
                 "mint": ["prefix": "", "alphabet": "ab", "length": 1], "life": true, "revivable": true,
                 "deadRows": "keep", "origins": ["replica"], "fields": [:]]],
    ])
    let planner = CommitPlanner(registry: registry)
    var replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), wholeScopes: true)
    let before = replica.json
    var gesture = Gesture(changes: [String(repeating: "abcdefgh", count: 25), "", ""].map { .create("node", id: .derived(label: $0)) })
    gesture.gestureId = "bounded"
    if max == 1 {
      #expect(throws: CommitFailure.self) {
        try planner.commit(gesture, in: .product("p"), to: &replica, as: Self.instance(5000),
                           identities: QueuedIdentities([:]), gestureIdTaken: false)
      }
      #expect(replica.json == before)
      return
    }
    let outcome = try planner.commit(gesture, in: .product("p"), to: &replica, as: Self.instance(5000),
                                     identities: QueuedIdentities([:]), gestureIdTaken: false)
    guard case .committed(let receipt) = outcome else { Issue.record("the bounded commit was refused"); return }
    #expect(receipt.ids.compactMap { $0?.string } == ["abcdefgh", "aaaaaaaa", "aaaaaa-2"])
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
      let outcome = try planner.commit(holding, in: scope, to: &replica, as: Self.instance(3000 + Int64(step)),
                                       identities: try QueuedIdentities([:]), gestureIdTaken: false)
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
      _ = try planner.commit(plain, in: scope, to: &replica, as: Self.instance(3000 + Int64(step)),
                                       identities: try QueuedIdentities([:]), gestureIdTaken: false)
    }
  }

  // The store loads only what `reads(of:)` names, and what a plan then finds unread; any row it left out would change the
  // decision, or trap. A revive that shows one more card reads the capped type, which may refuse it.
  @Test func aCommitOverItsReadSetDecidesAsOneOverEveryRow() throws {
    var random = SeededRandom.fromEnvironment()
    let planner = CommitPlanner(registry: Self.probe)
    var whole = try Self.replica()
    for step in 0..<150 {
      var (scope, gesture) = Self.gesture(&random)
      gesture.gestureId = "step\(step)"
      let instance = Self.instance(4000 + Int64(step))
      let (partial, partialOutcome) = try Self.planned(gesture, in: scope, over: whole, by: planner, as: instance)
      let wholeOutcome = try planner.commit(gesture, in: scope, to: &whole, as: instance, identities: try QueuedIdentities([:]), gestureIdTaken: false)
      #expect(partialOutcome == wholeOutcome, "seed \(random.seed), step \(step)")
      #expect(partial.writes == Array(whole.writes.suffix(partial.writes.count)), "seed \(random.seed), step \(step)")
    }
  }

  // A commit as the store's Action plans it: over the rows its read set names, then again over each it finds unread.
  static func planned(_ gesture: Gesture, in scope: ScopeRef, over whole: LoadedReplica, by planner: CommitPlanner,
                      as instance: Instance) throws -> (replica: LoadedReplica, outcome: CommitOutcome) {
    var reads = planner.reads(of: gesture, in: scope)
    var draws: [Draw] = []
    while true {
      var partial = try Self.partial(whole, reads: reads)
      do {
        let outcome = try planner.commit(gesture, in: scope, to: &partial, as: instance, identities: try QueuedIdentities([:]),
                                         gestureIdTaken: false, draws: draws)
        return (partial, outcome)
      } catch let unread as UnreadRows {
        reads[scope, default: RowSelection()].keys.formUnion(unread.keys)
        reads[scope, default: RowSelection()].types.formUnion(unread.types)
        draws = unread.draws
      }
    }
  }

  // A change of one record of a capped type reads that record alone, so its commit loads the same rows however many the
  // type holds; a create reads the whole type, which the cap counts, and any other change reads it only once its delta
  // shows one more record than `stored` does. A command's predicted create reads its record alone: the cap counts no
  // prediction. A revive of a live card commits over its one row; one of the dead card,
  // which the three live ones fill the cap without, stops for the type and is refused once it is read.
  @Test func aCappedTypeIsReadWholeOnlyByAChangeThatShowsOneMoreRecord() throws {
    let planner = CommitPlanner(registry: Self.probe)
    let card = RecordKey("card", "card0001"), dead = RecordKey("card", "card0004")
    let reads = { (change: Change) -> [ScopeRef: RowSelection] in planner.reads(of: Gesture(changes: [change]), in: Self.product) }
    #expect(reads(.update("card", card.id, ["title": "One"])) == [Self.product: RowSelection(keys: [card])])
    #expect(reads(.delete("card", card.id)) == [Self.product: RowSelection(keys: [card])])
    #expect(reads(.revive("card", card.id)) == [Self.product: RowSelection(keys: [card])])
    #expect(reads(.put("day", "2026-09-01", present: false)) == [Self.product: RowSelection(keys: [RecordKey("day", "2026-09-01")])])
    #expect(reads(.create("card")) == [Self.product: RowSelection(types: ["card"])])
    let predicted = Gesture(changes: [], command: Command(name: "probe.copy", args: ["src": "b_00000001", "dst": "b_00000002"]),
                            predict: [.create("card", id: .given("card0009"), ["title": "Nine"])])
    #expect(planner.reads(of: predicted, in: Self.product) == [Self.product: RowSelection(keys: [RecordKey("card", "card0009")])])

    let whole = try Self.replica()
    let live = Gesture(changes: [.revive("card", card.id, ["title": "Again"])], gestureId: "live")
    var partial = try Self.partial(whole, reads: planner.reads(of: live, in: Self.product))
    #expect(partial.rows(Self.product).loaded.count == 1)
    let outcome = try planner.commit(live, in: Self.product, to: &partial, as: Self.instance(6000), identities: try QueuedIdentities([:]),
                                     gestureIdTaken: false)
    guard case .committed = outcome else {
      Issue.record("a revive of a live card at the cap was refused: \(outcome)")
      return
    }

    let revival = Gesture(changes: [.revive("card", dead.id)], gestureId: "revival")
    var narrow = try Self.partial(whole, reads: planner.reads(of: revival, in: Self.product))
    #expect(throws: UnreadRows.self) {
      try planner.commit(revival, in: Self.product, to: &narrow, as: Self.instance(6000), identities: try QueuedIdentities([:]), gestureIdTaken: false)
    }
    let planned = try Self.planned(revival, in: Self.product, over: whole, by: planner, as: Self.instance(6000))
    #expect(planned.outcome == .refused(.cap, detail: ["type": "card", "cap": 3]))
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

  // Gesture ids that differ only by canonical equivalence are two gestures: both commit, and Undo of one leaves the other.
  @Test func lookAlikeGestureIdsAreTwoGestures() throws {
    var replica = try Self.replica()
    let planner = CommitPlanner(registry: Self.probe)
    for (id, card) in [("g\u{E9}", "card0001"), ("ge\u{301}", "card0002")] {
      _ = try planner.commit(
        Gesture(changes: [.update("card", RecordID(card), ["title": "Held"])], hold: true, gestureId: id), in: Self.product,
        to: &replica, as: Self.instance(5000), identities: try QueuedIdentities([:]), gestureIdTaken: false)
    }
    #expect(try Hold(registry: Self.probe).undo("ge\u{301}", in: &replica))
    #expect(replica.outbox.map { Array($0.localId.utf8) } == [Array("g\u{E9}/0".utf8)])
  }

  // A scope the registry cannot name, here a tree id the wire cannot carry, throws even for a command alone.
  @Test func aScopeTheRegistryCannotNameThrows() throws {
    var replica = try Self.replica()
    #expect(throws: CommitFailure.self) {
      try CommitPlanner(registry: Self.probe).commit(
        Gesture(changes: [], command: Command(name: "probe.copy", args: ["src": "b_00000001", "dst": "b_00000002"])),
        in: .tree("b_0000000\u{E9}"), to: &replica, as: Self.instance(5000), identities: try QueuedIdentities([:]), gestureIdTaken: false)
    }
    #expect(replica.writes == [])
  }

  // A put that keeps presence changes a record drawn holds, as an update does; one drawn does not hold throws.
  @Test func aPutKeepingPresenceOfARecordAbsentFromDrawnThrows() throws {
    var replica = try Self.replica()
    #expect(throws: CommitFailure.self) {
      try CommitPlanner(registry: Self.probe).commit(
        Gesture(changes: [.put("day", "2026-09-27", present: nil, ["score": 7])]), in: Self.product, to: &replica, as: Self.instance(5000),
        identities: try QueuedIdentities([:]), gestureIdTaken: false)
    }
    #expect(replica.writes == [])
  }

  // §7.1 step 4: a put that leaves a whole record absent carries its life alone, since §6.1 step 2 refuses a dead whole
  // delta with a field register: one that names a field value throws, whether it removes the record, deletes it, or keeps
  // it dead with `present` nil, and writes nothing.
  @Test func aChangeLeavingAWholeRecordAbsentThatNamesAFieldValueThrows() throws {
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let fact = { (life: Life.State, day: String) in
      Row(key: RecordKey("fact", RecordID(day)), lattice: Lattice(life: Life(life, stamp), fields: [
        "value": Register(80, stamp), "at": Register(900, stamp),
      ]), seq: 1, rc: 1, ru: 1)
    }
    let changes: [Change] = [
      .put("fact", "2026-09-01", present: false, ["value": 81]),
      Change(type: "fact", operation: .delete("2026-09-01"), values: ["value": 81]),
      .put("fact", "2026-09-02", present: nil, ["value": 81, "at": 5000]),
    ]
    for change in changes {
      var replica = LoadedReplica(
        meta: ReplicaMeta(replica: "rp_1", state: .bound, account: "A"),
        confirmed: [Self.product: Rows([fact(.alive, "2026-09-01"), fact(.dead, "2026-09-02")])], wholeScopes: true)
      #expect(throws: CommitFailure.malformed("a removal of fact \(change.id!) carries its life alone")) {
        try CommitPlanner(registry: Self.probe).commit(
          Gesture(changes: [change]), in: Self.product, to: &replica, as: Self.instance(5000), identities: try QueuedIdentities([:]),
          gestureIdTaken: false)
      }
      #expect(replica.writes == [])
    }
  }
}
