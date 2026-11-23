import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Synchronization
import Testing

// §7.1: a write costs what it names. A phone that is signed out sends nothing, so every entry it commits stays in the
// outbox, and a plant of many records stays there as entries of 500 records each. Here a probe tree whose tags the
// registry caps at 10,000, as a roadmap caps its steps, stands beside 0, 1, 10 and 20 unsent entries of 250 tags and 250
// links each, on disk and in memory, and each write is timed: a commit of a change to one confirmed tag, which carries
// its life as a domain's change of a step does, a held delete of one, a change to a tag the first unsent entry planted,
// and composed acts of 10 and 100 changes or deletes, each part read, staged and committed as the domain kit runs one,
// opted into Undo. Each measure beside 10 and 20 entries is held to the same measure beside one, taken in the same run:
// a fastest sample past `growth` times that one's, and `slackMs` more, fails the benchmark, since a write that names one
// record does not grow with entries that never touch it.
//
// Beside them, the ACK of a large push with an act journaled behind it (§7.4): N opted births, as one entry of N records
// or N entries of one, then one Delete of all N opted into Undo, which journals N preimages, and the push that
// acknowledges them all. Each of the ACK's transactions holds the store's writer; the longest is reported against
// WRITER_SLICE_MS (§2.5).
extension Benchmarks {
  @Suite struct UnsentOutbox {
    static let tree = ScopeRef.tree("b_00000001")
    static let board = RecordID("b_00000001")
    static let standing = 500
    static let warmUp = 5
    static let rounds = 20
    static let growth = 2.0
    static let slackMs = 0.25

    // The probe's registry with its tags capped as a roadmap's steps are, and its links as a roadmap's links.
    static func registry() throws -> Registry {
      var probe = try Corpus.registryFile("probe").asObject()
      let caps: [String: Int] = ["tag": 10_000, "link": 20_000]
      probe["types"] = .array(try probe.member("types").asArray().map { (type: JSON) throws -> JSON in
        var object = try type.asObject()
        if let cap = caps[try object.member("type").asString()] { object["cap"] = JSON(cap) }
        return .object(object)
      })
      return try Registry(json: .object(probe))
    }

    static func address(_ tag: RecordID) -> RecordAddress {
      RecordAddress(scope: tree, key: RecordKey("tag", tag))
    }

    // One unsent entry of 500 records: 250 tags, each led to by one link, the first from a confirmed tag.
    static func plant(_ index: Int) -> Gesture {
      let tags: [RecordID] = (0..<250).map { RecordID(String(format: "p%02d-%03d", index, $0)) }
      let links: [Change] = tags.indices.map { (at: Int) -> Change in
        let from = at == 0 ? RecordID("s00000") : tags[(at - 1) / 2]
        return .put("link", RecordID(tuple: [from.description, tags[at].description]), present: true)
      }
      return Gesture(changes: tags.map { .create("tag", id: .given($0), ["label": .string("Planted \($0)")]) } + links, atomic: true)
    }

    // A change of a tag as a domain's change of a step writes it, and its Undo.
    static func change(_ tag: RecordID, to label: String) -> (gesture: Gesture, recipe: ActUndoRecipe) {
      (Gesture(changes: [.revive("tag", tag, ["label": .string(label)])]),
       .fields(restoreCommand: "probe.restoreTree", targets: [RestoreTarget(target: Target(address(tag), .field("label")))]))
    }

    // A held delete of a tag, and its Undo.
    static func delete(_ tag: RecordID) -> (gesture: Gesture, recipe: ActUndoRecipe) {
      (Gesture(changes: [.delete("tag", tag)], hold: true),
       .fields(restoreCommand: "probe.restoreTree", targets: [RestoreTarget(target: Target(address(tag), .life))]))
    }

    // One composed act as the domain kit runs one: each part reads its tag, then stages its segment, which reads the tag
    // again; the act then commits every segment, each read once more, with one Undo carrying every part's recipe. Its
    // gesture id.
    static func act(_ parts: [(tag: RecordID, gesture: Gesture, recipe: ActUndoRecipe)], on phone: Phone, hold: Bool) throws -> String {
      let committed = try phone.engine.commitAct({ (context: any ActContext) throws -> (ActRequest?, Void) in
        for (index, part) in parts.enumerated() {
          if index > 0 { try context.beginPart() }
          _ = try context.inScope(tree) { try $0.drawn("tag", part.tag) }
          try context.finishLoad()
          let refused = try context.stage(tree) { (reader: any CommitContext) throws -> Gesture in
            _ = try reader.drawn("tag", part.tag)
            return part.gesture
          }
          if let refused { throw BenchError("a part was refused \(refused.code)") }
        }
        let undo = ActUndo(segments: parts.indices.map { ActUndo.Segment(index: $0, recipes: [parts[$0].recipe]) })
        return (ActRequest(scopes: Array(repeating: tree, count: parts.count), hold: hold, undo: undo), ())
      }, segment: { (_: Void, index: Int, reader: any CommitContext) throws -> Gesture in
        _ = try reader.drawn("tag", parts[index].tag)
        return parts[index].gesture
      })
      guard case .committed(let receipt)? = committed.outcome else { throw BenchError("an act of \(parts.count) parts did not commit") }
      return receipt.gestureId
    }

    @Test(arguments: ["disk", "memory"])
    func aWriteBesideTheUnsentOutbox(_ storage: String) async throws {
      let registry = try Self.registry()
      try await Bench.inDirectory { directory in
        let network = SimNetwork(server: ModelServer(registry: registry, rules: ProbeServerRules(), state: ServerState(epoch: "ep-1")),
                                 clock: SystemClock())
        let phone = storage == "disk"
          ? try Phone.onDisk(directory.appending(path: "sync.sqlite"), registry: registry, transport: network)
          : try Phone(store: Store.inMemory(registry: registry), transport: network)
        try await phone.signIn("writer", token: network.server.token(for: "writer"))

        // The board, and the tags the writes name, confirmed before anything is planted.
        let standing: [RecordID] = (0..<Self.standing).map { RecordID(String(format: "s%05d", $0)) }
        try phone.commit(Gesture(changes: [.create("board", id: .given(Self.board))]), in: .product("probe"))
        try phone.commit(Gesture(changes: standing.map { .create("tag", id: .given($0), ["label": .string("Standing \($0)")]) }, atomic: true),
                         in: Self.tree)
        await phone.sync()
        let confirmed = try phone.engine.read(Self.tree) { try $0.confirmed("tag", standing[0]) != nil && $0.drawn("tag").count == Self.standing }
        guard confirmed else { throw BenchError("the standing tags are not confirmed") }

        // Measures beside one unsent entry, which those beside more are held to.
        var besideOne: [String: Samples] = [:]
        func report(_ taken: Samples, as name: String, unsent: Int) {
          switch unsent {
          case 1:
            besideOne[name] = taken
            taken.report()
          case 10, 20:
            guard let still = besideOne[name] else { return taken.report() }
            #expect(!taken.report(growthBudget: Self.growth, slackMs: Self.slackMs, from: still), "\(taken.measure) grows with the unsent outbox")
          default: taken.report()
          }
        }

        var planted = 0
        var round = 0
        for unsent in [0, 1, 10, 20] {
          while planted < unsent {
            try phone.commit(Self.plant(planted), in: Self.tree)
            planted += 1
          }
          let outbox = try phone.store.read { tx in try tx.replica(tx.activeReplica())?.outbox ?? [] }
          guard outbox.filter({ $0.intent.deltas.count == 500 }).count == unsent else { throw BenchError("the outbox does not hold \(unsent) planted entries") }
          let beside = "\(storage), beside \(unsent) unsent of 500"
          // Each round of each measure names tags no earlier round of this outbox named.
          var next = 0
          func tags(_ count: Int) -> [RecordID] {
            defer { next += count }
            return Array(standing[next..<(next + count)])
          }

          var changed = Samples("commit · a change to one record · \(beside)")
          var deleted = Samples("commit · a held delete of one record · \(beside)")
          var plantedChange = Samples("commit · a change to one record an unsent entry planted · \(beside)")
          for index in 0..<(Self.warmUp + Self.rounds) {
            round += 1
            let tag = tags(1)[0]
            try changed.time {
              _ = try phone.engine.commit(Self.tree) { (context: any CommitContext) throws -> (Gesture?, Void) in
                _ = try context.drawn("tag", tag)
                return (Self.change(tag, to: "Changed \(round)").gesture, ())
              }
            }
            let held = try deleted.time {
              try phone.engine.commit(Self.tree) { (context: any CommitContext) throws -> (Gesture?, Void) in
                _ = try context.drawn("tag", tag)
                return (Self.delete(tag).gesture, ())
              }
            }
            guard case .committed(let receipt)? = held.outcome, try phone.engine.cancelHeld(receipt.gestureId) else {
              throw BenchError("a held delete did not commit and undo")
            }
            guard unsent > 0 else { continue }
            let plantedTag = RecordID(String(format: "p00-%03d", index))
            try plantedChange.time {
              _ = try phone.engine.commit(Self.tree) { (context: any CommitContext) throws -> (Gesture?, Void) in
                _ = try context.drawn("tag", plantedTag)
                return (Self.change(plantedTag, to: "Changed \(round)").gesture, ())
              }
            }
          }
          report(changed.afterWarmUp(Self.warmUp), as: "change", unsent: unsent)
          report(deleted.afterWarmUp(Self.warmUp), as: "delete", unsent: unsent)
          if unsent > 0 { report(plantedChange.afterWarmUp(Self.warmUp), as: "planted change", unsent: unsent) }

          // A composed act's time a part, a round of the act a sample.
          for (parts, rounds) in [(10, 5), (100, 3)] {
            var changes = Samples("act · \(parts) changes, a part · \(beside)")
            var deletes = Samples("act · \(parts) held deletes, a part · \(beside)")
            for _ in 0..<(1 + rounds) {
              round += 1
              let named = tags(parts)
              let began = ContinuousClock.now
              let changing = try Self.act(named.map { tag in let made = Self.change(tag, to: "Act \(round)"); return (tag, made.gesture, made.recipe) },
                                          on: phone, hold: false)
              changes.add((ContinuousClock.now - began) / parts)
              #expect(try phone.engine.releaseReversibleAct(changing))
              let deleting = ContinuousClock.now
              let removal = try Self.act(named.map { tag in let made = Self.delete(tag); return (tag, made.gesture, made.recipe) }, on: phone, hold: true)
              deletes.add((ContinuousClock.now - deleting) / parts)
              #expect(try phone.engine.cancelHeld(removal))
              #expect(try phone.engine.releaseReversibleAct(removal))
            }
            report(changes.afterWarmUp(1), as: "act of \(parts) changes", unsent: unsent)
            report(deletes.afterWarmUp(1), as: "act of \(parts) deletes", unsent: unsent)
          }
        }
      }
    }

    // `shape`-`count`: `plant` births `count` records in one entry, `births` in `count` entries of one.
    @Test(arguments: ["plant-1000", "plant-5000", "births-1000", "births-5000"])
    func theAckOfALargePushWithAnActJournaled(_ name: String) async throws {
      let parts = name.split(separator: "-")
      let (shape, count) = (String(parts[0]), Int(parts[1])!)
      let registry = try Corpus.probeRegistry()
      let scope = ScopeRef.product("probe")
      try await Bench.inDirectory { directory in
        let network = SimNetwork(server: ModelServer(registry: registry, rules: ProbeServerRules(), state: ServerState(epoch: "ep-1")),
                                 clock: SystemClock())
        let writers = WriterHolds()
        let phone = try Phone.onDisk(directory.appending(path: "sync.sqlite"), registry: registry, transport: network,
                                     writerObserver: { writers.record($0) })
        try await phone.signIn("writer", token: network.server.token(for: "writer"))
        let days: [RecordID] = (0..<count).map { RecordID(String(format: "%04d-%02d-%02d", 3000 + $0 / 100, 1 + $0 / 10 % 10, 1 + $0 % 10)) }
        let address = { (day: RecordID) in RecordAddress(scope: scope, key: RecordKey("day", day)) }

        // Births opted into Undo, each released at once as a planting room lets its act go.
        func birth(_ born: [RecordID]) throws {
          let recipes: [ActUndoRecipe] = born.map { .createdRecord(restoreCommand: "probe.restore", record: address($0)) }
          let act = try phone.engine.commitAct({ _ in (ActRequest(scopes: [scope], undo: ActUndo(segments: [ActUndo.Segment(index: 0, recipes: recipes)])), ()) },
                                               segment: { _, _, _ in Gesture(changes: born.map { .put("day", $0, present: true, ["score": 1]) }) })
          guard case .committed(let receipt)? = act.outcome, try phone.engine.releaseReversibleAct(receipt.gestureId) else {
            throw BenchError("a birth did not commit and release")
          }
        }
        if shape == "plant" { try birth(days) } else { for day in days { try birth([day]) } }
        let targets = days.map { RestoreTarget(target: Target(address($0), .life)) }
        let removal = try phone.engine.commitAct({ _ in
          (ActRequest(scopes: [scope], undo: ActUndo(segments: [ActUndo.Segment(index: 0, recipes: [.fields(restoreCommand: "probe.restore", targets: targets)])])), ())
        }, segment: { _, _, _ in Gesture(changes: days.map { .delete("day", $0) }) })
        guard case .committed? = removal.outcome else { throw BenchError("the Delete did not commit") }
        let queued = try phone.store.read { tx in try tx.replica(tx.activeReplica()) }
        guard queued?.outbox.count == (shape == "plant" ? 2 : count + 1),
              queued?.journal.acts.flatMap(\.sourceEntries).flatMap(\.preimages).count == count else {
          throw BenchError("the outbox does not hold the births and the Delete with its \(count) preimages journaled")
        }

        _ = writers.take()
        let began = ContinuousClock.now
        await phone.push()
        let took = ContinuousClock.now - began
        let holds = writers.take()
        let landed = try phone.store.read { tx in try tx.replica(tx.activeReplica()) }
        let preimages = landed?.journal.acts.flatMap(\.sourceEntries).flatMap(\.preimages) ?? []
        guard landed?.outbox.allSatisfy({ $0.state == .acked }) == true, preimages.count == count else {
          throw BenchError("the push did not acknowledge every entry with the Delete still journaled")
        }
        let longest = holds.max() ?? .zero
        let slice = Double(Constants.writerSliceMs)
        Bench.report("ack · \(shape == "plant" ? "one entry of \(count) births" : "\(count) entries of one birth"), a Delete of \(count) journaled",
                     [("ackMs", Bench.format(Bench.ms(took))), ("transactions", "\(holds.count)"),
                      ("longestHoldMs", Bench.format(Bench.ms(longest))),
                      ("overSlice", "\(holds.filter { Bench.ms($0) > slice }.count)"),
                      ("preimagesStepped", "\(preimages.filter { $0.rowSeq != nil }.count)/\(preimages.count)")],
                     budget: "longest hold ≤ \(Bench.format(slice))", over: Bench.ms(longest) > slice)
      }
    }
  }
}

// How long each of the store's transactions held its writer, as the engine's observer reports it.
final class WriterHolds: Sendable {
  let held = Mutex<[Duration]>([])

  func record(_ timing: WriterTiming) {
    held.withLock { $0.append(timing.held) }
  }

  func take() -> [Duration] {
    held.withLock { held in
      defer { held = [] }
      return held
    }
  }
}
