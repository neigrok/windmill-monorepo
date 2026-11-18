import SyncAPI
import SyncCore

// §9.1 a scope, a load phase over a reader, and a pure decide phase that returns a decision: what the runner runs and an
// action composes. A decider is a value; its stored properties are its input.
public protocol Decider: Sendable {
  associatedtype Loaded
  associatedtype Result
  associatedtype Refusal: ProductRefusal
  var scope: ScopeRef { get }
  // §9.6: a reversible action runs as a one-segment act, so a plan it writes may opt into Undo after its hold.
  var reversible: Bool { get }
  func load(_ read: Reader) throws -> Loaded
  func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Result, Refusal>
}

extension Decider {
  public var reversible: Bool { false }

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

// The ids a decision mints, valid only inside the run that passed it: a commit's, or a reversible action's act's in its
// one scope.
public struct IDSource {
  let mintID: (String) throws -> RecordID
  let opaque: () throws -> String

  package init(context: any CommitContext) {
    mintID = context.mintID
    opaque = context.opaqueID
  }

  init(act context: any ActContext, in scope: ScopeRef) {
    mintID = { (type: String) throws -> RecordID in try context.mintID(type, in: scope) }
    opaque = context.opaqueID
  }

  public func opaqueID() -> String {
    do { return try opaque() }
    catch { preconditionFailure("minting an opaque identity failed: \(error)") }
  }

  public func mint<E: Entity>(_ type: E.Type) -> ID<E> {
    do {
      return ID(try mintID(E.type))
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
  let holdRemovals: Bool

  public init(replica: any Replica, registry: Registry, zone: any Zone, holdRemovals: Bool = true) {
    self.replica = replica
    self.registry = registry
    self.zone = zone
    self.holdRemovals = holdRemovals
  }

  // A reversible action runs the one-segment act path (§9.6), its loads, decision, gone check and result as a run's, its
  // receipt the one segment's.
  public func run<A: Action>(_ action: A) throws -> Outcome<A.Result, A.Refusal> {
    guard action.reversible else { return try perform(action) }
    switch try runAct(ReversibleAct(action: action)) {
    case .committed(let result, let receipt):
      precondition(receipt.segments.count == 1, "a reversible action commits one segment")
      let segment = receipt.segments[0]
      return .committed(result, CommitReceipt(
        gestureId: receipt.gestureId, stamp: segment.stamp ?? .unset, localIds: segment.localIds, ids: segment.ids,
        releaseAt: receipt.releaseAt, retired: receipt.retired, superseded: receipt.superseded))
    case .unchanged(let result): return .unchanged(result)
    case .refused(let refusal): return .refused(refusal)
    }
  }

  public func read<T>(_ scope: ScopeRef, _ body: (Reader) throws -> T) throws -> T {
    let moment = try moment()
    return try replica.read(scope) { source in try body(Reader(source, scope: scope, moment: moment, registry: registry)) }
  }

  // Engine §7.3, the held-only Undo: true iff every entry of the gesture was still held.
  public func cancelHeld(_ gestureId: String) throws -> Bool {
    try replica.cancelHeld(gestureId)
  }

  // §9.6 the inverse of an act opted into Undo: a wholly held act is cancelled in place; otherwise the inverse is reserved
  // at once and settles as the act's sources do. An act that did not opt in is unavailable.
  public func undo(_ actId: String) throws -> InverseResult {
    try replica.requestInverse(actId, slots: nil)
  }

  // The inverse of an Undo, restoring only what it applied, or what `productSlots` name instead.
  public func redo(_ requestId: String, productSlots: [ProductSlot]? = nil) throws -> InverseResult {
    let undone = try inverseResult(requestId)
    let inverseActId: String
    switch undone {
    case .cancelled(_, let id, _), .pending(_, let id, _), .settled(_, let id, _, _, _): inverseActId = id
    case .unavailable: return undone
    }
    let slots = productSlots?.map { (slot: ProductSlot) -> ActUndo.Segment in
      ActUndo.Segment(index: slot.index, recipes: slot.plan.undoRecipes(in: slot.scope) ?? [])
    }
    return try replica.requestInverse(inverseActId, slots: slots)
  }

  public func inverseResult(_ requestId: String) throws -> InverseResult {
    try replica.readInverseResult(requestId)
  }

  // The product's stack no longer holds the act: its journal record and values go.
  public func release(_ actId: String) throws {
    _ = try replica.releaseReversibleAct(actId)
  }

  public func mint<E: ProductEntity>(_ type: E.Type) -> ID<E> {
    mint(type, in: E.scope)
  }

  public func mint<E: Entity>(_ type: E.Type, in scope: ScopeRef) -> ID<E> {
    precondition(EntityFacts(type).scope.map { $0 == scope } ?? true, "\(E.type) cannot be rebound to \(scope)")
    precondition(registry.lives(E.type, in: scope), "\(E.type) is outside \(scope)")
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
            guard plan.undo == nil else { throw PlanError(rule: 10, "only a reversible action opts its plan into Undo") }
            if let gone = try plan.firstGone(in: context, of: scope, registry: registry) { return (nil, .done(.refused(D.Refusal(gone)))) }
            return (try plan.gesture(in: scope, registry: registry, holdRemovals: holdRemovals), .writing(plan, result))
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

// §9.6 a reversible action as the one-segment act it runs: its load inside its scope, its decision as the act's.
struct ReversibleAct<A: Action>: ActAction {
  let action: A

  func load(_ read: ActReader) throws -> A.Loaded {
    try read.inScope(action.scope) { (reader: Reader) throws -> A.Loaded in try action.load(reader) }
  }

  func decide(_ loaded: A.Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<A.Result, A.Refusal> {
    switch action.decision(loaded, ids: IDSource(act: ids.context, in: action.scope)) {
    case .write(let plan, let result): .write(ActPlan([ScopedPlan(action.scope, plan)]), result)
    case .unchanged(let result): .unchanged(result)
    case .refuse(let refusal): .refuse(refusal)
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
      let wroteNothing = receipt.localIds.isEmpty && receipt.retired.isEmpty && receipt.superseded.isEmpty && plan.deviceWrites.isEmpty
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
    case .revive:
      guard let definition = registry.type(operation.entity.type), definition.hasBorn, definition.revivable == true else { return false }
      return try context.drawn(operation.entity.type, operation.id)?.born == nil
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
