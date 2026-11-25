import DomainKit
import DomainKitTesting
import SyncAPI
import SyncCore
import SyncModelServer
import SyncTesting
import Synchronization
import Testing

// §9.6 an act's Undo with the checks its plan names, over the real engine and the model server: a sticky's title written
// with its Undo, which a check reads before anything is asked of the engine.
struct UndoChecksTests {
  // A check that refuses while `refusing` holds, or fails as a store would while `failing` does, counting its reads.
  final class Standing: UndoCheck {
    let state = Mutex((refusing: false, failing: false, reads: 0))
    var scope: ScopeRef { Probe.scope }

    func check(_ read: Reader) throws {
      let now = state.withLock { (state: inout (refusing: Bool, failing: Bool, reads: Int)) -> (refusing: Bool, failing: Bool) in
        state.reads += 1
        return (state.refusing, state.failing)
      }
      _ = try read.repository(Sticky.self).all(in: .drawn)
      if now.failing { throw CommitFailure(.storeFailure, "the store could not be read") }
      if now.refusing { throw Violation(rule: "card.title.taken", path: "title", reason: .custom("taken")) }
    }
  }

  // A sticky's title, written with the Undo that writes the earlier one back where `opting`, and the checks it names.
  struct Retitle: ActAction {
    let id: ID<Sticky>
    let title: String
    var opting = true
    let checks: [any UndoCheck]

    func load(_ read: ActReader) throws -> (sticky: Sticky?, moment: Moment) {
      try read.inScope(Probe.scope) { (scope: Reader) throws -> (sticky: Sticky?, moment: Moment) in
        (try scope.repository(Sticky.self).find(id, in: .drawn), scope.moment)
      }
    }

    func decide(_ loaded: (sticky: Sticky?, moment: Moment), ids: ActIDSource) throws(Violation) -> ActDecision<Void, ProbeRefusal> {
      guard var sticky = loaded.sticky else { return .unchanged(()) }
      sticky.title = title
      var plan = Plan()
      plan.update(try Valid(sticky, fields: ["title"], at: loaded.moment), fields: ["title"])
      if opting { plan.undoBy(.fields(restoreCommand: "probe.restore", targets: [(target: .field(id, "title"), default: nil)])) }
      for check in checks { plan.undoCheckedBy(check) }
      return .write(ActPlan([ScopedPlan(Probe.scope, plan)]), ())
    }
  }

  // A phone holding the sticky *Old*, received, and its title read back.
  static func titled() throws -> (phone: Harness, id: ID<Sticky>, title: () throws -> String?) {
    let phone = Harness(registry: try Corpus.probeRegistry(), start: Probe.start, rules: ProbeServerRules())
    let id = try HarnessTests.sticky(phone, "Old").id
    phone.sync()
    return (phone, id, { try phone.drawn(Sticky.self).first { $0.id == id }?.title })
  }

  static func undo(of outcome: ActOutcome<Void, ProbeRefusal>) throws -> UndoHandle {
    guard case .committed(_, let receipt) = outcome else { throw ContractError("the title was not written: \(outcome)") }
    return receipt.undo
  }

  @Test func anUndoWhoseCheckRefusesWhatStandsIsUnavailableAndWritesNothingUntilItStands() throws {
    let (phone, id, title) = try Self.titled()
    let standing = Standing()
    let act = try Self.undo(of: try phone.runner.runAct(Retitle(id: id, title: "New", checks: [standing])))
    standing.state.withLock { $0.refusing = true }
    #expect(try phone.runner.undo(act) == .unavailable(requestId: nil, reason: "refused"))
    phone.sync()
    #expect(try title() == "New")
    standing.state.withLock { $0.refusing = false }
    guard case .pending(_, _, let changed) = try phone.runner.undo(act) else {
      Issue.record("the Undo was not asked once its check stood")
      return
    }
    let restored = try title()
    #expect(changed && restored == "Old" && standing.state.withLock { $0.reads } == 2)
  }

  @Test func anErrorACheckThrowsThatIsNoViolationPropagatesAndNothingIsAsked() throws {
    let (phone, id, title) = try Self.titled()
    let standing = Standing()
    let act = try Self.undo(of: try phone.runner.runAct(Retitle(id: id, title: "New", checks: [standing])))
    standing.state.withLock { $0.failing = true }
    #expect(throws: CommitFailure(.storeFailure, "the store could not be read")) { try phone.runner.undo(act) }
    #expect(try title() == "New")
  }

  @Test func anActThatNamesNoCheckIsUndoneAsTheEngineUndoesIt() throws {
    let (phone, id, title) = try Self.titled()
    let act = try Self.undo(of: try phone.runner.runAct(Retitle(id: id, title: "New", checks: [])))
    guard case .pending = try phone.runner.undo(act) else {
      Issue.record("the Undo was not asked")
      return
    }
    phone.sync()
    #expect(try title() == "Old")
  }

  @Test func aRedoAnswersTheUndoOfTheActItWroteWithTheChecksOfTheActItTookBack() throws {
    let (phone, id, title) = try Self.titled()
    let standing = Standing()
    let act = try Self.undo(of: try phone.runner.runAct(Retitle(id: id, title: "New", checks: [standing])))
    guard case .pending(let request, _, _) = try phone.runner.undo(act) else {
      Issue.record("the Undo was not asked")
      return
    }
    phone.sync()
    let redone = try phone.runner.redo(request, of: act)
    guard case .pending(_, let redoneAct, _) = redone.result, let undo = redone.undo else {
      Issue.record("the Redo was not asked: \(redone.result)")
      return
    }
    #expect(undo.actId == redoneAct)
    phone.sync()
    standing.state.withLock { $0.refusing = true }
    #expect(try phone.runner.undo(undo) == .unavailable(requestId: nil, reason: "refused"))
    #expect(try title() == "New")
  }

  @Test func aPlanThatChecksAnUndoItDoesNotOptIntoIsAPlanFault() throws {
    let (phone, id, _) = try Self.titled()
    #expect(throws: PlanError(rule: 11, "a plan checks an Undo it does not opt into")) {
      try phone.runner.runAct(Retitle(id: id, title: "New", opting: false, checks: [Standing()]))
    }
  }
}
