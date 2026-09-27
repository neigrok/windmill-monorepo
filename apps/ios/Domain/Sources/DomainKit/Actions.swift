import SyncAPI
import SyncCore

// §9.1 a scope, a load phase over a reader, and a pure decide phase that returns a decision: what the runner runs and an
// action composes. A decider is a value; its stored properties are its input.
public protocol Decider: Sendable {
  associatedtype Loaded
  associatedtype Result
  associatedtype Refusal: ProductRefusal
  var scope: ScopeRef { get }
  func load(_ read: Reader) throws -> Loaded
  func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Result, Refusal>
}

extension Decider {
  // The decision as the runner and a composing action read it: a violation decide throws is the refusal it maps to, so
  // every refusal arrives as `refuse`.
  public func decision(_ loaded: Loaded, ids: IDSource) -> Decision<Result, Refusal> {
    do throws(Violation) {
      return try decide(loaded, ids: ids)
    } catch {
      return .refuse(Refusal(error))
    }
  }
}

// D-16 a use case: a decider the runner runs. Its result is `Sendable`, so no action returns a draft's `Saved` (§10.1).
public protocol Action: Decider where Result: Sendable {}

public enum Decision<Result, Refusal> {
  case write(Plan, Result)
  case unchanged(Result)
  case refuse(Refusal)
}

extension Decision where Result == Void {
  public static func write(_ plan: Plan) -> Decision { .write(plan, ()) }
}

extension Decision: Sendable where Result: Sendable, Refusal: Sendable {}

// D-17 what `run` returns. `committed` means committed on this device, not accepted by the account.
public enum Outcome<Result, Refusal> {
  case committed(Result, CommitReceipt)
  case unchanged(Result)
  case refused(Refusal)
}

extension Outcome {
  public var receipt: CommitReceipt? {
    guard case .committed(_, let receipt) = self else { return nil }
    return receipt
  }

  public var refusal: Refusal? {
    guard case .refused(let refusal) = self else { return nil }
    return refusal
  }
}

extension Outcome: Sendable where Result: Sendable, Refusal: Sendable {}

// The ids a decision mints, valid only inside the run that passed it.
public struct IDSource {
  let context: any CommitContext

  package init(context: any CommitContext) {
    self.context = context
  }

  public func mint<E: Entity>(_ type: E.Type) -> ID<E> {
    do {
      return ID(try context.mintID(E.type))
    } catch {
      preconditionFailure("minting a \(E.type) id failed, a programming fault: \(error)")
    }
  }
}

// D-18 the only kit object that holds the `Replica` port. It runs an action as one engine commit.
public final class ActionRunner: Sendable {
  @TaskLocal static var isRunning = false

  let replica: any Replica
  let registry: Registry
  let zone: any Zone

  public init(replica: any Replica, registry: Registry, zone: any Zone) {
    self.replica = replica
    self.registry = registry
    self.zone = zone
  }

  public func run<A: Action>(_ action: A) throws -> Outcome<A.Result, A.Refusal> {
    try perform(action)
  }

  public func read<T>(_ scope: ScopeRef, _ body: (Reader) throws -> T) throws -> T {
    let moment = try moment()
    return try replica.read(scope) { source in try body(Reader(source, scope: scope, moment: moment, registry: registry)) }
  }

  // Engine §7.3: true iff every entry of the gesture was still held.
  public func undo(_ gestureId: String) throws -> Bool {
    try replica.undo(gestureId)
  }

  public func mint<E: Entity>(_ type: E.Type) -> ID<E> {
    do {
      return ID(try replica.mintID(E.type))
    } catch {
      preconditionFailure("minting a \(E.type) id failed, a programming fault: \(error)")
    }
  }

  public func moment() throws -> Moment {
    Moment(now: Instant(ms: try replica.physNow()), zone: zone)
  }

  // §9.2 one ordered, fail-fast pipeline: no nesting, one local transaction, load, decide, the gone check, translate,
  // then the engine's outcome mapped, a refusal the commit wrote into a notice delivered by the outcome alone.
  func perform<D: Decider>(_ decider: D) throws -> Outcome<D.Result, D.Refusal> {
    precondition(!ActionRunner.isRunning, "a run entered inside a run: a run commits one gesture (§9.2 step 1)")
    let scope = decider.scope
    return try ActionRunner.$isRunning.withValue(true) {
      let committed: (outcome: CommitOutcome?, value: Step<D.Result, D.Refusal>)
      do {
        committed = try replica.commit(scope) { context in
          let reader = Reader(context, scope: scope, moment: Moment(now: Instant(ms: context.now), zone: zone), registry: registry)
          switch decider.decision(try decider.load(reader), ids: IDSource(context: context)) {
          case .refuse(let refusal): return (nil, .done(.refused(refusal)))
          case .unchanged(let result): return (nil, .done(.unchanged(result)))
          case .write(let plan, let result):
            if let gone = try plan.firstGone(in: context, of: scope, registry: registry) { return (nil, .done(.refused(D.Refusal(gone)))) }
            return (try plan.gesture(in: scope, registry: registry), .writing(plan, result))
          }
        }
      } catch let failure as CommitFailure where failure.kind == .malformed {
        preconditionFailure("a malformed commit is a programming fault (ER-14): \(failure)")
      }
      if case .refused(_, _, let notice?)? = committed.outcome { try replica.dismissNotice(notice) }
      return committed.value.outcome(of: committed.outcome, registry: registry)
    }
  }
}

// What a run's body decided: an outcome already, or a plan the engine's commit answers.
enum Step<Result, Refusal: ProductRefusal> {
  case done(Outcome<Result, Refusal>)
  case writing(Plan, Result)

  // §9.2 step 7.
  func outcome(of committed: CommitOutcome?, registry: Registry) -> Outcome<Result, Refusal> {
    switch (self, committed) {
    case (.done(let outcome), _):
      return outcome
    case (.writing(let plan, let result), .committed(let receipt)?):
      let wroteNothing = receipt.localIds.isEmpty && receipt.retired.isEmpty && plan.deviceWrites.isEmpty
      return wroteNothing ? .unchanged(result) : .committed(result, receipt)
    case (.writing(let plan, _), .refused(let code, let detail, _)?):
      let subject = plan.subject(ofRefusal: code, detail: detail, registry: registry)
      return .refused(Refusal(Refused(code, subject: subject, detail: detail, path: .predicted)))
    case (.writing, nil):
      preconditionFailure("the engine answered a gesture with no outcome")
    }
  }
}

extension Plan {
  // §9.2 step 5: an update, removal or move of a type with life needs its record alive in `drawn`; an insert or move, its
  // anchor listed in `drawn` or `stored` (engine D-25). Another scope's type is §8.3 rule 1's to refuse.
  func firstGone(in context: any CommitContext, of scope: ScopeRef, registry: Registry) throws -> Refused? {
    for operation in operations where registry.lives(operation.entity.type, in: scope) {
      if try isGone(operation, in: context, registry: registry) { return Refused(.unknownRecord, subject: operation.ref, path: .predicted) }
      if let anchor = operation.anchor, let orderField = operation.entity.orderField,
         try !isListed(anchor, of: operation.entity.type, by: orderField, in: context) {
        return Refused(.unknownRecord, subject: RecordRef(type: operation.entity.type, id: anchor), path: .predicted)
      }
    }
    return nil
  }

  func isGone(_ operation: Operation, in context: any CommitContext, registry: Registry) throws -> Bool {
    switch operation.kind {
    case .update, .remove, .move: break
    default: return false
    }
    guard registry.type(operation.entity.type)?.life == true else { return false }
    return try context.drawn(operation.entity.type, operation.id)?.life?.isAlive != true
  }

  func isListed(_ anchor: RecordID, of type: String, by orderField: String, in context: any CommitContext) throws -> Bool {
    let listed = { (record: Record?) in record.map { $0.isVisible && $0.values[orderField]?.isString == true } ?? false }
    return try listed(context.drawn(type, anchor)) || listed(context.stored(type, anchor))
  }

  // §12.1 rule 2: for `cap`, the first record the plan creates of the capped type; otherwise the first record it writes.
  func subject(ofRefusal code: RefusalCode, detail: JSON?, registry: Registry) -> RecordRef? {
    let writing = operations.filter(\.writes)
    let named = { (operation: Operation) in RecordRef(type: operation.entity.type, id: operation.recordID(in: registry)) }
    if code == .cap, case .string(let type)? = detail?["type"],
       let created = writing.first(where: { $0.creates && $0.entity.type.utf8.elementsEqual(type.utf8) }) {
      return named(created)
    }
    return writing.first.map(named)
  }
}
