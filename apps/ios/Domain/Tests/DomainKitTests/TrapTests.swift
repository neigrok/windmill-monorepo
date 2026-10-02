import DomainKit
import Foundation
import SyncAPI
import SyncCore
import SyncTesting
import Synchronization
import Testing

// The programming faults the kit traps on (domain-kit.md §4.5, §9.2, §10.1, ER-14), each in a process of its own, and
// the failures `run` rethrows instead.
struct TrapTests {
  @Test func aRunInsideARunTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      let runner = Kit.runner(Kit.Replica())
      _ = try? runner.run(Kit.Nested(runner: runner))
    }
  }

  @Test func aMalformedCommitTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      let replica = Kit.Replica()
      replica.failing.withLock { $0 = CommitFailure.malformed("a string holds U+0000") }
      _ = try? Kit.runner(replica).run(Kit.Nested(runner: nil))
    }
  }

  @Test func aCheckThatThrowsAnotherErrorTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      _ = try? Valid(Kit.Card(id: ID("card0001"), title: "throw"), at: Kit.moment)
    }
  }

  @Test func aCheckThatChangesAnotherFieldTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      _ = try? Valid(Kit.Card(id: ID("card0001"), title: "meddle"), at: Kit.moment)
    }
  }

  @Test func aPlanErrorInASaveTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      let replica = Kit.Replica(Kit.record("lap", "lap00001", ["runId": "run00001"]))
      let runner = Kit.runner(replica)
      guard var draft = try? runner.open(ID<Kit.Lap>("lap00001")) else { return }
      draft.current.runId = "run00002"
      _ = runner.save(&draft, SaveDraft<Kit.Lap, Kit.Refusal>.self)
    }
  }

  @Test func aDecodeErrorInASaveTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      let replica = Kit.Replica(Kit.record("card", "card0001", ["title": 5]))
      let runner = Kit.runner(replica)
      var draft = Draft(new: Kit.Card(id: ID("card0001"), title: "Push"), placed: .bottom)
      _ = runner.save(&draft, SaveDraft<Kit.Card, Kit.Refusal>.self)
    }
  }

  @Test func aMintOfATypeThatMintsNoneTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      _ = Kit.runner(Kit.Replica()).mint(Kit.Card.self)
    }
  }

  @Test func theCapacityOfAnUncappedTypeTraps() async {
    await #expect(processExitsWith: .signal(SIGTRAP)) {
      _ = Capacity(of: Kit.Lap.self, stored: [Record](), registry: Kit.registry)
    }
  }

  @Test func aRunRethrowsAPlanErrorAndWritesNothing() throws {
    let replica = Kit.Replica()
    #expect(throws: PlanError(rule: 1, "card lives outside the action's scope self/other")) {
      try Kit.runner(replica).run(Kit.WriteElsewhere())
    }
    #expect(replica.committed.withLock { $0 } == [])
  }

  @Test func aRunRethrowsAStoreFailure() throws {
    let replica = Kit.Replica()
    replica.failing.withLock { $0 = CommitFailure(.storeFailure, "the disk is full") }
    #expect(throws: CommitFailure(.storeFailure, "the disk is full")) { try Kit.runner(replica).run(Kit.Nested(runner: nil)) }
  }
}

// The declarations the traps need, over the probe registry: a card whose checks misbehave on cue, a lap with a const
// field, and a replica over a few records.
enum Kit {
  static let registry = (try? Corpus.probeRegistry())!
  static let moment = Moment(now: Instant(ms: 1_800_000_000_000), zone: FixedZone(offsetSeconds: 0))

  static func runner(_ replica: Replica) -> ActionRunner {
    ActionRunner(replica: replica, registry: registry, zone: FixedZone(offsetSeconds: 0))
  }

  static func record(_ type: String, _ id: RecordID, _ values: [String: JSON]) -> Record {
    Record(type: type, id: id, life: Life(.alive, .unset), born: .unset, values: values, texts: [:], serials: [:], rc: nil, ru: nil,
           isVisible: true, isPending: false, isHeld: false)
  }

  struct Card: Draftable, Ordered {
    static let type = "card"
    static let scope = ScopeRef.product("probe")
    static let orderField = "ord"
    static let savesGuarded = true

    let id: ID<Card>
    var title: String
    var body = ""
    var extra: JSON = .null

    init(id: ID<Card>, title: String) {
      self.id = id
      self.title = title
    }

    init(_ r: Fields) throws(DecodeError) {
      self.init(id: ID(r.id), title: try r.string("title"))
    }

    var fields: [String: JSON] { ["title": .string(title), "body": .string(body), "extra": extra] }

    static let checks: [Check<Card>] = [
      Check("title") { card, _ in
        if card.title == "throw" { throw DecodeError(type: "card", field: "title", reason: "not a violation") }
        if card.title == "meddle" { card.body = "changed by the title's check" }
      },
    ]
  }

  struct Lap: Draftable {
    static let type = "lap"
    static let scope = ScopeRef.product("probe")
    static let savesGuarded = false

    let id: ID<Lap>
    var runId: String

    init(_ r: Fields) throws(DecodeError) {
      id = ID(r.id)
      runId = try r.string("runId")
    }

    var fields: [String: JSON] { ["runId": .string(runId)] }
    static let checks: [Check<Lap>] = []
  }

  enum Refusal: ProductRefusal, Equatable {
    case violation(Violation), refused(Refused)
    init(_ violation: Violation) { self = .violation(violation) }
    init(_ refused: Refused) { self = .refused(refused) }
    var isGeneric: Bool { false }
  }

  // An action that runs another action from its load when it holds a runner.
  struct Nested: Action {
    let runner: ActionRunner?
    var scope: ScopeRef { .product("probe") }
    func load(_ read: Reader) throws -> Bool { try runner.map { try $0.run(Nested(runner: nil)) } != nil }
    func decide(_ loaded: Bool, ids: IDSource) throws(Violation) -> Decision<Bool, Refusal> { .unchanged(loaded) }
  }

  // An action whose plan writes a type of another scope (§8.3 rule 1).
  struct WriteElsewhere: Action {
    var scope: ScopeRef { .product("other") }
    func load(_ read: Reader) throws -> Moment { read.moment }
    func decide(_ moment: Moment, ids: IDSource) throws(Violation) -> Decision<Void, Refusal> {
      var plan = Plan()
      plan.update(try Valid(Card(id: ID("card0001"), title: "Push"), fields: ["title"], at: moment))
      return .write(plan)
    }
  }

  final class Replica: SyncAPI.Replica {
    let records: [Record]
    let failing = Mutex<(any Error)?>(nil)
    let committed = Mutex<[Gesture]>([])

    init(_ records: Record...) {
      self.records = records
    }

    func commit<T>(_ scope: ScopeRef, _ body: (any CommitContext) throws -> (Gesture?, T)) throws -> (outcome: CommitOutcome?, value: T) {
      if let failure = failing.withLock({ $0 }) { throw failure }
      let (gesture, value) = try body(Context(records: records))
      guard let gesture else { return (nil, value) }
      committed.withLock { $0.append(gesture) }
      return (.committed(CommitReceipt(gestureId: "g1", stamp: .unset, localIds: ["g1/0"], ids: [], releaseAt: nil, retired: [])), value)
    }

    func undo(_ gestureId: String) throws -> Bool { false }
    func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T { try body(Context(records: records)) }
    func mintID(_ type: String) throws -> RecordID { throw CommitFailure.malformed("\(type) mints no id here") }
    func physNow() throws -> Int64 { Kit.moment.now.ms }
    func dismissNotice(_ id: String) throws { throw CommitFailure(.storeFailure, "no notice \(id) here") }
  }

  struct Context: CommitContext {
    let records: [Record]
    var now: Int64 { Kit.moment.now.ms }
    var replica: String { "rp_00000000000000000000000000000001" }
    var actor: String { replica }
    let isAnonymous = false
    func drawn(_ type: String, _ id: RecordID) throws -> Record? { records.first { $0.type == type && $0.id == id } }
    func stored(_ type: String, _ id: RecordID) throws -> Record? { try drawn(type, id) }
    func drawn(_ type: String) throws -> [Record] { records.filter { $0.type == type } }
    func stored(_ type: String) throws -> [Record] { try drawn(type) }
    func drawn(_ type: String, where field: String, is id: RecordID) throws -> [Record] { [] }
    func stored(_ type: String, where field: String, is id: RecordID) throws -> [Record] { [] }
    func device(_ key: String) throws -> JSON? { nil }
    func firstPullComplete() throws -> Bool { true }
    func confirmed(_ type: String, _ id: RecordID) throws -> Record? { try stored(type, id) }
    func checkpoint() throws -> ScopeCheckpoint { ScopeCheckpoint() }
    func devices(prefix: String) throws -> JSON.Object { [:] }
    func commands() throws -> [QueuedCommand] { [] }
    func opaqueID() throws -> String { throw CommitFailure.malformed("no opaque identity here") }
    func mintID(_ type: String) throws -> RecordID { throw CommitFailure.malformed("no mint here") }
  }
}
