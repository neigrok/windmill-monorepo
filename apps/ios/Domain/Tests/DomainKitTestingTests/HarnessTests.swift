import DomainKit
import DomainKitTesting
import SyncAPI
import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// §14.3 over the real engine in step mode: saves and their races, holds and Undo, the engine's refusals at commit, a
// failed commit, and the notices a server refusal leaves. A sticky is the probe card as a product would write it to the
// model server, every field inside its registry domain.
struct HarnessTests {
  static func phone() throws -> Harness {
    Harness(registry: try Corpus.probeRegistry(), start: Probe.start)
  }

  static func sticky(_ h: Harness, _ title: String) throws -> Draft<Sticky> {
    var draft = Draft(new: Sticky(id: h.runner.mint(Sticky.self)), placed: .bottom)
    draft.current.title = title
    try #require(saved(h.runner.save(&draft, SaveSticky.self)))
    return draft
  }

  @Test func aSecondEditorSeesStaleBeforeAnythingIsSentAndKeepsMine() throws {
    let a = try HarnessTests.phone()
    let b = a.device()
    let new = try HarnessTests.sticky(a, "Push")
    a.sync()
    b.sync()
    var mine = try #require(try a.runner.open(new.id))
    var theirs = try #require(try b.runner.open(new.id))
    mine.current.title = "Push A"
    theirs.current.body = "from b"
    theirs.current.title = "Push B"
    #expect(saved(b.runner.save(&theirs, SaveSticky.self)))
    b.sync()
    a.sync()
    #expect(refused(a.runner.save(&mine, SaveSticky.self)) == .refused(Refused(.stale, subject: new.id.ref, path: .predicted)))
    let drawn = try #require(try a.runner.open(new.id))
    mine = mine.rebased(onto: drawn.current)
    #expect(mine.touched == ["title"])
    #expect(saved(a.runner.save(&mine, SaveSticky.self)))
    a.sync()
    b.sync()
    #expect(try b.drawn(Sticky.self).map(\.fields) == [["title": "Push A", "body": "from b", "size": .null, "tier": "draft"]])
  }

  // Both devices save before either sends; the first device's sender runs first, so the second's guard finds a newer
  // stamp and its write returns as a notice holding what it wrote.
  @Test func aRaceNeitherDeviceCouldSeeReturnsAsAStaleNotice() throws {
    let a = try HarnessTests.phone()
    let b = a.device()
    let new = try HarnessTests.sticky(a, "Push")
    a.sync()
    var mine = try #require(try a.runner.open(new.id))
    var theirs = try #require(try b.runner.open(new.id))
    mine.current.title = "Push A"
    theirs.current.title = "Push B"
    #expect(saved(a.runner.save(&mine, SaveSticky.self)))
    #expect(saved(b.runner.save(&theirs, SaveSticky.self)))
    a.sync()
    let notices = try b.notices(ProbeRefusal.self)
    let current: JSON = ["t": "card", "id": new.id.json, "field": "title", "current": "1800000000000:1:r_34ubof9vzm4w"]
    #expect(notices.map(\.refusal) == [.refused(Refused(.stale, subject: new.id.ref, detail: current, path: .notice))])
    #expect(notices.map { $0.values(of: new.id.ref) } == [["title": "Push B"]])
    #expect(try a.notices(ProbeRefusal.self).isEmpty)
    #expect(try b.drawn(Sticky.self).map(\.title) == ["Push A"])
  }

  @Test func aHeldRemovalKeepsItsSlotUntilItsHoldReleases() throws {
    let a = try HarnessTests.phone()
    let b = a.device()
    let first = try HarnessTests.sticky(a, "One")
    let second = try HarnessTests.sticky(a, "Two")
    let third = try HarnessTests.sticky(a, "Three")
    a.sync()
    let removal = try a.runner.run(Remove<Sticky, ProbeRefusal>(first.id))
    let receipt = try #require(removal.receipt)
    #expect(receipt.releaseAt == Probe.start.ms + Constants.holdMs)
    #expect(a.undoOffers().map(\.id) == [receipt.gestureId])
    #expect(try a.drawn(Sticky.self).map(\.id) == [second.id, third.id])
    #expect(try a.stored(Sticky.self).map(\.id) == [first.id, second.id, third.id])
    let capacity = try a.runner.read(Probe.scope) { try $0.repository(Sticky.self).capacity() }
    #expect(capacity.used == 3 && capacity.cap == 3 && capacity.isFull)
    var fourth = Draft(new: Sticky(id: a.runner.mint(Sticky.self)), placed: .bottom)
    fourth.current.title = "Four"
    #expect(refused(a.runner.save(&fourth, SaveSticky.self))
      == .refused(Refused(.cap, subject: fourth.id.ref, detail: ["type": "card", "cap": 3], path: .predicted)))
    a.sync()
    b.sync()
    #expect(try b.drawn(Sticky.self).map(\.id) == [first.id, second.id, third.id])
    a.advance(ms: Constants.holdMs)
    #expect(a.undoOffers() == [])
    a.sync()
    b.sync()
    #expect(try b.drawn(Sticky.self).map(\.id) == [second.id, third.id])
    #expect(saved(a.runner.save(&fourth, SaveSticky.self)))
  }

  @Test func undoInsideTheWindowBringsTheRecordBack() throws {
    let a = try HarnessTests.phone()
    let first = try HarnessTests.sticky(a, "One")
    let removal = try #require(try a.runner.run(Remove<Sticky, ProbeRefusal>(first.id)).receipt)
    #expect(try a.drawn(Sticky.self).isEmpty)
    #expect(try a.runner.undo(removal.gestureId))
    #expect(try a.drawn(Sticky.self).map(\.id) == [first.id])
    #expect(a.undoOffers() == [])
    guard case .unchanged = try a.runner.run(Remove<Sticky, ProbeRefusal>(ID("absent00"))) else {
      Issue.record("a removal of what the person cannot see wrote")
      return
    }
  }

  @Test func aKeyedRewriteInsideTheWindowRetiresTheHeldRemoval() throws {
    let a = try HarnessTests.phone()
    let b = a.device()
    let today = ID<Day>(try a.runner.moment().today)
    var day = try a.runner.open(today, orNew: Day(id: today))
    day.current.score = 7
    #expect(saved(a.runner.save(&day, SaveDraft<Day, ProbeRefusal>.self)))
    a.sync()
    let removal = try #require(try a.runner.run(Remove<Day, ProbeRefusal>(today)).receipt)
    var again = try a.runner.open(today, orNew: Day(id: today))
    #expect(again.isNew)
    again.current.score = 3
    guard case .saved(let rewrite?) = a.runner.save(&again, SaveDraft<Day, ProbeRefusal>.self) else {
      Issue.record("the rewrite did not commit")
      return
    }
    #expect(rewrite.retired == [removal.gestureId])
    #expect(a.undoOffers() == [])
    a.sync()
    b.sync()
    #expect(try b.drawn(Day.self).map(\.fields) == [["score": 3]])
  }

  @Test func aFailedCommitWritesNothingAndTheDraftStaysAsItWas() throws {
    let a = try HarnessTests.phone()
    var draft = Draft(new: Sticky(id: a.runner.mint(Sticky.self)), placed: .bottom)
    draft.current.title = "Push"
    a.failNextCommit()
    #expect(failed(a.runner.save(&draft, SaveSticky.self)) is CommitFailure)
    #expect(draft.isNew && draft.touched == ["title"])
    #expect(try a.drawn(Sticky.self).isEmpty)
    #expect(saved(a.runner.save(&draft, SaveSticky.self)))
    #expect(!draft.isNew && !draft.isDirty)
  }

  @Test func aMoveWritesOneKeyAndADropInPlaceWritesNothing() throws {
    let a = try HarnessTests.phone()
    let b = a.device()
    let one = try HarnessTests.sticky(a, "One")
    let two = try HarnessTests.sticky(a, "Two")
    let three = try HarnessTests.sticky(a, "Three")
    guard case .unchanged = try a.runner.run(Move<Sticky, ProbeRefusal>(two.id, below: one.id)) else {
      Issue.record("a drop in place wrote")
      return
    }
    let moved = try a.runner.run(Move<Sticky, ProbeRefusal>(three.id, below: nil))
    #expect(moved.receipt != nil)
    a.sync()
    b.sync()
    #expect(try b.drawn(Sticky.self).map(\.id) == [three.id, one.id, two.id])
    #expect(try a.runner.run(Move<Sticky, ProbeRefusal>(ID("absent00"), below: nil)).refusal
      == .refused(Refused(.unknownRecord, subject: RecordRef(type: "card", id: "absent00"), path: .predicted)))
  }

  @Test func aMoveBelowARowDeletedElsewhereIsRefusedNamingIt() throws {
    let a = try HarnessTests.phone()
    let b = a.device()
    let one = try HarnessTests.sticky(a, "One")
    let two = try HarnessTests.sticky(a, "Two")
    a.sync()
    b.sync()
    _ = try b.runner.run(Remove<Sticky, ProbeRefusal>(one.id))
    b.advance(ms: Constants.holdMs)
    b.sync()
    #expect(try a.runner.run(Move<Sticky, ProbeRefusal>(two.id, below: one.id)).refusal
      == .refused(Refused(.unknownRecord, subject: one.id.ref, path: .predicted)))
    var placed = Draft(new: Sticky(id: a.runner.mint(Sticky.self)), placed: .below(one.id.record))
    placed.current.title = "Three"
    #expect(refused(a.runner.save(&placed, SaveSticky.self)) == .refused(Refused(.unknownRecord, subject: one.id.ref, path: .predicted)))
    #expect(placed.isNew && placed.isDirty)
  }

  @Test func leavingTheAppSendsTheHold() throws {
    let a = try HarnessTests.phone()
    let b = a.device()
    let first = try HarnessTests.sticky(a, "One")
    a.sync()
    _ = try a.runner.run(Remove<Sticky, ProbeRefusal>(first.id))
    a.leave()
    b.sync()
    #expect(try b.drawn(Sticky.self).isEmpty)
  }
}

// §8.4, §9.3 and §7.1 over the real engine: a command with its specs and prediction, an executor's own record and its
// replay, a device row, and the reader's first-pull flag.
struct HarnessCommandTests {
  static func phone() throws -> Harness {
    Harness(registry: try Corpus.probeRegistry(), start: Probe.start, rules: ProbeServerRules())
  }

  @Test func aCommandSendsItsArgumentsNormalisedAndDrawsItsPrediction() throws {
    let a = try HarnessCommandTests.phone()
    let b = a.device()
    let id = a.runner.mint(Run.self)
    let started = try a.runner.run(StartRun(id: id, label: "  Tempo\u{2003}"))
    #expect(started.receipt != nil)
    #expect(try a.drawn(Run.self).map(\.fields) == [["startedAt": JSON(Probe.start.ms), "label": "Tempo"]])
    a.sync()
    b.sync()
    #expect(try b.drawn(Run.self).map(\.fields) == [["startedAt": JSON(Probe.start.ms), "label": "Tempo"]])
    let pasted = try a.runner.run(StartRun(id: a.runner.mint(Run.self), label: "Te\u{0}mpo"))
    #expect(pasted.refusal == .violation(Violation(rule: "probe.start.label", path: "label", reason: .nul)))
  }

  @Test func aCreateLeavesANilTimeFieldToTheEngine() throws {
    let a = try HarnessCommandTests.phone()
    let b = a.device()
    let run = a.runner.mint(Run.self)
    #expect(try a.runner.run(StartRun(id: run, label: "Tempo")).receipt != nil)
    a.sync()
    let lap = try Lap.decoding(a.runner.mint(Lap.self).record, ["runId": run.json, "weight": 60])
    #expect(try a.runner.run(LogLap(lap: lap)).receipt != nil)
    #expect(try a.drawn(Lap.self).map(\.fields) == [["runId": run.json, "at": JSON(Probe.start.ms), "weight": 60]])
    a.sync()
    b.sync()
    #expect(try a.notices(ProbeRefusal.self).isEmpty)
    #expect(try b.drawn(Lap.self).map(\.fields) == [["runId": run.json, "at": JSON(Probe.start.ms), "weight": 60]])
  }

  @Test func anExecutorCreatesItsOwnRecordAndItsReplayFindsItTaken() throws {
    let a = try HarnessCommandTests.phone()
    var sticky = Sticky(id: a.runner.mint(Sticky.self))
    sticky.title = "From Coach"
    let first = try a.runner.run(CreateSticky(save: SaveSticky(creating: sticky, placed: .bottom)))
    #expect(first.receipt != nil)
    let replay = try a.runner.run(CreateSticky(save: SaveSticky(creating: sticky, placed: .bottom)))
    #expect(replay.refusal == .refused(Refused(.idTaken, subject: sticky.id.ref, path: .predicted)))
    #expect(try a.drawn(Sticky.self).map(\.title) == ["From Coach"])
  }

  @Test func aDeviceRowWrittenAloneCommitsAndReadsBack() throws {
    let a = try HarnessCommandTests.phone()
    #expect(try a.runner.run(RackUp(rack: ["slot": 2])).receipt != nil)
    #expect(try a.runner.read(Probe.scope) { try $0.device("rack") } == ["slot": 2])
    a.sync()
    #expect(try a.runner.read(Probe.scope) { try $0.firstPullComplete() })
  }

  struct StartRun: Action {
    let id: ID<Run>
    let label: String
    var scope: ScopeRef { Probe.scope }

    func load(_ read: Reader) throws -> Moment { read.moment }

    func decide(_ moment: Moment, ids: IDSource) throws(Violation) -> Decision<Void, ProbeRefusal> {
      let command = ProbeStart(args: ["id": id.json, "label": .string(label), "startedAt": JSON(moment.now.ms), "join": false])
      let predicted: [String: JSON] = ["startedAt": JSON(moment.now.ms), "label": "Tempo"]
      return .write(try Plan(running: command, predicting: [.create(Run.self, id, predicted)]))
    }
  }

  struct LogLap: Action {
    let lap: Lap
    var scope: ScopeRef { Probe.scope }

    func load(_ read: Reader) throws -> Moment { read.moment }

    func decide(_ moment: Moment, ids: IDSource) throws(Violation) -> Decision<Void, ProbeRefusal> {
      var plan = Plan()
      plan.create(try Valid(lap, at: moment))
      return .write(plan)
    }
  }

  struct CreateSticky: Action {
    let save: SaveSticky
    var scope: ScopeRef { save.scope }

    func load(_ read: Reader) throws -> SaveDraftLoaded<Sticky> { try save.load(read) }

    func decide(_ loaded: SaveDraftLoaded<Sticky>, ids: IDSource) throws(Violation) -> Decision<Bool, ProbeRefusal> {
      switch try save.decide(loaded, ids: ids) {
      case .write(let plan, _): .write(plan, true)
      case .unchanged: .unchanged(false)
      case .refuse(let refusal): .refuse(refusal)
      }
    }
  }

  struct RackUp: Action {
    let rack: JSON
    var scope: ScopeRef { Probe.scope }

    func load(_ read: Reader) throws {}

    func decide(_ loaded: Void, ids: IDSource) throws(Violation) -> Decision<Void, ProbeRefusal> {
      var plan = Plan()
      plan.device("rack", rack)
      return .write(plan)
    }
  }
}

// The probe card as a product writes it to a server: every field it writes stays inside its registry domain.
struct Sticky: Draftable, Removable, Ordered {
  static let type = "card"
  static let scope = Probe.scope
  static let orderField = "ord"
  static let savesGuarded = true
  static let heldRemoval = true

  let id: ID<Sticky>
  var title = ""
  var body = ""
  var size: Double?
  var tier = "draft"

  init(id: ID<Sticky>) {
    self.id = id
  }

  init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    title = try r.string("title", default: "")
    body = try r.string("body", default: "")
    size = try r.optionalDouble("size")
    tier = try r.string("tier", default: "draft")
  }

  var fields: [String: JSON] { ["title": .string(title), "body": .string(body), "size": .of(size), "tier": .string(tier)] }

  static let checks: [Check<Sticky>] = [
    Check("title") { s, _ in s.title = try Card.title.apply(s.title, at: "title") },
    Check("body") { s, _ in s.body = try Card.body.apply(s.body, at: "body") },
    Check("size") { s, _ in s.size = try Card.size.apply(s.size, at: "size") },
    Check("tier") { s, _ in s.tier = try Card.tier.apply(s.tier, at: "tier") },
  ]
}

typealias SaveSticky = SaveDraft<Sticky, ProbeRefusal>
