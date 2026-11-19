import GRDB
import SyncAPI
import SyncCore
import SyncEngine
@testable import SyncStore
import Synchronization
import Testing

struct ActTests {
  @Test func initialLoansEndAndSegmentsSeeEarlierCreates() throws {
    let timings = Mutex<[WriterTiming.Operation]>([])
    let rig = try Rig(writerObserver: { sample in timings.withLock { $0.append(sample.operation) } })
    timings.withLock { $0.removeAll() }
    let scope = Rig.scope
    var loan: (any ScopeReader)?
    var prepares = 0
    let result = try rig.engine.commitAct({ context in
      prepares += 1
      let count = try context.inScope(scope) { reader in loan = reader; return try reader.drawn("card").count }
      #expect(count == 0)
      return (ActRequest(scopes: [scope, scope], hold: true), context.now)
    }, segment: { now, index, context in
      #expect(context.now == now)
      if index == 0 { return Gesture(changes: [Rig.card("card0001", "First")]) }
      let previous = try context.drawn("card", "card0001")
      #expect(previous?.values["title"] == "First")
      return Gesture(changes: [.update("card", "card0001", ["title": "Next"])])
    })
    guard case .committed(let receipt)? = result.outcome else { Issue.record("act did not commit"); return }
    #expect(timings.withLock { $0 } == [.commit])
    #expect(throws: CommitFailure.self) { try loan!.drawn("card") }
    #expect(prepares == 1)
    #expect(receipt.segments.map(\.scope) == [scope, scope])
    #expect(receipt.localIds == ["\(receipt.gestureId)/0", "\(receipt.gestureId)/1"])
    #expect(receipt.segments[0].stamp! < receipt.segments[1].stamp!)
    #expect(try rig.engine.cancelHeld(receipt.gestureId))
    #expect(try rig.engine.read(scope) { try $0.drawn("card").isEmpty })
  }

  @Test func laterScopeRefusalAndDiskFailureRollBackTheWholeAct() throws {
    let fail = Mutex(false)
    let rig = try Rig(crashPoints: CrashPoints { point in
      if case .beforeCommit(.commit) = point, fail.withLock({ $0 }) { throw RigError("act disk failure") }
    })
    let before = try rig.store.read { try $0.device(rows: true).json }
    let board = ScopedGesture(scope: Rig.scope, gesture: Gesture(changes: [.create("board", id: .given("b_00000001"))], local: [DeviceWrite(key: "rack", value: 1)]))
    let tree = ScopedGesture(scope: .tree("b_00000001"), gesture: Gesture(changes: [.write("meta", "meta", ["title": "First"])]))
    fail.withLock { $0 = true }
    #expect(throws: CommitFailure.self) { try rig.engine.commitAct([board, tree]) }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
    fail.withLock { $0 = false }
    let cards = (1...4).map { ScopedGesture(scope: Rig.scope, gesture: Gesture(changes: [Rig.card("card000\($0)", "Card")])) }
    let refused = try rig.engine.commitAct([board] + cards)
    if case .refused(let segment, let code, _)? = refused { #expect(segment == 4 && code == .cap) }
    else { Issue.record("act did not refuse") }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
    #expect(try rig.engine.commitAct([board, tree]) != nil)
  }

  // §7.1 a composed act, staged: a later part's load reads through the segment staged before it, and the request's
  // segments then commit afresh as one act.
  @Test func aLaterLoadReadsThroughAStagedSegmentAndTheRequestCommitsEverySegmentAsOneAct() throws {
    let rig = try Rig(account: "A")
    let scope = Rig.scope
    let title = { (reader: any ScopeReader) throws -> JSON in try reader.drawn("card", "card0001")?.values["title"] ?? .null }
    let rename = { (title: String) -> Gesture in Gesture(changes: [.update("card", "card0001", ["title": .string(title)])]) }
    var reads: [JSON] = []
    var staged: [StagedRefusal?] = []
    let result = try rig.engine.commitAct({ act in
      reads.append(try act.inScope(scope, title))
      staged.append(try act.stage(scope) { _ in Gesture(changes: [Rig.card("card0001", "First")]) })
      try act.beginPart()
      reads.append(try act.inScope(scope, title))
      staged.append(try act.stage(scope) { context in rename("\(try title(context).asString())!") })
      return (ActRequest(scopes: [scope, scope]), ())
    }, segment: { _, index, _ in index == 0 ? Gesture(changes: [Rig.card("card0001", "First")]) : rename("First!") })
    guard case .committed(let receipt)? = result.outcome else { Issue.record("the act did not commit"); return }
    let expectedReads: [JSON] = [.null, "First"]
    #expect(reads == expectedReads)
    #expect(staged == [nil, nil])
    #expect(receipt.segments.map(\.localIds) == [["\(receipt.gestureId)/0"], ["\(receipt.gestureId)/1"]])
    #expect(try rig.engine.read(scope) { try title($0) } == "First!")
    #expect(try rig.outbox() == ["\(receipt.gestureId)/0 ready", "\(receipt.gestureId)/1 ready"])
  }

  // A staged local refusal is answered where the part stages it, and the act it ends writes nothing.
  @Test func aStagedLocalRefusalIsAnsweredAndTheActItEndsWritesNothing() async throws {
    let rig = try Rig(account: "A")
    let gone = ScopeRef.tree("b_00000005")
    _ = try rig.engine.subscribe(gone)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.page(gone, "gone")]))
    _ = await rig.engine.puller.step()
    let before = try rig.store.read { try $0.device(rows: true).json }
    var staged: [StagedRefusal?] = []
    let result = try rig.engine.commitAct({ act in
      staged.append(try act.stage(Rig.scope) { _ in Gesture(changes: [Rig.card("card0001", "First")]) })
      staged.append(try act.stage(gone) { _ in Gesture(changes: [.create("tag", id: .given("elm"), ["label": "Elm"])]) })
      return (nil, ())
    }, segment: { _, _, _ in
      Issue.record("a refused act reaches no segment")
      return Gesture(changes: [])
    })
    #expect(result.outcome == nil)
    #expect(staged == [nil, StagedRefusal(code: .scopeDead, detail: nil)])
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }

  @Test func aLaterScopeSQLiteFailureRollsBackEarlierBatches() async throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    try await rig.store.writer.write { db in
      try db.execute(sql: "CREATE TEMP TRIGGER fail_late_scope BEFORE INSERT ON outbox WHEN NEW.scope = 'tree/b_00000001' BEGIN SELECT RAISE(ABORT, 'act write fault'); END")
    }
    #expect(throws: CommitFailure.self) {
      try rig.engine.commitAct([
        ScopedGesture(scope: Rig.scope, gesture: Gesture(changes: [.create("board", id: .given("b_00000001"))], local: [DeviceWrite(key: "rack", value: 1)])),
        ScopedGesture(scope: .tree("b_00000001"), gesture: Gesture(changes: [.write("meta", "meta", ["title": "First"])])),
      ])
    }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }

  @Test func aNewGovernedScopeCanMintBeforeItsCreate() throws {
    let rig = try Rig()
    let tree = ScopeRef.tree("b_00000001")
    let result = try rig.engine.commitAct({ context in
      (ActRequest(scopes: [Rig.scope, tree]), try context.mintID("tag", in: tree))
    }, segment: { id, index, _ in
      index == 0 ? Gesture(changes: [.create("board", id: .given("b_00000001"))])
        : Gesture(changes: [.create("tag", id: .given(id), ["label": "New"])])
    })
    #expect(result.outcome != nil)
    #expect(try rig.engine.read(tree) { try $0.drawn("tag", result.value)?.values["label"] } == "New")
  }

  @Test func caughtLoadFailureAndLateReadsCannotEnterDecideOrMint() throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    rig.random.queue(raw: 123, count: 16)
    var decisions = 0
    #expect(throws: CommitFailure.self) {
      try rig.engine.commitAct({ context -> (ActRequest?, Void) in
        try context.inScope(Rig.scope) { _ in () }
        _ = try? context.inScope(.product("missing")) { _ in () }
        _ = try context.mintID("card", in: Rig.scope)
        decisions += 1
        return (nil, ())
      }, segment: { _, _, _ in Gesture(changes: []) })
    }
    #expect(decisions == 0)
    #expect(rig.random.queued.withLock { $0.count } == 16)
    #expect(throws: CommitFailure.self) {
      try rig.engine.commitAct({ context -> (ActRequest?, Void) in
        try context.finishLoad(); try context.finishLoad()
        _ = try? context.inScope(Rig.scope) { _ in () }
        return (ActRequest(scopes: [Rig.scope]), ())
      }, segment: { _, _, _ in Gesture(changes: [Rig.card("card0001", "First")]) })
    }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }

  @Test func mintRequiresAnInitialBorrowAndSharesReservations() throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    rig.random.queue(raw: 123, count: 16)
    #expect(throws: CommitFailure.self) {
      try rig.engine.commitAct({ context -> (ActRequest?, Void) in
        _ = try context.mintID("card", in: Rig.scope)
        return (nil, ())
      }, segment: { _, _, _ in Gesture(changes: []) })
    }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
    #expect(rig.random.queued.withLock { $0.count } == 16)
    rig.random.queue(raw: 123, count: 16)
    let values = try rig.engine.commitAct({ context in
      try context.inScope(Rig.scope) { _ in () }
      return (nil as ActRequest?, [try context.mintID("card", in: Rig.scope), try context.mintID("card", in: Rig.scope)])
    }, segment: { _, _, _ in Gesture(changes: []) }).value
    #expect(values[0] != values[1])
  }
}
