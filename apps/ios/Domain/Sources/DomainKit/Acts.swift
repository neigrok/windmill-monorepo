import SyncAPI
import SyncCore

public struct ScopedPlan: Sendable {
  public let scope: ScopeRef
  public let plan: Plan
  public init(_ scope: ScopeRef, _ plan: Plan) { self.scope = scope; self.plan = plan }
}

public struct ActPlan: Sendable {
  public let segments: [ScopedPlan]
  public init(_ segments: [ScopedPlan]) { self.segments = segments }
}

public protocol ActAction: Sendable {
  associatedtype Loaded
  associatedtype Result: Sendable
  associatedtype Refusal: ProductRefusal
  func load(_ read: ActReader) throws -> Loaded
  func decide(_ loaded: Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<Result, Refusal>
}

public enum ActDecision<Result, Refusal> {
  case write(ActPlan, Result)
  case unchanged(Result)
  case refuse(Refusal)
}

public enum ActOutcome<Result, Refusal> {
  case committed(Result, ActReceipt)
  case unchanged(Result)
  case refused(Refusal)
}

extension ActDecision: Sendable where Result: Sendable, Refusal: Sendable {}
extension ActOutcome: Sendable where Result: Sendable, Refusal: Sendable {}

public final class ActReader {
  let context: any ActContext
  let registry: Registry
  public let moment: Moment
  var isOpen = true

  package init(_ context: any ActContext, registry: Registry, moment: Moment) {
    self.context = context; self.registry = registry; self.moment = moment
  }

  public func inScope<T>(_ scope: ScopeRef, _ body: (Reader) throws -> T) throws -> T {
    precondition(isOpen, "an act reads only during load")
    return try context.inScope(scope) { try body(Reader($0, scope: scope, moment: moment, registry: registry)) }
  }

  // The load is over: a read after it traps.
  package func end() {
    isOpen = false
  }
}

public struct ActIDSource {
  let context: any ActContext

  package init(context: any ActContext) {
    self.context = context
  }

  public func mint<E: Entity>(_ type: E.Type, inScope scope: ScopeRef) -> ID<E> {
    precondition(EntityFacts(type).scope.map { $0 == scope } ?? true, "an identity names its entity's scope")
    do { return ID(try context.mintID(E.type, in: scope)) }
    catch { preconditionFailure("minting an act identity failed: \(error)") }
  }

  public func mint<E: ProductEntity>(_ type: E.Type) -> ID<E> { mint(type, inScope: E.scope) }

  public func opaqueID() -> String {
    do { return try context.opaqueID() }
    catch { preconditionFailure("minting an opaque act identity failed: \(error)") }
  }
}

extension ActionRunner {
  public func runAct<A: ActAction>(_ action: A) throws -> ActOutcome<A.Result, A.Refusal> {
    precondition(!ActionRunner.isRunning, "a run cannot enter inside a run")
    return try ActionRunner.$isRunning.withValue(true) {
      do {
        let committed = try replica.commitAct({ context -> (ActRequest?, ActStep<A.Result, A.Refusal>) in
          let read = ActReader(context, registry: registry, moment: Moment(now: Instant(ms: context.now), zone: zone))
          let loaded: A.Loaded
          do { loaded = try action.load(read) }
          catch { read.end(); throw error }
          read.end()
          try context.finishLoad()
          let decision: ActDecision<A.Result, A.Refusal>
          do throws(Violation) { decision = try action.decide(loaded, ids: ActIDSource(context: context)) }
          catch { return (nil, .done(.refused(A.Refusal(error)))) }
          switch decision {
          case .refuse(let refusal): return (nil, .done(.refused(refusal)))
          case .unchanged(let result): return (nil, .done(.unchanged(result)))
          case .write(let act, let result):
            let opted: [ActUndo.Segment] = act.segments.enumerated().compactMap { (index: Int, segment: ScopedPlan) -> ActUndo.Segment? in
              segment.plan.undoRecipes(in: segment.scope).map { ActUndo.Segment(index: index, recipes: $0) }
            }
            let request = ActRequest(scopes: act.segments.map(\.scope), hold: holdRemovals && act.segments.contains { $0.plan.isHeld },
                                     undo: opted.isEmpty ? nil : ActUndo(segments: opted))
            return (request, .writing(act, result))
          }
        }, segment: { step, index, context in
          guard case .writing(let act, _) = step else { preconditionFailure("only a writing act has segments") }
          let scoped = act.segments[index]
          if let gone = try scoped.plan.firstGone(in: context, of: scoped.scope, registry: registry) { throw ActPrediction(refusal: gone) }
          return try scoped.plan.gesture(in: scoped.scope, registry: registry, holdRemovals: holdRemovals)
        })
        switch committed.value {
        case .done(let outcome): return outcome
        case .writing(let act, let result):
          switch committed.outcome {
          case .committed(let receipt): return .committed(result, receipt)
          case .refused(let index, let code, let detail):
            return .refused(A.Refusal(Refused(code, subject: act.segments[index].plan.subject(ofRefusal: code, detail: detail, registry: registry),
              detail: detail, path: .predicted)))
          case nil: return .unchanged(result)
          }
        }
      } catch let prediction as ActPrediction { return .refused(A.Refusal(prediction.refusal)) }
      catch let failure as CommitFailure where failure.kind == .malformed { preconditionFailure("a malformed act is a programming fault: \(failure)") }
    }
  }
}

enum ActStep<Result, Refusal> {
  case done(ActOutcome<Result, Refusal>)
  case writing(ActPlan, Result)
}

struct ActPrediction: Error {
  let refusal: Refused
}
